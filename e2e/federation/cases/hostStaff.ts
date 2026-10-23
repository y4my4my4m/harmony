// Instance staff of the host as Trust & Safety (migration 20261027250001,
// activitypub/memberRemoval.ts, channelWriteAuthz.ts), both directions.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - suspending the peer's account removes it from the server; the job sends the peer's inbox
//     the Group's Remove{harmony:reason: suspended, harmony:staff: true}, which a strict
//     receiver takes as signed by the Group;
//   - a kick by staff (payload.staff) is sent the same way, marked as staff, with the reason;
//   - while the server is suspended, the peer user's Join is answered with a Reject and a
//     member's new message is not stored.
//
// Hosted by the peer (its Group, fx_carol a member):
//   - the Group's Remove{suspended, harmony:staff} removes fx_carol and tells her that the
//     peer's staff removed her because her account is suspended there.
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

export interface HostStaffContext {
  db: SupabaseClient
  peer: {
    base: string
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
    hostedChannel: string
    remoteRef: string
  }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseHostStaff(ctx: HostStaffContext): Promise<void> {
  console.log('\nInstance staff -> a suspended account leaves with a Remove marked as staff; a suspended server refuses Joins and posts')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { handleMemberRemovalJob } = await backend('queue/handlers/memberRemovalHandler.ts')
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const memberInbox = new URL(peer.personalInbox).pathname
  const sentSince = (n: number, type: string) => peer.captured.slice(n)
    .filter((c) => c.url === memberInbox && JSON.parse(c.raw.toString('utf-8')).type === type)
  const membership = async () => (await db.from('user_servers').select('status')
    .eq('server_id', ids.hostedServer).eq('user_id', ids.remote).maybeSingle()).data
  const removals = async () => (await db.from('federation_member_removals').select('id, reason, summary, staff, delivered_at')
    .eq('server_id', ids.hostedServer).eq('profile_id', ids.remote).order('created_at', { ascending: true })).data ?? []
  const readmit = async () => {
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
    const row = await db.from('user_servers').insert({
      server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).hostname,
    })
    assert(!row.error, 'the peer\'s user is an accepted member of the hosted server', row.error?.message)
  }
  const sendRemove = async (removalId: string) => {
    const n = peer.captured.length
    await handleMemberRemovalJob({ type: 'delete', removal_id: removalId })
    return sentSince(n, 'Remove')[0]
  }

