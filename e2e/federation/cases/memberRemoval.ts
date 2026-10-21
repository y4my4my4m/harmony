// Removal of a member from another instance, both directions (migration 20261025200001,
// activitypub/memberRemoval.ts).
//
// Hosted here (the private server, the peer's user an accepted member):
//   - turning federation off removes the peer's user and records the removal; the job sends the
//     peer's inbox the Group's Remove{object: member, target: <group>/members,
//     harmony:reason: federation_closed}, which a strict receiver takes as signed by the Group;
//   - with federation on again nobody is back; a kick of the readmitted member is sent the same
//     way with harmony:reason kick and the moderator's reason.
//
// Hosted by the peer (its Group, fx_carol a member):
//   - a Remove signed with the peer's user key instead of the Group's is refused 403 and keeps
//     the membership;
//   - the Group's Remove removes it and writes fx_carol a 'server_federation_closed' notice;
//   - a Reject of an earlier Join of fx_carol, replayed after she joined again, keeps the new
//     membership.
//
// The BullMQ worker is not part of this harness: the job handler is called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface MemberRemovalContext {
  db: SupabaseClient
  peer: {
    actorUrl: string
    groupUrl: string
    personalInbox: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    carol: string
    remote: string
    hostedServer: string
    remoteRef: string
  }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseMemberRemoval(ctx: MemberRemovalContext): Promise<void> {
  console.log('\nMember removal -> the Group\'s Remove when federation goes off or a member is kicked, each way')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { handleMemberRemovalJob } = await backend('queue/handlers/memberRemovalHandler.ts')
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const memberInbox = new URL(peer.personalInbox).pathname
  const removesSince = (n: number) => peer.captured.slice(n)
    .filter((c) => c.url === memberInbox && JSON.parse(c.raw.toString('utf-8')).type === 'Remove')
  const remoteMembership = async () => (await db.from('user_servers').select('status')
    .eq('server_id', ids.hostedServer).eq('user_id', ids.remote).maybeSingle()).data
  const removals = async () => (await db.from('federation_member_removals').select('id, reason, summary, delivered_at')
    .eq('server_id', ids.hostedServer).eq('profile_id', ids.remote).order('created_at', { ascending: true })).data ?? []
  const readmit = async () => {
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
    const row = await db.from('user_servers').insert({
      server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).hostname,
    })
    assert(!row.error, 'the peer\'s user is an accepted member of the hosted server', row.error?.message)
  }

  // Hosted here.
  await db.from('federation_member_removals').delete().eq('server_id', ids.hostedServer)
  const on = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!on.error, 'federate the hosted server', on.error?.message)
  await readmit()

  let n = peer.captured.length
  const off = await db.from('servers').update({ federation_enabled: false }).eq('id', ids.hostedServer)
  assert(!off.error, 'turn federation off for the hosted server', off.error?.message)
  eq(await remoteMembership(), null, 'federation off removes the peer\'s user')
  const [closed] = await removals()
  eq(closed?.reason, 'federation_closed', 'and records the removal')

  if (closed) await handleMemberRemovalJob({ type: 'delete', removal_id: closed.id })
  const [remove] = removesSince(n)
  assert(remove, 'the job sends a Remove to the member\'s inbox')
  if (remove) {
    const body = JSON.parse(remove.raw.toString('utf-8'))
    eq(body.actor, group, 'the Remove is the Group\'s')
    eq(body.object, peer.actorUrl, 'naming the member')
    eq(body.target, `${group}/members`, 'from the Group\'s members')
    eq(body['harmony:reason'], 'federation_closed', 'because federation was turned off')
    eq(body.id, `${group}/activities/removal-${closed?.id}`, 'with an id fixed per removal')
    const refusal = await strictReceiverRefusal(remove, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver takes it: signed with the key the Group publishes', refusal)
  }
  assert((await removals())[0]?.delivered_at, 'the removal is marked delivered')

  const back = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!back.error, 'turn federation on again', back.error?.message)
  eq(await remoteMembership(), null, 'federation on again brings nobody back')

  // A kick, recorded as kick_server_member records it.
  await readmit()
  await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  const kicked = await db.from('server_membership_events').insert({
    server_id: ids.hostedServer, user_id: ids.remote, event_type: 'kick', payload: { kicked_by: ids.alice, reason: 'off topic' },
  })
  assert(!kicked.error, 'kick the peer\'s user', kicked.error?.message)
  const kick = (await removals()).find((r) => r.reason === 'kick')
  eq(kick?.summary, 'off topic', 'the kick is recorded with its reason')
  n = peer.captured.length
  if (kick) await handleMemberRemovalJob({ type: 'delete', removal_id: kick.id })
  const [kickRemove] = removesSince(n)
  assert(kickRemove, 'the kick reaches the member\'s inbox as a Remove')
  if (kickRemove) {
    const body = JSON.parse(kickRemove.raw.toString('utf-8'))
    eq(`${body['harmony:reason']}/${body.summary}`, 'kick/off topic', 'naming a kick and the reason given')
    const refusal = await strictReceiverRefusal(kickRemove, localUrl, instanceDomain)
    assert(refusal === null, 'signed with the Group\'s key', refusal)
  }
  await readmit()

  // Hosted by the peer.
  const carolUrl = `https://${instanceDomain}/users/fx_carol`
  const carolInbox = `${localUrl}/users/fx_carol/inbox`
  const send = (body: string, privateKey: string, actor: string) =>
    deliver(ctx.post, ctx.signedHeaders, carolInbox, body, privateKey, `${actor}#main-key`)
  const carolMembership = async () => (await db.from('user_servers').select('id, status')
    .eq('server_id', ids.remoteRef).eq('user_id', ids.carol).maybeSingle()).data
  const joinCarol = async (joinId: string) => {
    await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.carol)
    const row = await db.from('user_servers').insert({
      server_id: ids.remoteRef, user_id: ids.carol, status: 'accepted', member_instance: instanceDomain, join_activity_id: joinId,
    })
    assert(!row.error, 'fx_carol is a member of the peer\'s Group', row.error?.message)
  }
  await db.from('notifications').delete().eq('user_id', ids.carol).eq('type', 'server_federation_closed')
  const firstJoin = `${carolUrl}/activities/join-${crypto.randomUUID()}`
  await joinCarol(firstJoin)

  const groupRemove = (id: string) => JSON.stringify({
    '@context': AS,
    id: `${peer.groupUrl}/activities/${id}`,
    type: 'Remove',
    actor: peer.groupUrl,
    object: carolUrl,
    target: `${peer.groupUrl}/members`,
    to: [carolUrl],
    published: new Date().toISOString(),
    summary: 'This server stopped taking members from other instances',
    'harmony:reason': 'federation_closed',
  })

  eq(await send(groupRemove(`removal-forged-${crypto.randomUUID()}`), peer.key.privateKey, peer.actorUrl), 403,
    'a Remove by the Group signed with a member\'s key is refused (403)')
  assert(await carolMembership(), 'and keeps fx_carol\'s membership')

  eq(await send(groupRemove(`removal-${crypto.randomUUID()}`), peer.groupKey.privateKey, peer.groupUrl), 202,
    'the Remove signed with the Group\'s key is taken (202)')
  eq(await carolMembership(), null, 'fx_carol\'s membership is removed')
  const { data: notices } = await db.from('notifications').select('type, data')
    .eq('user_id', ids.carol).eq('type', 'server_federation_closed')
  eq(notices?.length, 1, 'and she is told why')
  eq((notices?.[0]?.data as any)?.server?.ap_id, peer.groupUrl, 'naming the server')

  // She joins again; a Reject of the first Join arrives late.
  await joinCarol(`${carolUrl}/activities/join-${crypto.randomUUID()}`)
  const staleReject = JSON.stringify({
    '@context': AS,
    id: `${peer.groupUrl}/activities/reject-${crypto.randomUUID()}`,
    type: 'Reject',
    actor: peer.groupUrl,
    object: { type: 'Join', id: firstJoin, actor: carolUrl, object: peer.groupUrl },
  })
  eq(await send(staleReject, peer.groupKey.privateKey, peer.groupUrl), 202, 'a Reject of the earlier Join is taken (202)')
  assert(await carolMembership(), 'and keeps the membership the later Join made')
}
