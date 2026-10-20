// Journey: real calls over LiveKit: the speaking indicator, the input sensitivity gate,
// the minimized dock's participant list, a voice channel encrypted on its own, and a call
// in an encrypted direct message conversation.
//
// Speaking is detected in the browser from the audio itself (speakingDetector), not from
// the SFU's speaker updates. The LiveKit server here sends speaker updates every 300 s,
// longer than the spec runs, so any speaking indicator can only have come from the
// listener's own analysis of the received track. Both browsers capture synthetic speech
// from Chrome's fake audio device.
//
// The stack has no realtime: the roster each client shows comes from the LiveKit room.

import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'
import { startLiveKit, writeSpeechWav, type LiveKit } from './livekit'
import { setUpEncryption } from './encryption'

const speech = writeSpeechWav()

test.describe.configure({ mode: 'serial' })
test.use({
  serviceWorkers: 'block',
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${speech}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

const SFU_SPEAKER_UPDATE_MS = 300_000

const admin = adminClient()
let liveKit: LiveKit
let backend: Backend
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let lounge: string
let vault: string
let conversation: string

test.beforeAll(async () => {
  test.setTimeout(120_000)
  liveKit = await startLiveKit({ speakerUpdateMs: SFU_SPEAKER_UPDATE_MS })
  backend = await startBackend(liveKit.env)
  alice = await createUser(admin, 'vsa')
  bob = await createUser(admin, 'vsb')
  server = await seedServer(admin, alice, `Voice Speaking ${alice.username}`)
  await addMember(admin, bob, server.id)

  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const voiceChannel = async (name: string) => {
    const { data, error } = await admin
      .from('channels')
      .insert({ server_id: server.id, name, type: 1, category: general?.category ?? null })
      .select('id')
      .single()
    if (error || !data) throw new Error(`voice channel ${name}: ${error?.message}`)
    return data.id as string
  }
  lounge = await voiceChannel('lounge')
  vault = await voiceChannel('vault')
  // Voice encryption on this channel alone; the server encrypts no messages.
  const { error } = await admin
    .from('channel_encryption_settings')
    .upsert({ channel_id: vault, voice_encrypted: true }, { onConflict: 'channel_id' })
  if (error) throw new Error(`vault encryption: ${error.message}`)

  const { data: dm, error: dmError } = await admin.from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single()
  if (dmError || !dm) throw new Error(`conversation: ${dmError?.message}`)
  conversation = dm.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversation, user_id: alice.id },
    { conversation_id: conversation, user_id: bob.id },
  ])
  const { error: dmEncError } = await admin.from('conversation_encryption_settings')
    .insert({ conversation_id: conversation, encryption_enabled: true })
  if (dmEncError) throw new Error(`conversation encryption: ${dmEncError.message}`)
})

test.afterAll(async () => {
  if (conversation) await admin.from('conversations').delete().eq('id', conversation)
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
  await backend?.stop()
  liveKit?.stop()
})

async function openAs(browser: Browser, user: SpecUser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

/** Clicks the voice channel until the dock appears: a click during the sidebar's first render can be lost. */
async function joinVoice(page: Page, channelId: string): Promise<void> {
  const dock = page.locator('[data-testid="dock-mute"]')
  await expect(async () => {
    if (!(await dock.isVisible())) await page.locator(`[data-nav-kind="channel"][data-nav-id="${channelId}"]`).click()
    await expect(dock).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 45_000 })
}

const joinLounge = (page: Page) => joinVoice(page, lounge)

const row = (page: Page, user: SpecUser) => page.locator(`[data-testid="voice-participant-${user.id}"]`)
const speakingAvatar = (page: Page, user: SpecUser) => row(page, user).locator('.speaking')

test('a member who starts talking lights up for the others before the SFU could report it', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await openAs(browser, alice)
  const b = await openAs(browser, bob)

  // The dock appears while the join is still connecting; a mute chosen then holds once it completes.
  await joinLounge(a)
  await a.locator('[data-testid="dock-mute"]').click()
  await joinLounge(b)

  await expect(row(b, alice)).toBeVisible({ timeout: 30_000 })
  await expect(row(a, bob)).toBeVisible({ timeout: 30_000 })
  await expect(a.locator('[data-testid="dock-mute"]')).toHaveAttribute('aria-pressed', 'true')

  // Bob talks and is unmuted: Alice sees him speaking.
  await expect(speakingAvatar(a, bob)).toBeVisible({ timeout: 5_000 })

  // Alice is muted: silent for Bob.
  await expect(speakingAvatar(b, alice)).toHaveCount(0)

  // Unmuted, Alice lights up on Bob's screen and on her own.
  await a.locator('[data-testid="dock-mute"]').click()
  await expect(speakingAvatar(b, alice)).toBeVisible({ timeout: 5_000 })
  await expect(speakingAvatar(a, alice)).toBeVisible({ timeout: 5_000 })

  // Muted again: the indicator clears after the hangover and the 1.2 s display hold.
  await a.locator('[data-testid="dock-mute"]').click()
  await expect(speakingAvatar(b, alice)).toHaveCount(0, { timeout: 6_000 })
  await expect(speakingAvatar(a, alice)).toHaveCount(0, { timeout: 6_000 })

  // Input sensitivity. A manual threshold above her speech closes Alice's gate: unmuted, she
  // sends silence, so Bob's analysis of her track stays quiet. Automatic sends her speech.
  await a.locator('[data-testid="dock-mute"]').click()
  await expect(speakingAvatar(b, alice)).toBeVisible({ timeout: 5_000 })
  await a.locator('.control-btn.settings-btn').click()
  await a.locator('label:has([data-testid="input-sensitivity-manual"])').click()
  await a.locator('[data-testid="input-threshold"]').fill('-10')
  await expect(speakingAvatar(b, alice)).toHaveCount(0, { timeout: 6_000 })
  await expect(speakingAvatar(a, alice)).toHaveCount(0)
  await b.waitForTimeout(2_000)
  await expect(speakingAvatar(b, alice)).toHaveCount(0)
  await expect(a.locator('[data-testid="dock-mute"]')).toHaveAttribute('aria-pressed', 'false')

  await a.locator('label:has([data-testid="input-sensitivity-auto"])').click()
  await expect(speakingAvatar(b, alice)).toBeVisible({ timeout: 5_000 })
  await expect(speakingAvatar(a, alice)).toBeVisible({ timeout: 5_000 })

  await a.context().close()
  await b.context().close()
})

