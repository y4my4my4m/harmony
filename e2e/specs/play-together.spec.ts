// Journey: play together. Two people in a DM start DrawinPhone, play a whole game in sandboxed
// frames through the federation backend's relay, and the starter ends it for everyone. The frame
// runs in an opaque origin with no storage and no network, and one that navigates itself away is
// cut off. An instance admin turns the app off and the launcher stops offering it.
//
// The backend runs as a child process (backend.ts): page.route() carries the frame document and
// routeWebSocket() bridges the relay socket to it.

import { test, expect, type Browser, type BrowserContext, type FrameLocator, type Page } from '@playwright/test'
import { addMember, adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let alice: SpecUser
let bob: SpecUser
let boss: SpecUser
let dm = ''
let backend: Backend
let server: SeededServer
let voiceId = ''

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

async function open(browser: Browser, user: SpecUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, user)
  return { context, page }
}

const game = (page: Page): FrameLocator => page.frameLocator('[data-testid="play-together-frame"]')

async function scribble(page: Page): Promise<void> {
  const box = await game(page).locator('[data-testid="dp-canvas"]').boundingBox()
  if (!box) throw new Error('no canvas')
  const x = box.x + box.width * 0.3
  const y = box.y + box.height * 0.4
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 14, y + Math.sin(i) * 30, { steps: 2 })
  await page.mouse.up()
}

test.beforeAll(async () => {
  backend = await startBackend()
  alice = await createUser(admin, 'pta')
  bob = await createUser(admin, 'ptb')
  boss = await createUser(admin, 'ptadm')
  await must('admin flag', admin.from('profiles').update({ is_admin: true }).eq('id', boss.id))
  await must('app on', admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone'))
  const conversation = await must('dm', admin.from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single())
  dm = conversation.data!.id
  await must('participants', admin.from('conversation_participants').insert([
    { conversation_id: dm, user_id: alice.id }, { conversation_id: dm, user_id: bob.id },
  ]))
  server = await seedServer(admin, alice, `Arcade ${alice.username}`)
  await addMember(admin, bob, server.id)
  const voice = await must('voice channel', admin.from('channels').insert({ server_id: server.id, name: 'arcade', type: 1 }).select('id').single())
  voiceId = voice.data!.id
  await must('in the call', admin.from('voice_channel_participants').insert([
    { channel_id: voiceId, user_id: alice.id, server_id: server.id }, { channel_id: voiceId, user_id: bob.id, server_id: server.id },
  ]))
})

/** The voice store as a call to the arcade channel leaves it; no LiveKit runs in this stack. */
async function enterCall(page: Page, user: SpecUser, overlay: boolean): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId, roster, overlay }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    stores.get('unifiedVoiceChannel')!.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'arcade'
      state.localState.userId = userId
      if (overlay) state.isOverlayVisible = true
    })
    stores.get('serverUsers')?.$patch((state) => {
      state.usersInVoiceChannels = { ...state.usersInVoiceChannels, [channelId]: roster }
    })
  }, { serverId: server.id, channelId: voiceId, userId: user.id, roster: [alice.id, bob.id], overlay })
}

test.afterAll(async () => {
  test.setTimeout(120_000)
  await admin.from('activity_apps').delete().eq('id', 'tictac')
  await admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone')
  if (voiceId) await admin.from('activity_sessions').delete().eq('channel_id', voiceId)
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await admin.from('activity_sessions').delete().eq('conversation_id', dm)
  await admin.from('conversations').delete().eq('id', dm)
  for (const user of [alice, bob, boss]) if (user) await deleteUser(admin, user)
  await backend?.stop()
})