  // Hosted here: the account is suspended.
  await db.from('federation_member_removals').delete().eq('server_id', ids.hostedServer)
  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)
  await readmit()

  const suspend = await db.from('profiles').update({ is_suspended: true, suspended_at: new Date().toISOString() }).eq('id', ids.remote)
  assert(!suspend.error, 'suspend the peer\'s user here', suspend.error?.message)
  eq(await membership(), null, 'the suspension removes the peer\'s user from the server hosted here')
  const [suspended] = await removals()
  eq(`${suspended?.reason}/${suspended?.staff}`, 'suspended/true', 'and records a removal by staff')
  const suspendedRemove = suspended ? await sendRemove(suspended.id) : undefined
  assert(suspendedRemove, 'the job sends a Remove to the member\'s inbox')
  if (suspendedRemove) {
    const body = JSON.parse(suspendedRemove.raw.toString('utf-8'))
    eq(body.actor, group, 'the Remove is the Group\'s')
    eq(`${body['harmony:reason']}/${body['harmony:staff']}`, 'suspended/true', 'naming the suspension by staff')
    const refusal = await strictReceiverRefusal(suspendedRemove, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver takes it: signed with the key the Group publishes', refusal)
  }
  const lift = await db.from('profiles').update({ is_suspended: false, suspended_at: null }).eq('id', ids.remote)
  assert(!lift.error, 'lift the suspension', lift.error?.message)

  // A staff kick, recorded as staff_remove_member records it.
  await readmit()
  await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  const kicked = await db.from('server_membership_events').insert({
    server_id: ids.hostedServer, user_id: ids.remote, event_type: 'kick',
    payload: { kicked_by: ids.alice, reason: 'raid account', staff: true },
  })
  assert(!kicked.error, 'staff kick the peer\'s user', kicked.error?.message)
  const kick = (await removals()).find((r) => r.reason === 'kick')
  eq(`${kick?.summary}/${kick?.staff}`, 'raid account/true', 'the staff kick is recorded as staff, with its reason')
  const kickRemove = kick ? await sendRemove(kick.id) : undefined
  if (kickRemove) {
    const body = JSON.parse(kickRemove.raw.toString('utf-8'))
    eq(`${body['harmony:reason']}/${body['harmony:staff']}/${body.summary}`, 'kick/true/raid account',
      'the Remove names a kick by staff and the reason')
  } else {
    assert(false, 'the staff kick reaches the member\'s inbox as a Remove')
  }

  // A suspended server, the peer's user still a member.
  await readmit()
  const off = await db.from('servers').update({ suspended_at: new Date().toISOString(), suspended_reason: 'raids' })
    .eq('id', ids.hostedServer)
  assert(!off.error, 'suspend the hosted server', off.error?.message)
  const serverInbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const fromPeer = (activity: Record<string, unknown>) => {
    const body = JSON.stringify({ '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, actor: peer.actorUrl, ...activity })
    return deliver(ctx.post, ctx.signedHeaders, serverInbox, body, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  }
  const noteId = `${peer.base}/messages/${crypto.randomUUID()}`
  eq(await fromPeer({
    type: 'Create',
    object: {
      type: 'Note', id: noteId, attributedTo: peer.actorUrl, content: '<p>still posting</p>',
      context: `${group}/channels/${ids.hostedChannel}`,
      'harmony:rawContent': [{ type: 'text', text: 'still posting' }],
    },
  }), 202, 'a member\'s message to the suspended server is taken (202)')
  eq((await db.from('messages').select('id').eq('metadata->>ap_id', noteId).maybeSingle()).data, null,
    'and not stored')

  await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  const n = peer.captured.length
  eq(await fromPeer({ type: 'Join', object: group }), 202, 'a Join of the suspended server is taken (202)')
  const [reject] = sentSince(n, 'Reject')
  eq(reject ? JSON.parse(reject.raw.toString('utf-8')).summary : null, 'This server is suspended by instance staff',
    'and answered with a Reject saying why')
  eq(await membership(), null, 'the peer\'s user is not admitted')

  const on = await db.from('servers').update({ suspended_at: null, suspended_reason: null }).eq('id', ids.hostedServer)
  assert(!on.error, 'lift the server\'s suspension', on.error?.message)

  // Hosted by the peer: its staff removed fx_carol.
  const carolUrl = `https://${instanceDomain}/users/fx_carol`
  const carolInbox = `${localUrl}/users/fx_carol/inbox`
  await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.carol)
  const joined = await db.from('user_servers').insert({
    server_id: ids.remoteRef, user_id: ids.carol, status: 'accepted', member_instance: instanceDomain,
  })
  assert(!joined.error, 'fx_carol is a member of the peer\'s Group', joined.error?.message)
  await db.from('notifications').delete().eq('user_id', ids.carol).eq('type', 'server_member_removed')

  const remove = JSON.stringify({
    '@context': AS,
    id: `${peer.groupUrl}/activities/removal-${crypto.randomUUID()}`,
    type: 'Remove',
    actor: peer.groupUrl,
    object: carolUrl,
    target: `${peer.groupUrl}/members`,
    to: [carolUrl],
    published: new Date().toISOString(),
    'harmony:reason': 'suspended',
    'harmony:staff': true,
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, carolInbox, remove, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202,
    'the Group\'s Remove by its staff is taken (202)')
  eq((await db.from('user_servers').select('id').eq('server_id', ids.remoteRef).eq('user_id', ids.carol).maybeSingle()).data, null,
    'fx_carol\'s membership is removed')
  const { data: notices } = await db.from('notifications').select('data')
    .eq('user_id', ids.carol).eq('type', 'server_member_removed')
  const data = (notices?.[0]?.data ?? {}) as Record<string, unknown>
  eq(`${data.action}/${data.staff}`, `suspended/${new URL(peer.groupUrl).host}`,
    'and she is told the peer\'s staff removed her for a suspension there')

  // The peer's staff suspend its server: the Group's Update carries harmony:suspended, and this
  // instance's copy shows it; lifting it clears it.
  const groupUpdate = (suspended: unknown) => JSON.stringify({
    '@context': [AS, { harmony: 'https://mony.lol/ns#' }],
    id: `${peer.groupUrl}/activities/update-${crypto.randomUUID()}`,
    type: 'Update',
    actor: peer.groupUrl,
    object: { id: peer.groupUrl, type: 'Group', name: 'Peer private', 'harmony:suspended': suspended },
    published: new Date().toISOString(),
  })
  const copySuspension = async () => (await db.from('servers').select('suspended_at, suspended_reason')
    .eq('id', ids.remoteRef).single()).data
  eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/inbox`,
    groupUpdate({ at: '2026-10-23T01:00:00.000Z', reason: 'raids' }), peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202,
    'the Group\'s Update naming a suspension is taken (202)')
  const suspendedCopy = await copySuspension()
  eq(`${suspendedCopy?.suspended_at ? 'suspended' : 'open'}/${suspendedCopy?.suspended_reason}`, 'suspended/raids',
    'the copy records the host\'s suspension and its reason')
  eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/inbox`, groupUpdate(null),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202, 'the Group\'s Update lifting it is taken (202)')
  eq((await copySuspension())?.suspended_at ?? null, null, 'and the copy is open again')

  await readmit()
}
