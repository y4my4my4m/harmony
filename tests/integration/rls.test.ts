import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminClient,
  createTestUser,
  cleanupTestUsers,
  createDirectConversation,
  sendMessage,
  createTestServer,
  createTestChannel,
  addUserToServer,
  type TestUser,
} from '../helpers/supabaseTestHelper'

let admin: SupabaseClient

let alice: TestUser
let bob: TestUser
let eve: TestUser // unauthorized third party

beforeAll(async () => {
  admin = createAdminClient()
  alice = await createTestUser(admin, { username: 'alice_rls' })
  bob = await createTestUser(admin, { username: 'bob_rls' })
  eve = await createTestUser(admin, { username: 'eve_rls' })
})

afterAll(async () => {
  await cleanupTestUsers(admin)
})

describe('RLS Policies - DM Privacy', () => {
  let conversationId: string
  let messageId: string

  beforeAll(async () => {
    conversationId = await createDirectConversation(
      alice.client,
      alice.profileId,
      bob.profileId,
    )

    messageId = await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Secret DM from Alice to Bob',
      conversationId,
    })
  })

  it('Alice can read her own DM conversation', async () => {
    const { data, error } = await alice.client
      .from('conversations')
      .select('id')
      .eq('id', conversationId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(conversationId)
  })

  it('Bob can read the DM conversation he is part of', async () => {
    const { data, error } = await bob.client
      .from('conversations')
      .select('id')
      .eq('id', conversationId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('Eve CANNOT read a DM conversation she is not part of', async () => {
    const { data, error } = await eve.client
      .from('conversations')
      .select('id')
      .eq('id', conversationId)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('Alice can read messages in her DM', async () => {
    const { data, error } = await alice.client
      .from('messages')
      .select('id, content')
      .eq('conversation_id', conversationId)

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((m: any) => m.id === messageId)).toBe(true)
  })

  it('Bob can read messages in his DM with Alice', async () => {
    const { data, error } = await bob.client
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('Eve CANNOT read messages from a DM she is not part of', async () => {
    const { data, error } = await eve.client
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('Eve CANNOT insert messages into a DM she is not part of', async () => {
    const { data, error } = await eve.client.from('messages').insert({
      user_id: eve.profileId,
      content: [{ type: 'text', content: 'I should not be here' }],
      conversation_id: conversationId,
    })

    expect(error).not.toBeNull()
  })
})

describe('RLS Policies - Server Channel Access', () => {
  let serverId: string
  let channelId: string
  let messageId: string

  beforeAll(async () => {
    serverId = await createTestServer(admin, alice.profileId, {
      name: 'RLS Test Server',
    })
    channelId = await createTestChannel(admin, serverId, { name: 'rls-test-channel' })

    // Add Bob as a member, Eve stays out
    await addUserToServer(admin, bob.profileId, serverId)

    messageId = await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Server message from Alice',
      channelId,
    })
  })

  it('server owner (Alice) can read channel messages', async () => {
    const { data, error } = await alice.client
      .from('messages')
      .select('id')
      .eq('channel_id', channelId)

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('server member (Bob) can read channel messages', async () => {
    const { data, error } = await bob.client
      .from('messages')
      .select('id')
      .eq('channel_id', channelId)

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('non-member (Eve) CANNOT read channel messages', async () => {
    const { data, error } = await eve.client
      .from('messages')
      .select('id')
      .eq('channel_id', channelId)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('non-member (Eve) CANNOT see the channel', async () => {
    const { data, error } = await eve.client
      .from('channels')
      .select('id')
      .eq('id', channelId)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('server member (Bob) can see the channel', async () => {
    const { data, error } = await bob.client
      .from('channels')
      .select('id')
      .eq('id', channelId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
})

describe('RLS Policies - Block Filtering', () => {
  it('blocked user posts are hidden from the blocker', async () => {
    // Alice blocks Eve
    await admin.from('user_blocks').upsert(
      {
        blocker_id: alice.profileId,
        blocked_user_id: eve.profileId,
        block_type: 'full',
      },
      { onConflict: 'blocker_id,blocked_user_id' },
    )

    // Eve creates a public post (via admin to bypass insert RLS)
    const { data: post } = await admin
      .from('posts')
      .insert({
        author_id: eve.profileId,
        content: [{ type: 'text', content: 'Post from Eve' }],
        visibility: 'public',
        is_local: true,
      })
      .select('id')
      .single()

    // Alice should NOT see Eve's post
    const { data: alicePosts } = await alice.client
      .from('posts')
      .select('id')
      .eq('id', post!.id)

    expect(alicePosts).toHaveLength(0)

    // Bob (who hasn't blocked Eve) SHOULD see the post
    const { data: bobPosts } = await bob.client
      .from('posts')
      .select('id')
      .eq('id', post!.id)

    expect(bobPosts!.length).toBeGreaterThanOrEqual(1)

    // Clean up
    await admin
      .from('user_blocks')
      .delete()
      .eq('blocker_id', alice.profileId)
      .eq('blocked_user_id', eve.profileId)
    await admin.from('posts').delete().eq('id', post!.id)
  })
})

describe('RLS Policies - Notifications', () => {
  it('users can only read their own notifications', async () => {
    // Create notifications for Alice and Bob via admin
    const { data: aliceNotif } = await admin
      .from('notifications')
      .insert({
        user_id: alice.profileId,
        type: 'test_rls',
        data: { test: true },
      })
      .select('id')
      .single()

    const { data: bobNotif } = await admin
      .from('notifications')
      .insert({
        user_id: bob.profileId,
        type: 'test_rls',
        data: { test: true },
      })
      .select('id')
      .single()

    // Alice can see her notification
    const { data: aliceSees } = await alice.client
      .from('notifications')
      .select('id')
      .eq('id', aliceNotif!.id)

    expect(aliceSees).toHaveLength(1)

    // Alice CANNOT see Bob's notification
    const { data: aliceSeeBob } = await alice.client
      .from('notifications')
      .select('id')
      .eq('id', bobNotif!.id)

    expect(aliceSeeBob).toHaveLength(0)

    // Clean up
    await admin.from('notifications').delete().eq('id', aliceNotif!.id)
    await admin.from('notifications').delete().eq('id', bobNotif!.id)
  })

  it('users can mark their own notifications as read', async () => {
    const { data: notif } = await admin
      .from('notifications')
      .insert({
        user_id: alice.profileId,
        type: 'test_update',
        data: {},
      })
      .select('id')
      .single()

    const { error } = await alice.client
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notif!.id)

    expect(error).toBeNull()

    // Verify
    const { data: updated } = await admin
      .from('notifications')
      .select('is_read')
      .eq('id', notif!.id)
      .single()

    expect(updated!.is_read).toBe(true)

    await admin.from('notifications').delete().eq('id', notif!.id)
  })

  it('users CANNOT update other users notifications', async () => {
    const { data: notif } = await admin
      .from('notifications')
      .insert({
        user_id: bob.profileId,
        type: 'test_update_other',
        data: {},
      })
      .select('id')
      .single()

    // Alice tries to mark Bob's notification as read
    const { data, error } = await alice.client
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notif!.id)
      .select('id')

    // Should either error or return 0 rows (RLS blocks the update)
    expect(data?.length ?? 0).toBe(0)

    await admin.from('notifications').delete().eq('id', notif!.id)
  })
})
