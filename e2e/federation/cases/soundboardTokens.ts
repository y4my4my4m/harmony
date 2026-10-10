// Soundboard grants in a hosted voice channel's LiveKit token: metadata.soundboard is
// USE_SOUNDBOARD and SPEAK on the channel, metadata.soundboardExternal adds
// USE_EXTERNAL_SOUNDS (20261012300001_soundboard_external_sounds.sql). Listeners drop plays
// the sender's token withholds, so both follow the database whatever the request claims.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SoundboardTokenHarness {
  /** service_role */
  db: SupabaseClient
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  localUrl: string
  /** A local server and one of its voice channels. */
  serverId: string
  channelId: string
  /** A local user who is not yet a member of serverId. */
  member: { id: string; auth: string }
  /** HS256 access token for a local auth user. */
  bearer: (authUserId: string) => string
}

// USE_EXTERNAL_SOUNDS, bit 31.
const USE_EXTERNAL_SOUNDS = 2 ** 31

function tokenMetadata(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return JSON.parse(payload.metadata)
  } catch {
    return null
  }
}

export async function caseSoundboardTokenGrants(h: SoundboardTokenHarness): Promise<void> {
  console.log('\nsoundboard grants in a voice channel token -> the member\'s channel permissions')

  const room = `channel-${h.channelId}`
  const token = async () => {
    const res = await fetch(`${h.localUrl}/api/livekit/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.bearer(h.member.auth)}` },
      body: JSON.stringify({
        roomName: room,
        roomType: 'voice_channel',
        metadata: { soundboard: true, soundboardExternal: true },
      }),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, metadata: tokenMetadata(json?.token) }
  }

  const { data: everyone, error: roleError } = await h.db
    .from('server_roles')
    .select('id, permissions')
    .eq('server_id', h.serverId)
    .eq('is_default', true)
    .single()
  if (roleError || !everyone) throw new Error(`@everyone of ${h.serverId}: ${roleError?.message}`)

  const { error: joinError } = await h.db
    .from('user_servers')
    .insert({ server_id: h.serverId, user_id: h.member.id, status: 'accepted' })
  if (joinError) throw new Error(`membership: ${joinError.message}`)

  let overrideId: string | null = null
  try {
    h.assert((BigInt(everyone.permissions) & BigInt(USE_EXTERNAL_SOUNDS)) !== 0n,
      '@everyone of a server created after the migration holds USE_EXTERNAL_SOUNDS', everyone.permissions)

    const open = await token()
    h.eq(open.status, 200, 'a member gets a token for the voice channel')
    h.eq(open.metadata?.soundboard, true, 'it grants the soundboard')
    h.eq(open.metadata?.soundboardExternal, true, 'and external sounds')

    const { data: override, error: overrideError } = await h.db
      .from('channel_permission_overrides')
      .insert({
        channel_id: h.channelId,
        target_type: 'role',
        role_id: everyone.id,
        allow_permissions: 0,
        deny_permissions: USE_EXTERNAL_SOUNDS,
      })
      .select('id')
      .single()
    if (overrideError || !override) throw new Error(`override: ${overrideError?.message}`)
    overrideId = override.id

    const denied = await token()
    h.eq(denied.status, 200, 'a channel denying USE_EXTERNAL_SOUNDS still admits the member')
    h.eq(denied.metadata?.soundboard, true, 'still grants the soundboard')
    h.eq(denied.metadata?.soundboardExternal, false, 'but not external sounds, whatever the request claims')
  } finally {
    if (overrideId) await h.db.from('channel_permission_overrides').delete().eq('id', overrideId)
    await h.db.from('user_servers').delete().eq('server_id', h.serverId).eq('user_id', h.member.id)
  }
}
