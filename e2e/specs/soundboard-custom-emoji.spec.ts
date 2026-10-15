// Journey: custom emoji on soundboard sounds (20261016100002_soundboard_custom_emoji.sql).
//
// A server owner opens Server Settings > Soundboard, edits a sound and picks a custom emoji of
// the server from the emoji picker, then uploads a new sound with the same emoji. The rows
// store emoji_id in place of the unicode emoji. In a voice channel of the server the
// soundboard shows both emoji as images, as does the play indicator after a play; in a voice
// channel of another server, the server's section, read through list_soundboard_library,
// shows them too. Removing the emoji brings back the speaker.
//
// The stack has no LiveKit: the voice store is set as a joined call leaves it. The emoji image
// is the dev server's own file; the uploaded clip is a built-in one.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const IMAGE_URL = `${process.env.BASE_URL || 'http://localhost:5173'}/default_server.webp`
const CLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/assets/sounds/soundboard/ding.mp3')

let owner: SpecUser
let home: SeededServer
let echo: SeededServer
let homeVoice: string
let echoVoice: string
let emojiId: string
let emojiName: string
let doorbellId: string

async function addVoiceChannel(server: SeededServer): Promise<string> {
  const { data, error } = await admin.from('channels').insert({ server_id: server.id, name: 'lounge', type: 1 }).select('id').single()
  if (error || !data) throw new Error(`voice channel: ${error?.message}`)
  return data.id
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'sbce')
  home = await seedServer(admin, owner, `Home ${owner.username}`)
  echo = await seedServer(admin, owner, `Echo ${owner.username}`)
  homeVoice = await addVoiceChannel(home)
  echoVoice = await addVoiceChannel(echo)

  emojiName = `blob${owner.username.replace(/[^a-z0-9]/gi, '').slice(-8)}`
  const { data: emoji, error: emojiError } = await admin
    .from('emojis')
    .insert({ name: emojiName, url: IMAGE_URL, server_id: home.id, scope: 'server', uploader: owner.id })
    .select('id')
    .single()
  if (emojiError || !emoji) throw new Error(`emoji: ${emojiError?.message}`)
  emojiId = emoji.id

  // Service-role inserts skip the client guard that wants the file in the soundboard bucket.
  const { data: sound, error } = await admin
    .from('server_sounds')
    .insert({
      server_id: home.id,
      name: 'Doorbell',
      emoji: '🔔',
      volume: 0.8,
      duration_ms: 1200,
      storage_path: `${home.id}/${crypto.randomUUID()}.mp3`,
    })
    .select('id')
    .single()
  if (error || !sound) throw new Error(`sound: ${error?.message}`)
  doorbellId = sound.id
})

test.afterAll(async () => {
  await admin.from('emojis').delete().eq('id', emojiId)
  await deleteUser(admin, owner)
})

/** The voice store as a joined call leaves it. */
async function enterVoice(page: Page, serverId: string, channelId: string, userId: string): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'lounge'
      state.localState.userId = userId
    })
  }, { serverId, channelId, userId })
}

async function openSoundboard(page: Page) {
  const button = page.locator('.unified-voice-dock .soundboard-btn')
  await expect(button).toBeVisible({ timeout: 30000 })
  await button.click()
  const popover = page.locator('.sbp')
  await expect(popover).toBeVisible({ timeout: 10000 })
  return popover
}

/** Opens the emoji picker from `trigger` and picks the server's custom emoji. */
async function pickCustomEmoji(page: Page, trigger: ReturnType<Page['locator']>) {
  await trigger.click()
  const picker = page.locator('[data-testid="emoji-popup"]')
  await expect(picker).toBeVisible({ timeout: 15000 })
  await picker.locator('.search-input').fill(emojiName)
  await picker.locator(`button[aria-label=":${emojiName}:"]`).first().click()
  await expect(picker).toBeHidden({ timeout: 5000 })
}

/** The image renders: loaded, with a size. */
async function expectLoadedImage(image: ReturnType<Page['locator']>) {
  await expect(image).toBeVisible({ timeout: 15000 })
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15000 }).toBe(true)
}

