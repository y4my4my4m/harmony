// Journey: self-assignable roles and the join role (1.9.8). The owner marks a role "Members can
// pick this role" in the role editor; a member takes and drops it from Pick roles in the server
// menu and from a role menu card posted with /rolemenu, in a plain and an end-to-end encrypted
// channel; the owner picks a role for new members, and someone joining gets it.
//
// Covered: the editor toggle and group saved; the warning for a role with extra permissions; the
// picker listing only pickable roles; a toggle reaching user_roles and back; the card's text part
// stored beside it in plaintext channels and nothing readable in encrypted ones; the join role
// applied by a real join and not to people already there; an untitled menu headed in each viewer's
// language; a post the server refuses named by its missing permission, with nothing left behind.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  permissionMask,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'

const admin = adminClient()
let owner: SpecUser
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let secret: SeededServer
const roleIds: Record<string, string> = {}

async function insertRoles(serverId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  // A bulk insert sends null for keys a row lacks, not the column default.
  const full = rows.map((r) => ({ server_id: serverId, self_assignable: false, self_assign_group: null, self_assign_note: null, ...r }))
  const { data, error } = await admin.from('server_roles').insert(full).select('id, name')
  if (error || !data) throw new Error(`roles: ${error?.message}`)
  for (const r of data as Array<{ id: string; name: string }>) roleIds[r.name] = r.id
}

async function holds(user: SpecUser, roleName: string): Promise<boolean> {
  const { data } = await admin.from('user_roles').select('id').eq('user_id', user.id).eq('role_id', roleIds[roleName])
  return (data ?? []).length > 0
}

const pill = (page: Page, name: string) =>
  page.locator('.role-rail .role-pill').filter({ has: page.locator('.role-pill-name', { hasText: new RegExp(`^${name}$`) }) })
const chip = (scope: Page | ReturnType<Page['locator']>, roleName: string) =>
  scope.locator(`[data-testid="role-chip-${roleIds[roleName]}"]`)

/** Clicks a chip and waits for set_my_self_assignable_role to answer. */
async function toggleChip(page: Page, scope: Page | ReturnType<Page['locator']>, roleName: string): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().includes('/rpc/set_my_self_assignable_role'))
  await chip(scope, roleName).click()
  expect((await answered).ok()).toBe(true)
}

