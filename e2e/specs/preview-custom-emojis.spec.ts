// Journey: custom emojis in the one-line previews of messages and posts. The inbox draws those of the
// message a notification is about, also when the message is emojis alone, though the preview the server
// stored holds none; a deleted message keeps the stored text. The line above a reply in the social feed
// draws the parent's. The line above a chat reply: reply-preview-twemoji.spec.ts.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { addMember, adminClient, createUser, deleteUser, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
const marker = Date.now().toString(36).slice(-6)
const REMOTE_DOMAIN = `emoji${marker}.example`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const emoji = (name: string) => ({ type: 'emoji', emoji: { id: randomUUID(), name, url: `https://${REMOTE_DOMAIN}/emoji/${name}.png` } })
const text = (value: string) => ({ type: 'text', text: value })
const parentAuthor = { id: randomUUID(), username: `far${marker}` }
let reader: SpecUser
let writer: SpecUser
let server: SeededServer
let dm = ''

async function must<T>(what: string, result: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await result
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

async function drawn(page: Page): Promise<string[]> {
  const asked: string[] = []
  await page.route(`https://${REMOTE_DOMAIN}/emoji/*`, (route) => {
    asked.push(route.request().url())
    return route.fulfill({ contentType: 'image/png', body: PNG })
  })
  return asked
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'pver')
  writer = await createUser(admin, 'pvew')
  server = await seedServer(admin, writer, `Previews ${marker}`)
  await addMember(admin, reader, server.id)
  dm = (await must('conversation', admin.from('conversations').insert({ type: 'direct', created_by: writer.id }).select('id').single()) as { id: string }).id
  await must('participants', admin.from('conversation_participants').insert([{ conversation_id: dm, user_id: writer.id }, { conversation_id: dm, user_id: reader.id }]))
  await must('remote profile', admin.from('profiles').insert({
    id: parentAuthor.id, username: parentAuthor.username, display_name: 'Far Away', domain: REMOTE_DOMAIN, is_local: false,
    federated_id: `https://${REMOTE_DOMAIN}/users/${parentAuthor.username}`, inbox_url: `https://${REMOTE_DOMAIN}/inbox`,
  }))
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [writer?.id, parentAuthor.id].filter(Boolean))
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await admin.from('conversations').delete().eq('id', dm)
  await admin.from('profiles').delete().eq('id', parentAuthor.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, writer)
})

test('the inbox draws the custom emojis of a message', async ({ page }) => {
  test.setTimeout(120_000)
  // As the federation backend stores them: a client's emoji part of another instance is stored as its name.
  const mention = { type: 'mention', userId: reader.id, username: reader.username }
  const send = (row: Record<string, unknown>) => must('message', admin.from('messages').insert({ user_id: writer.id, ...row }).select('id').single()) as Promise<{ id: string }>
  await send({ channel_id: server.generalChannelId, content: [mention, text(` lets update ${marker} `), emoji('pog')] })
  const gone = await send({ channel_id: server.generalChannelId, content: [mention, text(` taken back ${marker} `), emoji('gone')] })
  await must('delete', admin.from('messages').update({ is_deleted: true }).eq('id', gone.id))
  await send({ conversation_id: dm, content: [emoji('wave'), emoji('party')] })
  const stored = await must('notifications', admin.from('notifications').select('type, data').eq('user_id', reader.id)) as { type: string; data: any }[]
  expect(JSON.stringify(stored), 'the server stores no emoji').not.toMatch(/pog|wave/)

  const asked = await drawn(page)
  const reads: string[] = []
  page.on('request', (request) => { if (/\/rest\/v1\/messages\?.*content=cs\./.test(request.url())) reads.push(request.url()) })
  await signIn(page, reader)
  await page.locator('[data-testid="notification-bell"]').first().click()
  const previews = page.locator('[data-testid="notification-panel"] [data-testid="notification-preview"]')

  const mentioned = previews.filter({ hasText: `lets update ${marker}` })
  await expect(mentioned.locator('img[alt=":pog:"]')).toHaveCount(1, { timeout: 30_000 })
  expect(await mentioned.innerText()).not.toContain(':pog:')
  await expect.poll(() => mentioned.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  const alone = previews.filter({ has: page.locator('img[alt=":wave:"]') })
  await expect(alone.locator('img')).toHaveCount(2)
  await expect(alone).not.toContainText('New message')
  const deleted = previews.filter({ hasText: `taken back ${marker}` })
  await expect(deleted).toBeVisible()
  await expect(deleted.locator('img')).toHaveCount(0)
  expect(asked.some((url) => url.endsWith('/gone.png'))).toBe(false)
  expect(reads, 'one read for the whole inbox').toHaveLength(1)
})

test('the line above a social reply draws the parent\'s custom emojis', async ({ page }) => {
  test.setTimeout(180_000)
  const parent = await must('parent', admin.from('posts').insert({
    author_id: parentAuthor.id, visibility: 'public', is_local: false, ap_id: `https://${REMOTE_DOMAIN}/posts/${marker}`,
    content: [text(`a parent ${marker} `), emoji('blob')], created_at: new Date(Date.now() - 120_000).toISOString(),
  }).select('id').single()) as { id: string }
  await must('reply', admin.from('posts').insert({
    author_id: writer.id, visibility: 'public', is_local: true, in_reply_to: parent.id, content: [text(`local answer ${marker}`)],
  }).select('id').single())

  await drawn(page)
  await signIn(page, reader)
  await page.goto('/social/local')
  const line = page.locator('article[data-testid="post-item"]').filter({ hasText: `local answer ${marker}` }).getByTestId('post-reply-context')
  await expect(line).toContainText(`a parent ${marker}`, { timeout: 90_000 })
  await expect(line.locator('img[alt=":blob:"]')).toHaveCount(1)
  expect(await line.innerText()).not.toContain(':blob:')
  await expect(line).toHaveAccessibleName(new RegExp(`Replying to Far Away a parent ${marker} :blob:`))
})
