// Journey: a server's invite on someone's website. The backend answers a badge and a card another
// origin can show: no frame refusal, cross-origin resource policy, no script. A page on another
// origin draws both; a dead invite draws without naming the server. The invite dialog hands out
// the snippets, and warns about a link that expires.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
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
const marker = Date.now().toString(36).slice(-6).toUpperCase()
const code = `W${marker}A`.padEnd(8, 'X')
const deadCode = `D${marker}B`.padEnd(8, 'X')
const NAME = `Lounge <${marker}>`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'iwg')
  server = await seedServer(admin, owner, NAME)
  const { error } = await admin.from('invites').insert([
    { code, server_id: server.id, created_by: owner.id, max_uses: 0 },
    { code: deadCode, server_id: server.id, created_by: owner.id, used: true },
  ])
  if (error) throw new Error(`invites: ${error.message}`)
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

test('the badge is an image any page can load', async () => {
  const res = await fetch(`${backend.url}/widget/invite/${code}/badge.svg`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('image/svg+xml')
  expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  const svg = await res.text()
  expect(svg).toContain(`Lounge &lt;${marker}&gt;`)
  expect(svg).toContain('1 member')
  expect(svg).not.toMatch(/<script/i)

  const dead = await (await fetch(`${backend.url}/widget/invite/${deadCode}/badge.svg`)).text()
  expect(dead).toContain('Invite no longer valid')
  expect(dead).not.toContain(marker)
})

test('the card can be framed anywhere and runs no script', async () => {
  const res = await fetch(`${backend.url}/widget/invite/${code}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('x-frame-options')).toBeNull()
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toContain('frame-ancestors *')
  expect(csp).not.toContain('script-src')
  const html = await res.text()
  expect(html).not.toMatch(/<script/i)
  expect(html).toContain(`/invite/${code}`)
})

test('a page on another origin shows both, also where a proxy adds X-Frame-Options', async ({ page }) => {
  test.setTimeout(60_000)
  // nginx's server-level add_header applies to /api/federation/*.
  const proxied = http.createServer(async (req, res) => {
    const upstream = await fetch(`${backend.url}${req.url}`)
    upstream.headers.forEach((value, key) => {
      if (key !== 'content-encoding' && key !== 'content-length') res.setHeader(key, value)
    })
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.end(Buffer.from(await upstream.arrayBuffer()))
  })
  await new Promise<void>((resolve) => proxied.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${(proxied.address() as AddressInfo).port}`

  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<!doctype html><title>site</title>
      <img id="badge" src="${proxyUrl}/widget/invite/${code}/badge.svg">
      <img id="icon" src="${proxyUrl}/widget/invite/${code}/badge.svg?style=icon">
      <iframe id="card" src="${proxyUrl}/widget/invite/${code}" width="340" height="72" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`)
  })
  await new Promise<void>((resolve) => site.listen(0, 'localhost', resolve))
  try {
    await page.goto(`http://localhost:${(site.address() as AddressInfo).port}/`)
    await expect.poll(() => page.locator('#badge').evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(60)
    await expect.poll(() => page.locator('#icon').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(28)
    const card = page.frameLocator('#card')
    await expect(card.getByText(`Lounge <${marker}>`)).toBeVisible({ timeout: 15000 })
    await expect(card.getByRole('link', { name: 'Join' })).toHaveAttribute('href', new RegExp(`/invite/${code}$`))
  } finally {
    site.close()
    proxied.close()
  }
})

test('the invite dialog hands out the snippets', async ({ browser }) => {
  test.setTimeout(150_000)
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('.server-dropdown li').filter({ hasText: 'Get Invite Link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite people' })
  await expect(dialog.getByLabel('Invite link')).toHaveValue(/\/invite\/[A-Za-z0-9_-]+$/, { timeout: 30000 })

  await dialog.getByTestId('invite-widgets-toggle').click()
  const badge = dialog.getByTestId('invite-widget-badge')
  await expect(badge.getByRole('textbox')).toHaveValue(/<a href="[^"]+\/invite\/[^"]+".*badge\.svg/)
  await expect.poll(() => badge.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(60)
  await expect(dialog.getByTestId('invite-widget-markdown').getByRole('textbox')).toHaveValue(/^\[!\[Join /)
  await expect(dialog.getByTestId('invite-widget-card').getByRole('textbox')).toHaveValue(/<iframe .*sandbox=/)
  await context.close()
})
