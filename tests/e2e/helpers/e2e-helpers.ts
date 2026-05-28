/**
 * E2E test helpers.
 *
 * Adapts patterns from tests/helpers/supabaseTestHelper.ts for Playwright E2E use.
 * Provides admin client, test user creation, and data seeding via Supabase.
 *
 * Requires local Supabase running and .env.test configured.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '../../../.env.test') })

export interface E2ETestUser {
  authId: string
  profileId: string
  email: string
  username: string
  displayName: string
  password: string
}

const TEST_PASSWORD = 'e2e-test-password-12345'

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) {
    throw new Error(
      `Missing ${key}. Copy .env.test.example → .env.test for local runs, ` +
        `or set ${key} in the environment (GitHub Actions: repo secrets TEST_SUPABASE_*).`,
    )
  }
  return val
}

export function getSupabaseUrl(): string {
  return requireEnv('TEST_SUPABASE_URL')
}

export function getSupabaseAnonKey(): string {
  return requireEnv('TEST_SUPABASE_ANON_KEY')
}

export function createAdminClient(): SupabaseClient {
  return createClient(
    requireEnv('TEST_SUPABASE_URL'),
    requireEnv('TEST_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function createE2EUser(
  admin: SupabaseClient,
  opts: { username: string; displayName?: string },
): Promise<E2ETestUser> {
  const email = `${opts.username}@e2e.harmony.local`

  // Clean up if user already exists from a previous run
  const { data: existingProfile } = await admin
    .from('profiles')
    .select('auth_user_id')
    .eq('username', opts.username)
    .maybeSingle()

  if (existingProfile?.auth_user_id) {
    await cleanupSingleUser(admin, existingProfile.auth_user_id)
  }

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    throw new Error(`Failed to create E2E auth user ${opts.username}: ${authError?.message}`)
  }

  const authId = authData.user.id

  const { error: profileError } = await admin.from('profiles').upsert(
    {
      id: authId,
      auth_user_id: authId,
      username: opts.username,
      display_name: opts.displayName || opts.username,
      domain: 'localhost',
      is_local: true,
    },
    { onConflict: 'auth_user_id' },
  )

  if (profileError) {
    throw new Error(`Failed to create E2E profile for ${opts.username}: ${profileError.message}`)
  }

  const { data: profile, error: fetchError } = await admin
    .from('profiles')
    .select('id')
    .eq('auth_user_id', authId)
    .single()

  if (fetchError || !profile) {
    throw new Error(`Failed to fetch E2E profile: ${fetchError?.message}`)
  }

  // Ensure notification_preferences exist (trigger may not fire on upsert-as-update)
  await admin.from('notification_preferences').upsert(
    { user_id: profile.id },
    { onConflict: 'user_id' },
  )

  return {
    authId,
    profileId: profile.id,
    email,
    username: opts.username,
    displayName: opts.displayName || opts.username,
    password: TEST_PASSWORD,
  }
}

async function cleanupSingleUser(admin: SupabaseClient, authId: string): Promise<void> {
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('auth_user_id', authId)
    .maybeSingle()

  if (profile?.id) {
    await admin.from('user_servers').delete().eq('user_id', profile.id)
    await admin.from('user_roles').delete().eq('user_id', profile.id)
    try {
      await admin.rpc('_test_delete_owned_servers', { p_owner_id: profile.id })
    } catch {
      // RPC may not exist in all environments
    }
    await admin.from('messages').delete().eq('user_id', profile.id)
    await admin.from('conversation_participants').delete().eq('user_id', profile.id)
    await admin.from('user_blocks').delete().eq('blocker_id', profile.id)
    await admin.from('user_blocks').delete().eq('blocked_user_id', profile.id)
    await admin.from('notifications').delete().eq('user_id', profile.id)
    await admin.from('notification_preferences').delete().eq('user_id', profile.id)
    await admin.from('user_view_contexts').delete().eq('user_id', profile.id)
    await admin.from('reactions').delete().eq('user_id', profile.id)
    await admin.from('profiles').delete().eq('id', profile.id)
  }

  try {
    await admin.auth.admin.deleteUser(authId)
  } catch {
    // User may already be deleted
  }
}

export async function cleanupE2EUsers(admin: SupabaseClient, users: E2ETestUser[]): Promise<void> {
  for (const user of users) {
    await cleanupSingleUser(admin, user.authId)
  }
}

export async function cleanupUserByEmail(admin: SupabaseClient, email: string): Promise<void> {
  const { data } = await admin.auth.admin.listUsers()
  const authUser = data?.users?.find((u) => u.email === email)
  if (authUser) {
    await cleanupSingleUser(admin, authUser.id)
  }
}

export async function seedServer(
  admin: SupabaseClient,
  ownerProfileId: string,
  opts: { name?: string; isPublic?: boolean } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const { data, error } = await admin
    .from('servers')
    .insert({
      name: opts.name || `E2E Server ${suffix}`,
      owner: ownerProfileId,
      public: opts.isPublic ?? true,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to seed server: ${error.message}`)

  await admin.from('user_servers').insert({
    user_id: ownerProfileId,
    server_id: data.id,
    status: 'accepted',
  })

  return data.id
}

export async function seedChannel(
  admin: SupabaseClient,
  serverId: string,
  opts: { name?: string } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const { data, error } = await admin
    .from('channels')
    .insert({
      server_id: serverId,
      name: opts.name || `e2e-channel-${suffix}`,
      is_private: false,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to seed channel: ${error.message}`)
  return data.id
}

export async function addUserToServer(
  admin: SupabaseClient,
  userId: string,
  serverId: string,
): Promise<void> {
  const { error } = await admin.from('user_servers').upsert(
    { user_id: userId, server_id: serverId, status: 'accepted' },
    { onConflict: 'user_id,server_id' },
  )
  if (error) throw new Error(`Failed to add user to server: ${error.message}`)
}

export async function seedConversation(
  admin: SupabaseClient,
  user1ProfileId: string,
  user2ProfileId: string,
): Promise<string> {
  // Use admin client to call the RPC
  const userClient = createClient(
    requireEnv('TEST_SUPABASE_URL'),
    requireEnv('TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // Sign in as user1 to create conversation
  const { data: profile1 } = await admin
    .from('profiles')
    .select('auth_user_id')
    .eq('id', user1ProfileId)
    .single()

  if (!profile1) throw new Error('User1 profile not found')

  const { data: authUser } = await admin.auth.admin.getUserById(profile1.auth_user_id)
  if (!authUser?.user?.email) throw new Error('User1 auth not found')

  await userClient.auth.signInWithPassword({
    email: authUser.user.email,
    password: TEST_PASSWORD,
  })

  const { data, error } = await userClient.rpc('create_or_get_direct_conversation', {
    user1_uuid: user1ProfileId,
    user2_uuid: user2ProfileId,
  })

  if (error) throw new Error(`Failed to seed conversation: ${error.message}`)
  return data as string
}