test('the minimized dock opens its participant list between the dock and the tab', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openAs(browser, alice)
  await joinLounge(a)
  await expect(row(a, alice)).toBeVisible({ timeout: 30_000 })

  await a.locator('[data-testid="dock-minimize"]').click()
  const mini = a.locator('.minimized-info')
  await expect(mini).toBeVisible()
  // Away from the default corner, where the tab is not shown.
  const start = (await mini.boundingBox())!
  await a.mouse.move(start.x + 20, start.y + start.height / 2)
  await a.mouse.down()
  await a.mouse.move(start.x + 320, start.y - 260, { steps: 12 })
  await a.mouse.up()

  const toggle = a.locator('[data-testid="mini-participants-toggle"]')
  const list = a.locator('[data-testid="mini-participants-list"]')
  await expect(toggle).toBeVisible()
  const dockBox = (await a.locator('.minimized-container').boundingBox())!
  const closedTab = (await toggle.boundingBox())!
  expect(closedTab.y).toBeGreaterThan(dockBox.y + dockBox.height - 8)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const listRow = list.locator(`[data-testid="voice-participant-${alice.id}"]`)
  await expect(listRow).toBeVisible()
  // Settled: the list shows its row under the dock, and the tab rides the list's bottom edge.
  await expect(a.locator('.participants-reveal-enter-active')).toHaveCount(0)
  const listBox = (await list.boundingBox())!
  const rowBox = (await listRow.boundingBox())!
  const openTab = (await toggle.boundingBox())!
  expect(listBox.y).toBeGreaterThanOrEqual(dockBox.y + dockBox.height - 1)
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(listBox.y + listBox.height)
  expect(Math.abs(openTab.y - (listBox.y + listBox.height))).toBeLessThanOrEqual(2)
  expect(openTab.y).toBeGreaterThan(closedTab.y + rowBox.height)

  await toggle.click()
  await expect(list).toHaveCount(0)
  await expect(async () => {
    expect(Math.abs((await toggle.boundingBox())!.y - closedTab.y)).toBeLessThanOrEqual(1)
  }).toPass({ timeout: 2_000 })

  await a.context().close()
})

test('a voice channel encrypted on its own carries speech between members holding keys', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await openAs(browser, alice)
  await setUpEncryption(a, alice)
  const b = await openAs(browser, bob)
  await setUpEncryption(b, bob)

  await joinVoice(a, vault)
  await joinVoice(b, vault)
  await expect(row(b, alice)).toBeVisible({ timeout: 30_000 })
  await expect(row(a, bob)).toBeVisible({ timeout: 30_000 })

  // Both ends report an end-to-end encrypted room.
  for (const page of [a, b]) {
    await expect(page.locator('.voice-encryption-badge.encrypted').first()).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => {
      const voice = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
      return voice.isEncrypted
    })).toBe(true)
  }

  // Speech decrypts on the far end: Bob's analysis of Alice's track hears her, and hers his.
  await expect(speakingAvatar(b, alice)).toBeVisible({ timeout: 10_000 })
  await expect(speakingAvatar(a, bob)).toBeVisible({ timeout: 10_000 })

  await a.context().close()
  await b.context().close()
})

test('a call in an encrypted direct message conversation is end-to-end encrypted', async ({ browser }) => {
  test.setTimeout(120_000)
  const open = async (user: SpecUser) => {
    const page = await openAs(browser, user)
    await setUpEncryption(page, user)
    await page.goto(`/dm/${conversation}`)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30_000 })
    await setUpEncryption(page, user)
    return page
  }
  const a = await open(alice)
  const b = await open(bob)

  // Joined as an accepted call joins; ringing travels over realtime, which this stack lacks.
  const join = (page: Page) => page.evaluate(async (room) => {
    const voice = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    return voice.joinVoiceChannel(room, 'dm')
  }, `dm-${conversation}`)
  expect(await join(a)).toBe(true)
  expect(await join(b)).toBe(true)

  const callState = (page: Page, other: SpecUser) => page.evaluate((otherId) => {
    const voice = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    const peer = voice.allUsers.find((u: any) => u.userId === otherId)
    return { encrypted: voice.isEncrypted === true, hearsPeer: peer?.isSpeaking === true }
  }, other.id)

  // Keyed through the conversation's Megolm room, and each hears the other's decrypted speech.
  await expect.poll(() => callState(a, bob), { timeout: 20_000 }).toEqual({ encrypted: true, hearsPeer: true })
  await expect.poll(() => callState(b, alice), { timeout: 20_000 }).toEqual({ encrypted: true, hearsPeer: true })
  await expect(b.locator('.voice-encryption-badge.encrypted').first()).toBeVisible()

  await a.context().close()
  await b.context().close()
})
