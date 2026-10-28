// Journey: usernames that read as a mass mention or as staff are reserved, and a typed @everyone
// is the server-wide mention, never a user.
//
// - Sign-up refuses `everyone` and `admin` (20261031900001_reserved_usernames.sql).
// - A member holding Mention Everyone types @everyone without picking the suggestion: the message
//   carries the server's default role, every member is notified, and the account named everyone
//   (from before the rule) is not mentioned as a user.
// - A member without it sends the same text: it stays text and nobody is notified.
// - A user whose display name reads as @everyone or @here shows their @username, unlike the role pill.
//
// The account named everyone cannot be made through the API any more; it is renamed in SQL as
// supabase_admin with triggers off for that one statement (session_replication_role = replica).

import { execFileSync } from 'node:child_process'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  instanceDomain,
  messageList,
  openChannel,
  PASSWORD,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

// One worker: the account named everyone is one row per stack.
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const SIGNUP_EMAIL = `rsv${RUN}@e2e.harmony.local`

let owner: SpecUser
let member: SpecUser
let bystander: SpecUser
let named: SpecUser
let herebob: SpecUser
let server: SeededServer

function sql(query: string): string {
  const project = process.env.E2E_PROJECT || 'hme2e'
  const cid = execFileSync('docker', ['ps', '-q',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=db']).toString().trim()
  if (!cid) throw new Error(`no db container for project ${project}`)
  return execFileSync('docker', ['exec', '-i', cid, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-tAc', query]).toString().trim()
}

/** Mention notifications of `user` for a message. */
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

/** Types `text` key by key, never picking a suggestion, and sends it. */
async function typeAndSend(page: Page, text: string, marker: string): Promise<string> {
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 20 })
  await expect(page.getByRole('option')).toHaveCount(0, { timeout: 15000 })
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: marker }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return (await posted.getAttribute('data-message-id')) ?? ''
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'rsvo')
  member = await createUser(admin, 'rsvm')
  bystander = await createUser(admin, 'rsvb')
  named = await createUser(admin, 'rsvn')
  herebob = await createUser(admin, 'rsvh')
  server = await seedServer(admin, owner, `Reserved ${owner.username}`)
  for (const user of [member, bystander, named, herebob]) await addMember(admin, user, server.id)

  // The account named everyone, as one made before the rule: any earlier one is renamed away.
  sql(`SET session_replication_role = replica;
       UPDATE public.profiles SET username = 'everyone_' || substr(md5(id::text), 1, 8)
        WHERE is_local AND username = 'everyone';
       UPDATE public.profiles SET username = 'everyone', display_name = 'everyone' WHERE id = '${named.id}';`)
  named = { ...named, username: 'everyone', displayName: 'everyone' }
  const { error } = await admin.from('profiles').update({ display_name: 'here' }).eq('id', herebob.id)
  if (error) throw new Error(`display name: ${error.message}`)
})

test.afterAll(async () => {
  for (const user of [named, herebob, bystander, member, owner]) await deleteUser(admin, user)
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const user = data?.users?.find((u) => u.email === SIGNUP_EMAIL)
  if (user) {
    await admin.from('profiles').delete().eq('id', user.id)
    await admin.auth.admin.deleteUser(user.id)
  }
})

test('sign-up refuses a reserved username', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/register')
  await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 30000 })
  await page.locator('[data-testid="auth-email"]').fill(SIGNUP_EMAIL)
  await page.locator('[data-testid="auth-password"]').fill(PASSWORD)
  await page.locator('[data-testid="auth-submit"]').click()
  await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })

  const username = page.locator('[data-testid="profile-username"]')
  const status = page.locator('#np-username-status')
  // The form prefills the address's local part once the instance domain loads.
  await expect(username).toHaveValue(`rsv${RUN}`, { timeout: 15000 })
  await page.locator('[data-testid="profile-display-name"]').fill('Reserved')
  for (const name of ['everyone', 'Admin']) {
    await username.fill(name)
    await expect(status).toContainText('That username is reserved', { timeout: 15000 })
    await expect(page.locator('[data-testid="username-available"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="profile-submit"]')).toBeDisabled()
  }
  await username.fill(`rsv${RUN}`)
  await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
})

test('typed @everyone pings the server for a member who may, never the user named everyone', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const id = await typeAndSend(page, `@everyone standup ${RUN}`, `standup ${RUN}`)

  const { data: role } = await admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  const content = await storedContent(id)
  expect(content).toContainEqual(expect.objectContaining({ type: 'role_mention', roleId: role!.id }))
  expect(content.filter((p) => p.type === 'mention')).toEqual([])
  await expect(messageList(page).locator(`.message-item[data-message-id="${id}"] .role-mention`)).toHaveText('@everyone')
  await expect.poll(() => mentionsOf(bystander, id), { timeout: 15000 }).toBe(1)
  expect(await mentionsOf(named, id)).toBe(1)
})

test('typed @everyone and @here are text for a member who may not', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  const id = await typeAndSend(page, `@everyone and @here plain ${RUN}`, `plain ${RUN}`)

  const content = await storedContent(id)
  expect(content.filter((p) => p.type !== 'text')).toEqual([])
  expect(content.map((p) => p.text).join('')).toBe(`@everyone and @here plain ${RUN}`)
  await page.waitForTimeout(1500)
  expect(await mentionsOf(bystander, id)).toBe(0)
  expect(await mentionsOf(named, id)).toBe(0)
})

test('a user whose name reads as @everyone or @here shows a pill unlike the role pill', async ({ page }) => {
  test.setTimeout(120_000)
  const domain = await instanceDomain(admin)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const id = await typeAndSend(page, `@everyone@${domain} @${herebob.username} @everyone pills ${RUN}`, `pills ${RUN}`)

  const content = await storedContent(id)
  expect(content.filter((p) => p.type === 'mention').map((p) => p.userId)).toEqual([named.id, herebob.id])
  const message = messageList(page).locator(`.message-item[data-message-id="${id}"]`)
  const people = message.locator('.mention:not(.role-mention)')
  await expect(people).toHaveCount(2)
  await expect(people.nth(0)).toHaveText(`@everyone@${domain}`)
  await expect(people.nth(1)).toHaveText(`@${herebob.username}`)
  await expect(message.locator('.role-mention')).toHaveText('@everyone')

  await people.nth(0).click()
  await expect(page.locator('.username').filter({ hasText: `@everyone@${domain}` }).first()).toBeVisible({ timeout: 15000 })
})
