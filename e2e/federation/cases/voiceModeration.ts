// Voice moderation of a remote member in a hosted voice channel, against the stack's LiveKit
// (20261017100002_voice_moderation.sql, federation-backend voiceModeration.ts):
//   - the server owner server-mutes the peer's user: its connected participant loses the
//     microphone at once and its metadata says so; a new token withholds the microphone too;
//   - a server deafen also withholds every subscription; lifting both restores them;
//   - a disconnect removes the participant from the room and its presence row.
//
// Registered from roundtrip.ts after caseHostedVoiceJoin; the harness carries what this module
// needs of it.

import { createRequire } from 'node:module'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface VoiceModerationHarness {
  db: SupabaseClient
  localUrl: string
  backendRoot: string
  livekit: { url: string; key: string; secret: string; join: (token: string) => Promise<{ close: () => void }> }
  peer: { actorUrl: string; key: { privateKey: string } }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  /** HS256 access token for a local auth user. */
  bearer: (authUserId: string) => string
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  ids: { serverId: string; channelId: string; ownerAuth: string; remote: string }
}

// @livekit/protocol TrackSource.
const MICROPHONE = 2
const SCREEN_SHARE = 3

export async function caseVoiceModeration(h: VoiceModerationHarness): Promise<void> {
  console.log('\nvoice moderation of the peer\'s user in the hosted voice channel -> LiveKit follows the database')
  const { ids, assert, eq } = h
  const room = `channel-${ids.channelId}`
  const identity = `federated:${h.peer.actorUrl}`
  const load = createRequire(path.join(h.backendRoot, 'package.json'))
  const sdk = load('livekit-server-sdk')
  const rooms = new sdk.RoomServiceClient(h.livekit.url.replace(/^ws/, 'http'), h.livekit.key, h.livekit.secret)

  const token = async () => {
    const url = `${h.localUrl}/api/livekit/federated-token`
    const body = JSON.stringify({ actorId: h.peer.actorUrl, roomName: room, roomType: 'voice_channel' })
    const res = await h.post(url, h.signedHeaders(url, body, h.peer.key.privateKey, `${h.peer.actorUrl}#main-key`), body)
    const json = res.status === 200 ? JSON.parse(res.body) : null
    const claims = json?.token ? JSON.parse(Buffer.from(json.token.split('.')[1], 'base64url').toString('utf8')) : null
    return { status: res.status, token: json?.token as string | undefined, claims }
  }
  const moderate = async (path: string, payload: Record<string, unknown>) => {
    const res = await h.post(`${h.localUrl}/api/federation/voice/${path}`, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${h.bearer(ids.ownerAuth)}`,
    }, JSON.stringify({ serverId: ids.serverId, userId: ids.remote, ...payload }))
    return { status: res.status, json: JSON.parse(res.body || '{}') }
  }
  const seated = async () => (await rooms.listParticipants(room)).find((p: any) => p.identity === identity)
  const metadata = (p: any) => {
    try {
      return JSON.parse(p?.metadata ?? '{}')
    } catch {
      return {}
    }
  }

  const first = await token()
  eq(first.status, 200, 'the peer\'s user gets a token for the hosted voice channel')
  assert(first.claims?.video?.canPublishSources?.includes('microphone'), 'which publishes the microphone', JSON.stringify(first.claims?.video))
  const connection = await h.livekit.join(first.token as string)
  try {
    assert(!!(await seated()), 'LiveKit seats the peer\'s user in the room')

    const muted = await moderate('moderation', { mute: true })
    eq(muted.status, 200, 'the owner server-mutes the peer\'s user')
    eq(muted.json?.livekit?.updated, 1, 'and its participant is updated')
    const mutedSeat = await seated()
    assert(
      mutedSeat && !mutedSeat.permission?.canPublishSources?.includes(MICROPHONE)
        && mutedSeat.permission?.canPublishSources?.includes(SCREEN_SHARE),
      'the participant loses the microphone, not the screen share',
      JSON.stringify(mutedSeat?.permission),
    )
    eq(metadata(mutedSeat).serverMuted, true, 'its metadata names the server mute')
    const again = await token()
    assert(again.status === 200 && !again.claims?.video?.canPublishSources?.includes('microphone'),
      'a new token withholds the microphone as well', JSON.stringify(again.claims?.video))
    eq(JSON.parse(again.claims?.metadata ?? '{}').serverMuted, true, 'and names the mute')

    const deafened = await moderate('moderation', { deafen: true })
    eq(deafened.status, 200, 'the owner server-deafens the peer\'s user')
    eq((await seated())?.permission?.canSubscribe, false, 'the participant subscribes to nothing')

    const lifted = await moderate('moderation', { mute: false, deafen: false })
    eq(lifted.status, 200, 'the owner lifts both')
    const liftedSeat = await seated()
    assert(
      liftedSeat?.permission?.canSubscribe === true && liftedSeat.permission.canPublishSources?.includes(MICROPHONE),
      'the participant has the microphone and its subscriptions back',
      JSON.stringify(liftedSeat?.permission),
    )
    eq(metadata(liftedSeat).serverMuted, false, 'and its metadata no longer names a mute')

    const { data: row } = await h.db.from('server_voice_moderation').select('user_id')
      .eq('server_id', ids.serverId).eq('user_id', ids.remote)
    eq(row?.length ?? 0, 0, 'no moderation row is left')

    const before = await h.db.from('voice_channel_participants').select('user_id')
      .eq('channel_id', ids.channelId).eq('user_id', ids.remote)
    if (!before.data?.length) {
      await h.db.from('voice_channel_participants').insert({
        channel_id: ids.channelId, server_id: ids.serverId, user_id: ids.remote, is_federated: true,
      })
    }
    const disconnected = await moderate('move', { channelId: null })
    eq(disconnected.status, 200, 'the owner disconnects the peer\'s user')
    eq(await seated(), undefined, 'LiveKit no longer holds its participant')
    const { data: presence } = await h.db.from('voice_channel_participants').select('user_id')
      .eq('channel_id', ids.channelId).eq('user_id', ids.remote)
    eq(presence?.length ?? 0, 0, 'and its presence row is gone')
  } finally {
    connection.close()
    await h.db.from('server_voice_moderation').delete().eq('server_id', ids.serverId).eq('user_id', ids.remote)
  }
}
