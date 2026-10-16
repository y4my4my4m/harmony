// Journey: saving an edit closes the editor and shows the new text at once, marked as being
// saved, while the request is still on its way; the stored row takes over when it answers. A
// refused edit puts the old text back on the row, reopens the editor with the attempted text,
// and says why.
//
// The PATCH is held, then released, at the network (page.route).

import { test, expect, type Page, type Route } from '@playwright/test'
import {
  adminClient,
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

test.beforeAll(async () => {
  owner = await createUser(admin, 'edto')
  server = await seedServer(admin, owner, `Edits ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })

/** Opens the editor of the row through its menu and replaces the text with `text`. */
async function editTo(page: Page, original: string, text: string): Promise<void> {
  const row = rowOf(page, original)
  await row.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Message options' })
  await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
  await page.keyboard.press('Enter')
  const editor = row.getByRole('textbox', { name: 'Edit message' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
}

/** Holds message PATCHes until the returned function is called; `answer` replaces the response. */
async function holdEdits(page: Page, answer?: (route: Route) => Promise<void>): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/messages*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await released
    if (answer) await answer(route)
    else await route.continue()
  })
  return release
}

async function storedText(messageId: string): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('id', messageId).single()
  return JSON.stringify(data?.content ?? null)
}

test('an edit shows at once and the stored row takes over when the server answers', async ({ page }) => {
  test.setTimeout(120_000)
  const original = `before ${owner.username}`
  const edited = `after ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const sent = await sendMessage(page, original)
  const messageId = (await sent.getAttribute('data-message-id'))!

  const release = await holdEdits(page)
  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/rest/v1/messages'))
  await editTo(page, original, edited)
  await page.keyboard.press('Enter')

  await test.step('the editor closes and the new text shows, being saved, before the server answers', async () => {
    const row = rowOf(page, edited)
    await expect(row.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('edit-pending')).toBeVisible()
    await expect(rowOf(page, original)).toHaveCount(0)
    expect(await storedText(messageId)).toContain(original)
  })

  await test.step('the answer clears the pending mark and the edit is stored', async () => {
    release()
    expect((await patched).ok()).toBe(true)
    const row = rowOf(page, edited)
    await expect(row.getByTestId('edit-pending')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-message-id', messageId)
    expect(await storedText(messageId)).toContain(edited)
  })
})

test('a refused edit restores the old text, reopens the editor with the attempt and says why', async ({ page }) => {
  test.setTimeout(120_000)
  const original = `keep ${owner.username}`
  const attempted = `lost ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const sent = await sendMessage(page, original)
  const messageId = (await sent.getAttribute('data-message-id'))!

  const release = await holdEdits(page, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'XX000', message: 'database unavailable', details: null, hint: null }),
  }))
  await editTo(page, original, attempted)
  await page.keyboard.press('Enter')
  await expect(rowOf(page, attempted).getByTestId('edit-pending')).toBeVisible()

  release()
  const row = messageList(page).locator(`[data-message-id="${messageId}"]`)

  await test.step('the editor is open again with the attempted text, and a toast says the edit was not saved', async () => {
    const editor = row.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeVisible({ timeout: 15000 })
    await expect(editor).toContainText(attempted)
    await expect(page.locator('.Vue-Toastification__toast--error').filter({ hasText: 'Your edit was not saved' }))
      .toBeVisible()
  })

  await test.step('closing the editor shows the stored text, no longer pending', async () => {
    await page.keyboard.press('Escape')
    await expect(row.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    await expect(row).toContainText(original)
    await expect(row).not.toContainText(attempted)
    await expect(row.getByTestId('edit-pending')).toHaveCount(0)
    expect(await storedText(messageId)).toContain(original)
  })
})

test('a thread reply is edited the same way', async ({ page }) => {
  test.setTimeout(150_000)
  const name = `Edits ${owner.username.slice(-4)}`
  const reply = `reply ${owner.username}`
  const edited = `reply edited ${owner.username}`
  const panel = page.locator('.thread-panel')
  const panelRow = (text: string) => panel.locator('[data-testid="message-list"]').getByRole('article').filter({ hasText: text })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('.new-thread-btn').click()
  await modal.locator('#new-thread-name').fill(name)
  await modal.locator('.new-thread-submit').click()
  await expect(panel).toBeVisible({ timeout: 15000 })

  const input = panel.locator('[data-testid="message-input"] .rich-text-editor')
  await input.click()
  await input.pressSequentially(reply, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = panelRow(reply)
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  const messageId = (await posted.getAttribute('data-message-id'))!

  const release = await holdEdits(page)
  await posted.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Edit message' }).focus()
  await page.keyboard.press('Enter')
  await expect(posted.getByRole('textbox', { name: 'Edit message' })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(edited)
  await page.keyboard.press('Enter')

  await expect(panelRow(edited).getByTestId('edit-pending')).toBeVisible()
  release()
  await expect(panelRow(edited).getByTestId('edit-pending')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => storedText(messageId)).toContain(edited)
})
