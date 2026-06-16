/**
 * Supabase integration test helper.
 *
 * Provides:
 * - Admin client (service_role) for setup/teardown that bypasses RLS
 * - Per-user clients (with real JWTs) for testing RLS policies
 * - Test user factory with automatic cleanup
 *
 * Requires local Supabase running. Env vars loaded via --env-file .env.test
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface TestUser {
  authId: string
  profileId: string
  email: string
  username: string
  client: SupabaseClient
}

const createdAuthIds: string[] = []

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing ${key}. Make sure .env.test exists and you're running via: npm run test:integration`)
  return val
}

export function createAdminClient(): SupabaseClient {
  return createClient(requireEnv('TEST_SUPABASE_URL'), requireEnv('TEST_SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function createTestUser(
  admin: SupabaseClient,
  opts: { username?: string; displayName?: string } = {},
): Promise<TestUser> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const username = opts.username || `testuser_${suffix}`
  const email = `${username}@test.harmony.local`

  let { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password: 'test-password-12345',
    email_confirm: true,
  })

  if (authError?.message?.includes('already been registered')) {
    // Look up stale auth user via profile (most reliable)
    const { data: existingProfile } = await admin
      .from('profiles')
      .select('auth_user_id')
      .eq('username', username)
      .single()

    let staleAuthId = existingProfile?.auth_user_id

    // Fallback: search auth users list
    if (!staleAuthId) {
      const { data: listData } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = listData?.users?.find((u: any) => u.email === email)
      staleAuthId = existing?.id
    }

    if (staleAuthId) {
      await cleanupSingleUser(admin, staleAuthId)
    }

    const retry = await admin.auth.admin.createUser({
      email,
      password: 'test-password-12345',
      email_confirm: true,
    })
    authData = retry.data
    authError = retry.error
  }

  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user: ${authError?.message}`)
  }

  const authId = authData.user.id
  createdAuthIds.push(authId)

  const { error: profileError } = await admin.from('profiles').upsert(
    {
      auth_user_id: authId,
      username,
      display_name: opts.displayName || username,
      domain: 'localhost',
      is_local: true,
    },
    { onConflict: 'auth_user_id' },
  )

  if (profileError) {
    throw new Error(`Failed to create profile: ${profileError.message}`)
  }

  const { data: profile, error: fetchError } = await admin
    .from('profiles')
    .select('id')
    .eq('auth_user_id', authId)
    .single()

  if (fetchError || !profile) {
    throw new Error(`Failed to fetch profile: ${fetchError?.message}`)
  }

  const userClient = createClient(requireEnv('TEST_SUPABASE_URL'), requireEnv('TEST_SUPABASE_ANON_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error: signInError } = await userClient.auth.signInWithPassword({
    email,
    password: 'test-password-12345',
  })

  if (signInError) {
    throw new Error(`Failed to sign in test user: ${signInError.message}`)
  }

  return {
    authId,
    profileId: profile.id,
    email,
    username,
    client: userClient,
  }
}

async function cleanupSingleUser(admin: SupabaseClient, authId: string): Promise<void> {
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('auth_user_id', authId)
    .single()

  if (profile?.id) {
    await admin.from('user_servers').delete().eq('user_id', profile.id)
    await admin.from('user_roles').delete().eq('user_id', profile.id)
    await admin.rpc('_test_delete_owned_servers', { p_owner_id: profile.id })
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

  await admin.auth.admin.deleteUser(authId)
}

export async function cleanupTestUsers(admin: SupabaseClient): Promise<void> {
  for (const authId of createdAuthIds) {
    await cleanupSingleUser(admin, authId)
  }
  createdAuthIds.length = 0
}

export async function createDirectConversation(
  callerClient: SupabaseClient,
  user1ProfileId: string,
  user2ProfileId: string,
): Promise<string> {
  const { data, error } = await callerClient.rpc('create_or_get_direct_conversation', {
    user1_uuid: user1ProfileId,
    user2_uuid: user2ProfileId,
  })
  if (error) throw new Error(`Failed to create conversation: ${error.message}`)
  return data as string
}

export async function sendMessage(
  client: SupabaseClient,
  opts: {
    userId: string
    content: string
    channelId?: string
    conversationId?: string
  },
): Promise<string> {
  const { data, error } = await client
    .from('messages')
    .insert({
      user_id: opts.userId,
      content: [{ type: 'text', text: opts.content }],
      channel_id: opts.channelId || null,
      conversation_id: opts.conversationId || null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to send message: ${error.message}`)
  return data.id
}

export async function createTestServer(
  admin: SupabaseClient,
  ownerProfileId: string,
  opts: { name?: string; isPublic?: boolean } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const { data, error } = await admin
    .from('servers')
    .insert({
      name: opts.name || `Test Server ${suffix}`,
      owner: ownerProfileId,
      public: opts.isPublic ?? false,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to create server: ${error.message}`)

  await admin.from('user_servers').insert({
    user_id: ownerProfileId,
    server_id: data.id,
    status: 'accepted',
  })

  return data.id
}

export async function createTestChannel(
  admin: SupabaseClient,
  serverId: string,
  opts: { name?: string } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const { data, error } = await admin
    .from('channels')
    .insert({
      server_id: serverId,
      name: opts.name || `test-channel-${suffix}`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to create channel: ${error.message}`)
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
