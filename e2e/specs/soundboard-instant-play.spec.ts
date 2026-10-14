// Journey: a soundboard sound is ready before its first click. Joining a call fetches and
// decodes the built-in clips; clicking one then plays it from memory, through Web Audio,
// with no fetch and no <audio> element. Each click used to build an element that loaded the
// clip before it could start.
//
// The stack has no LiveKit: the voice store is set as a joined call leaves it
// (soundboard-external-sounds.spec.ts does the same). The built-in clips are the dev
// server's own files.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let voiceId: string

test.beforeAll(async () => {
  user = await createUser(admin, 'sbi')
  server = await seedServer(admin, user, `Instant ${user.username}`)
  const { data, error } = await admin.from('channels').insert({ server_id: server.id, name: 'lounge', type: 1 }).select('id').single()
  if (error || !data) throw new Error(`voice channel: ${error?.message}`)
  voiceId = data.id
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function enterVoice(page: Page) {
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
  }, { serverId: server.id, channelId: voiceId, userId: user.id })
}

test('a built-in sound plays from memory on its first click', async ({ page }) => {
  test.setTimeout(120_000)
  const clipRequests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/assets/sounds/soundboard/')) clipRequests.push(new URL(r.url()).pathname)
  })

  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)

  // Counts elements built for playback and buffers started through Web Audio.
  await page.evaluate(() => {
    const w = window as unknown as { __audioElements: number; __bufferStarts: number; Audio: typeof Audio }
    w.__audioElements = 0
    w.__bufferStarts = 0
    const NativeAudio = w.Audio
    w.Audio = function (...args: ConstructorParameters<typeof Audio>) {
      w.__audioElements++
      return new NativeAudio(...args)
    } as unknown as typeof Audio
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<AudioBufferSourceNode['start']>) {
      w.__bufferStarts++
      return start.apply(this, args)
    }
  })

  await test.step('joining the call fetches the built-in clips', async () => {
    await enterVoice(page)
    await expect.poll(() => clipRequests.includes('/assets/sounds/soundboard/ding.mp3'), { timeout: 30000 }).toBe(true)
    // Decoding runs one clip at a time while the page is idle.
    await expect.poll(() => new Set(clipRequests).size, { timeout: 30000 }).toBe(10)
  })

  await test.step('a click plays the clip from memory', async () => {
    const button = page.locator('.unified-voice-dock .soundboard-btn')
    await expect(button).toBeVisible({ timeout: 30000 })
    await button.click()
    const popover = page.locator('.sbp')
    await expect(popover).toBeVisible({ timeout: 10000 })
    const fetchedBefore = clipRequests.length
    await popover.locator('[data-testid="soundboard-tile"]').filter({ hasText: 'Ding' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __bufferStarts: number }).__bufferStarts)).toBe(1)
    expect(await page.evaluate(() => (window as unknown as { __audioElements: number }).__audioElements)).toBe(0)
    expect(clipRequests.length).toBe(fetchedBefore)
  })
})
