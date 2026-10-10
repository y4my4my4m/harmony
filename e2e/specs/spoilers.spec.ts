// Journey: a member posts ||text|| and it stays covered until clicked; a reply
// to it previews the spoiler as a bar, not as its text.
//
// Image spoilers (SPOILER_ file names) need storage, which the stack lacks.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  sendMessage,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let author: SpecUser
let reader: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  author = await createUser(admin, 'spla')
  reader = await createUser(admin, 'splb')
  server = await seedServer(admin, author, `Spoiler ${author.username}`)
  await addMember(admin, reader, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

test('a spoiler is covered until clicked and masked in reply previews', async ({ browser }) => {
  test.setTimeout(180_000)

  const secret = `snape${author.username.slice(-4)}`
  const text = `plot twist ||${secret}|| ahead`
  const reply = `no way ${reader.username}`

  const authorContext = await browser.newContext()
  const page = await authorContext.newPage()

  await test.step('post a message with a spoiler', async () => {
    await signIn(page, author)
    await openChannel(page, server.id, server.generalChannelId)
    const posted = await sendMessage(page, text)
    const spoiler = posted.locator('.md-spoiler')
    await expect(spoiler).toHaveText(secret)
    await expect(spoiler).not.toHaveClass(/revealed/)
  })

  const readerContext = await browser.newContext()
  const readerPage = await readerContext.newPage()
  const spoiler = readerPage
    .locator('[data-testid="message-list"] .md-spoiler')
    .filter({ hasText: secret })

  await test.step('another member sees it covered', async () => {
    await signIn(readerPage, reader)
    await openChannel(readerPage, server.id, server.generalChannelId)
    await expect(spoiler).toBeVisible({ timeout: 30000 })
    await expect(spoiler).not.toHaveClass(/revealed/)
    // Covered: the glyphs are transparent on a solid bar.
    await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  })

  await test.step('a click reveals it', async () => {
    await spoiler.click()
    await expect(spoiler).toHaveClass(/revealed/)
    await expect(spoiler).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  })

  await test.step('a reply previews the spoiler as a bar', async () => {
    const original = messageList(readerPage)
      .locator('.message-item')
      .filter({ has: readerPage.locator('.md-spoiler') })
    await original.hover()
    await original.locator('[data-testid="msg-action-reply"]').click()
    const posted = await sendMessage(readerPage, reply)
    const preview = posted.locator('.reply-reference .reply-preview')
    await expect(preview).toContainText('▒', { timeout: 30000 })
    await expect(preview).toContainText('plot twist')
    await expect(preview).not.toContainText(secret)
  })

  await test.step('after a reload it is covered again, the preview still masked', async () => {
    await readerPage.reload()
    await expect(spoiler).toBeVisible({ timeout: 30000 })
    await expect(spoiler).not.toHaveClass(/revealed/)
    const preview = messageList(readerPage)
      .locator('.message-item')
      .filter({ hasText: reply })
      .locator('.reply-reference .reply-preview')
    await expect(preview).toContainText('▒', { timeout: 30000 })
    await expect(preview).not.toContainText(secret)
  })

  await readerContext.close()
  await authorContext.close()
})
