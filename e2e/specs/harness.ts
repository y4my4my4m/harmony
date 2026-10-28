// Support for the journey specs in this directory.
//
// Every spec owns its actors: users are created through GoTrue's admin API and
// PostgREST as service_role, never reused between specs, so counts asserted as
// "exactly one" cannot be moved by a parallel worker.
//
// Profile id equals the auth user id: src/views/NewProfile.vue writes profiles
// that way, and src/layouts/BaseLayout.vue looks user_servers up by
// session.user.id. A profile whose id differs from its auth user id renders an
// empty server list, so the fixture users in e2e/seed.mjs, which diverge the
// two on purpose, cannot drive the chat UI.
//
// Requires the stack from e2e/stack.sh and a dev server pointed at it.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export const PASSWORD = 'e2e-spec-password-12345'

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  throw new Error(`none of ${names.join(', ')} is set - run: npm run e2e:up`)
}

// Deferred until first use. Specs hold the result at module scope, and Playwright imports
// every spec to enumerate tests, so constructing eagerly makes `--list` fail whenever the
// stack is down - which reads as "no tests" rather than "stack not running".
export function adminClient(): SupabaseClient {
  let client: SupabaseClient | undefined
  const real = (): SupabaseClient => (client ??= createClient(
    requireEnv('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
    requireEnv('E2E_SUPABASE_SERVICE_ROLE_KEY', 'TEST_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  ))
  return new Proxy({} as SupabaseClient, {
    get: (_t, prop) => {
      const value = (real() as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === 'function' ? value.bind(real()) : value
    },
  })
}

export interface SpecUser {
  id: string
  email: string
  username: string
  displayName: string
  password: string
}

let cachedDomain: string | null = null

/** profiles.domain the instance itself hands out; handle lookups filter on it. */
export async function instanceDomain(admin: SupabaseClient): Promise<string> {
  if (cachedDomain) return cachedDomain
  const { data } = await admin
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'domain')
    .maybeSingle()
  const raw = data?.config_value
  cachedDomain = (typeof raw === 'string' ? raw : String(raw ?? 'localhost')).replace(/"/g, '')
  return cachedDomain
}

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Creates a signed-up user: auth row, confirmed email, profile, notification
 * preferences. `tag` only has to be short and lowercase; usernames are
 * alphanumeric because the profile form rejects anything else.
 */
export async function createUser(admin: SupabaseClient, tag: string): Promise<SpecUser> {
  const username = `${tag}${unique()}`.toLowerCase().replace(/[^a-z0-9]/g, '')
  const email = `${username}@e2e.harmony.local`

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser ${username}: ${error?.message}`)

  const id = data.user.id
  const displayName = `Spec ${username}`
  const { error: profileError } = await admin.from('profiles').insert({
    id,
    auth_user_id: id,
    username,
    display_name: displayName,
    is_local: true,
    domain: await instanceDomain(admin),
  })
  if (profileError) throw new Error(`profile ${username}: ${profileError.message}`)

  await admin.from('notification_preferences').upsert({ user_id: id }, { onConflict: 'user_id' })

  return { id, email, username, displayName, password: PASSWORD }
}

/** Best effort: the stack is thrown away, so a failed delete is not a failure. */
export async function deleteUser(admin: SupabaseClient, user: SpecUser | undefined): Promise<void> {
  if (!user) return
  try {
    await admin.from('servers').delete().eq('owner', user.id)
    await admin.from('profiles').delete().eq('id', user.id)
    await admin.auth.admin.deleteUser(user.id)
  } catch {
    /* leftovers are harmless on an ephemeral stack */
  }
}

/**
 * A supabase-js client signed in as `user`. Its writes pass RLS and the client-write guards
 * as the app's own do; a service_role write is recorded as 'system' where that matters.
 */
export async function userClient(user: SpecUser): Promise<SupabaseClient> {
  const client = createClient(
    requireEnv('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
    requireEnv('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(`sign-in ${user.username}: ${error.message}`)
  return client
}

export interface SeededServer {
  id: string
  name: string
  generalChannelId: string
}

/**
 * A server as the UI would leave it: triggers on the insert create the default
 * channels, the default roles and the owner's role assignment.
 */
export async function seedServer(
  admin: SupabaseClient,
  owner: SpecUser,
  name: string,
): Promise<SeededServer> {
  const { data, error } = await admin
    .from('servers')
    .insert({ name, owner: owner.id, public: false })
    .select('id')
    .single()
  if (error || !data) throw new Error(`seedServer ${name}: ${error?.message}`)

  await addMember(admin, owner, data.id)

  const { data: channels, error: channelError } = await admin
    .from('channels')
    .select('id, name')
    .eq('server_id', data.id)
  if (channelError) throw new Error(`channels of ${name}: ${channelError.message}`)
  const general = channels?.find((c) => c.name === 'general')
  if (!general) throw new Error(`server ${name} has no general channel`)

  return { id: data.id, name, generalChannelId: general.id }
}

export async function addMember(
  admin: SupabaseClient,
  user: SpecUser,
  serverId: string,
): Promise<void> {
  const { error } = await admin
    .from('user_servers')
    .upsert(
      { user_id: user.id, server_id: serverId, status: 'accepted' },
      { onConflict: 'user_id,server_id' },
    )
  if (error) throw new Error(`addMember ${user.username}: ${error.message}`)
}

// Bit positions in server_roles.permissions: a subset of PERMISSION_BITS in
// src/services/RoleService.ts.
export const PERMISSION_BITS = {
  ADMINISTRATOR: 0,
  VIEW_CHANNEL: 1,
  MANAGE_CHANNELS: 2,
  MANAGE_ROLES: 3,
  VIEW_AUDIT_LOG: 5,
  MANAGE_WEBHOOKS: 6,
  MANAGE_SERVER: 7,
  CREATE_INVITE: 8,
  SEND_MESSAGES: 12,
  SEND_MESSAGES_IN_THREADS: 13,
  CREATE_PUBLIC_THREADS: 14,
  ADD_REACTIONS: 18,
  READ_MESSAGE_HISTORY: 22,
} as const

export type PermissionName = keyof typeof PERMISSION_BITS

export function permissionMask(names: PermissionName[]): number {
  return names.reduce((mask, name) => mask + 2 ** PERMISSION_BITS[name], 0)
}

/** Creates a role on the server and assigns it to `user`; returns the role id. */
export async function grantRole(
  admin: SupabaseClient,
  serverId: string,
  user: SpecUser,
  role: { name: string; position: number; permissions: PermissionName[] },
): Promise<string> {
  const { data, error } = await admin
    .from('server_roles')
    .insert({
      server_id: serverId,
      name: role.name,
      position: role.position,
      permissions: permissionMask(role.permissions),
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`role ${role.name}: ${error?.message}`)
  await assignRole(admin, serverId, user, data.id)
  return data.id
}

export async function assignRole(
  admin: SupabaseClient,
  serverId: string,
  user: SpecUser,
  roleId: string,
): Promise<void> {
  const { error } = await admin
    .from('user_roles')
    .insert({ user_id: user.id, role_id: roleId, server_id: serverId })
  if (error) throw new Error(`assign role to ${user.username}: ${error.message}`)
}

/** A text channel in the general channel's category; returns its id. */
export async function addChannel(
  admin: SupabaseClient,
  server: SeededServer,
  name: string,
): Promise<string> {
  const { data: general } = await admin
    .from('channels')
    .select('category')
    .eq('id', server.generalChannelId)
    .single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name, type: 0, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`channel ${name}: ${error?.message}`)
  return data.id
}

// Chromium fails every request in flight with ERR_NETWORK_CHANGED when a host interface
// gains or loses an address: a container starting on the same host, a veth's IPv6
// link-local address. A dev-server page load is some 630 module requests; one lost import
// leaves main.ts unevaluated and the page blank. A failed module stays failed in the
// document's module map, so a lost lazy route import breaks that route until a reload.
const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED'
// Time the app gets to show `ready` after a lost request, and the watch waits before a reload, ms.
const NETWORK_CHANGED_GRACE_MS = 3000
// Watch reloads per page; one stack start changes host addresses for some 20 s.
const NETWORK_CHANGED_RELOADS = 5

interface NetworkWatch {
  /** Time of the first request lost to a network change; 0 for none. */
  lostAt: number
  /** A load with its own recovery is in progress; the watch does not reload. */
  driven: boolean
  reloads: number
  checking: boolean
  /** Main-frame document requests started. */
  navigations: number
}

const watches = new WeakMap<Page, NetworkWatch>()

/**
 * Watches `page` for requests lost to a host network change. A page that lost its document
 * or one of the app's scripts is reloaded after the grace, unless another navigation
 * started meanwhile. A signed-in reload of /login moves on to /chat.
 */
export function watchNetworkChanges(page: Page): NetworkWatch {
  const known = watches.get(page)
  if (known) return known
  const watch: NetworkWatch = { lostAt: 0, driven: false, reloads: 0, checking: false, navigations: 0 }
  watches.set(page, watch)
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) watch.navigations++
  })
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText !== NETWORK_CHANGED) return
    if (!watch.lostAt) watch.lostAt = Date.now()
    if (watch.driven || watch.checking || watch.reloads >= NETWORK_CHANGED_RELOADS) return
    const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame()
    const appScript = request.resourceType() === 'script' && new URL(request.url()).origin === new URL(page.url()).origin
    if (!mainDocument && !appScript) return
    watch.checking = true
    const navigation = watch.navigations
    setTimeout(() => {
      // Cleared first: a request lost during the reload schedules the next one.
      watch.checking = false
      if (watch.driven || watch.navigations !== navigation) return
      watch.reloads++
      page.reload().catch(() => {
        // Page closed, or navigated during the reload.
      })
    }, NETWORK_CHANGED_GRACE_MS)
  })
  return watch
}

/**
 * page.goto(url), then waits up to `timeout` for `ready`. A load that lost a request to a
 * host network change and does not show `ready` within the grace is loaded again; reloads
 * start within twice `timeout`. Any other failure to show `ready` fails as toBeVisible does.
 */
export async function loadApp(page: Page, url: string, ready: Locator, timeout = 30000): Promise<void> {
  const watch = watchNetworkChanges(page)
  const budget = Date.now() + 2 * timeout
  watch.driven = true
  try {
    for (;;) {
      watch.lostAt = 0
      try {
        await page.goto(url)
      } catch (error) {
        if (Date.now() < budget && String(error).includes(NETWORK_CHANGED)) continue
        throw error
      }
      const deadline = Date.now() + timeout
      let lost = false
      while (Date.now() < deadline) {
        if (await ready.isVisible().catch(() => false)) return
        if (watch.lostAt && Date.now() - watch.lostAt > NETWORK_CHANGED_GRACE_MS && Date.now() < budget) {
          lost = true
          break
        }
        await page.waitForTimeout(200)
      }
      if (!lost) break
    }
  } finally {
    watch.driven = false
  }
  await expect(ready).toBeVisible({ timeout: 1000 })
}

export const messageList = (page: Page) => page.locator('[data-testid="message-list"]')
export const composer = (page: Page) =>
  page.locator('[data-testid="message-input"] .rich-text-editor')

/** Opens a channel by URL and waits for its message list. */
export async function openChannel(page: Page, serverId: string, channelId: string): Promise<void> {
  await loadApp(page, `/chat/${serverId}/${channelId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
}

/** Types into the composer, sends, and waits until the insert has returned. */
export async function sendMessage(page: Page, text: string) {
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  // A ||spoiler|| renders without its bars.
  const shown = text.replace(/\|\|/g, '')
  const posted = messageList(page).locator('.message-item').filter({ hasText: shown }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return posted
}

/** A channel's row in the open server's sidebar, by exact name. */
export const channelRow = (page: Page, name: string) =>
  page.locator('.channel-sidebar .channel-wrapper').filter({
    has: page.locator('.channel-name').getByText(name, { exact: true }),
  })

/** Opens Create Channel from the TEXT CHANNELS category's context menu. */
export async function openCreateChannel(page: Page) {
  await page
    .locator('.channel-sidebar .category-name')
    .filter({ hasText: 'TEXT CHANNELS' })
    .first()
    .click({ button: 'right' })
  await page
    .locator('.context-menu .context-menu-item')
    .filter({ hasText: 'Create Channel' })
    .click()
  const modal = page.locator('.modal-container').filter({ hasText: 'Create Channel' })
  await expect(modal).toBeVisible({ timeout: 10000 })
  return modal
}

/** Deletes a channel through its context menu and the typed confirmation. */
export async function deleteChannelFromMenu(page: Page, name: string): Promise<void> {
  await channelRow(page, name).click({ button: 'right' })
  await page
    .locator('.context-menu .context-menu-item')
    .filter({ hasText: 'Delete channel' })
    .click()
  const dialog = page.locator('.modal-container').filter({ hasText: `delete #${name}?` })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await dialog.locator('input').fill(name)
  await dialog.getByRole('button', { name: 'Delete channel' }).click()
  await expect(dialog).toBeHidden({ timeout: 30000 })
}

/** Announcements render over the whole app and swallow clicks. */
export async function dismissAnnouncements(page: Page): Promise<void> {
  const overlay = page.locator('[data-testid="announcement-overlay"]')
  if (!(await overlay.isVisible({ timeout: 2000 }).catch(() => false))) return

  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await overlay.isVisible().catch(() => false))) return
    const markAll = page.locator('[data-testid="announcement-mark-all-read"]')
    if (await markAll.isVisible({ timeout: 500 }).catch(() => false)) {
      await markAll.click()
      break
    }
    const markOne = page.locator('[data-testid="announcement-mark-read"]').first()
    if (!(await markOne.isVisible({ timeout: 500 }).catch(() => false))) break
    await markOne.click()
  }
  await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}

/** Signs in through the real login form and waits for the app shell. */
export async function signIn(page: Page, user: SpecUser): Promise<void> {
  await loadApp(page, '/login', page.locator('[data-testid="auth-email"]'))
  await page.locator('[data-testid="auth-email"]').fill(user.email)
  await page.locator('[data-testid="auth-password"]').fill(user.password)
  await page.locator('[data-testid="auth-submit"]').click()
  await page.waitForURL(/\/chat/, { timeout: 30000 })
  await dismissAnnouncements(page)
}
