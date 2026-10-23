// This instance's tools for a server hosted elsewhere (migration 20261027300001,
// federation-backend queue/handlers/instanceLeaveHandler.ts, activitypub/instanceServerBlocks.ts).
// The peer hosts the private Group copied here as the remote reference.
//
//   - Instance staff remove fx_bob, keeping him out: the membership goes here, and the job sends
//     the Group his own Leave, signed with his key. Nothing else reaches the peer.
//   - Instance staff block the server: fx_bob and fx_carol leave, each with a Leave to the
//     Group. The Group's relay of a member's message is then acknowledged at the copy's inbox
//     and at the shared inbox and stored nowhere; allowed again, the same relay is stored.
//
// The BullMQ worker is not part of this harness: the job handler is called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface InstanceServerToolsContext {
  db: SupabaseClient
  peer: {
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    carol: string
    remote: string
    remoteRef: string
    remoteChannel: string
  }
  asUser: (authUserId: string) => SupabaseClient
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  verifySignature: (
    signature: string, headers: Record<string, string>, method: string, p: string, body?: unknown,
  ) => Promise<{ verified: boolean; actorUrl?: string; error?: string }>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseInstanceServerTools(ctx: InstanceServerToolsContext): Promise<void> {
  console.log('\nInstance tools for a server hosted elsewhere -> removal and block send Leave; a blocked server\'s relays are dropped')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { handleInstanceLeaveJob } = await backend('queue/handlers/instanceLeaveHandler.ts')
  const staff = ctx.asUser(ids.aliceAuth)
  const groupInbox = new URL(`${peer.groupUrl}/inbox`).pathname
  const localUser = (name: string) => `https://${instanceDomain}/users/${name}`
  const leavesSince = (n: number) => peer.captured.slice(n)
    .filter((c) => c.url === groupInbox)
    .map((c) => ({ req: c, body: JSON.parse(c.raw.toString('utf-8')) }))
    .filter((d) => d.body.type === 'Leave')
  const membership = async (profileId: string) => (await db.from('user_servers').select('status')
    .eq('server_id', ids.remoteRef).eq('user_id', profileId).maybeSingle()).data
  const join = async (name: string, profileId: string, instance: string) => {
    const { error } = await db.from('user_servers').upsert(
      { server_id: ids.remoteRef, user_id: profileId, status: 'accepted', member_instance: instance },
      { onConflict: 'user_id,server_id' })
    assert(!error, `${name} is a member of the peer's Group`, error?.message)
  }
  const sendLeaves = async (reason: string) => {
    const { data } = await db.from('instance_server_leaves').select('id')
      .eq('server_id', ids.remoteRef).eq('reason', reason).is('delivered_at', null)
    for (const row of data ?? []) await handleInstanceLeaveJob({ type: 'delete', leave_id: row.id })
    return (data ?? []).length
  }

  const promoted = await db.from('profiles').update({ is_admin: true }).eq('id', ids.alice)
  assert(!promoted.error, 'fx_alice is an instance admin', promoted.error?.message)
  await db.from('instance_server_blocks').delete().eq('server_id', ids.remoteRef)
  await db.from('instance_server_keepouts').delete().eq('server_id', ids.remoteRef)
  await db.from('instance_server_leaves').delete().eq('server_id', ids.remoteRef)
  await join('fx_bob', ids.bob, instanceDomain)

  try {
    // Removal of one member from here.
    let n = peer.captured.length
    const removed = await staff.rpc('instance_remove_member', {
      p_server_id: ids.remoteRef, p_profile_id: ids.bob, p_keep_out: true, p_reason: 'spam links',
    })
    eq(JSON.stringify(removed.data), JSON.stringify({ removed: true, kept_out: true }),
      `staff remove fx_bob and keep him out${removed.error ? ` (${removed.error.message})` : ''}`)
    eq(await membership(ids.bob), null, 'his membership of the copy is gone')
    eq(await sendLeaves('removed'), 1, 'one Leave is queued for him')

    const [leave] = leavesSince(n)
    assert(leave, 'the job sends a Leave to the Group\'s inbox')
    if (leave) {
      eq(leave.body.actor, localUser('fx_bob'), 'as fx_bob')
      eq(leave.body.object, peer.groupUrl, 'naming the Group')
      const v = await ctx.verifySignature(leave.req.headers.signature, leave.req.headers, 'POST', leave.req.url, leave.req.raw)
      eq(v.actorUrl, localUser('fx_bob'), 'signed with fx_bob\'s key')
    }
    eq(leavesSince(n).length, 1, 'and only that Leave')
    const { data: delivered } = await db.from('instance_server_leaves').select('delivered_at')
      .eq('server_id', ids.remoteRef).eq('profile_id', ids.bob).single()
    assert(delivered?.delivered_at, 'the leave is marked delivered')
    const rejoin = await db.from('user_servers').insert({ server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted' })
    assert(rejoin.error?.message?.includes('KEPT_OUT_HERE'), 'he cannot rejoin from here', rejoin.error?.message)

    // Block: every member from here leaves.
    const lifted = await staff.rpc('instance_lift_keepout', { p_server_id: ids.remoteRef, p_profile_id: ids.bob })
    eq(lifted.data, true, 'staff let fx_bob back in')
    await join('fx_bob', ids.bob, instanceDomain)
    await join('fx_carol', ids.carol, instanceDomain)
    await join('the peer\'s user', ids.remote, new URL(peer.actorUrl).host)

    n = peer.captured.length
    const blocked = await staff.rpc('instance_set_server_blocked', { p_server_id: ids.remoteRef, p_blocked: true, p_reason: 'raids' })
    eq(blocked.data?.blocked, true, `staff block the server${blocked.error ? ` (${blocked.error.message})` : ''}`)
    eq([await membership(ids.bob), await membership(ids.carol)].every((m) => m === null), true,
      'fx_bob and fx_carol are no longer members')
    assert(await membership(ids.remote), 'the member from the peer stays in the copy')
    await sendLeaves('blocked')
    eq(leavesSince(n).map((l) => l.body.actor).sort().join(' '), [localUser('fx_bob'), localUser('fx_carol')].sort().join(' '),
      'each sends the Group a Leave of their own')

    // Relays of the blocked server.
    const copyInbox = `${localUrl}/servers/${ids.remoteRef}/inbox`
    const sharedInbox = `${localUrl}/inbox`
    const relayOf = () => {
      const note = {
        type: 'Note', id: `${new URL(peer.actorUrl).origin}/messages/${crypto.randomUUID()}`, attributedTo: peer.actorUrl,
        content: '<p>from the blocked server</p>', context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef,
      }
      const create = { '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl, object: note }
      return {
        noteId: note.id,
        json: JSON.stringify({ '@context': AS, id: `${peer.groupUrl}/relays/${crypto.randomUUID()}`, type: 'Announce', actor: peer.groupUrl, object: create }),
      }
    }
    const asGroup = (url: string, json: string) =>
      deliver(ctx.post, ctx.signedHeaders, url, json, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
    const stored = async (noteId: string) =>
      (await db.from('messages').select('id').eq('metadata->>ap_id', noteId).maybeSingle()).data

    const atCopy = relayOf()
    eq(await asGroup(copyInbox, atCopy.json), 202, 'the Group\'s relay is acknowledged at the copy\'s inbox (202)')
    eq(await stored(atCopy.noteId), null, 'and stored nowhere')
    const atShared = relayOf()
    eq(await asGroup(sharedInbox, atShared.json), 202, 'and at the shared inbox (202)')
    eq(await stored(atShared.noteId), null, 'and stored nowhere')

    const allowed = await staff.rpc('instance_set_server_blocked', { p_server_id: ids.remoteRef, p_blocked: false })
    eq(allowed.data?.blocked, false, 'staff allow the server again')
    const again = relayOf()
    eq(await asGroup(copyInbox, again.json), 202, 'the same relay is acknowledged (202)')
    assert(await stored(again.noteId), 'and stored, once the server is allowed')
  } finally {
    await db.from('instance_server_blocks').delete().eq('server_id', ids.remoteRef)
    await db.from('instance_server_keepouts').delete().eq('server_id', ids.remoteRef)
    await db.from('user_servers').delete().eq('server_id', ids.remoteRef).in('user_id', [ids.carol, ids.remote])
    await db.from('profiles').update({ is_admin: false }).eq('id', ids.alice)
    await join('fx_bob', ids.bob, instanceDomain)
  }
}
