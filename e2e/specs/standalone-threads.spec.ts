// Journey: a member starts a thread from the channel's threads list without
// picking a message, lands in it, and replies there. The thread is listed after
// a reload.
//
// create_channel_thread posts the channel's 'started a thread' notice as the
// thread's parent; the thread view does not show it as an opening message.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'thro')
  member = await createUser(admin, 'thrm')
  server = await seedServer(admin, owner, `Threads ${owner.username}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

async function openThreadsList(page: Page) {
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  return modal
}

test('New thread in the threads list creates a thread and opens it', async ({ page }) => {
  test.setTimeout(150_000)

  const name = `Planning ${member.username.slice(-4)}`
  const reply = `first reply in ${name}`
  const panel = page.locator('.thread-panel')

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('start a thread from the threads list', async () => {
    const modal = await openThreadsList(page)
    await modal.locator('.new-thread-btn').click()
    await modal.locator('#new-thread-name').fill(name)
    const created = page.waitForResponse((r) => r.url().includes('/rpc/create_channel_thread'))
    await modal.locator('.new-thread-submit').click()
    expect((await created).ok()).toBe(true)
    await expect(modal).toBeHidden({ timeout: 15000 })
  })

  await test.step('the new thread is open', async () => {
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel.locator('.thread-info h3')).toHaveText(name)
    await expect(panel.locator('.thread-channel')).toHaveText('#general')
    await expect(
      panel.locator('[data-testid="message-list"]').getByText('started a thread'),
    ).toHaveCount(0)
  })

  await test.step('reply in it', async () => {
    const editor = panel.locator('[data-testid="message-input"] .rich-text-editor')
    await editor.click()
    await editor.pressSequentially(reply, { delay: 10 })
    await page.keyboard.press('Enter')
    const posted = panel
      .locator('[data-testid="message-list"] .message-item')
      .filter({ hasText: reply })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  })

  await test.step('after a reload the thread is listed and holds the reply', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    const modal = await openThreadsList(page)
    const item = modal
      .locator('.thread-item')
      .filter({ has: page.locator('.thread-name', { hasText: name }) })
    await expect(item).toBeVisible({ timeout: 30000 })
    await item.click()
    await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
    await expect(panel.locator('[data-testid="message-list"]').getByText(reply)).toBeVisible({
      timeout: 30000,
    })
  })

  const { data: threads } = await admin
    .from('threads')
    .select('id, name')
    .eq('channel_id', server.generalChannelId)
  expect((threads ?? []).map((t) => t.name)).toEqual([name])
})
