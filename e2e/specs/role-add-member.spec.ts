// Journey: Server settings → Roles → Members → Add members lists a member who lacks the role when
// the role holds every earlier match (20261123500003_search_members_without_role.sql).
//
// 31 members match "zed"; Zed 01 to Zed 30 hold Crew and sort first. The search leaves Crew's
// members out before its limit, so Zed 31 is listed and can be added.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
const DOMAIN = 'roles-e2e.example'
let owner: SpecUser
let server: SeededServer
let roleId = ''
let memberIds: string[] = []
let lastId = ''
const tag = crypto.randomUUID().slice(0, 6)

test.beforeAll(async () => {
  owner = await createUser(admin, 'roleadd')
  server = await seedServer(admin, owner, `Role add ${tag}`)
  const { data: role, error: roleError } = await admin.from('server_roles')
    .insert({ server_id: server.id, name: 'Crew', position: 1, permissions: 0 }).select('id').single()
  if (roleError || !role) throw new Error(`role: ${roleError?.message}`)
  roleId = role.id

  const names = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
  const { data: profiles, error } = await admin.from('profiles')
    .insert(names.map((n) => ({ username: `zed${n}${tag}`, display_name: `Zed ${n}`, is_local: false, domain: DOMAIN })))
    .select('id, display_name')
  if (error || !profiles) throw new Error(`profiles: ${error?.message}`)
  memberIds = profiles.map((p) => p.id)
  const byName = new Map(profiles.map((p) => [p.display_name as string, p.id as string]))
  lastId = byName.get('Zed 31')!
  const joined = await admin.from('user_servers')
    .insert(memberIds.map((id) => ({ user_id: id, server_id: server.id, status: 'accepted' })))
  if (joined.error) throw new Error(`members: ${joined.error.message}`)
  const held = await admin.from('user_roles')
    .insert(names.slice(0, 30).map((n) => ({ user_id: byName.get(`Zed ${n}`), role_id: roleId, server_id: server.id })))
  if (held.error) throw new Error(`roles: ${held.error.message}`)
})

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  if (memberIds.length) await admin.from('profiles').delete().in('id', memberIds)
  await deleteUser(admin, owner)
})

test('Add members finds the member a role lacks past every member holding it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=roles`)
  await dismissAnnouncements(page)

  const crew = page.locator('.role-rail .role-pill').filter({ has: page.locator('.role-pill-name', { hasText: /^Crew$/ }) })
  await expect(crew).toBeVisible({ timeout: 30000 })
  await crew.click()
  await page.locator('.editor-tabs .tab-btn').filter({ hasText: 'Members' }).click()

  await page.getByLabel('Add members').fill('zed')
  const add = page.locator('.member-row-add')
  await expect(add).toHaveCount(1, { timeout: 15000 })
  await expect(add).toHaveAttribute('aria-label', 'Add Zed 31 to Crew')

  await add.click()
  await expect.poll(async () => (await admin.from('user_roles').select('user_id')
    .eq('role_id', roleId).eq('user_id', lastId)).data?.length ?? 0, { timeout: 15000 }).toBe(1)
})
