// Journey: a role named exactly like a member's username.
//
// - The suggestion list names each entry a role or a member, role first.
// - Typed without picking, @name is the member: only they are notified.
// - Picked from the list (Enter takes the first entry), it is the role: its holder is notified,
//   the member is not.
// - The role pill carries the role's colour and a marker, is announced as a role, and opens a
//   role card with the member count; the member's pill has none of these.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  assignRole,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ROLE_COLOR = '#e91e63'

let owner: SpecUser
let bob: SpecUser
let holder: SpecUser
let server: SeededServer
let roleId: string

async function mentionsOf(user: SpecUser, messageId: string): Promise<number> {
  const { data, error } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'mention')
    .eq('data->>message_id', messageId)
  if (error) throw new Error(`notifications: ${error.message}`)
  return data?.length ?? 0
}

async function storedContent(messageId: string): Promise<any[]> {
  const { data, error } = await admin.from('messages').select('content').eq('id', messageId).single()
  if (error) throw new Error(`message: ${error.message}`)
  return data.content as any[]
}

async function sendAndWait(page: Page, marker: string): Promise<string> {
  await expect(page.getByRole('option')).toHaveCount(0, { timeout: 15000 })
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: marker }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return (await posted.getAttribute('data-message-id')) ?? ''
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'rnso')
  bob = await createUser(admin, 'rnsb')
  holder = await createUser(admin, 'rnsh')
  server = await seedServer(admin, owner, `Same name ${owner.username}`)
  await addMember(admin, bob, server.id)
  await addMember(admin, holder, server.id)
  const { data, error } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name: bob.username, color: ROLE_COLOR, position: 1, permissions: 0, mentionable: true })
    .select('id')
    .single()
  if (error || !data) throw new Error(`role: ${error?.message}`)
  roleId = data.id
  await assignRole(admin, server.id, holder, roleId)
})

test.afterAll(async () => {
  for (const user of [holder, bob, owner]) await deleteUser(admin, user)
})

test('a role named like a member: typed is the member, picked is the role, and the pills differ', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  let typedId = ''
  let pickedId = ''

  await test.step('the list names the role and the member, role first', async () => {
    await composer(page).click()
    await composer(page).pressSequentially(`@${bob.username}`, { delay: 20 })
    const options = page.getByRole('option')
    await expect(options.first()).toHaveAccessibleName(`${bob.username}, role`, { timeout: 15000 })
    await expect(page.getByRole('option', { name: `${bob.displayName}, member, @${bob.username}` })).toBeVisible()
  })

  await test.step('typed without picking, @name pings the member only', async () => {
    await page.keyboard.type(` direct ${RUN}`, { delay: 10 })
    typedId = await sendAndWait(page, `direct ${RUN}`)
    const content = await storedContent(typedId)
    expect(content.filter((p) => p.type === 'role_mention')).toEqual([])
    expect(content.filter((p) => p.type === 'mention').map((p) => p.userId)).toEqual([bob.id])
    await expect.poll(() => mentionsOf(bob, typedId), { timeout: 15000 }).toBe(1)
    expect(await mentionsOf(holder, typedId)).toBe(0)
  })

  await test.step('picked from the list, it is the role', async () => {
    await composer(page).click()
    await composer(page).pressSequentially(`@${bob.username}`, { delay: 20 })
    await expect(page.getByRole('option').first()).toHaveAccessibleName(`${bob.username}, role`, { timeout: 15000 })
    await page.keyboard.press('Enter')
    await expect(composer(page).locator('.editor-role-mention')).toHaveCount(1)
    await page.keyboard.type(` picked ${RUN}`, { delay: 10 })
    pickedId = await sendAndWait(page, `picked ${RUN}`)
    const content = await storedContent(pickedId)
    expect(content).toContainEqual(expect.objectContaining({ type: 'role_mention', roleId }))
    expect(content.filter((p) => p.type === 'mention')).toEqual([])
    await expect.poll(() => mentionsOf(holder, pickedId), { timeout: 15000 }).toBe(1)
    expect(await mentionsOf(bob, pickedId)).toBe(0)
  })

  await test.step('the pills look and read differently', async () => {
    const person = messageList(page).locator(`.message-item[data-message-id="${typedId}"] .mention`)
    const role = messageList(page).locator(`.message-item[data-message-id="${pickedId}"] .role-mention`)
    await expect(person).toHaveCount(1)
    await expect(person).not.toHaveClass(/role-mention/)
    await expect(person.locator('.role-mention-dot')).toHaveCount(0)
    await expect(person).not.toHaveAccessibleName(/role/)

    await expect(role).toHaveAccessibleName(`@${bob.username}, role`)
    await expect(role.locator('.role-mention-dot')).toHaveCount(1)
    await expect(role).toHaveCSS('color', 'rgb(233, 30, 99)')
    expect(await person.evaluate((el) => getComputedStyle(el).color)).not.toBe('rgb(233, 30, 99)')
  })

  await test.step('the role pill opens a role card, not a person card', async () => {
    await messageList(page).locator(`.message-item[data-message-id="${pickedId}"] .role-mention`).click()
    const card = page.getByRole('dialog', { name: `Role ${bob.username}` })
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId('role-mention-card-detail')).toHaveText('1 member', { timeout: 10000 })
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })
})
