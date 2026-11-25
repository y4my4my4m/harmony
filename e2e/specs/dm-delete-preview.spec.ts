// Journey: a deleted direct message leaves the conversation list's preview; the message before
// it takes its place, at once on the deleting page and on every later load, for both people.
//
// The e2e stack runs no realtime service: the other person reads the list on a fresh load.
// A federated Delete sets is_deleted and keeps the content; the last step writes that row.

import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

const admin = adminClient()
let author: SpecUser
let reader: SpecUser
let conversationId = ''
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  author = await createUser(admin, 'dpa')
  reader = await createUser(admin, 'dpb')

  const dm = await admin.from('conversations').insert({ type: 'direct', created_by: author.id }).select('id').single()
  if (dm.error) throw new Error(`conversation: ${dm.error.message}`)
  conversationId = dm.data.id
  const parts = await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: author.id },
    { conversation_id: conversationId, user_id: reader.id },
  ])
  if (parts.error) throw new Error(`participants: ${parts.error.message}`)

  const client = await userClient(author)
  for (const text of ['zero preview', 'first preview', 'second preview']) {
    const sent = await client.from('messages')
      .insert({ conversation_id: conversationId, user_id: author.id, content: [{ type: 'text', text }] })
      .select('id').single()
    if (sent.error) throw new Error(`message ${text}: ${sent.error.message}`)
    ids[text] = sent.data.id
  }
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

const listRow = (page: Page): Locator =>
  page.locator(`[data-testid="dm-conversation-item"][data-conversation-id="${conversationId}"]`)
const preview = (page: Page): Locator => listRow(page).locator('.last-message')

async function openList(page: Page, url: string) {
  await page.goto(url)
  await dismissAnnouncements(page)
  await expect(listRow(page)).toHaveCount(1, { timeout: 30000 })
}

test('a deleted message leaves the DM list preview', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, author)

  await test.step('the newest message is the preview', async () => {
    await openList(page, `/dm/${conversationId}`)
    await expect(preview(page)).toHaveText('You: second preview', { timeout: 30000 })
  })

  await test.step('deleting it shows the message before it, without a reload', async () => {
    const row = messageList(page).getByRole('article').filter({ hasText: 'second preview' })
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Delete message' }).click()
    const confirm = page.getByRole('alertdialog')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirm).toBeHidden()
    await expect(row).toHaveCount(0, { timeout: 15000 })
    await expect(preview(page)).toHaveText('You: first preview')
  })

  await test.step('a fresh load of the list agrees', async () => {
    await openList(page, '/dm')
    await expect(preview(page)).toHaveText('You: first preview', { timeout: 30000 })
  })

  const readerContext = await browser.newContext()
  const readerPage = await readerContext.newPage()
  await signIn(readerPage, reader)

  await test.step('so does the other person', async () => {
    await openList(readerPage, '/dm')
    await expect(preview(readerPage)).toHaveText('first preview', { timeout: 30000 })
  })

  await test.step('a delete that keeps the content leaves the preview too', async () => {
    const gone = await admin.from('messages').update({ is_deleted: true }).eq('id', ids['first preview'])
    if (gone.error) throw new Error(`federated-style delete: ${gone.error.message}`)
    await openList(readerPage, '/dm')
    await expect(preview(readerPage)).toHaveText('zero preview', { timeout: 30000 })
    await openList(page, '/dm')
    await expect(preview(page)).toHaveText('You: zero preview', { timeout: 30000 })
  })

  await readerContext.close()
})
