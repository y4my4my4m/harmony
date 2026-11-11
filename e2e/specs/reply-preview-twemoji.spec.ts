// Journey: the line above a reply draws default emoji in the selected pack. On Twemoji the preview
// holds the pack's image for each emoji; on the native pack it holds the character.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const marker = Date.now().toString(36).slice(-6)
const EMOJI = '😀'
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'rpt')
  server = await seedServer(admin, user, `Reply ${user.username.slice(-6)}`)
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `target ${EMOJI} ${marker}` }],
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }).select('id').single()
  if (error) throw new Error(error.message)
  const reply = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    reply_to: data.id,
    content: [{ type: 'text', text: `the reply ${marker}` }],
  })
  if (reply.error) throw new Error(reply.error.message)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, user)
})

test('the reply line uses the selected emoji pack', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const preview = messageList(page).getByTestId('reply-preview')
  await expect(preview).toContainText(`target`, { timeout: 30000 })

  const image = preview.locator(`img.inline-emoji[alt="${EMOJI}"]`)
  await expect(image).toHaveCount(1, { timeout: 30000 })
  await expect(image).toHaveAttribute('src', /twemoji/)
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  expect(await preview.innerText()).not.toContain(EMOJI)
})
