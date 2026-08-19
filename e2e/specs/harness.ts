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
import type { Page } from '@playwright/test'
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
  await page.goto('/login')
  await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 30000 })
  await page.locator('[data-testid="auth-email"]').fill(user.email)
  await page.locator('[data-testid="auth-password"]').fill(user.password)
  await page.locator('[data-testid="auth-submit"]').click()
  await page.waitForURL(/\/chat/, { timeout: 30000 })
  await dismissAnnouncements(page)
}
