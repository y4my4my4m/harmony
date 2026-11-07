// Journey: "Discoverable across federation" in a server's Privacy settings (migrations
// 20261105100001, 20261107900001). A new server carries it on. The switch is unavailable while the
// server is invite-only or does not federate, and says why. Made public and federated, the server
// is listed without the switch being touched: the instance's directory (GET /servers/directory,
// e2e/specs/backend.ts) lists its Group and the Group says discoverable. Turned off, the server
// leaves the directory at once, the Group no longer says discoverable, the audit log records it,
// and it stays off through an invite-only spell. Turned on and made private, the listing goes and
// returns once the server is public again.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let backend: Backend

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'sfd')
  server = await seedServer(admin, owner, `Directory ${owner.username}`)
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

const toggle = (page: Page) => page.getByTestId('server-directory-toggle')
const requirement = (page: Page) => page.getByTestId('server-directory-requires')

/** The radios sit under their drawn label, which takes the click. */
async function choose(page: Page, name: 'Public directory' | 'Invite only') {
  await page.locator(`label[for="${name === 'Public directory' ? 'public-directory' : 'invite-only'}"]`).click()
  await expect(page.getByRole('radio', { name })).toBeChecked()
}

/** The switches' inputs are 0x0 under their label; a click on the label flips them. */
async function flip(page: Page, testId: string, on: boolean) {
  const input = page.getByTestId(testId)
  await input.locator('xpath=..').click()
  if (on) await expect(input).toBeChecked()
  else await expect(input).not.toBeChecked()
}

async function stored(): Promise<{ public: boolean; federation_enabled: boolean; federation_discoverable: boolean }> {
  const { data, error } = await admin.from('servers')
    .select('public, federation_enabled, federation_discoverable').eq('id', server.id).single()
  if (error) throw new Error(error.message)
  return data
}

async function listedGroups(): Promise<string[]> {
  const res = await fetch(`${backend.url}/servers/directory?page=1`, { headers: { Accept: 'application/activity+json' } })
  expect(res.status).toBe(200)
  return ((await res.json()).orderedItems ?? []).map((g: { id: string }) => g.id)
}

async function groupDocument(): Promise<Record<string, unknown>> {
  const res = await fetch(`${backend.url}/servers/${server.id}`, { headers: { Accept: 'application/activity+json' } })
  return res.json()
}

async function save(page: Page) {
  const saved = page.waitForResponse((r) => r.url().includes('/rpc/update_server') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save Changes' }).first().click()
  expect((await saved).ok()).toBe(true)
}

test('a public, federated server is listed by default and its owner\'s choice stays', async ({ page }) => {
  test.setTimeout(180_000)
  const group = `https://localhost/servers/${server.id}`

  expect((await stored()).federation_discoverable).toBe(true)

  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=privacy`)
  await expect(page.getByText('Discoverable across federation', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(/On by default; it applies while the server is public and federated\./)).toBeVisible()

  await test.step('an invite-only server cannot be listed and says why', async () => {
    await expect(toggle(page)).toBeDisabled()
    await expect(toggle(page)).not.toBeChecked()
    await expect(requirement(page)).toHaveText('Make the server public to list it.')
    expect(await listedGroups()).not.toContain(group)
  })

  await test.step('public but not federated, it still cannot', async () => {
    await choose(page, 'Public directory')
    await expect(requirement(page)).toHaveText('Turn on federation to list it.')
    await expect(toggle(page)).toBeDisabled()
  })

  await test.step('public and federated, it is listed without touching the switch', async () => {
    await flip(page, 'server-federation-toggle', true)
    await expect(requirement(page)).toBeHidden()
    await expect(toggle(page)).toBeEnabled()
    await expect(toggle(page)).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Discoverable across federation' })).toBeAttached()
    await save(page)
    await expect.poll(stored).toEqual({ public: true, federation_enabled: true, federation_discoverable: true })
    await expect.poll(listedGroups).toContain(group)
    expect((await groupDocument()).discoverable).toBe(true)
  })

  await test.step('turned off, it leaves the directory at once and the audit log records it', async () => {
    await flip(page, 'server-directory-toggle', false)
    await save(page)
    await expect.poll(stored).toMatchObject({ federation_discoverable: false })
    expect(await listedGroups()).not.toContain(group)
    const doc = await groupDocument()
    expect('discoverable' in doc).toBe(false)
    expect(doc['harmony:public']).toBe(true)
    const { data: audit } = await admin.from('server_audit_log').select('actor_id, changes')
      .eq('server_id', server.id).not('changes->federation_discoverable', 'is', null)
    expect(audit).toEqual([{ actor_id: owner.id, changes: { federation_discoverable: { old: true, new: false } } }])
  })

  await test.step('the owner\'s off stays off through an invite-only spell', async () => {
    await choose(page, 'Invite only')
    await save(page)
    await choose(page, 'Public directory')
    await save(page)
    await expect.poll(stored).toEqual({ public: true, federation_enabled: true, federation_discoverable: false })
    await expect(toggle(page)).toBeEnabled()
    await expect(toggle(page)).not.toBeChecked()
    expect(await listedGroups()).not.toContain(group)
  })

  await test.step('turned on and made private, the listing goes, and returns with the server public', async () => {
    await flip(page, 'server-directory-toggle', true)
    await save(page)
    await expect.poll(listedGroups).toContain(group)
    await choose(page, 'Invite only')
    await expect(toggle(page)).toBeDisabled()
    await expect(toggle(page)).not.toBeChecked()
    await save(page)
    await expect.poll(stored).toEqual({ public: false, federation_enabled: true, federation_discoverable: true })
    expect(await listedGroups()).not.toContain(group)
    expect((await groupDocument()).discoverable).toBe(false)
    await choose(page, 'Public directory')
    await expect(toggle(page)).toBeChecked()
    await save(page)
    await expect.poll(listedGroups).toContain(group)
  })
})
