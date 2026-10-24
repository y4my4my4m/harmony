// Journey: a server's owner registers an outgoing webhook in the server's settings; a message in
// the server reaches its URL signed per Standard Webhooks, the test event too, and the delivery
// log shows them. Turned off, it receives nothing more.
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
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'
import { startWebhookWorker, type WebhookWorker } from './webhookWorker'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let receiver: http.Server
let port = 0
let gateway: BotGateway | null = null
let worker: WebhookWorker | null = null
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []

test.beforeAll(async () => {
  owner = await createUser(admin, 'owh')
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
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
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
  let secret = ''

  await test.step('the owner registers a webhook and copies its secret once', async () => {
    await panel.getByTestId('outgoing-webhook-new').click({ timeout: 30000 })
    await panel.getByTestId('outgoing-webhook-name').fill('Message log')
    await panel.getByTestId('outgoing-webhook-url').fill(`http://localhost:${port}/hook`)
    await expect(panel.getByTestId('outgoing-webhook-event-MESSAGE_CREATE')).toBeChecked()
    await panel.getByTestId('outgoing-webhook-submit').click()
    const value = panel.getByTestId('outgoing-webhook-secret-value')
    await expect(value).toHaveText(/^whsec_/, { timeout: 15000 })
    secret = (await value.textContent())!.trim()
    await panel.getByRole('button', { name: 'Done' }).click()
    await expect(value).toHaveCount(0)
    await expect(panel.locator('li').filter({ hasText: 'Message log' })).toContainText(`Secret ends in ${secret.slice(-4)}`)
  })

  gateway = await startBotGateway()
  worker = await startWebhookWorker()

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
    const row = panel.locator('li').filter({ hasText: 'Message log' })
    await expect(row).toContainText('Last delivered', { timeout: 30000 })
    await row.getByRole('button', { name: 'Send test event' }).click()
    await expect.poll(() => ofType('PING').length, { timeout: 30000 }).toBe(1)
    expect(verify(secret, ofType('PING')[0])).toBe(true)
    const log = row.getByRole('button', { name: 'Deliveries' })
    await log.click()
    await log.click()
    await expect(row.getByTestId('outgoing-webhook-delivery').filter({ hasText: 'PING' })).toContainText('Delivered', { timeout: 15000 })
  })

  await test.step('turned off, the webhook receives nothing more', async () => {
    const row = panel.locator('li').filter({ hasText: 'Message log' })
    await row.getByRole('switch', { name: 'Message log on' }).uncheck({ force: true })
    await expect(row.getByTestId('outgoing-webhook-state')).toHaveText('Off')
    await openChannel(page, server.id, server.generalChannelId)
    await sendMessage(page, 'after the switch')
    await page.waitForTimeout(5000)
    expect(ofType('MESSAGE_CREATE')).toHaveLength(1)
  })
})
