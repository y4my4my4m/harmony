// Journey: a thread's unsent draft, text and attachments, stays with that thread. In the full
// thread view a sidebar thread opens, it survives a trip to another channel, a switch to another
// thread and a reload; the other thread never shows it, and sending empties it. In the side panel,
// the draft of a thread not created yet stays with its starter message through a close and reopen,
// and the first send takes it into the new thread.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const marker = Date.now().toString(36).slice(-6)
const THREAD_A = `Drafted ${marker}`
const THREAD_B = `Other ${marker}`
const STARTER = `Starter for later ${marker}`
let owner: SpecUser
let server: SeededServer
let elsewhereId = ''
let threadA = ''
let threadB = ''

const freshFile = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} ${Date.now()} ${Math.random()}\n`) })
const threadRow = (page: Page, name: string) => page.locator('[data-nav-kind="thread"]').filter({ hasText: name })
const editorIn = (scope: Locator) => scope.locator('[data-testid="message-input"] .rich-text-editor')
const previewsIn = (scope: Locator) => scope.getByTestId('file-preview-item')
const textIn = async (scope: Locator) => (await editorIn(scope).innerText()).replace(/\u00a0/g, ' ').trim()

async function startThread(name: string): Promise<string> {
  const client = await userClient(owner)
  const made = await client.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: name, p_auto_archive_duration: 1440 })
  if (made.error) throw new Error(made.error.message)
  const id = made.data as string
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: id, user_id: owner.id,
    content: [{ type: 'text', text: `first in ${name}` }],
  })
  if (posted.error) throw new Error(posted.error.message)
  return id
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'tdr')
  server = await seedServer(admin, owner, `Thread drafts ${marker}`)
  elsewhereId = await addChannel(admin, server, 'elsewhere')
  threadA = await startThread(THREAD_A)
  threadB = await startThread(THREAD_B)
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: STARTER }],
  })
  if (posted.error) throw new Error(posted.error.message)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  if (owner) await deleteUser(admin, owner)
})

test('the full thread view keeps its draft through a channel, another thread and a reload', async ({ page }) => {
  test.setTimeout(180_000)
  const view = page.locator('.thread-full-view')
  const text = `half a thought ${marker}`

  const openFromSidebar = async (name: string, id: string) => {
    await threadRow(page, name).click()
    await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${id}$`), { timeout: 15000 })
    await expect(view.locator('.thread-title')).toHaveText(name, { timeout: 15000 })
    await expect(editorIn(view)).toBeVisible({ timeout: 15000 })
  }

  await test.step('type and attach in a thread opened from the sidebar', async () => {
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await expect(threadRow(page, THREAD_A)).toBeVisible({ timeout: 30000 })
    await openFromSidebar(THREAD_A, threadA)
    await view.getByTestId('composer-file-input').setInputFiles(freshFile('notes.txt'))
    await expect(previewsIn(view).filter({ hasText: 'notes.txt' })).toContainText('Uploaded', { timeout: 15000 })
    await editorIn(view).click()
    await editorIn(view).pressSequentially(text, { delay: 10 })
    await expect.poll(() => textIn(view)).toBe(text)
  })

  await test.step('another channel and back: the draft is there', async () => {
    await channelRow(page, 'elsewhere').click()
    await page.waitForURL(new RegExp(`${elsewhereId}$`), { timeout: 15000 })
    await expect(previewsIn(page.locator('body'))).toHaveCount(0)
    await openFromSidebar(THREAD_A, threadA)
    await expect(previewsIn(view).filter({ hasText: 'notes.txt' })).toContainText('Uploaded')
    await expect.poll(() => textIn(view)).toBe(text)
  })

  await test.step('another thread shows its own empty draft; the first keeps its own', async () => {
    await openFromSidebar(THREAD_B, threadB)
    await expect(previewsIn(view)).toHaveCount(0)
    await expect.poll(() => textIn(view)).toBe('')
    await openFromSidebar(THREAD_A, threadA)
    await expect(previewsIn(view).filter({ hasText: 'notes.txt' })).toContainText('Uploaded')
    await expect.poll(() => textIn(view)).toBe(text)
  })

  await test.step('a reload keeps text and the finished upload', async () => {
    await page.reload()
    await dismissAnnouncements(page)
    await expect(view.locator('.thread-title')).toHaveText(THREAD_A, { timeout: 30000 })
    await expect(previewsIn(view).filter({ hasText: 'notes.txt' })).toBeVisible({ timeout: 15000 })
    await expect.poll(() => textIn(view), { timeout: 15000 }).toBe(text)
  })

  await test.step('sending takes the draft with it and leaves it empty', async () => {
    await editorIn(view).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const posted = view.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).toContainText('notes.txt')
    await expect(previewsIn(view)).toHaveCount(0)
    await expect.poll(() => textIn(view)).toBe('')

    await channelRow(page, 'elsewhere').click()
    await page.waitForURL(new RegExp(`${elsewhereId}$`), { timeout: 15000 })
    await openFromSidebar(THREAD_A, threadA)
    await expect(previewsIn(view)).toHaveCount(0)
    await expect.poll(() => textIn(view)).toBe('')
  })
})

