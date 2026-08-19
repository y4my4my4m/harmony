// Journey: a member posts in a channel, sees it in the list, and the other
// member sees it too.
//
// The second member reloads rather than waiting: message fan-out rides
// supabase realtime, which the e2e stack does not run.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
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
  author = await createUser(admin, 'msga')
  reader = await createUser(admin, 'msgb')
  server = await seedServer(admin, author, `Msg Server ${author.username}`)
  await addMember(admin, reader, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

test('post a message in a channel and see it appear', async ({ browser }) => {
  test.setTimeout(180_000)

  const text = `hello from ${author.username}`
  const channelUrl = `/chat/${server.id}/${server.generalChannelId}`

  const authorContext = await browser.newContext()
  const authorPage = await authorContext.newPage()

  await test.step('open the channel', async () => {
    await signIn(authorPage, author)
    await authorPage.goto(channelUrl)
    await dismissAnnouncements(authorPage)
    await expect(authorPage.locator('[data-testid="message-list"]')).toBeVisible({
      timeout: 30000,
    })
    await expect(
      authorPage.locator('[data-testid="message-list"]').getByText(text, { exact: false }),
    ).toHaveCount(0)
  })

  await test.step('type the message and send it', async () => {
    const input = authorPage.locator('[data-testid="message-input"] .rich-text-editor')
    await input.click()
    await input.pressSequentially(text, { delay: 10 })
    await authorPage.keyboard.press('Enter')

    const posted = authorPage
      .locator('[data-testid="message-list"] .message-item')
      .filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    // Until the insert returns, the item carries a temp- id and .is-sending.
    // Asserting only on the text would pass on the optimistic copy alone.
    await expect(posted).not.toHaveClass(/is-sending/, { timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  })

  await test.step('it is still there after a reload', async () => {
    await authorPage.reload()
    await dismissAnnouncements(authorPage)
    await expect(
      authorPage.locator('[data-testid="message-list"]').getByText(text, { exact: false }),
    ).toBeVisible({ timeout: 30000 })
  })

  await test.step('the other member reads it', async () => {
    const readerContext = await browser.newContext()
    const readerPage = await readerContext.newPage()
    await signIn(readerPage, reader)
    await readerPage.goto(channelUrl)
    await dismissAnnouncements(readerPage)

    await expect(
      readerPage.locator('[data-testid="message-list"]').getByText(text, { exact: false }),
    ).toBeVisible({ timeout: 30000 })
    await readerContext.close()
  })

  await authorContext.close()
})
