// Journey: browsing another instance's server directory from Discover communities, and joining a
// server listed there. The other instance is e2e/specs/directoryPeer.ts, an HTTPS server on a
// non-private address; this instance's federation backend (e2e/specs/backend.ts) reads its
// NodeInfo and directory, signed, and sends the Join.
//
// - Other instances lists the known instance (a federated_instances row whose NodeInfo the
//   backend reads on opening) and the servers it lists; one it lists with discoverable false is
//   not shown.
// - Join opens Join remote server on the server's Group; joining sends a signed Join to its inbox
//   and opens the server.
// - At phone width the tab and its list fit the screen.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { startDirectoryPeer, type DirectoryPeer } from './directoryPeer'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let user: SpecUser
// No server: the phone opens Discover communities from the empty-state splash.
let phoneUser: SpecUser
let home: SeededServer
let backend: Backend
let peer: DirectoryPeer
const listed = { id: crypto.randomUUID(), name: 'Lighthouse Lounge', summary: 'Keepers of the light', memberCount: 12 }
const hidden = { id: crypto.randomUUID(), name: 'Back Room', discoverable: false }

test.beforeAll(async () => {
  test.setTimeout(120_000)
  user = await createUser(admin, 'rsd')
  phoneUser = await createUser(admin, 'rsp')
  home = await seedServer(admin, user, `Home ${user.username}`)
  peer = await startDirectoryPeer([listed, hidden])
  await admin.from('federated_instances').delete().eq('domain', peer.domain)
  const { error } = await admin.from('federated_instances').insert({
    domain: peer.domain, software: 'harmony', last_seen_at: new Date().toISOString(),
  })
  if (error) throw new Error(`known instance: ${error.message}`)
  backend = await startBackend({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })
})

test.afterAll(async () => {
  await backend?.stop()
  const { data: copy } = await admin.from('servers').select('id').eq('ap_id', peer?.groupUrl(listed.id) ?? '').maybeSingle()
  if (copy) await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('federated_instances').delete().eq('domain', peer?.domain ?? '')
  await peer?.stop()
  await admin.from('servers').delete().eq('id', home?.id ?? '')
  await deleteUser(admin, user)
  await deleteUser(admin, phoneUser)
})

async function openOtherInstances(page: Page, from: 'rail' | 'splash' = 'rail') {
  if (from === 'rail') await page.getByRole('button', { name: 'Harmony Portal' }).click()
  else await page.getByRole('button', { name: /Browse public servers/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover communities' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await dialog.getByRole('tab', { name: 'Other instances' }).click()
  await expect(dialog.getByRole('tab', { name: 'Other instances' })).toHaveAttribute('aria-selected', 'true')
  return dialog
}

test('a server listed on another instance is browsed and joined', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, user)
  await page.goto(`/chat/${home.id}/${home.generalChannelId}`)

  const dialog = await openOtherInstances(page)

  await test.step('the known instance is offered and its directory lists what it lists as discoverable', async () => {
    const chip = dialog.getByTestId('remote-directory-peer').filter({ hasText: peer.domain })
    await expect(chip).toBeVisible({ timeout: 30000 })
    await chip.click()
    const cards = dialog.getByTestId('remote-directory-server')
    await expect(cards).toHaveCount(1, { timeout: 30000 })
    await expect(cards.first()).toContainText(listed.name)
    await expect(cards.first()).toContainText(listed.summary)
    await expect(cards.first()).toContainText('12 members')
    await expect(dialog).not.toContainText(hidden.name)
    await expect(dialog.getByTestId('remote-directory-stats')).toHaveText(`2 servers on ${peer.domain}`)
    const signed = peer.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/servers/directory'))
    expect(signed.length).toBeGreaterThan(0)
    expect(signed.every((r) => /keyId="https:\/\/localhost\/users\/instance\.actor#main-key"/.test(String(r.headers.signature)))).toBe(true)
  })

  await test.step('typing the domain browses it the same way', async () => {
    await dialog.getByTestId('remote-directory-domain').fill(`https://${peer.domain}/`)
    await dialog.getByTestId('remote-directory-browse').click()
    await expect(dialog.getByTestId('remote-directory-server')).toHaveCount(1, { timeout: 30000 })
  })

  await test.step('Join opens Join remote server on the listed Group, and joining opens the server', async () => {
    await dialog.getByRole('button', { name: `Join ${listed.name}` }).click()
    const join = page.getByRole('dialog', { name: 'Join remote server' })
    await expect(join).toBeVisible()
    await expect(join.locator('#server-url')).toHaveValue(peer.groupUrl(listed.id))
    await expect(join.locator('.server-name')).toHaveText(listed.name, { timeout: 30000 })
    const delivered = peer.requests.length
    await join.getByTestId('join-federated-submit').click()
    await expect(page).toHaveURL(new RegExp(`/chat/${listed.id}/`), { timeout: 30000 })
    await expect(page.locator('.channel-sidebar .server-name')).toHaveText(listed.name, { timeout: 30000 })

    const joinPost = peer.requests.slice(delivered).find((r) => r.method === 'POST' && r.url === `/servers/${listed.id}/inbox`)
    expect(joinPost, 'a Join reaches the Group inbox').toBeTruthy()
    const activity = JSON.parse(joinPost!.body)
    expect(activity).toMatchObject({ type: 'Join', object: peer.groupUrl(listed.id), actor: `https://localhost/users/${user.username}` })
    expect(String(joinPost!.headers.signature)).toContain(`keyId="https://localhost/users/${user.username}#main-key"`)
    const { data: member } = await admin.from('user_servers').select('status').eq('server_id', listed.id).eq('user_id', user.id).single()
    expect(member?.status).toBe('accepted')
  })

  await test.step('the directory then offers to open it', async () => {
    const again = await openOtherInstances(page)
    await again.getByTestId('remote-directory-peer').filter({ hasText: peer.domain }).click()
    await expect(again.getByRole('button', { name: `Open server ${listed.name}` })).toBeVisible({ timeout: 30000 })
    await page.keyboard.press('Escape')
  })
})

test('at phone width Other instances fits the screen', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await backend.route(page)
  await signIn(page, phoneUser)
  const dialog = await openOtherInstances(page, 'splash')
  await dialog.getByTestId('remote-directory-domain').fill(peer.domain)
  await dialog.getByTestId('remote-directory-browse').click()
  const card = dialog.getByTestId('remote-directory-server').first()
  await expect(card).toBeVisible({ timeout: 30000 })
  const box = await card.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const input = await dialog.getByTestId('remote-directory-domain').evaluate((el) => getComputedStyle(el).fontSize)
  expect(input).toBe('16px')
})
