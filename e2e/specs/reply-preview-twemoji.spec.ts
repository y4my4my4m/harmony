// Journey: the line above a reply draws default emoji in the selected pack. On Twemoji the preview
// holds the pack's image for each emoji; on the native pack it holds the character.
//
// The pack's SVGs carry a viewBox and no width or height; an unsized <img> of one lays out at
// 300px and raises the reply line to that height. The line stays one text line tall whether the
// emoji is visible or past the ellipsis, and whether the reply is local or a federated copy.

import { randomUUID } from 'node:crypto'
import { test, expect, type Locator } from '@playwright/test'
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
const TRAILING_EMOJI = '🙂'
const REMOTE_DOMAIN = 'replies.example'
let user: SpecUser
let server: SeededServer
const remote = { id: randomUUID(), username: `rpr${marker}` }
const replies = { localTrailing: '', remoteTrailing: '', plain: '' }

async function insert(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('messages').insert(row).select('id').single()
  if (error) throw new Error(error.message)
  return data.id
}

test.beforeAll(async () => {
  user = await createUser(admin, 'rpt')
  server = await seedServer(admin, user, `Reply ${user.username.slice(-6)}`)
  const { error: remoteError } = await admin.from('profiles').insert({
    id: remote.id, username: remote.username, display_name: 'Remote Replier', domain: REMOTE_DOMAIN, is_local: false,
    federated_id: `https://${REMOTE_DOMAIN}/users/${remote.username}`,
    inbox_url: `https://${REMOTE_DOMAIN}/users/${remote.username}/inbox`,
  })
  if (remoteError) throw new Error(`remote profile: ${remoteError.message}`)

  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
  const channel = server.generalChannelId
  const target = await insert({
    channel_id: channel, user_id: user.id, created_at: at(600),
    content: [{ type: 'text', text: `target ${EMOJI} ${marker}` }],
  })
  await insert({
    channel_id: channel, user_id: user.id, reply_to: target, created_at: at(590),
    content: [{ type: 'text', text: `the reply ${marker}` }],
  })

  // Emoji past the preview's ellipsis.
  const trailing = await insert({
    channel_id: channel, user_id: user.id, created_at: at(500),
    content: [{ type: 'text', text: `I was testing out the federated discovery feature and saw this server, decided to join ${TRAILING_EMOJI}` }],
  })
  const plain = await insert({
    channel_id: channel, user_id: user.id, created_at: at(490),
    content: [{ type: 'text', text: `I was testing out the federated discovery feature and saw this server, decided to join ${marker}` }],
  })
  replies.localTrailing = await insert({
    channel_id: channel, user_id: user.id, reply_to: trailing, created_at: at(400),
    content: [{ type: 'text', text: `local reply ${marker}` }],
  })
  replies.remoteTrailing = await insert({
    channel_id: channel, user_id: remote.id, reply_to: trailing, created_at: at(300),
    content: [{ type: 'text', text: `Welcome! ${TRAILING_EMOJI}` }],
    metadata: { federated: true, from_domain: REMOTE_DOMAIN, ap_id: `https://${REMOTE_DOMAIN}/messages/${randomUUID()}` },
  })
  replies.plain = await insert({
    channel_id: channel, user_id: user.id, reply_to: plain, created_at: at(200),
    content: [{ type: 'text', text: `plain reply ${marker}` }],
  })
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, user)
})

test('the reply line uses the selected emoji pack', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const preview = messageList(page).getByTestId('reply-preview').filter({ hasText: 'target' })
  await expect(preview).toContainText(`target`, { timeout: 30000 })

  const image = preview.locator(`img.inline-emoji[alt="${EMOJI}"]`)
  await expect(image).toHaveCount(1, { timeout: 30000 })
  await expect(image).toHaveAttribute('src', /twemoji/)
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  expect(await preview.innerText()).not.toContain(EMOJI)
})

test('an emoji in the replied-to text keeps the reply line one text line tall', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const list = messageList(page)
  const line = (replyId: string): Locator => list.locator(`#msg-reply-${replyId}`)
  for (const id of Object.values(replies)) await line(id).scrollIntoViewIfNeeded()

  const emojiImage = (replyId: string) => line(replyId).locator(`img.inline-emoji[alt="${TRAILING_EMOJI}"]`)
  for (const id of [replies.localTrailing, replies.remoteTrailing]) {
    await expect(emojiImage(id)).toHaveCount(1, { timeout: 30000 })
    await expect.poll(() => emojiImage(id).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  }
  await expect(line(replies.plain).getByTestId('reply-preview')).toContainText(marker, { timeout: 30000 })

  const fontSize = await line(replies.plain).getByTestId('reply-preview')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const height = async (locator: Locator) => (await locator.boundingBox())?.height ?? Number.NaN
  const plainHeight = await height(line(replies.plain))
  expect(plainHeight).toBeLessThan(fontSize * 3)

  for (const id of [replies.localTrailing, replies.remoteTrailing]) {
    expect(await height(emojiImage(id))).toBeLessThanOrEqual(fontSize * 1.5)
    expect(Math.abs((await height(line(id))) - plainHeight)).toBeLessThanOrEqual(1)
  }
})
