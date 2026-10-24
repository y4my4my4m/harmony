// Journeys, outgoing webhooks (migration 20261028600001):
// - a server's owner registers a webhook in the server's settings; its first test event's 2xx
//   verifies it, then a message in the server reaches its URL signed per Standard Webhooks, a
//   later test event too, and the delivery log shows them. Turned off, it receives nothing more.
// - instance staff: a moderator turns the webhook off from Admin › Webhooks and its owner cannot
//   turn it back on; an admin makes outgoing webhooks staff-only and turns incoming webhooks off,
//   and the server's settings say so.
//
// The bot gateway routes the event (EventDispatcher, enqueue_outgoing_webhook_event) and
// e2e/outgoing-webhook-worker.ts sends it with the federation backend's sender, the receiver
// being a local HTTP server (deliveries to localhost are allowed for this run only).

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import http from 'node:http'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'
import { startWebhookWorker, type WebhookWorker } from './webhookWorker'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let owner: SpecUser
let staffAdmin: SpecUser
let moderator: SpecUser
let server: SeededServer
let receiver: http.Server
let port = 0
let gateway: BotGateway | null = null
let worker: WebhookWorker | null = null
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []

test.beforeAll(async () => {
  owner = await createUser(admin, 'owh')
  staffAdmin = await createUser(admin, 'owa')
  moderator = await createUser(admin, 'owm')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staffAdmin.id)
  await admin.from('profiles').update({ is_moderator: true }).eq('id', moderator.id)
  await admin.from('instance_config').delete().eq('config_key', 'webhook_settings')
  server = await seedServer(admin, owner, `Hooks ${owner.username}`)
  receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  port = (receiver.address() as { port: number }).port
})

test.afterAll(async () => {
  await gateway?.stop()
  await worker?.stop()
  await new Promise<void>((resolve) => receiver.close(() => resolve()))
  await admin.from('instance_config').delete().eq('config_key', 'webhook_settings')
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const u of [owner, staffAdmin, moderator]) await deleteUser(admin, u)
})

function verify(secret: string, hit: { headers: http.IncomingHttpHeaders; body: string }): boolean {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = crypto.createHmac('sha256', key)
    .update(`${hit.headers['webhook-id']}.${hit.headers['webhook-timestamp']}.${hit.body}`).digest('base64')
  return hit.headers['webhook-signature'] === `v1,${expected}`
}

const ofType = (type: string) => received.filter((r) => JSON.parse(r.body).type === type)

test('a server webhook receives the server\'s messages, signed, until it is turned off', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=outgoing-webhooks`)
  await dismissAnnouncements(page)
  const panel = page.getByTestId('outgoing-webhooks')
  const row = panel.locator('li').filter({ hasText: 'Message log' })
  let secret = ''
  let createdAt = 0

  await test.step('the owner registers a webhook and copies its secret once', async () => {
    await panel.getByTestId('outgoing-webhook-new').click({ timeout: 30000 })
    await panel.getByTestId('outgoing-webhook-name').fill('Message log')
    await panel.getByTestId('outgoing-webhook-url').fill(`http://localhost:${port}/hook`)
    await expect(panel.getByTestId('outgoing-webhook-event-MESSAGE_CREATE')).toBeChecked()
    await panel.getByTestId('outgoing-webhook-submit').click()
    const value = panel.getByTestId('outgoing-webhook-secret-value')
    await expect(value).toHaveText(/^whsec_/, { timeout: 15000 })
    secret = (await value.textContent())!.trim()
    createdAt = Date.now()
    await panel.getByRole('button', { name: 'Done' }).click()
    await expect(value).toHaveCount(0)
    await expect(row).toContainText(`Secret ends in ${secret.slice(-4)}`)
    await expect(row.getByTestId('outgoing-webhook-state'))
      .toHaveText('Waiting for a 2xx answer to the test event before events are sent')
  })

  await test.step('the test event sent on create verifies the endpoint', async () => {
    worker = await startWebhookWorker()
    await expect.poll(() => ofType('PING').length, { timeout: 30000 }).toBe(1)
    expect(verify(secret, ofType('PING')[0])).toBe(true)
    await expect(row.getByTestId('outgoing-webhook-state')).toContainText('Last delivered', { timeout: 30000 })
  })

  // The gateway reads the routes at start: the webhook is verified by now.
  gateway = await startBotGateway()

  await test.step('a message in the server reaches the URL, signed', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await sendMessage(page, 'hello webhook')
    await expect.poll(() => ofType('MESSAGE_CREATE').length, { timeout: 30000 }).toBe(1)
    const [hit] = ofType('MESSAGE_CREATE')
    expect(verify(secret, hit)).toBe(true)
    const body = JSON.parse(hit.body)
    expect(body.data).toMatchObject({ server_id: server.id, channel_id: server.generalChannelId })
    expect(JSON.stringify(body.data.content)).toContain('hello webhook')
    expect(hit.headers['content-type']).toContain('application/json')
  })

  await test.step('the test event arrives and the delivery log shows it delivered', async () => {
    await page.goto(`/server/${server.id}?section=outgoing-webhooks`)
    await expect(row).toContainText('Last delivered', { timeout: 30000 })
    // One test event per 10 seconds.
    await page.waitForTimeout(Math.max(0, createdAt + 11_000 - Date.now()))
    await row.getByRole('button', { name: 'Send test event' }).click()
    await expect.poll(() => ofType('PING').length, { timeout: 30000 }).toBe(2)
    expect(verify(secret, ofType('PING')[1])).toBe(true)
    const log = row.getByRole('button', { name: 'Deliveries' })
    await log.click()
    await log.click()
    const pings = row.getByTestId('outgoing-webhook-delivery').filter({ hasText: 'PING' })
    await expect(pings).toHaveCount(2, { timeout: 15000 })
    await expect(pings.first()).toContainText('Delivered')
  })

  await test.step('turned off, the webhook receives nothing more', async () => {
    await row.getByRole('switch', { name: 'Message log on' }).uncheck({ force: true })
    await expect(row.getByTestId('outgoing-webhook-state')).toHaveText('Off')
    await openChannel(page, server.id, server.generalChannelId)
    await sendMessage(page, 'after the switch')
    await page.waitForTimeout(5000)
    expect(ofType('MESSAGE_CREATE')).toHaveLength(1)
  })
})

