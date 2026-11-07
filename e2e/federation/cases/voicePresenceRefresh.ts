// Voice presence of a call outlives a lost VoiceChannelLeave by at most 30 minutes.
//
//   - host side: refreshVoicePresence re-announces a local caller of the hosted server to the
//     member instance running Harmony 1.9.4+, one signed harmony:VoiceChannelJoin marked
//     harmony:refresh from a single read; on 1.9.3 the instance gets none;
//   - copy side: the peer's VoiceChannelJoin into the copy of its server stamps last_seen_at;
//     a re-announcement restamps it and, after the caller's row is gone, writes none;
//     sweep_stale_voice_participants drops the row once it goes 30 minutes unannounced, and
//     keeps it before that.

import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

interface Captured { method: string; url: string; raw: Buffer; headers: Record<string, string> }

export interface VoicePresenceRefreshContext {
  db: SupabaseClient
  peer: { captured: Captured[]; actorUrl: string; channelUrl: (id: string) => string; base: string }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  localAlice: string
  peerSends: (target: string, activity: Record<string, unknown>) => Promise<{ status: number }>
  verifySignature: (signature: string, headers: Record<string, string>, method: string, url: string, raw: Buffer) =>
    Promise<{ verified: boolean; actorUrl?: string }>
  ids: { alice: string; remote: string; hostedServer: string; hostedVoice: string; remoteRef: string; remoteVoice: string }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

export async function caseVoicePresenceRefresh(ctx: VoicePresenceRefreshContext): Promise<void> {
  console.log('\nvoice presence -> the host re-announces its callers; a copy drops a row unannounced for 30 minutes')
  const { db, peer, localUrl, backendRoot, ids, assert, eq } = ctx
  const src = (p: string) => pathToFileURL(path.join(backendRoot, 'src', p)).href
  const { refreshVoicePresence } = await import(src('services/voicePresenceRefresh.ts'))
  const { DeliveryQueue } = await import(src('activitypub/DeliveryQueue.ts'))

  // Host side. ------------------------------------------------------------------------------
  await db.from('voice_channel_participants').delete().eq('channel_id', ids.hostedVoice).eq('user_id', ids.alice)
  const seated = await db.from('voice_channel_participants').insert({
    channel_id: ids.hostedVoice, server_id: ids.hostedServer, user_id: ids.alice, joined_at: ago(5), is_federated: false,
  })
  assert(!seated.error, 'seat fx_alice in the hosted voice channel', seated.error?.message)

  const { data: remoteProfile } = await db.from('profiles').select('domain').eq('id', ids.remote).single()
  const peerDomain = String(remoteProfile?.domain ?? '').toLowerCase()
  const { data: priorInstance } = await db.from('federated_instances').select('software, version').eq('domain', peerDomain).maybeSingle()
  const runsHarmony = async (version: string) => {
    const { error } = await db.from('federated_instances')
      .upsert({ domain: peerDomain, software: 'harmony', version }, { onConflict: 'domain' })
    assert(!error, `record the peer as Harmony ${version}`, error?.message)
  }

  await runsHarmony('1.9.3')
  const older: Array<{ activity: any }> = []
  await refreshVoicePresence({
    supabase: db, instanceDomain: ctx.instanceDomain,
    deliver: async (items: Array<{ inbox: string; activity: any }>) => { older.push(...items) },
  })
  eq(older.filter((s) => s.activity?.actor === ctx.localAlice).length, 0, 'a peer on Harmony 1.9.3 gets no re-announcement')

  await runsHarmony('1.9.4')
  const rpcCalls: string[] = []
  const counted = { rpc: (fn: string, ...rest: unknown[]) => { rpcCalls.push(fn); return (db.rpc as any)(fn, ...rest) } }
  const sent: Array<{ inbox: string; activity: any; signer: string }> = []
  const result = await refreshVoicePresence({
    supabase: counted,
    instanceDomain: ctx.instanceDomain,
    deliver: async (items: Array<{ inbox: string; activity: any }>, signer: string) => {
      for (const item of items) sent.push({ ...item, signer })
      await Promise.all(items.map((item) => DeliveryQueue.deliverOnce(item.activity, item.inbox, signer)))
    },
  })
  eq(rpcCalls.join(','), 'voice_presence_refresh_targets', 'one read for the whole refresh')
  assert(result.ok, 'the refresh runs', JSON.stringify(result))
  const mine = sent.filter((s) => s.activity?.actor === ctx.localAlice)
  eq(mine.length, 1, 'fx_alice is re-announced once, to the peer\'s instance')
  eq(mine[0]?.signer, ids.alice, 'signed as fx_alice')
  eq(mine[0]?.activity?.type, 'harmony:VoiceChannelJoin', 'as a harmony:VoiceChannelJoin')
  eq(mine[0]?.activity?.['harmony:refresh'], true, 'marked as a re-announcement')
  eq(mine[0]?.activity?.object?.id, `https://${ctx.instanceDomain}/servers/${ids.hostedServer}/channels/${ids.hostedVoice}`,
    'naming the hosted voice channel')
  const arrived = peer.captured.filter((c) => {
    try { return JSON.parse(c.raw.toString('utf8')).id === mine[0]?.activity?.id } catch { return false }
  })
  eq(arrived.length, 1, 'the peer receives it once')
  if (arrived[0]) {
    const v = await ctx.verifySignature(arrived[0].headers.signature, arrived[0].headers, 'POST', arrived[0].url, arrived[0].raw)
    assert(v.verified && v.actorUrl === ctx.localAlice, 'with fx_alice\'s signature', JSON.stringify(v))
  }
  eq(sent.some((s) => s.signer === ids.remote), false, 'the peer\'s own member is not announced back to it')
  await db.from('voice_channel_participants').delete().eq('channel_id', ids.hostedVoice).eq('user_id', ids.alice)
  if (priorInstance) {
    await db.from('federated_instances').update(priorInstance).eq('domain', peerDomain)
  } else {
    await db.from('federated_instances').update({ software: null, version: null }).eq('domain', peerDomain)
  }

  // Copy side. ------------------------------------------------------------------------------
  const { data: had } = await db.from('user_servers').select('id').eq('server_id', ids.remoteRef).eq('user_id', ids.remote).maybeSingle()
  if (!had) {
    const joined = await db.from('user_servers').insert({
      server_id: ids.remoteRef, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.base).host,
    })
    assert(!joined.error, 'the peer\'s member belongs to the copy', joined.error?.message)
  }
  await db.from('voice_channel_participants').delete().eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)

  const announce = (refresh = false) => ctx.peerSends(`${localUrl}/inbox`, {
    type: 'harmony:VoiceChannelJoin',
    id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`,
    actor: peer.actorUrl,
    object: { type: 'harmony:VoiceChannel', id: peer.channelUrl(ids.remoteVoice), name: 'peer-voice' },
    ...(refresh ? { 'harmony:refresh': true } : {}),
  })
  const row = async () => (await db.from('voice_channel_participants')
    .select('last_seen_at').eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote).maybeSingle()).data
  const settle = async (want: boolean) => {
    for (let i = 0; i < 40; i++) {
      if (!!(await row()) === want) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  eq((await announce()).status, 202, 'the host\'s presence is acknowledged (202)')
  await settle(true)
  const stamped = await row()
  assert(stamped?.last_seen_at && Date.now() - Date.parse(stamped.last_seen_at) < 60_000,
    'the copy\'s row carries the announcement time', JSON.stringify(stamped))

  await db.from('voice_channel_participants').update({ last_seen_at: ago(20) })
    .eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)
  eq((await announce(true)).status, 202, 'a re-announcement is acknowledged (202)')
  let restamped = false
  for (let i = 0; i < 40 && !restamped; i++) {
    const r = await row()
    restamped = !!r?.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 60_000
    if (!restamped) await new Promise((res) => setTimeout(res, 250))
  }
  assert(restamped, 'and restamps the row', JSON.stringify(await row()))

  await db.from('voice_channel_participants').delete().eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)
  eq((await announce(true)).status, 202, 'a re-announcement after the caller left is acknowledged (202)')
  await new Promise((res) => setTimeout(res, 2_000))
  eq(await row(), null, 'and lists nobody')
  eq((await announce()).status, 202, 'a join lists the caller again')
  await settle(true)

  const sweep = async () => (await db.rpc('sweep_stale_voice_participants')).data
  await db.from('voice_channel_participants').update({ joined_at: ago(120), last_seen_at: ago(29) })
    .eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)
  await sweep()
  assert(await row(), 'a copy row announced 29 minutes ago stays')

  await db.from('voice_channel_participants').update({ last_seen_at: ago(31) })
    .eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)
  await sweep()
  eq(await row(), null, 'a copy row unannounced for 31 minutes is swept')

  eq((await announce()).status, 202, 'a join after the sweep is acknowledged (202)')
  await settle(true)
  assert(await row(), 'and lists the caller again')

  await db.from('voice_channel_participants').delete().eq('channel_id', ids.remoteVoice).eq('user_id', ids.remote)
  if (!had) await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.remote)
}
