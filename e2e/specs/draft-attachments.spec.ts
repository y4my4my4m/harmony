// Journey: attachments are part of a channel's message draft, as its text is. An image attached
// in one channel stays with that channel through a switch to another channel, a trip to Direct
// messages and a reload, spoiler flag included; the other channel never shows it. An upload
// running when the user leaves keeps going and shows its progress on return. Sending takes the
// attachments with the message and leaves an empty draft behind. A thread's draft keeps its
// attachments the same way when its panel closes and opens again.

import { test, expect, type Page, type Route } from '@playwright/test'
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
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const OBJECT_POST = '**/storage/v1/object/message_media/**'

let owner: SpecUser
let server: SeededServer
let otherChannelId: string
let threadChannelId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'dra')
  server = await seedServer(admin, owner, `Draft attachments ${owner.username}`)
  otherChannelId = await addChannel(admin, server, 'elsewhere')
  threadChannelId = await addChannel(admin, server, 'threaded')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const previews = (page: Page) => page.getByTestId('file-preview-item')
const preview = (page: Page, name: string) => previews(page).filter({ hasText: name })
const draftText = async (page: Page) => (await composer(page).innerText()).replace(/\u00a0/g, ' ').trim()
/** A text file no Drive holds yet: its bytes are uploaded, not reused. */
const freshFile = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} ${Date.now()} ${Math.random()}\n`) })

async function showChannel(page: Page, name: string, channelId: string) {
  await channelRow(page, name).click()
  await page.waitForURL(new RegExp(`${channelId}$`), { timeout: 15000 })
  await expect(composer(page)).toBeVisible({ timeout: 15000 })
}

test('attachments stay with their channel draft until it is sent', async ({ page }) => {
  test.setTimeout(240_000)
  const text = `draft with files by ${owner.username}`
  const spoilerButton = () => preview(page, 'pixel.png').getByRole('button', { name: /^(Mark as spoiler|Remove spoiler)$/ })

  await test.step('attach an image, mark it a spoiler and type in #general', async () => {
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await page.getByTestId('composer-file-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG })
    await expect(preview(page, 'pixel.png')).toContainText('Uploaded', { timeout: 15000 })
    await spoilerButton().click()
    await expect(spoilerButton()).toHaveAttribute('aria-pressed', 'true')
    await composer(page).click()
    await composer(page).pressSequentially(text, { delay: 10 })
  })

  await test.step('#elsewhere shows its own draft, and keeps an attachment of its own', async () => {
    await showChannel(page, 'elsewhere', otherChannelId)
    await expect(previews(page)).toHaveCount(0)
    expect(await draftText(page)).toBe('')
    await page.getByTestId('composer-file-input').setInputFiles(freshFile('other.txt'))
    await expect(preview(page, 'other.txt')).toContainText('Uploaded', { timeout: 15000 })
  })

  await test.step('back in #general the image and the text are there', async () => {
    await showChannel(page, 'general', server.generalChannelId)
    await expect(previews(page)).toHaveCount(1)
    await expect(preview(page, 'pixel.png')).toContainText('Uploaded')
    await expect(spoilerButton()).toHaveAttribute('aria-pressed', 'true')
    await expect(preview(page, 'pixel.png').locator('img')).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => draftText(page)).toBe(text)
  })

  await test.step('an upload running when the user leaves keeps going and shows on return', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let held = false
    await page.route(OBJECT_POST, async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      held = true
      await released
      await route.fallback()
    })

    await page.getByTestId('composer-file-input').setInputFiles(freshFile('slow.txt'))
    await expect(preview(page, 'slow.txt')).toContainText('Uploading', { timeout: 15000 })
    await expect.poll(() => held).toBe(true)

    await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
    await page.waitForURL(/\/dm/, { timeout: 15000 })
    await page.goBack()
    await page.waitForURL(new RegExp(`${server.generalChannelId}$`), { timeout: 15000 })
    await expect(composer(page)).toBeVisible({ timeout: 30000 })

    await expect(preview(page, 'slow.txt')).toContainText('Uploading')
    await expect(preview(page, 'slow.txt').getByRole('progressbar')).toBeVisible()
    await expect(preview(page, 'pixel.png')).toContainText('Uploaded')
    await expect.poll(() => draftText(page)).toBe(text)

    release()
    await expect(preview(page, 'slow.txt')).toContainText('Uploaded', { timeout: 15000 })
    await page.unroute(OBJECT_POST)
  })

  await test.step('a reload brings back the uploaded attachments', async () => {
    // The draft is stored 500 ms after its last change.
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter((key) => key.endsWith('message-draft-attachments'))
      .map((key) => localStorage.getItem(key) ?? '')
      .join(''))).toContain('slow.txt')
    await page.reload()
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
    await expect(previews(page)).toHaveCount(2, { timeout: 15000 })
    await expect(preview(page, 'pixel.png')).toContainText('Uploaded')
    await expect(spoilerButton()).toHaveAttribute('aria-pressed', 'true')
    await expect(preview(page, 'pixel.png').locator('img')).toHaveAttribute('src', /^https?:\/\/.+message_media/)
    await expect(preview(page, 'slow.txt')).toContainText('Uploaded')
    await expect.poll(() => draftText(page)).toBe(text)
  })

  await test.step('sending takes the attachments and empties the draft', async () => {
    await composer(page).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(posted).toContainText('slow.txt')
    await expect(previews(page)).toHaveCount(0)
    expect(await draftText(page)).toBe('')

    const { data, error } = await admin
      .from('messages')
      .select('content')
      .eq('channel_id', server.generalChannelId)
      .eq('user_id', owner.id)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    const files = (data![0].content as Array<{ type: string; fileName?: string; path?: string }>)
      .filter((part) => part.type === 'file')
    expect(files.map((part) => part.fileName).sort()).toEqual(['SPOILER_pixel.png', 'slow.txt'])
    for (const part of files) expect(part.path).toMatch(new RegExp(`^c/${server.generalChannelId}/`))
  })

  await test.step('no stale attachment comes back to #general; #elsewhere keeps its own', async () => {
    await showChannel(page, 'elsewhere', otherChannelId)
    await expect(previews(page)).toHaveCount(1)
    await expect(preview(page, 'other.txt')).toContainText('Uploaded')
    await showChannel(page, 'general', server.generalChannelId)
    await expect(previews(page)).toHaveCount(0)
    expect(await draftText(page)).toBe('')
  })
})

test('a thread draft keeps its attachments when the panel closes', async ({ page }) => {
  test.setTimeout(180_000)
  const name = `Plans ${owner.username.slice(-4)}`
  const text = `thread draft by ${owner.username}`
  const panel = page.locator('.thread-panel')
  const panelEditor = panel.locator('[data-testid="message-input"] .rich-text-editor')
  const panelPreview = (file: string) => panel.getByTestId('file-preview-item').filter({ hasText: file })
  const panelText = async () => (await panelEditor.innerText()).replace(/\u00a0/g, ' ').trim()

  const openThread = async () => {
    await page.locator('.chat-header .threads-btn').click()
    const modal = page.locator('.threads-modal')
    await expect(modal).toBeVisible({ timeout: 15000 })
    await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: name }) }).click()
    await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
  }
  const closeThread = async () => {
    await panel.locator('.back-btn').click()
    await expect(panel).toBeHidden({ timeout: 15000 })
  }

  await test.step('attach a file and type in a new thread', async () => {
    await signIn(page, owner)
    await openChannel(page, server.id, threadChannelId)
    await page.locator('.chat-header .threads-btn').click()
    const modal = page.locator('.threads-modal')
    await expect(modal).toBeVisible({ timeout: 15000 })
    await modal.locator('.new-thread-btn').click()
    await modal.locator('#new-thread-name').fill(name)
    await modal.locator('.new-thread-submit').click()
    await expect(modal).toBeHidden({ timeout: 15000 })
    await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })

    await panel.getByTestId('composer-file-input').setInputFiles(freshFile('thread.txt'))
    await expect(panelPreview('thread.txt')).toContainText('Uploaded', { timeout: 15000 })
    await panelEditor.click()
    await panelEditor.pressSequentially(text, { delay: 10 })
  })

  await test.step('closed, the channel composer does not show it; reopened, the thread does', async () => {
    await closeThread()
    await expect(previews(page)).toHaveCount(0)
    expect(await draftText(page)).toBe('')

    await openThread()
    await expect(panelPreview('thread.txt')).toContainText('Uploaded')
    await expect.poll(panelText).toBe(text)
  })

  await test.step('sending in the thread empties its draft', async () => {
    await panelEditor.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const posted = panel.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(posted).toContainText('thread.txt')
    await expect(panel.getByTestId('file-preview-item')).toHaveCount(0)

    await closeThread()
    await openThread()
    await expect(panel.getByTestId('file-preview-item')).toHaveCount(0)
    expect(await panelText()).toBe('')
  })
})
