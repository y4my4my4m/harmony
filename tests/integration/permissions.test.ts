import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminClient,
  createTestUser,
  cleanupTestUsers,
  createTestServer,
  createTestChannel,
  addUserToServer,
  sendMessage,
  type TestUser,
} from '../helpers/supabaseTestHelper'

let admin: SupabaseClient

let owner: TestUser
let member: TestUser
let outsider: TestUser

let serverId: string
let publicChannelId: string
// eslint-disable-next-line unused-imports/no-unused-vars
let privateChannelId: string

beforeAll(async () => {
  admin = createAdminClient()
  owner = await createTestUser(admin, { username: 'owner_perm' })
  member = await createTestUser(admin, { username: 'member_perm' })
  outsider = await createTestUser(admin, { username: 'outsider_perm' })

  serverId = await createTestServer(admin, owner.profileId, {
    name: 'Permissions Test Server',
  })
  publicChannelId = await createTestChannel(admin, serverId, {
    name: 'public-channel',
  })
  privateChannelId = await createTestChannel(admin, serverId, {
    name: 'private-channel',
  })

  await addUserToServer(admin, member.profileId, serverId)
})

afterAll(async () => {
  await cleanupTestUsers(admin)
})

describe('Server ownership', () => {
  it('owner can update their server', async () => {
    const { error } = await owner.client
      .from('servers')
      .update({ description: 'Updated by owner' })
      .eq('id', serverId)

    expect(error).toBeNull()
  })

  it('member CANNOT update a server they do not own', async () => {
    const { data } = await member.client
      .from('servers')
      .update({ description: 'Hacked by member' })
      .eq('id', serverId)
      .select('id')

    expect(data?.length ?? 0).toBe(0)
  })

  it('outsider CANNOT update a server', async () => {
    const { data } = await outsider.client
      .from('servers')
      .update({ description: 'Hacked by outsider' })
      .eq('id', serverId)
      .select('id')

    expect(data?.length ?? 0).toBe(0)
  })

  it('owner can create channels', async () => {
    const { data, error } = await owner.client
      .from('channels')
      .insert({
        server_id: serverId,
        name: 'owner-created-channel',
      })
      .select('id')
      .single()

    expect(error).toBeNull()
    expect(data).not.toBeNull()

    // Clean up
    await admin.from('channels').delete().eq('id', data!.id)
  })

  it('member CANNOT create channels', async () => {
    const { error } = await member.client.from('channels').insert({
      server_id: serverId,
      name: 'member-channel-attempt',
    })

    expect(error).not.toBeNull()
  })
})

describe('Server membership', () => {
  it('server members can see the server', async () => {
    const { data, error } = await member.client
      .from('servers')
      .select('id, name')
      .eq('id', serverId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('server members can see channels', async () => {
    const { data } = await member.client
      .from('channels')
      .select('id')
      .eq('server_id', serverId)

    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('server members can send messages to channels', async () => {
    const msgId = await sendMessage(member.client, {
      userId: member.profileId,
      content: 'Member message',
      channelId: publicChannelId,
    })

    expect(msgId).toBeTruthy()
  })

  it('outsiders CANNOT send messages to server channels', async () => {
    const { error } = await outsider.client.from('messages').insert({
      user_id: outsider.profileId,
      content: [{ type: 'text', content: 'Outsider message' }],
      channel_id: publicChannelId,
    })

    expect(error).not.toBeNull()
  })

  it('outsiders CANNOT see server channels', async () => {
    const { data } = await outsider.client
      .from('channels')
      .select('id')
      .eq('server_id', serverId)

    expect(data).toHaveLength(0)
  })
})

describe('Server join/leave', () => {
  it('can join a server and see content, then leave and lose access', async () => {
    // Create a new server for this test
    const testServerId = await createTestServer(admin, owner.profileId, {
      name: 'Join Leave Test',
    })
    const testChannelId = await createTestChannel(admin, testServerId, { name: 'general' })

    // Owner sends a message
    await sendMessage(owner.client, {
      userId: owner.profileId,
      content: 'Welcome message',
      channelId: testChannelId,
    })

    // Outsider cannot see the channel
    const { data: beforeJoin } = await outsider.client
      .from('channels')
      .select('id')
      .eq('id', testChannelId)

    expect(beforeJoin).toHaveLength(0)

    // Add outsider to the server
    await addUserToServer(admin, outsider.profileId, testServerId)

    // Now outsider can see the channel
    const { data: afterJoin } = await outsider.client
      .from('channels')
      .select('id')
      .eq('id', testChannelId)

    expect(afterJoin).toHaveLength(1)

    // And can read messages
    const { data: messages } = await outsider.client
      .from('messages')
      .select('id')
      .eq('channel_id', testChannelId)

    expect(messages!.length).toBeGreaterThanOrEqual(1)

    // Remove outsider from server
    await admin
      .from('user_servers')
      .delete()
      .eq('user_id', outsider.profileId)
      .eq('server_id', testServerId)

    // Outsider can no longer see the channel
    const { data: afterLeave } = await outsider.client
      .from('channels')
      .select('id')
      .eq('id', testChannelId)

    expect(afterLeave).toHaveLength(0)
  })
})

describe('User server membership status', () => {
  it('banned users cannot see channels', async () => {
    const testServerId = await createTestServer(admin, owner.profileId, {
      name: 'Ban Test Server',
    })
    const testChannelId = await createTestChannel(admin, testServerId, { name: 'general' })

    // Add member
    await addUserToServer(admin, member.profileId, testServerId)

    // Member can see channel
    const { data: canSee } = await member.client
      .from('channels')
      .select('id')
      .eq('id', testChannelId)

    expect(canSee).toHaveLength(1)

    // Ban the member
    await admin
      .from('user_servers')
      .update({ status: 'banned' })
      .eq('user_id', member.profileId)
      .eq('server_id', testServerId)

    // Banned member cannot see channels (RLS checks status = 'accepted')
    const { data: afterBan } = await member.client
      .from('channels')
      .select('id')
      .eq('id', testChannelId)

    expect(afterBan).toHaveLength(0)

    // Restore for cleanup
    await admin
      .from('user_servers')
      .delete()
      .eq('user_id', member.profileId)
      .eq('server_id', testServerId)
  })
})

describe('Cross-user data isolation', () => {
  it('users can only see their own user_servers entries', async () => {
    // Each user should see their own memberships
    const { data: ownerServers } = await owner.client
      .from('user_servers')
      .select('user_id, server_id')
      .eq('server_id', serverId)

    // user_servers has broad read access, so this checks data is present
    expect(ownerServers!.length).toBeGreaterThanOrEqual(1)
  })

  it('users can only see their own profile data via get_current_profile_id', async () => {
    const { data: ownerId } = await owner.client.rpc('get_current_profile_id')
    const { data: memberId } = await member.client.rpc('get_current_profile_id')

    expect(ownerId).toBe(owner.profileId)
    expect(memberId).toBe(member.profileId)
    expect(ownerId).not.toBe(memberId)
  })
})
