import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminClient,
  createTestUser,
  cleanupTestUsers,
  sendMessage,
  type TestUser,
} from '../helpers/supabaseTestHelper'

let admin: SupabaseClient

let alice: TestUser
let bob: TestUser
let charlie: TestUser

beforeAll(async () => {
  admin = createAdminClient()
  alice = await createTestUser(admin, { username: 'alice_conv' })
  bob = await createTestUser(admin, { username: 'bob_conv' })
  charlie = await createTestUser(admin, { username: 'charlie_conv' })
})

afterAll(async () => {
  await cleanupTestUsers(admin)
})

describe('create_or_get_direct_conversation RPC', () => {
  it('creates a new conversation between two users', async () => {
    const { data, error } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(typeof data).toBe('string')

    // Verify the conversation exists
    const { data: conv } = await admin
      .from('conversations')
      .select('id, type')
      .eq('id', data)
      .single()

    expect(conv).not.toBeNull()
    expect(conv!.type).toBe('direct')

    // Verify both participants
    const { data: participants } = await admin
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', data)

    const participantIds = participants!.map((p: any) => p.user_id)
    expect(participantIds).toContain(alice.profileId)
    expect(participantIds).toContain(bob.profileId)
  })

  it('returns the SAME conversation on subsequent calls (idempotent)', async () => {
    const { data: first } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    const { data: second } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    expect(first).toBe(second)
  })

  it('returns the same conversation regardless of argument order', async () => {
    const { data: aliceFirst } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    // Bob calls with reversed order
    const { data: bobFirst } = await bob.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: bob.profileId,
      user2_uuid: alice.profileId,
    })

    expect(aliceFirst).toBe(bobFirst)
  })

  it('creates SEPARATE conversations for different user pairs', async () => {
    const { data: aliceBob } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    const { data: aliceCharlie } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: charlie.profileId,
    })

    expect(aliceBob).not.toBe(aliceCharlie)
  })

  it('rejects creation when caller is not a participant', async () => {
    // Charlie tries to create a conversation between Alice and Bob
    const { error } = await charlie.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })

    expect(error).not.toBeNull()
    expect(error!.message).toContain('Unauthorized')
  })
})

describe('DM message flow', () => {
  let conversationId: string

  beforeAll(async () => {
    const { data } = await alice.client.rpc('create_or_get_direct_conversation', {
      user1_uuid: alice.profileId,
      user2_uuid: bob.profileId,
    })
    conversationId = data as string
  })

  it('participants can send messages to the conversation', async () => {
    const msgId = await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Hello Bob!',
      conversationId,
    })

    expect(msgId).toBeTruthy()

    // Bob can read the message
    const { data } = await bob.client
      .from('messages')
      .select('id, content')
      .eq('id', msgId)
      .single()

    expect(data).not.toBeNull()
    expect(data!.content[0].text).toBe('Hello Bob!')
  })

  it('multiple messages can be sent in a conversation', async () => {
    await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Message 1',
      conversationId,
    })

    await sendMessage(bob.client, {
      userId: bob.profileId,
      content: 'Message 2',
      conversationId,
    })

    await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Message 3',
      conversationId,
    })

    const { data } = await alice.client
      .from('messages')
      .select('id, content, user_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })

    expect(data!.length).toBeGreaterThanOrEqual(3)

    // Verify messages from both users
    const aliceMessages = data!.filter((m: any) => m.user_id === alice.profileId)
    const bobMessages = data!.filter((m: any) => m.user_id === bob.profileId)
    expect(aliceMessages.length).toBeGreaterThanOrEqual(1)
    expect(bobMessages.length).toBeGreaterThanOrEqual(1)
  })

  it('non-participant cannot send messages', async () => {
    const { error } = await charlie.client.from('messages').insert({
      user_id: charlie.profileId,
      content: [{ type: 'text', content: 'Intruder!' }],
      conversation_id: conversationId,
    })

    expect(error).not.toBeNull()
  })

  it('users can only update their own messages', async () => {
    const msgId = await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'Original message',
      conversationId,
    })

    // Alice can update her own message
    const { error: aliceUpdateErr } = await alice.client
      .from('messages')
      .update({ content: [{ type: 'text', content: 'Updated message' }] })
      .eq('id', msgId)

    expect(aliceUpdateErr).toBeNull()

    // Bob CANNOT update Alice's message
    const { data: bobUpdate } = await bob.client
      .from('messages')
      .update({ content: [{ type: 'text', content: 'Hacked' }] })
      .eq('id', msgId)
      .select('id')

    expect(bobUpdate?.length ?? 0).toBe(0)
  })

  it('users can only delete their own messages', async () => {
    const msgId = await sendMessage(alice.client, {
      userId: alice.profileId,
      content: 'To be deleted',
      conversationId,
    })

    // Bob tries to delete Alice's message - should fail silently
    const { data: bobDelete } = await bob.client
      .from('messages')
      .delete()
      .eq('id', msgId)
      .select('id')

    expect(bobDelete?.length ?? 0).toBe(0)

    // Verify the message still exists
    const { data: stillExists } = await admin
      .from('messages')
      .select('id')
      .eq('id', msgId)
      .single()

    expect(stillExists).not.toBeNull()
  })
})

describe('get_current_profile_id', () => {
  it('returns the correct profile ID for the authenticated user', async () => {
    const { data, error } = await alice.client.rpc('get_current_profile_id')

    expect(error).toBeNull()
    expect(data).toBe(alice.profileId)
  })

  it('returns different IDs for different users', async () => {
    const { data: aliceId } = await alice.client.rpc('get_current_profile_id')
    const { data: bobId } = await bob.client.rpc('get_current_profile_id')

    expect(aliceId).not.toBe(bobId)
    expect(aliceId).toBe(alice.profileId)
    expect(bobId).toBe(bob.profileId)
  })
})

describe('Block functions', () => {
  afterAll(async () => {
    // Clean up any remaining blocks
    await admin
      .from('user_blocks')
      .delete()
      .eq('blocker_id', alice.profileId)
      .eq('blocked_user_id', bob.profileId)
  })

  it('has_blocked returns false when no block exists', async () => {
    const { data, error } = await alice.client.rpc('has_blocked', {
      target_user_id: bob.profileId,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('has_blocked returns true after blocking', async () => {
    const { error: insertError } = await admin.from('user_blocks').insert({
      blocker_id: alice.profileId,
      blocked_user_id: bob.profileId,
      block_type: 'full',
    })

    expect(insertError).toBeNull()

    const { data, error } = await alice.client.rpc('has_blocked', {
      target_user_id: bob.profileId,
    })

    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('is_blocked_by returns true for the blocked user', async () => {
    const { data, error } = await bob.client.rpc('is_blocked_by', {
      target_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('is_blocked_by returns false for a non-blocked user', async () => {
    const { data, error } = await charlie.client.rpc('is_blocked_by', {
      target_user_id: alice.profileId,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })
})
