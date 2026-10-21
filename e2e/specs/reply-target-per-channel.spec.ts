// Journey: a reply belongs to its channel. Starting a reply in one channel and moving to another
// leaves the second channel's composer without the reply bar, and a message sent there is stored
// as an ordinary message. The server refuses a reply that names another channel's message
// (REPLY_OUT_OF_SCOPE), so a reply target carried across channels lost every message sent with it.

import { test, expect } from '@playwright/test'
import {
  addChannel,
  adminClient,
  channelRow,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let channelA = ''
const B = 'reply-b'

test.beforeAll(async () => {
  owner = await createUser(admin, 'rtc')
  server = await seedServer(admin, owner, `Replies ${owner.username}`)
  channelA = await addChannel(admin, server, 'reply-a')
  await addChannel(admin, server, B)
  const { error } = await admin.from('messages').insert({
    channel_id: channelA,
    user_id: owner.id,
    content: [{ type: 'text', text: 'question in channel A' }],
    created_at: new Date(Date.now() - 60_000).toISOString(),
  })
  if (error) throw new Error(error.message)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

test('a reply started in one channel does not follow to the next', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, channelA)

  const question = messageList(page).locator('.message-item').filter({ hasText: 'question in channel A' }).last()
  await question.hover()
  await question.locator('[data-testid="msg-action-reply"]').click()
  await expect(page.locator('.replyBar')).toBeVisible()

  await channelRow(page, B).click()
  await expect(page.locator('.chat-header .channel-name')).toContainText(B, { timeout: 15000 })
  await expect(page.locator('.replyBar')).toHaveCount(0)

  await expect(composer(page)).toBeVisible()
  const sent = await sendMessage(page, 'hello B')
  await expect(sent.locator('.failed-message-bar')).toHaveCount(0)

  const { data: channelB } = await admin.from('channels').select('id').eq('server_id', server.id).eq('name', B).single()
  const { data: rows, error } = await admin.from('messages').select('reply_to').eq('channel_id', channelB!.id)
  expect(error).toBeNull()
  expect(rows).toEqual([{ reply_to: null }])
})