test('instance staff turn a webhook off and restrict webhooks for the instance', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const { data: webhook } = await admin.from('outgoing_webhooks').select('id').eq('server_id', server.id).single()
  expect(webhook).toBeTruthy()
  // The journey above ends with its owner having turned it off.
  await admin.from('outgoing_webhooks').update({ is_active: true, disabled_reason: null }).eq('id', webhook!.id)

  await test.step('a moderator turns the webhook off from Admin › Webhooks', async () => {
    await signIn(page, moderator)
    await page.goto('/admin?tab=webhooks')
    await dismissAnnouncements(page)
    const row = page.getByTestId(`webhooks-admin-${webhook!.id}`)
    await expect(row).toContainText(`localhost`, { timeout: 30000 })
    await expect(page.getByTestId('webhooks-save')).toHaveCount(0)
    await page.getByTestId(`webhooks-admin-toggle-${webhook!.id}`).click()
    await expect(row).toContainText('Off (staff)')
  })

  const ownerContext = await browser.newContext({ serviceWorkers: 'block' })
  const ownerPage = await ownerContext.newPage()
  await signIn(ownerPage, owner)

  await test.step('its owner sees why and cannot turn it back on', async () => {
    await ownerPage.goto(`/server/${server.id}?section=outgoing-webhooks`)
    await dismissAnnouncements(ownerPage)
    const panel = ownerPage.getByTestId('outgoing-webhooks')
    await expect(panel.getByTestId('outgoing-webhook-state')).toHaveText("Turned off by this instance's staff", { timeout: 30000 })
    await expect(panel.getByRole('switch', { name: 'Message log on' })).toBeDisabled()
  })

  await test.step('an admin makes outgoing webhooks staff-only and turns incoming webhooks off', async () => {
    const adminContext = await browser.newContext({ serviceWorkers: 'block' })
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, staffAdmin)
    await adminPage.goto('/admin?tab=webhooks')
    await dismissAnnouncements(adminPage)
    await adminPage.getByTestId('webhooks-outgoing-mode').selectOption('staff', { timeout: 30000 })
    await adminPage.getByTestId('webhooks-incoming-enabled').uncheck()
    await adminPage.getByTestId('webhooks-save').click()
    await expect.poll(async () => (await admin.from('instance_config').select('config_value')
      .eq('config_key', 'webhook_settings').maybeSingle()).data?.config_value?.outgoing_mode, { timeout: 15000 }).toBe('staff')
    await adminContext.close()
  })

  await test.step('the owner is told: no new outgoing webhook, no incoming ones', async () => {
    await ownerPage.goto(`/server/${server.id}?section=outgoing-webhooks`)
    const panel = ownerPage.getByTestId('outgoing-webhooks')
    await expect(panel.getByTestId('outgoing-webhook-unavailable'))
      .toHaveText('On this instance, only its staff create outgoing webhooks.', { timeout: 30000 })
    await expect(panel.getByTestId('outgoing-webhook-new')).toHaveCount(0)
    const { error } = await (await userClient(owner)).rpc('create_channel_webhook', {
      p_channel_id: server.generalChannelId, p_name: 'CI',
    })
    expect(error?.message).toContain('WEBHOOK_DISABLED')
  })
  await ownerContext.close()
})
