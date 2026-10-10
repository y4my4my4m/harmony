// Journey: a member posts a poll from the composer's + menu, votes and changes
// the vote; another member reloads, reads the counts and votes too. /poll opens
// the same form. An end-to-end encrypted channel offers no poll and
// create_message_poll refuses one there.
//
// Votes from others arrive over realtime, absent here; each side reloads to
// read them.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let author: SpecUser
let voter: SpecUser
let server: SeededServer
let encrypted: SeededServer

test.beforeAll(async () => {
  author = await createUser(admin, 'polla')
  voter = await createUser(admin, 'pollb')
  server = await seedServer(admin, author, `Polls ${author.username}`)
  await addMember(admin, voter, server.id)

  encrypted = await seedServer(admin, author, `Polls E2EE ${author.username}`)
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: encrypted.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption floor: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, voter)
})

const pollCard = (page: Page, question: string) =>
  messageList(page).locator('[data-testid="poll-card"]').filter({ hasText: question })
const option = (card: Locator, text: string) =>
  card.locator('[data-testid="poll-option"]').filter({ hasText: text })
const voters = (card: Locator) => card.locator('[data-testid="poll-voters"]')

async function openPlusMenu(page: Page): Promise<void> {
  await page
    .locator('[data-testid="message-input"] .plus-icon-container > svg.icon-component')
    .click()
  await expect(page.locator('[data-testid="message-input"] .file-upload-menu')).toBeVisible({
    timeout: 15000,
  })
}

/** Clicks an answer and waits for vote_message_poll to land. */
async function vote(page: Page, card: Locator, text: string): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().includes('/rpc/vote_message_poll'))
  await option(card, text).click()
  expect((await saved).ok()).toBe(true)
  await expect(option(card, text)).toHaveAttribute('aria-checked', 'true')
}

test('post a poll, vote, change the vote; another member reads and adds to the counts', async ({
  browser,
}) => {
  test.setTimeout(180_000)

  const question = `Tea or coffee ${author.username}?`
  const authorContext = await browser.newContext()
  const page = await authorContext.newPage()
  const card = pollCard(page, question)

  await test.step('post a poll from the + menu', async () => {
    await signIn(page, author)
    await openChannel(page, server.id, server.generalChannelId)
    await openPlusMenu(page)
    await page.locator('[data-testid="upload-menu-poll"]').click()

    const form = page.locator('[data-testid="poll-create-form"]')
    await expect(form).toBeVisible({ timeout: 15000 })
    await form.locator('[data-testid="poll-question"]').fill(question)
    await form.locator('[data-testid="poll-answer"]').nth(0).fill('Tea')
    await form.locator('[data-testid="poll-answer"]').nth(1).fill('Coffee')
    const created = page.waitForResponse((r) => r.url().includes('/rpc/create_message_poll'))
    await page.locator('[data-testid="poll-post"]').click()
    expect((await created).ok()).toBe(true)
    await expect(form).toBeHidden()

    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(card.locator('[data-testid="poll-option"]')).toHaveText([/Tea/, /Coffee/])
    // Results stay hidden until the caller votes.
    await expect(card.locator('.poll-option-percent')).toHaveCount(0)
  })

  await test.step('vote, then change the vote', async () => {
    await vote(page, card, 'Tea')
    await expect(voters(card)).toHaveText('1 vote')
    await expect(option(card, 'Tea').locator('.poll-option-percent')).toHaveText('100%')

    await vote(page, card, 'Coffee')
    await expect(option(card, 'Tea')).toHaveAttribute('aria-checked', 'false')
    await expect(voters(card)).toHaveText('1 vote')
    await expect(option(card, 'Coffee').locator('.poll-option-percent')).toHaveText('100%')
    await expect(option(card, 'Tea').locator('.poll-option-percent')).toHaveText('0%')
  })

  const voterContext = await browser.newContext()
  const voterPage = await voterContext.newPage()
  const voterCard = pollCard(voterPage, question)

  await test.step('another member loads the poll and sees the count', async () => {
    await signIn(voterPage, voter)
    await openChannel(voterPage, server.id, server.generalChannelId)
    await expect(voterCard).toBeVisible({ timeout: 30000 })
    await expect(voters(voterCard)).toHaveText('1 vote', { timeout: 30000 })
    await expect(voterCard.locator('.poll-option-percent')).toHaveCount(0)
    await voterCard.getByRole('button', { name: 'Show results' }).click()
    await expect(option(voterCard, 'Coffee').locator('.poll-option-percent')).toHaveText('100%')
  })

  await test.step('their vote moves the shares', async () => {
    await vote(voterPage, voterCard, 'Tea')
    await expect(voters(voterCard)).toHaveText('2 votes')
    await expect(option(voterCard, 'Tea').locator('.poll-option-percent')).toHaveText('50%')
    await expect(option(voterCard, 'Coffee').locator('.poll-option-percent')).toHaveText('50%')
  })

  await test.step('the author reloads: two votes, theirs still on Coffee', async () => {
    await page.reload()
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(voters(card)).toHaveText('2 votes', { timeout: 30000 })
    await expect(option(card, 'Coffee')).toHaveAttribute('aria-checked', 'true')
    await expect(option(card, 'Tea')).toHaveAttribute('aria-checked', 'false')
  })

  await voterContext.close()
  await authorContext.close()
})

test('/poll opens the poll form', async ({ page }) => {
  test.setTimeout(120_000)

  await signIn(page, author)
  await openChannel(page, server.id, server.generalChannelId)
  await composer(page).click()
  await composer(page).pressSequentially('/poll', { delay: 20 })
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="poll-create-form"]')).toBeVisible({ timeout: 15000 })
})

test('an end-to-end encrypted channel offers no poll and refuses one', async ({ page }) => {
  test.setTimeout(120_000)

  await test.step('create_message_poll refuses the channel', async () => {
    const client = await userClient(author)
    const { error } = await client.rpc('create_message_poll', {
      p_channel_id: encrypted.generalChannelId,
      p_conversation_id: null,
      p_question: 'Secret?',
      p_options: ['Yes', 'No'],
    })
    expect(error?.message ?? '').toContain('POLL_ENCRYPTED')
  })

  await test.step('the + menu has no Create poll', async () => {
    await signIn(page, author)
    await openChannel(page, encrypted.id, encrypted.generalChannelId)
    // The header lock reads the same encryption state the + menu does.
    await expect(page.locator('.chat-header .channel-lock')).toBeVisible({ timeout: 30000 })
    await openPlusMenu(page)
    await expect(page.locator('[data-testid="upload-menu-poll"]')).toHaveCount(0)
  })
})