test('a thread not created yet keeps its draft with its starter message', async ({ page }) => {
  test.setTimeout(180_000)
  const panel = page.locator('.thread-panel')
  const text = `opening words ${marker}`
  const starterRow = () => page.locator('[data-testid="message-list"]').getByRole('article').filter({ hasText: STARTER }).first()

  const openDraftPanel = async () => {
    const row = starterRow()
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    await row.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(editorIn(panel)).toBeVisible({ timeout: 15000 })
  }
  const closePanel = async () => {
    await panel.locator('.back-btn').click()
    await expect(panel).toBeHidden({ timeout: 15000 })
  }

  await test.step('type and attach in a new thread on a message', async () => {
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await openDraftPanel()
    await expect(panel.locator('.draft-hint')).toBeVisible()
    await panel.getByTestId('composer-file-input').setInputFiles(freshFile('opening.txt'))
    await expect(previewsIn(panel).filter({ hasText: 'opening.txt' })).toContainText('Uploaded', { timeout: 15000 })
    await editorIn(panel).click()
    await editorIn(panel).pressSequentially(text, { delay: 10 })
    await expect.poll(() => textIn(panel)).toBe(text)
  })

  await test.step('closed and opened again on the same message, the draft is there', async () => {
    await closePanel()
    await openDraftPanel()
    await expect(previewsIn(panel).filter({ hasText: 'opening.txt' })).toContainText('Uploaded')
    await expect.poll(() => textIn(panel)).toBe(text)
  })

  await test.step('another channel and back, the draft is still there', async () => {
    await closePanel()
    await channelRow(page, 'elsewhere').click()
    await page.waitForURL(new RegExp(`${elsewhereId}$`), { timeout: 15000 })
    // The general row holds its thread rows; its name is clicked, not its middle.
    await channelRow(page, 'general').locator('.channel-name').getByText('general', { exact: true }).click()
    await page.waitForURL(new RegExp(`${server.generalChannelId}$`), { timeout: 15000 })
    await openDraftPanel()
    await expect(previewsIn(panel).filter({ hasText: 'opening.txt' })).toContainText('Uploaded')
    await expect.poll(() => textIn(panel)).toBe(text)
  })

  await test.step('the first send creates the thread and empties the draft', async () => {
    await editorIn(panel).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const posted = panel.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(posted).toContainText('opening.txt')
    await expect(panel.locator('.draft-hint')).toHaveCount(0)
    await expect(previewsIn(panel)).toHaveCount(0)
    await expect.poll(() => textIn(panel)).toBe('')

    await closePanel()
    await starterRow().locator('.thread-indicator').click()
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })).toBeVisible({ timeout: 30000 })
    await expect(previewsIn(panel)).toHaveCount(0)
    await expect.poll(() => textIn(panel)).toBe('')
  })
})
