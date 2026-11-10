// What one row or request may name, through PostgREST under RLS and the backend's routes
// (migration 20261110100001).
//
//   - a message names one room: a stranger naming a room of their own writes nothing into a
//     channel, a DM or a thread, no job leaves, and a block holds;
//   - a reaction's room is its message's, and its reactor and image are not the client's to state;
//   - Drive names rooms the owner reads;
//   - a banned or pending row reads no roster or roles, and pending reads the server it asked for;
//   - a Group read signed over no (request-target) is anonymous with or without Signature-Input;
//   - voice_channel_announce speaks only as its caller, on a copy.

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RoomBoundariesContext {
  db: SupabaseClient
  peer: { actorUrl: string; key: { privateKey: string } }
  localUrl: string
  get: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  asUser: (authUserId: string) => SupabaseClient
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    carol: string
    carolAuth: string
    hostedServer: string
    hostedChannel: string
    hostedSecret: string
    dm: string
    remoteRef: string
    remoteChannel: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const text = (t: string) => [{ type: 'text', text: t }]

export async function caseRoomBoundaries(ctx: RoomBoundariesContext): Promise<void> {
  console.log('\nRoom boundaries -> one row names one room, and server topics speak for the database')
  const { db, peer, ids, localUrl, assert, eq } = ctx
  const carol = ctx.asUser(ids.carolAuth)
  const alice = ctx.asUser(ids.aliceAuth)
  const bob = ctx.asUser(ids.bobAuth)

  const made: { servers: string[]; messages: string[]; thread?: string; files: string[]; conversation?: string } = {
    servers: [], messages: [], files: [],
  }
  const broadcasts = async (topic: string): Promise<any[]> =>
    ((await db.rpc('hmfed_broadcasts', { p_topic: topic })).data ?? []) as any[]

  try {
    const server = crypto.randomUUID()
    const channel = crypto.randomUUID()
    const conversation = (await carol.rpc('create_or_get_direct_conversation', { user1_uuid: ids.carol, user2_uuid: ids.bob })).data as string
    assert(conversation, 'fx_carol has a conversation of her own')
    made.conversation = conversation
    made.servers.push(server)
    const seeded = await db.from('servers').insert({ id: server, name: 'carol room', owner: ids.carol })
    assert(!seeded.error, 'and a server', seeded.error?.message)
    await db.from('user_servers').upsert({ server_id: server, user_id: ids.carol, status: 'accepted' }, { onConflict: 'server_id,user_id' })
    const seededChannel = await db.from('channels').insert({ id: channel, server_id: server, name: 'carol channel', type: 0 })
    assert(!seededChannel.error, 'and a channel', seededChannel.error?.message)

    // One room per message. ---------------------------------------------------------------------
    const countIn = async (column: 'channel_id' | 'conversation_id' | 'thread_id', id: string) =>
      (await db.from('messages').select('id', { count: 'exact', head: true }).eq(column, id).eq('user_id', ids.carol)).count

    const intoChannel = await carol.from('messages').insert({
      channel_id: ids.hostedChannel, conversation_id: conversation, user_id: ids.carol, content: text('forged in general'),
    }).select('id')
    assert(intoChannel.error, 'a stranger naming her conversation writes nothing into a channel', intoChannel.data)
    eq(await countIn('channel_id', ids.hostedChannel), 0, 'and no row is there')

    const intoSecret = await carol.from('messages').insert({
      channel_id: ids.hostedSecret, conversation_id: conversation, user_id: ids.carol, content: text('forged in secret'),
    }).select('id')
    assert(intoSecret.error, 'nor into a channel @everyone cannot view', intoSecret.data)

    const intoDm = await carol.from('messages').insert({
      channel_id: channel, conversation_id: ids.dm, user_id: ids.carol, content: text('forged in the DM'),
    }).select('id')
    assert(intoDm.error, 'naming her own channel writes nothing into another\'s DM', intoDm.data)
    eq(await countIn('conversation_id', ids.dm), 0, 'and no row is there')

    const parent = (await db.from('messages').select('id').eq('channel_id', ids.hostedChannel).eq('user_id', ids.alice).limit(1)).data?.[0]?.id
    const thread = crypto.randomUUID()
    made.thread = thread
    const madeThread = await db.from('threads').insert({ id: thread, channel_id: ids.hostedChannel, parent_message_id: parent, name: 'rooms', created_by: ids.alice })
    assert(!madeThread.error, 'a thread of fx_alice\'s', madeThread.error?.message)
    const intoThread = await carol.from('messages').insert({
      conversation_id: conversation, thread_id: thread, user_id: ids.carol, content: text('forged in the thread'),
    }).select('id')
    assert(intoThread.error, 'naming her conversation writes nothing into a thread', intoThread.data)
    eq(await countIn('thread_id', thread), 0, 'and no row is there')

    const own = await carol.from('messages').insert({ channel_id: channel, user_id: ids.carol, content: text('in her channel') }).select('id').single()
    assert(!own.error, 'a message in her own channel is taken', own.error?.message)
    made.messages.push(own.data?.id)
    const ownDm = await carol.from('messages').insert({ conversation_id: conversation, user_id: ids.carol, content: text('in her DM') }).select('id').single()
    assert(!ownDm.error, 'and in her own conversation', ownDm.error?.message)
    made.messages.push(ownDm.data?.id)
    const aliceDm = await alice.from('messages').insert({ conversation_id: ids.dm, user_id: ids.alice, content: text('rooms: a real DM') }).select('id').single()
    assert(!aliceDm.error, 'and fx_alice\'s DM is hers to write', aliceDm.error?.message)
    made.messages.push(aliceDm.data?.id)

    // A reaction's room is its message's. --------------------------------------------------------
    const reaction = await carol.from('reactions').insert({
      message_id: own.data?.id,
      user_id: ids.carol,
      custom_emoji_content: "👍",
      channel_id: ids.hostedChannel,
      conversation_id: ids.dm,
      metadata: { federated: true, remote_emoji_url: 'https://evil.example/x.png', discord_user: { id: '1', username: 'fx_alice', display_name: 'Alice' } },
    }).select('id, channel_id, conversation_id, metadata').single()
    assert(!reaction.error, 'a reaction naming other rooms is taken', reaction.error?.message)
    eq(reaction.data?.channel_id, channel, 'under the channel of its message')
    eq(reaction.data?.conversation_id, null, 'and no conversation')
    eq(JSON.stringify(reaction.data?.metadata), '{}', 'with no metadata')
    const hit = async (topic: string) => (await broadcasts(topic)).filter((p) => p?.reaction_id === reaction.data?.id)
    eq((await hit(`dm-conversation-${ids.dm}`)).length, 0, 'the DM it named hears nothing')
    eq((await hit(`channel-messages-${ids.hostedChannel}`)).length, 0, 'nor the channel it named')
    const announced = (await hit(`channel-messages-${channel}`))[0]
    assert(announced, 'its message\'s channel hears it', announced)
    assert(announced?.display_name !== 'Alice', 'under the reactor\'s own name', announced?.display_name)
    eq(announced?.emoji_url ?? null, null, 'and no image of its choosing')

    // Drive. -------------------------------------------------------------------------------------
    const drivePath = `u/${ids.carolAuth}/rooms-${crypto.randomUUID()}.png`
    const file = await db.from('drive_files').insert({ owner_id: ids.carol, bucket: 'message_media', path: drivePath, name: 'x.png', mime_type: 'image/png', size_bytes: 1, state: 'drive' })
    assert(!file.error, 'a Drive file of fx_carol\'s', file.error?.message)
    made.files.push(drivePath)
    const part = [{ type: 'file', path: drivePath, mimeType: 'image/png', url: 'x', fileName: 'x.png' }]
    const inSecret = await db.from('messages').insert({ channel_id: ids.hostedSecret, user_id: ids.carol, content: part }).select('id').single()
    assert(!inSecret.error, 'named from a private channel', inSecret.error?.message)
    made.messages.push(inSecret.data?.id)
    const inOwn = await db.from('messages').insert({ channel_id: channel, user_id: ids.carol, content: part }).select('id').single()
    assert(!inOwn.error, 'and from her own', inOwn.error?.message)
    made.messages.push(inOwn.data?.id)
    const tree = (await carol.rpc('drive_context_tree')).data as any
    eq((tree?.servers ?? []).map((s: any) => s.name).join(), 'carol room', 'Drive names the room she reads, not the other')

    // A row that is not accepted. -----------------------------------------------------------------
    const reads = async () => ({
      server: (await carol.from('servers').select('id').eq('id', ids.hostedServer)).data?.length,
      roster: (await carol.from('user_servers').select('user_id').eq('server_id', ids.hostedServer).neq('user_id', ids.carol)).data?.length,
      roles: (await carol.from('server_roles').select('id').eq('server_id', ids.hostedServer)).data?.length,
    })
    const wasPublic = (await db.from('servers').select('public').eq('id', ids.hostedServer).single()).data?.public
    await db.from('servers').update({ public: false }).eq('id', ids.hostedServer)
    await db.from('user_servers').upsert({ server_id: ids.hostedServer, user_id: ids.carol, status: 'banned' }, { onConflict: 'server_id,user_id' })
    eq(JSON.stringify(await reads()), JSON.stringify({ server: 0, roster: 0, roles: 0 }), 'a banned row reads no server, roster or roles')
    await db.from('user_servers').update({ status: 'pending' }).eq('server_id', ids.hostedServer).eq('user_id', ids.carol)
    eq(JSON.stringify(await reads()), JSON.stringify({ server: 1, roster: 0, roles: 0 }), 'a pending row reads only the server it asked to join')
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.carol)
    await db.from('servers').update({ public: wasPublic }).eq('id', ids.hostedServer)

    // A signature over no target. ------------------------------------------------------------------
    const pageUrl = `${localUrl}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}/messages?page=1`
    const u = new URL(pageUrl)
    const date = new Date().toUTCString()
    const sig = crypto.createSign('SHA256').update([`host: ${u.host}`, `date: ${date}`].join('\n')).sign(peer.key.privateKey, 'base64')
    const noTarget: Record<string, string> = {
      Host: u.host, Date: date, Accept: 'application/activity+json',
      Signature: [`keyId="${peer.actorUrl}#main-key"`, 'algorithm="rsa-sha256"', 'headers="host date"', `signature="${sig}"`].join(','),
    }
    const anonymous = (await ctx.get(pageUrl, { Accept: 'application/activity+json' })).status
    eq((await ctx.get(pageUrl, noTarget)).status, anonymous, 'a read signed over no target is anonymous')
    eq((await ctx.get(pageUrl, { ...noTarget, 'Signature-Input': '' })).status, anonymous, 'with an empty Signature-Input too')
    eq((await ctx.get(pageUrl, ctx.signedGetHeaders(pageUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))).status, 200, 'a read signed over its target is the member\'s')

    // voice_channel_announce. -----------------------------------------------------------------------
    const topic = `voice-channels:${ids.remoteRef}`
    const restricted = (await db.rpc('channel_is_restricted', { p_channel_id: ids.remoteChannel })).data
    const voiceTopic = restricted === false ? topic : `voice-channel:${ids.remoteChannel}`
    const before = (await broadcasts(voiceTopic)).length
    const onLocal = await bob.rpc('voice_channel_announce', { p_server_id: ids.hostedServer, p_channel_id: ids.hostedChannel, p_event: 'user-joined' })
    assert(onLocal.error, 'a local server takes no announcement', onLocal.data)
    const forged = await bob.rpc('voice_channel_announce', { p_server_id: ids.remoteRef, p_channel_id: ids.remoteChannel, p_event: 'voice-moderation' })
    assert(forged.error, 'an event of the database is not announced', forged.data)
    const announcedVoice = await bob.rpc('voice_channel_announce', { p_server_id: ids.remoteRef, p_channel_id: ids.remoteChannel, p_event: 'user-joined' })
    assert(!announcedVoice.error, 'an accepted member announces on a copy', announcedVoice.error?.message)
    const newest = (await broadcasts(voiceTopic)).slice(before)
    eq(newest.find((p) => p?.event === 'user-joined')?.userId, ids.bob, 'as the caller')
    const stranger = await carol.rpc('voice_channel_announce', { p_server_id: ids.remoteRef, p_channel_id: ids.remoteChannel, p_event: 'user-joined' })
    assert(stranger.error, 'and a non-member does not', stranger.data)
  } finally {
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.carol)
    if (made.messages.length) await db.from('messages').delete().in('id', made.messages.filter(Boolean))
    if (made.thread) await db.from('threads').delete().eq('id', made.thread)
    if (made.files.length) await db.from('drive_files').delete().in('path', made.files)
    if (made.conversation) await db.from('messages').delete().eq('conversation_id', made.conversation)
    for (const id of made.servers) {
      await db.from('messages').delete().eq('user_id', ids.carol).in('channel_id', [id])
      await db.from('channels').delete().eq('server_id', id)
      await db.from('user_servers').delete().eq('server_id', id)
      await db.from('servers').delete().eq('id', id)
    }
  }
}
