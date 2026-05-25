import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminClient,
  createTestUser,
  cleanupTestUsers,
  createDirectConversation,
  createTestServer,
  createTestChannel,
  addUserToServer,
  type TestUser,
} from '../helpers/supabaseTestHelper'

let admin: SupabaseClient

let alice: TestUser
let bob: TestUser

beforeAll(async () => {
  admin = createAdminClient()
  alice = await createTestUser(admin, { username: 'alice_notif' })
  bob = await createTestUser(admin, { username: 'bob_notif' })
})

afterAll(async () => {
  await admin.from('notifications').delete().eq('type', 'dm')
  await admin.from('notifications').delete().eq('type', 'mention')
  await admin.from('notifications').delete().eq('type', 'test_notif')
  if (alice?.profileId) {
    await admin.from('user_view_contexts').delete().eq('user_id', alice.profileId)
  }
  if (bob?.profileId) {
    await admin.from('user_view_contexts').delete().eq('user_id', bob.profileId)
  }
  await cleanupTestUsers(admin)
})

describe('send_notification RPC', () => {
  it('creates a notification for the recipient', async () => {
    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'test_notif',
      to_user_ids: [bob.profileId],
      notification_data: { message: 'Hello from test' },
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toHaveLength(1)

    // Verify the notification was created
    const { data: notif } = await admin
      .from('notifications')
      .select('*')
      .eq('id', data![0])
      .single()

    expect(notif).not.toBeNull()
    expect(notif!.user_id).toBe(bob.profileId)
    expect(notif!.type).toBe('test_notif')

    await admin.from('notifications').delete().eq('id', data![0])
  })

  it('does NOT create a notification when sending to yourself', async () => {
    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'test_notif',
      to_user_ids: [alice.profileId],
      notification_data: { message: 'Self message' },
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('skips notification when recipient has blocked the sender', async () => {
    // Bob blocks Alice
    await admin.from('user_blocks').upsert(
      {
        blocker_id: bob.profileId,
        blocked_user_id: alice.profileId,
        block_type: 'full',
      },
      { onConflict: 'blocker_id,blocked_user_id' },
    )

    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'test_notif',
      to_user_ids: [bob.profileId],
      notification_data: { message: 'From blocked user' },
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toHaveLength(0)

    // Clean up block
    await admin
      .from('user_blocks')
      .delete()
      .eq('blocker_id', bob.profileId)
      .eq('blocked_user_id', alice.profileId)
  })
})

describe('View context suppression (the DM notification bug)', () => {
  let conversationId: string

  beforeAll(async () => {
    conversationId = await createDirectConversation(
      alice.client,
      alice.profileId,
      bob.profileId,
    )
  })

  it('sync_view_context_from_presence writes to user_view_contexts', async () => {
    // Bob is currently viewing the conversation with Alice
    const { error } = await bob.client.rpc('sync_view_context_from_presence', {
      p_view_type: 'dm',
      p_conversation_id: conversationId,
    })

    expect(error).toBeNull()

    // Verify the view context was written with the correct profile ID
    const { data } = await admin
      .from('user_view_contexts')
      .select('*')
      .eq('user_id', bob.profileId)
      .single()

    expect(data).not.toBeNull()
    expect(data!.view_type).toBe('dm')
    expect(data!.conversation_id).toBe(conversationId)
  })

  it('is_user_viewing_context returns true when user is viewing the DM', async () => {
    // Ensure Bob's view context is set
    await admin.from('user_view_contexts').upsert(
      {
        user_id: bob.profileId,
        view_type: 'dm',
        conversation_id: conversationId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    // Directly test the function via SQL (using admin RPC won't work,
    // so we call it via a raw query through the service role)
    const { data, error } = await admin.rpc('is_user_viewing_context', {
      p_user_id: bob.profileId,
      p_conversation_id: conversationId,
    })

    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('is_user_viewing_context returns false when user is viewing a different context', async () => {
    const fakeConversationId = '00000000-0000-0000-0000-000000000000'

    const { data, error } = await admin.rpc('is_user_viewing_context', {
      p_user_id: bob.profileId,
      p_conversation_id: fakeConversationId,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('is_user_viewing_context returns false when no view context exists', async () => {
    // Clear Alice's view context
    await admin.from('user_view_contexts').delete().eq('user_id', alice.profileId)

    const { data, error } = await admin.rpc('is_user_viewing_context', {
      p_user_id: alice.profileId,
      p_conversation_id: conversationId,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('send_notification SUPPRESSES when recipient is viewing the conversation', async () => {
    // Set Bob as viewing the conversation
    await admin.from('user_view_contexts').upsert(
      {
        user_id: bob.profileId,
        view_type: 'dm',
        conversation_id: conversationId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    // Alice sends a notification to Bob for this conversation
    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'dm',
      to_user_ids: [bob.profileId],
      notification_data: { message: 'New DM' },
      conversation_id: conversationId,
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    // The notification should be SUPPRESSED because Bob is viewing the conversation
    expect(data).toHaveLength(0)
  })

  it('send_notification CREATES notification when recipient is NOT viewing the conversation', async () => {
    // Clear Bob's view context
    await admin.from('user_view_contexts').delete().eq('user_id', bob.profileId)

    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'dm',
      to_user_ids: [bob.profileId],
      notification_data: { message: 'New DM while away' },
      conversation_id: conversationId,
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)

    // Clean up
    if (data && data.length > 0) {
      await admin.from('notifications').delete().eq('id', data[0])
    }
  })

  it('send_notification CREATES notification when recipient is viewing a DIFFERENT conversation', async () => {
    // Bob is viewing a different conversation
    const otherConversationId = '00000000-0000-0000-0000-999999999999'
    await admin.from('user_view_contexts').upsert(
      {
        user_id: bob.profileId,
        view_type: 'dm',
        conversation_id: otherConversationId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'dm',
      to_user_ids: [bob.profileId],
      notification_data: { message: 'DM to different convo' },
      conversation_id: conversationId,
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)

    // Clean up
    if (data && data.length > 0) {
      await admin.from('notifications').delete().eq('id', data[0])
    }
    await admin.from('user_view_contexts').delete().eq('user_id', bob.profileId)
  })
})

describe('Channel notification suppression', () => {
  let serverId: string
  let channelId: string

  beforeAll(async () => {
    serverId = await createTestServer(admin, alice.profileId, {
      name: 'Notif Test Server',
    })
    channelId = await createTestChannel(admin, serverId, { name: 'notif-test' })
    await addUserToServer(admin, bob.profileId, serverId)
  })

  it('suppresses notification when recipient is viewing the channel', async () => {
    await admin.from('user_view_contexts').upsert(
      {
        user_id: bob.profileId,
        view_type: 'server_channel',
        server_id: serverId,
        channel_id: channelId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'mention',
      to_user_ids: [bob.profileId],
      notification_data: { message: '@bob check this out' },
      server_id: serverId,
      channel_id: channelId,
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toHaveLength(0)

    await admin.from('user_view_contexts').delete().eq('user_id', bob.profileId)
  })

  it('creates notification when recipient is in a different channel', async () => {
    const otherChannelId = await createTestChannel(admin, serverId, { name: 'other-channel' })

    await admin.from('user_view_contexts').upsert(
      {
        user_id: bob.profileId,
        view_type: 'server_channel',
        server_id: serverId,
        channel_id: otherChannelId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    const { data, error } = await admin.rpc('send_notification', {
      p_notification_type: 'mention',
      to_user_ids: [bob.profileId],
      notification_data: { message: '@bob in other channel' },
      server_id: serverId,
      channel_id: channelId,
      from_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)

    if (data && data.length > 0) {
      await admin.from('notifications').delete().eq('id', data[0])
    }
    await admin.from('user_view_contexts').delete().eq('user_id', bob.profileId)
  })
})