async function postRoleMenu(page: Page, group: string, title: string): Promise<void> {
  await composer(page).click()
  await composer(page).pressSequentially('/rolemenu', { delay: 20 })
  await page.keyboard.press('Enter')
  const form = page.locator('[data-testid="role-menu-create"]')
  await expect(form).toBeVisible({ timeout: 15000 })
  await form.locator('[data-testid="role-menu-group"]').selectOption(group)
  await form.locator('[data-testid="role-menu-title"]').fill(title)
  await page.locator('[data-testid="role-menu-post"]').click()
  await expect(form).toHaveCount(0, { timeout: 15000 })
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'sro')
  alice = await createUser(admin, 'sra')
  bob = await createUser(admin, 'srb')
  server = await seedServer(admin, owner, `Pick roles ${owner.username}`)
  await addMember(admin, alice, server.id)
  await insertRoles(server.id, [
    { name: 'Red', position: 1, color: '#e11d48', permissions: '0' },
    { name: 'Blue', position: 2, color: '#2563eb', permissions: '0', self_assignable: true, self_assign_group: 'Colours', self_assign_note: 'Calm' },
    { name: 'Mods', position: 10, color: '#16a34a', permissions: String(permissionMask(['VIEW_CHANNEL', 'MANAGE_MESSAGES'])) },
    { name: 'Newcomer', position: 1, color: '#a855f7', permissions: '0' },
  ])

  secret = await seedServer(admin, owner, `Pick roles E2EE ${owner.username}`)
  await addMember(admin, alice, secret.id)
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: secret.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption floor: ${error.message}`)
  await insertRoles(secret.id, [
    { name: 'Teal', position: 1, color: '#0d9488', permissions: '0', self_assignable: true, self_assign_group: 'Colours' },
  ])
})

test.afterAll(async () => {
  await deleteUser(admin, bob)
  await deleteUser(admin, alice)
  await deleteUser(admin, owner)
})

test('the owner makes a role pickable, and a member takes and drops it from the server menu', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext()
  const aliceContext = await browser.newContext()
  try {
    const ownerPage = await ownerContext.newPage()
    await signIn(ownerPage, owner)
    await ownerPage.goto(`/server/${server.id}?section=roles`)
    await expect(ownerPage.locator('.role-rail .role-pill').first()).toBeVisible({ timeout: 30000 })

    await test.step('a role with extra permissions shows why it cannot be picked', async () => {
      await pill(ownerPage, 'Mods').click()
      await ownerPage.locator('[data-testid="role-self-assignable"]').click()
      await expect(ownerPage.locator('[data-testid="role-self-assign-warning"]')).toContainText('permissions @everyone lacks')
      await ownerPage.locator('[data-testid="role-self-assignable"]').click()
      await expect(ownerPage.locator('[data-testid="role-self-assign-warning"]')).toHaveCount(0)
    })

    await test.step('Red becomes pickable under Colours', async () => {
      await pill(ownerPage, 'Red').click()
      await ownerPage.locator('[data-testid="role-self-assignable"]').click()
      await expect(ownerPage.locator('[data-testid="role-self-assign-warning"]')).toHaveCount(0)
      await ownerPage.locator('[data-testid="role-self-assign-group"]').fill('Colours')
      await ownerPage.locator('[data-testid="role-self-assign-note"]').fill('Loud')
      const patched = ownerPage.waitForResponse((r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH')
      await ownerPage.locator('.editor-footer .save-btn').click()
      expect((await patched).ok()).toBe(true)
      const { data } = await admin.from('server_roles').select('self_assignable, self_assign_group, self_assign_note').eq('id', roleIds.Red).single()
      expect(data).toEqual({ self_assignable: true, self_assign_group: 'Colours', self_assign_note: 'Loud' })
    })

    const alicePage = await aliceContext.newPage()
    await signIn(alicePage, alice)
    await openChannel(alicePage, server.id, server.generalChannelId)
    await alicePage.locator('.channel-sidebar .server-name').click()
    await alicePage.locator('[data-testid="server-pick-roles"]').click()
    const picker = alicePage.locator('[data-testid="role-picker"]')
    await expect(picker).toBeVisible({ timeout: 15000 })

    await test.step('the picker lists Red and Blue, not Mods or Newcomer', async () => {
      await expect(chip(picker, 'Red')).toBeVisible({ timeout: 15000 })
      await expect(chip(picker, 'Blue')).toContainText('Calm')
      await expect(chip(picker, 'Mods')).toHaveCount(0)
      await expect(chip(picker, 'Newcomer')).toHaveCount(0)
    })

    await test.step('taking and dropping a role', async () => {
      await toggleChip(alicePage, picker, 'Red')
      await expect(chip(picker, 'Red')).toHaveAttribute('aria-checked', 'true')
      expect(await holds(alice, 'Red')).toBe(true)
      await toggleChip(alicePage, picker, 'Red')
      await expect(chip(picker, 'Red')).toHaveAttribute('aria-checked', 'false')
      expect(await holds(alice, 'Red')).toBe(false)
    })

    await test.step('the server refuses a role that is not pickable', async () => {
      const client = await userClient(alice)
      const { error } = await client.rpc('set_my_self_assignable_role', { p_role_id: roleIds.Mods, p_on: true })
      expect(error?.message).toContain('NOT_SELF_ASSIGNABLE')
    })
  } finally {
    await aliceContext.close()
    await ownerContext.close()
  }
})

test('/rolemenu posts a card a member toggles their roles from', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext()
  const aliceContext = await browser.newContext()
  try {
    const ownerPage = await ownerContext.newPage()
    await signIn(ownerPage, owner)
    await openChannel(ownerPage, server.id, server.generalChannelId)
    await postRoleMenu(ownerPage, 'Colours', 'Pick a colour')
    await expect(messageList(ownerPage).locator('[data-testid="role-menu-card"]').filter({ hasText: 'Pick a colour' }))
      .toBeVisible({ timeout: 30000 })

    const { data: rows } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
      .order('created_at', { ascending: false }).limit(1)
    const content = rows?.[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'role_menu', serverId: server.id, group: 'Colours', title: 'Pick a colour' })
    expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Pick a colour: ') })

    const alicePage = await aliceContext.newPage()
    await signIn(alicePage, alice)
    await openChannel(alicePage, server.id, server.generalChannelId)
    const card = messageList(alicePage).locator('[data-testid="role-menu-card"]').filter({ hasText: 'Pick a colour' })
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(chip(card, 'Blue')).toBeVisible({ timeout: 15000 })
    await toggleChip(alicePage, card, 'Blue')
    await expect(chip(card, 'Blue')).toHaveAttribute('aria-checked', 'true')
    expect(await holds(alice, 'Blue')).toBe(true)
  } finally {
    await aliceContext.close()
    await ownerContext.close()
  }
})

test('an untitled role menu is headed in each viewer\'s language', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext()
  const readerContext = await browser.newContext()
  const reader = await createUser(admin, 'srf')
  try {
    await addMember(admin, reader, server.id)
    const { error } = await admin.from('profiles').update({ locale: 'fr' }).eq('id', reader.id)
    if (error) throw new Error(`reader locale: ${error.message}`)
    const channelId = await addChannel(admin, server, 'untitled')

    const ownerPage = await ownerContext.newPage()
    await signIn(ownerPage, owner)
    await openChannel(ownerPage, server.id, channelId)
    await postRoleMenu(ownerPage, 'Colours', '')
    await expect(messageList(ownerPage).getByTestId('role-menu-card')).toContainText('Pick your roles', { timeout: 30000 })
    const { data: rows } = await admin.from('messages').select('content').eq('channel_id', channelId)
    const content = rows?.[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'role_menu', serverId: server.id, group: 'Colours' })
    expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Pick your roles: ') })

    const readerPage = await readerContext.newPage()
    await signIn(readerPage, reader)
    await openChannel(readerPage, server.id, channelId)
    const card = messageList(readerPage).getByTestId('role-menu-card')
    await expect(card.getByRole('heading')).toHaveText('Choisis tes rôles', { timeout: 30000 })
  } finally {
    await readerContext.close()
    await ownerContext.close()
    await deleteUser(admin, reader)
  }
})

test('a role menu the server refuses says which permission is missing', async ({ page }) => {
  test.setTimeout(120_000)
  const channelId = await addChannel(admin, server, 'refused')
  await signIn(page, owner)
  await openChannel(page, server.id, channelId)
  let inserts = 0
  await page.route((url) => url.pathname.endsWith('/rest/v1/messages'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    inserts += 1
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: '42501', message: 'Missing permission: MANAGE_ROLES', details: null, hint: null }),
    })
  })
  await composer(page).click()
  await composer(page).pressSequentially('/rolemenu', { delay: 20 })
  await page.keyboard.press('Enter')
  const form = page.getByTestId('role-menu-create')
  await expect(form).toBeVisible({ timeout: 15000 })
  await form.getByTestId('role-menu-group').selectOption('Colours')
  await page.getByTestId('role-menu-post').click()
  await expect(page.locator('.Vue-Toastification__toast--error')).toHaveText(/Missing permission: MANAGE_ROLES/, { timeout: 15000 })
  await expect(form).toBeVisible()
  await expect(messageList(page).getByTestId('role-menu-card')).toHaveCount(0)
  expect(inserts).toBe(1)
})

test('a role menu works in an end-to-end encrypted channel', async ({ browser }) => {
  test.setTimeout(240_000)
  const ownerContext = await browser.newContext()
  const aliceContext = await browser.newContext()
  try {
    const alicePage = await aliceContext.newPage()
    await signIn(alicePage, alice)
    await setUpEncryption(alicePage, alice)

    const ownerPage = await ownerContext.newPage()
    await signIn(ownerPage, owner)
    await setUpEncryption(ownerPage, owner)
    await openChannel(ownerPage, secret.id, secret.generalChannelId)
    await expect(ownerPage.locator('.chat-header .channel-lock')).toBeVisible({ timeout: 30000 })
    await postRoleMenu(ownerPage, 'Colours', 'Secret colours')
    await expect(messageList(ownerPage).locator('[data-testid="role-menu-card"]').filter({ hasText: 'Secret colours' }))
      .toBeVisible({ timeout: 30000 })

    const { data: rows } = await admin.from('messages').select('content').eq('channel_id', secret.generalChannelId)
      .order('created_at', { ascending: false }).limit(1)
    expect(JSON.stringify(rows?.[0]?.content)).not.toContain('role_menu')
    expect(JSON.stringify(rows?.[0]?.content)).not.toContain('Secret colours')

    await openChannel(alicePage, secret.id, secret.generalChannelId)
    const card = messageList(alicePage).locator('[data-testid="role-menu-card"]').filter({ hasText: 'Secret colours' })
    await expect(card).toBeVisible({ timeout: 45000 })
    await toggleChip(alicePage, card, 'Teal')
    await expect(chip(card, 'Teal')).toHaveAttribute('aria-checked', 'true')
    expect(await holds(alice, 'Teal')).toBe(true)
  } finally {
    await aliceContext.close()
    await ownerContext.close()
  }
})

test('the owner picks a role for new members, and someone joining gets it', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=roles`)
  const select = page.locator('[data-testid="join-role-select"]')
  await expect(select).toBeVisible({ timeout: 30000 })
  await expect(select.locator('option', { hasText: 'Newcomer' })).toHaveCount(1)
  expect(await select.locator('option').allTextContents()).not.toContain('Admin')
  const answered = page.waitForResponse((r) => r.url().includes('/rpc/set_server_join_role'))
  await select.selectOption(roleIds.Newcomer)
  expect((await answered).ok()).toBe(true)
  const { data: settings } = await admin.from('server_settings').select('default_role_id').eq('server_id', server.id).single()
  expect(settings?.default_role_id).toBe(roleIds.Newcomer)

  expect(await holds(alice, 'Newcomer')).toBe(false)

  await admin.from('servers').update({ public: true }).eq('id', server.id)
  const joining = await userClient(bob)
  const { error } = await joining.rpc('join_public_server', { p_server_id: server.id })
  expect(error).toBeNull()
  await expect.poll(() => holds(bob, 'Newcomer'), { timeout: 15000 }).toBe(true)
})
