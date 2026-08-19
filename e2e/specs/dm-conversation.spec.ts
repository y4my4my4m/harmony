// Journey: open a direct conversation with someone and send them a message.
//
// The recipient reads it in a second browser context after opening the
// conversation; nothing waits on a live push, since the e2e stack runs no
// realtime service.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  signIn,
  type SpecUser,
} from './harness'

const admin = adminClient()
let sender: SpecUser
let recipient: SpecUser

test.beforeAll(async () => {
  sender = await createUser(admin, 'dma')
  recipient = await createUser(admin, 'dmb')
})

test.afterAll(async () => {
  await deleteUser(admin, sender)
  await deleteUser(admin, recipient)
})

test('open a DM conversation and send a message', async ({ browser }) => {
  test.setTimeout(180_000)

  const text = `dm from ${sender.username}`
  let conversationUrl = ''

  const senderContext = await browser.newContext()
  const senderPage = await senderContext.newPage()

  await test.step('start a conversation from the DM sidebar', async () => {
    await signIn(senderPage, sender)
    await senderPage.goto('/dm')
    await dismissAnnouncements(senderPage)
    await expect(senderPage.locator('[data-testid="dm-sidebar"]')).toBeVisible({ timeout: 30000 })
    await expect(senderPage.locator('[data-testid="dm-conversation-item"]')).toHaveCount(0)

    await senderPage.locator('[data-testid="dm-new-conversation"]').click()
    await senderPage.locator('.search-input').fill(recipient.username)

    const result = senderPage.locator('.search-result-item').filter({ hasText: recipient.username })
    await expect(result).toHaveCount(1, { timeout: 30000 })
    await result.click()

    await senderPage.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
    conversationUrl = new URL(senderPage.url()).pathname
  })

  await test.step('send a message', async () => {
    await expect(senderPage.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
    const input = senderPage.locator('[data-testid="message-input"] .rich-text-editor')
    await input.click()
    await input.pressSequentially(text, { delay: 10 })
    await senderPage.keyboard.press('Enter')

    const posted = senderPage
      .locator('[data-testid="message-list"] .message-item')
      .filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    // .is-sending and a temp- id mark the optimistic copy; both clear when the
    // insert returns.
    await expect(posted).not.toHaveClass(/is-sending/, { timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  })

  await test.step('the conversation is listed in the sidebar', async () => {
    await senderPage.goto('/dm')
    await dismissAnnouncements(senderPage)
    await expect(
      senderPage.locator('[data-testid="dm-conversation-item"]').filter({
        hasText: recipient.displayName,
      }),
    ).toHaveCount(1, { timeout: 30000 })
  })

  await test.step('the recipient reads it', async () => {
    const recipientContext = await browser.newContext()
    const recipientPage = await recipientContext.newPage()
    await signIn(recipientPage, recipient)
    await recipientPage.goto(conversationUrl)
    await dismissAnnouncements(recipientPage)

    await expect(
      recipientPage.locator('[data-testid="message-list"]').getByText(text, { exact: false }),
    ).toBeVisible({ timeout: 30000 })
    await recipientContext.close()
  })

  await senderContext.close()
})
