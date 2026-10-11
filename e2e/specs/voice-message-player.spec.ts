// Journey: a voice message recorded too quietly plays for a keyboard and screen-reader user.
// The player is a named group; its play button and position slider work from the keyboard;
// the clip loads in CORS mode and is measured, which is what lets playback raise a quiet clip.
//
// The stack has no storage: the clip is served by a route at a fixed fixture URL, with the
// Access-Control-Allow-Origin header storage sends.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const CLIP_URL = 'https://fixtures.harmony.test/quiet-voice.webm'
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/quiet-voice.webm'))

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'vmsg')
  server = await seedServer(admin, user, `Voice ${user.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'file', fileType: 'audio', url: CLIP_URL, fileName: 'voice-message.webm' }],
    metadata: { voice_message: { duration: 3, waveform: Array.from({ length: 32 }, (_, i) => (i % 4) / 8 + 0.1) } },
  })
  if (error) throw new Error(`voice message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('a quiet voice message plays from the keyboard and is measured for a boost', async ({ page }) => {
  test.setTimeout(120_000)
  let clipRequests = 0
  await page.route(CLIP_URL, (route) => {
    clipRequests += 1
    return route.fulfill({
      status: 200,
      body: CLIP,
      headers: { 'Content-Type': 'audio/webm', 'Access-Control-Allow-Origin': '*' },
    })
  })

  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)

  const player = page.getByRole('group', { name: 'Voice message' })
  const play = player.getByRole('button', { name: /^Play voice message/ })
  const position = player.getByRole('slider', { name: 'Playback position' })

  await test.step('the player exposes named controls', async () => {
    await expect(play).toBeVisible()
    await expect(play).toHaveAccessibleName('Play voice message, 0:03')
    await expect(position).toHaveAttribute('aria-valuetext', '0:00 of 0:03')
    await expect(player.getByRole('button', { name: 'Playback speed 1x' })).toBeVisible()
  })

  await test.step('Enter on the play button plays the clip through the boost path', async () => {
    await play.focus()
    await page.keyboard.press('Enter')
    await expect(player.getByRole('button', { name: 'Pause voice message' })).toBeVisible()
    // One request for the element, one for the measurement that sets the boost.
    await expect.poll(() => clipRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect(player.getByRole('alert')).toHaveCount(0)
  })

  await test.step('the position slider moves with the keyboard', async () => {
    await page.keyboard.press('Enter')
    await expect(player.getByRole('button', { name: /^Play voice message/ })).toBeVisible()
    await position.focus()
    await page.keyboard.press('End')
    await expect(position).toHaveAttribute('aria-valuenow', '3')
    await page.keyboard.press('Home')
    await expect(position).toHaveAttribute('aria-valuenow', '0')
  })
})