test('a sound manager gives sounds a custom emoji, and the soundboard shows it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, home.id, home.generalChannelId)
  await page.goto(`/server/${home.id}?section=soundboard`)
  const rows = page.locator('[data-testid="soundboard-row"]')
  await expect(rows).toHaveCount(1, { timeout: 30000 })

  await test.step('an edit swaps the unicode emoji for the custom one', async () => {
    await rows.first().locator('[data-testid="soundboard-edit"]').click()
    const emojiButton = rows.first().locator('[data-testid="soundboard-edit-emoji"]')
    await expect(emojiButton).toHaveText('🔔')
    await pickCustomEmoji(page, emojiButton)
    await expect(emojiButton.locator(`img[alt=":${emojiName}:"]`)).toBeVisible()
    await expect(emojiButton).toHaveAttribute('aria-label', `Change emoji (:${emojiName}:)`)

    const saved = page.waitForResponse((r) => r.url().includes('/rest/v1/server_sounds') && r.request().method() === 'PATCH')
    await rows.first().locator('[data-testid="soundboard-edit-save"]').click()
    expect((await saved).ok()).toBe(true)
    await expectLoadedImage(rows.first().locator(`.sound-emoji img[alt=":${emojiName}:"]`))

    const { data } = await admin.from('server_sounds').select('emoji, emoji_id').eq('id', doorbellId).single()
    expect(data).toEqual({ emoji: null, emoji_id: emojiId })
  })

  await test.step('an upload records the custom emoji', async () => {
    await page.locator('[data-testid="soundboard-file"]').setInputFiles(CLIP)
    await expect(page.locator('[data-testid="soundboard-name"]')).toHaveValue('ding', { timeout: 15000 })
    await page.locator('[data-testid="soundboard-name"]').fill('Chime')
    const emojiButton = page.locator('[data-testid="soundboard-emoji-button"]')
    await expect(emojiButton).toHaveAttribute('aria-label', 'Choose an emoji')
    await pickCustomEmoji(page, emojiButton)
    await expect(emojiButton.locator(`img[alt=":${emojiName}:"]`)).toBeVisible()
    await page.locator('[data-testid="soundboard-upload-submit"]').click()
    await expect(rows).toHaveCount(2, { timeout: 30000 })
    await expect(rows.nth(1).locator('.sound-name')).toHaveText('Chime')
    await expect(rows.nth(1).locator(`.sound-emoji img[alt=":${emojiName}:"]`)).toBeVisible()

    const { data } = await admin.from('server_sounds').select('emoji, emoji_id').eq('server_id', home.id).eq('name', 'Chime').single()
    expect(data).toEqual({ emoji: null, emoji_id: emojiId })
  })

  await test.step('the soundboard shows the custom emoji as an image, and so does a play', async () => {
    await openChannel(page, home.id, home.generalChannelId)
    await enterVoice(page, home.id, homeVoice, owner.id)
    const popover = await openSoundboard(page)
    const tiles = popover.locator('[data-testid="soundboard-section-server"] [data-testid="soundboard-tile"]')
    await expect(tiles).toHaveText(['Doorbell', 'Chime'], { timeout: 15000 })
    for (const tile of [tiles.nth(0), tiles.nth(1)]) {
      await expectLoadedImage(tile.locator(`.sbp-emoji img[alt=":${emojiName}:"]`))
    }
    await tiles.nth(0).click()
    await expectLoadedImage(page.locator('.sba-item').filter({ hasText: 'Doorbell' }).locator(`img[alt=":${emojiName}:"]`))
    await popover.press('Escape')
    await expect(popover).toBeHidden()
  })

  await test.step('another server\'s soundboard lists them with the image too', async () => {
    await enterVoice(page, echo.id, echoVoice, owner.id)
    const popover = await openSoundboard(page)
    const section = popover.locator(`[data-testid="soundboard-section-external"][data-server-id="${home.id}"]`)
    await expect(section).toBeVisible({ timeout: 30000 })
    await expect(section.locator(`.sbp-emoji img[alt=":${emojiName}:"]`)).toHaveCount(2)
    await expectLoadedImage(section.locator(`.sbp-emoji img[alt=":${emojiName}:"]`).first())
    await popover.press('Escape')
    await expect(popover).toBeHidden()
  })

  await test.step('removing the emoji brings back the speaker', async () => {
    await page.goto(`/server/${home.id}?section=soundboard`)
    await expect(rows).toHaveCount(2, { timeout: 30000 })
    await rows.first().locator('[data-testid="soundboard-edit"]').click()
    await rows.first().locator('[data-testid="soundboard-edit-emoji-clear"]').click()
    await expect(rows.first().locator('[data-testid="soundboard-edit-emoji"]')).toHaveText('🔊')
    await rows.first().locator('[data-testid="soundboard-edit-save"]').click()
    await expect(rows.first().locator('.sound-emoji')).toHaveText('🔊')
    await expect(rows.first().locator('.sound-emoji img')).toHaveCount(0)
    await expect
      .poll(async () => (await admin.from('server_sounds').select('emoji, emoji_id').eq('id', doorbellId).single()).data)
      .toEqual({ emoji: null, emoji_id: null })
  })
})
