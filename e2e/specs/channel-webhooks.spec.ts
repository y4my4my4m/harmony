// Journey: the owner creates a webhook in the channel's settings, posts through
// its URL, and reads the message under the webhook's name with the WEBHOOK tag.
// Regenerating the URL retires the old token; deleting the webhook retires the
// new one.
//
// Posts go to the federation backend's /webhooks/channels route (e2e/specs/backend.ts),
// which hashes the token and calls execute_channel_webhook.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let backend: Backend

test.beforeAll(async () => {
  owner = await createUser(admin, 'whk')
  server = await seedServer(admin, owner, `Webhooks ${owner.username}`)
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await deleteUser(admin, owner)
})

/** The webhook URL the UI reveals, as { id, token }. */
async function revealedWebhook(page: Page): Promise<{ id: string; token: string }> {
  const shown = await page.locator('[data-testid="webhook-url"]').textContent()
  const match = /\/webhooks\/channels\/([0-9a-f-]{36})\/([^/\s]+)$/.exec((shown ?? '').trim())
  if (!match) throw new Error(`no webhook URL in "${shown}"`)
  expect(new URL(shown!.trim()).origin).toBe(new URL(page.url()).origin)
  return { id: match[1], token: match[2] }
}

async function execute(
  id: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${backend.url}/webhooks/channels/${id}/${token}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function openWebhooksTab(page: Page) {
  await channelRow(page, 'general').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const modal = page.locator('.modal-container').filter({ hasText: 'Edit channel' })
  await expect(modal).toBeVisible({ timeout: 10000 })
  await modal.locator('.modal-tab').filter({ hasText: 'Webhooks' }).click()
  await expect(modal.locator('[data-testid="webhook-new"]')).toBeEnabled({ timeout: 15000 })
  return modal
}

async function confirmDialog(page: Page, title: string, button: string): Promise<void> {
  const dialog = page.locator('.modal-container').filter({ hasText: title })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await dialog.getByRole('button', { name: button, exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('create a webhook, post through it, regenerate and delete it', async ({ page }) => {
  test.setTimeout(180_000)

  const text = `deployed build ${owner.username.slice(-4)}`
  let webhook = { id: '', token: '' }

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  let modal = await openWebhooksTab(page)

  await test.step('create a webhook', async () => {
    await expect(modal.locator('[data-testid="webhook-empty"]')).toBeVisible()
    await modal.locator('[data-testid="webhook-new"]').click()
    await modal.locator('[data-testid="webhook-name"]').fill('Deploy Bot')
    await modal.locator('[data-testid="webhook-submit"]').click()
    await expect(modal.locator('[data-testid="webhook-secret"]')).toBeVisible({ timeout: 15000 })
    webhook = await revealedWebhook(page)
    await expect(modal.locator(`[data-testid="webhook-${webhook.id}"]`)).toContainText('Deploy Bot')
  })

  await test.step('a post through its URL lands in the channel', async () => {
    const response = await execute(webhook.id, webhook.token, { content: text })
    expect(response.status).toBe(200)
    expect((await response.json()).author.username).toBe('Deploy Bot')

    await openChannel(page, server.id, server.generalChannelId)
    const posted = messageList(page).locator('.message-item').filter({ hasText: text })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted.locator('.username')).toContainText('Deploy Bot')
    await expect(posted.locator('.webhook-badge')).toHaveText('WEBHOOK')
  })

  await test.step('a name in the payload overrides the shown author', async () => {
    const response = await execute(webhook.id, webhook.token, {
      content: `${text} again`,
      username: 'CI',
    })
    expect(response.status).toBe(200)
    await openChannel(page, server.id, server.generalChannelId)
    const posted = messageList(page)
      .locator('.message-item')
      .filter({ hasText: `${text} again` })
    await expect(posted.locator('.username')).toContainText('CI', { timeout: 30000 })
    await expect(posted.locator('.webhook-badge')).toHaveText('WEBHOOK')
  })

  await test.step('regenerating retires the old URL', async () => {
    modal = await openWebhooksTab(page)
    await modal.locator(`[data-testid="webhook-regenerate-${webhook.id}"]`).click()
    await confirmDialog(page, 'Regenerate webhook URL?', 'Regenerate')
    await expect(modal.locator('[data-testid="webhook-secret"]')).toBeVisible({ timeout: 15000 })
    const regenerated = await revealedWebhook(page)
    expect(regenerated.id).toBe(webhook.id)
    expect(regenerated.token).not.toBe(webhook.token)

    expect((await execute(webhook.id, webhook.token, { content: 'old token' })).status).toBe(401)
    expect(
      (await execute(regenerated.id, regenerated.token, { content: 'new token' })).status,
    ).toBe(200)
    webhook = regenerated
  })

  await test.step('deleting retires the webhook', async () => {
    await modal.locator(`[data-testid="webhook-delete-${webhook.id}"]`).click()
    await confirmDialog(page, 'Delete webhook?', 'Delete')
    await expect(modal.locator(`[data-testid="webhook-${webhook.id}"]`)).toHaveCount(0)
    await expect(modal.locator('[data-testid="webhook-empty"]')).toBeVisible()

    expect((await execute(webhook.id, webhook.token, { content: 'after delete' })).status).toBe(401)
    const { data } = await admin
      .from('channel_webhooks')
      .select('id')
      .eq('channel_id', server.generalChannelId)
    expect(data).toEqual([])
  })

  await test.step('messages it posted stay', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(messageList(page).getByText(text, { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(messageList(page).getByText('old token')).toHaveCount(0)
    await expect(messageList(page).getByText('after delete')).toHaveCount(0)
  })
})