test('two people play DrawinPhone in a DM, then the starter ends it', async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await open(browser, alice)
  const b = await open(browser, bob)

  await a.page.goto(`/dm/${dm}`)
  await a.page.getByTestId('play-together-button').click()
  await expect(a.page.getByTestId('play-together-launcher')).toBeVisible()
  await a.page.getByTestId('play-together-app-drawinphone').click()

  await expect(a.page.getByTestId('play-together-panel')).toBeVisible()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(1)
  await expect(a.page.getByTestId('play-together-third-party')).toHaveCount(0)

  // Bob joins from the notice in the conversation. The stack has no Realtime: the notice reaches
  // a page that loads the conversation after it was posted.
  await b.page.goto(`/dm/${dm}`)
  await expect(b.page.locator('[data-system-type="activity_started"]')).toHaveCount(1)
  await b.page.getByTestId('activity-system-join').click()
  await expect(game(b.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(game(b.page).getByTestId('dp-player')).toHaveCount(2)
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(2)

  // Write, then draw the other's prompt.
  await game(a.page).getByTestId('dp-start').click()
  for (const [page, text] of [[a.page, 'a cat surfing a wave'], [b.page, 'a robot baking bread']] as const) {
    await game(page).getByTestId('dp-prompt-input').fill(text)
    await game(page).getByTestId('dp-submit').click()
  }
  for (const page of [a.page, b.page]) {
    await expect(game(page).getByTestId('dp-canvas')).toBeVisible({ timeout: 20_000 })
    await scribble(page)
    await game(page).getByTestId('dp-submit').click()
  }

  // The album: everyone sees it; the host steps through to the end.
  await expect(game(a.page).getByTestId('dp-album')).toBeVisible({ timeout: 20_000 })
  await expect(game(b.page).getByTestId('dp-album')).toBeVisible()
  await expect(game(b.page).getByTestId('dp-album')).toContainText(/a cat surfing a wave|a robot baking bread/)
  const next = game(a.page).getByTestId('dp-next')
  const again = game(a.page).getByTestId('dp-play-again')
  for (let i = 0; i < 12; i++) {
    await expect(next.or(again).first()).toBeVisible()
    if (await again.isVisible()) break
    await next.click().catch(() => {})
  }
  await expect(game(a.page).getByTestId('dp-play-again')).toBeVisible()

  // Alice started it: she ends it for everyone.
  await a.page.getByTestId('play-together-end').click()
  await expect(b.page.getByTestId('play-together-status')).toHaveText(/Ended/)
  await expect(game(b.page).getByTestId('dp-ended')).toBeVisible()
  await b.page.getByTestId('play-together-leave').click()
  await expect(b.page.getByTestId('play-together-panel')).toHaveCount(0)
  await b.page.reload()
  await expect(b.page.locator('[data-system-type="activity_ended"]')).toHaveCount(1, { timeout: 15_000 })
  await expect(b.page.locator('[data-system-type="activity_ended"]')).toContainText('2')
  const row = await must('session', admin.from('activity_sessions').select('status, end_reason, played_by').eq('conversation_id', dm).single())
  expect(row.data).toMatchObject({ status: 'ended', end_reason: 'host_ended' })
  expect((row.data!.played_by as string[]).sort()).toEqual([alice.id, bob.id].sort())

  await a.context.close()
  await b.context.close()
})

test('the activity frame runs in an opaque origin without storage or network', async ({ browser }) => {
  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await a.page.getByTestId('play-together-button').click()
  await a.page.getByTestId('play-together-app-drawinphone').click()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })

  await expect(a.page.getByTestId('play-together-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock')
  const frame = a.page.frames().find((f) => f.url().includes('/activities/frame/drawinphone'))!
  const probe = await frame.evaluate(async () => {
    const attempt = async (fn: () => unknown) => {
      try {
        await fn()
        return 'open'
      } catch {
        return 'blocked'
      }
    }
    return {
      origin: self.origin,
      storage: await attempt(() => window.localStorage.length),
      cookie: await attempt(() => document.cookie),
      top: await attempt(() => window.top!.location.href),
      fetch: await attempt(() => fetch('/api/federation/health').then((r) => r.status)),
      // Firefox refuses the socket without an error event: only an open counts as open.
      socket: await attempt(() => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host || 'localhost'}/`)
        ws.onopen = resolve
        ws.onerror = reject
        setTimeout(() => reject(new Error('no open')), 3000)
      })),
    }
  })
  expect(probe).toEqual({ origin: 'null', storage: 'blocked', cookie: 'blocked', top: 'blocked', fetch: 'blocked', socket: 'blocked' })

  // An activity that navigates its own frame away is detached and the frame blanked.
  await frame.evaluate(() => { location.href = '/activities/index.json' })
  await expect(a.page.getByText('tried to leave its sandbox')).toBeVisible()
  await expect(a.page.getByTestId('play-together-frame')).toHaveAttribute('src', 'about:blank')

  await a.page.getByTestId('play-together-end').click()
  await a.context.close()
})

test('an admin turns DrawinPhone off and the launcher stops offering it', async ({ browser }) => {
  const boss$ = await open(browser, boss)
  await boss$.page.goto('/admin?tab=activities')
  const toggle = boss$.page.getByTestId('activities-admin-toggle-drawinphone')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const row = await must('app', admin.from('activity_apps').select('enabled').eq('id', 'drawinphone').single())
  expect(row.data!.enabled).toBe(false)

  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await expect(a.page.locator('.dm-header, [class*="header"]').first()).toBeVisible()
  await expect(a.page.getByTestId('play-together-button')).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await boss$.context.close()
  await a.context.close()
})

test('a call plays DrawinPhone on its stage, and the frame takes input over the call view', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await open(browser, alice)
  const b = await open(browser, bob)

  await openChannel(a.page, server.id, server.generalChannelId)
  await enterCall(a.page, alice, false)
  await a.page.getByTestId('dock-play-together-button').click()
  await a.page.getByTestId('play-together-app-drawinphone').click()

  // The call view opens with the game on its stage.
  const stage = a.page.locator('.voice-overlay [data-testid="play-together-panel"]')
  await expect(stage).toBeVisible()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })

  // Bob is in the call: the stage banner offers the game.
  await openChannel(b.page, server.id, server.generalChannelId)
  await enterCall(b.page, bob, true)
  await b.page.locator('.voice-overlay').getByTestId('play-together-join').click()
  await expect(game(b.page).getByTestId('dp-player')).toHaveCount(2, { timeout: 30_000 })
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(2)

  // The call view makes the rest of the page inert; the game must still take clicks and keys.
  await game(a.page).getByTestId('dp-start').click()
  await game(a.page).getByTestId('dp-prompt-input').fill('a duck conducting an orchestra')
  await expect(game(a.page).getByTestId('dp-prompt-input')).toHaveValue('a duck conducting an orchestra')
  await expect(game(b.page).getByTestId('dp-prompt-input')).toBeVisible()

  const row = await must('session', admin.from('activity_sessions').select('context, status').eq('channel_id', voiceId).eq('status', 'active').single())
  expect(row.data!.context).toBe('voice')

  await a.page.getByTestId('play-together-end').click()
  await expect(b.page.getByTestId('play-together-status')).toHaveText(/Ended/)
  await a.context.close()
  await b.context.close()
})

/**
 * A minimal package: the activity protocol by hand (activities/sdk/protocol.ts), greeting every
 * member it hears of. It asks to save an image once on init, without a click, and again from its
 * button; pkg-saved lists each answer.
 */
async function testPackage(): Promise<{ zip: Buffer; entrySha: string }> {
  const app = `(() => {
    const names = new Map()
    const out = document.createElement('div')
    out.setAttribute('data-testid', 'pkg-hello')
    document.body.appendChild(out)
    const show = () => { out.textContent = 'Hello ' + [...names.values()].join(', ') }
    const saved = document.createElement('div')
    saved.setAttribute('data-testid', 'pkg-saved')
    document.body.appendChild(saved)
    const asked = new Map()
    const save = (label) => {
      const id = asked.size + 1
      asked.set(id, label)
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
      parent.postMessage({ hp: 1, t: 'save', id, blob: new Blob([png], { type: 'image/png' }), name: 'tictac' }, '*')
    }
    const button = document.createElement('button')
    button.setAttribute('data-testid', 'pkg-save')
    button.textContent = 'Save'
    button.onclick = () => save('click')
    document.body.appendChild(button)
    addEventListener('message', (event) => {
      const m = event.data
      if (!m || m.hp !== 1) return
      if (m.t === 'init') { for (const member of m.members) names.set(member.id, member.name); show(); save('auto') }
      if (m.t === 'join') { names.set(m.member.id, m.member.name); show() }
      if (m.t === 'saved') saved.textContent += asked.get(m.id) + ':' + m.ok + ' '
    })
    parent.postMessage({ hp: 1, t: 'ready', sdk: 'test' }, '*')
  })()`
  const zip = new JSZip()
  zip.file('tictac/manifest.json', JSON.stringify({
    id: 'tictac', name: 'Tic Tac', version: '1.0.0', description: 'Noughts and crosses, from a package',
    minPlayers: 2, maxPlayers: 2, contexts: ['direct', 'group'], icon: 'icon.svg', accent: '#7C3AED', entry: 'app.js',
  }))
  zip.file('tictac/app.js', app)
  zip.file('tictac/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#7C3AED"/></svg>')
  return { zip: await zip.generateAsync({ type: 'nodebuffer' }), entrySha: createHash('sha256').update(app).digest('hex') }
}

test('an admin installs an activity package, switches it on, and a member plays it', async ({ browser }) => {
  test.setTimeout(120_000)
  const { zip, entrySha } = await testPackage()
  const boss$ = await open(browser, boss)
  await boss$.page.goto('/admin?tab=activities')

  await boss$.page.getByTestId('activities-admin-file').setInputFiles({ name: 'tictac.zip', mimeType: 'application/zip', buffer: zip })
  const preview = boss$.page.getByTestId('activities-admin-preview')
  await expect(preview).toContainText('Tic Tac')
  await expect(preview).toContainText(createHash('sha256').update(zip).digest('hex'))
  await boss$.page.getByTestId('activities-admin-install-confirm').click()

  const toggle = boss$.page.getByTestId('activities-admin-toggle-tictac')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // The stored script is served sandboxed, at its hash.
  const served = await fetch(`${backend.url}/activities/pkg/tictac/${entrySha}.js`)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")

  // Third-party label: on the package, not the built-in.
  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await a.page.getByTestId('play-together-button').click()
  await expect(a.page.getByTestId('play-together-third-party-tictac')).toHaveText('Third-party')
  await expect(a.page.getByTestId('play-together-third-party-drawinphone')).toHaveCount(0)
  await a.page.getByTestId('play-together-app-tictac').click()
  await expect(game(a.page).getByTestId('pkg-hello')).toContainText(alice.displayName, { timeout: 30_000 })
  await expect(a.page.getByTestId('play-together-third-party')).toContainText('Harmony never asks for your password')

  // A save without a click in the frame is refused; one from a click downloads.
  await expect(game(a.page).getByTestId('pkg-saved')).toHaveText('auto:false')
  const download = a.page.waitForEvent('download')
  await game(a.page).getByTestId('pkg-save').click()
  expect((await download).suggestedFilename()).toBe('tictac.png')
  await expect(game(a.page).getByTestId('pkg-saved')).toHaveText('auto:false click:true')

  // Bob sees the label on the Join banner before joining.
  const b = await open(browser, bob)
  await b.page.goto(`/dm/${dm}`)
  await expect(b.page.getByTestId('play-together-banner')).toBeVisible({ timeout: 30_000 })
  await expect(b.page.getByTestId('play-together-banner-third-party')).toHaveText('Third-party')
  await b.context.close()

  await a.page.getByTestId('play-together-end').click()

  // Removing it ends its sessions and takes it out of the launcher.
  await boss$.page.getByTestId('activities-admin-remove-tictac').click()
  await boss$.page.getByTestId('activities-admin-remove-tictac').click()
  await expect(boss$.page.getByTestId('activities-admin-tictac')).toHaveCount(0)
  const row = await admin.from('activity_apps').select('id').eq('id', 'tictac')
  expect(row.data).toEqual([])

  await boss$.context.close()
  await a.context.close()
})
