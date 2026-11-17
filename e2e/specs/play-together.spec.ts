// Journey: play together. Two people in a DM start DrawinPhone, play a whole game in sandboxed
// frames through the federation backend's relay, and the starter ends it for everyone. The frame
// runs in an opaque origin with no storage and no network, and one that navigates itself away is
// cut off. An instance admin turns the app off and the launcher stops offering it.
//
// The backend runs as a child process (backend.ts): page.route() carries the frame document and
// routeWebSocket() bridges the relay socket to it.

import { test, expect, type Browser, type BrowserContext, type FrameLocator, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

test.use({
  serviceWorkers: 'block',
  // route.fulfill() answers the frame document without an address, so Chromium places it in the
  // public address space and Local Network Access refuses its script from localhost. Served by a
  // real host, the frame and its script share one address space.
  launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] },
})
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let alice: SpecUser
let bob: SpecUser
let boss: SpecUser
let dm = ''
let backend: Backend

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
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  await admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone')
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
      socket: await attempt(() => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host || 'localhost'}/`)
        ws.onopen = resolve
        ws.onerror = reject
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
