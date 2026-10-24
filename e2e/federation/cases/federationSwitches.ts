// The instance's federation switches against a peer (migration 20261028500001,
// services/FederationSwitches.ts). Runs last: closing the instance removes memberships the other
// cases set up; the switches are restored on.
//
//   inbound off   the peer's signed POST to the shared inbox answers 403; the Group stub still
//                 reads without a signature; the peer member's signed read of a private channel
//                 is anonymous and gets nothing.
//   outbound off  a Create to the peer is dropped; so is a closing Remove while inbound is on.
//   both off      the instance closes: the hosted server stops federating and the peer's user is
//                 removed, fx_bob leaves the peer's Group. The Group's Remove and fx_bob's Leave
//                 reach the peer, signed as before; a Create does not.
//   one on again  the hosted server federates again; nobody removed is back.
//
// The BullMQ worker is not part of this harness: the job handlers are called as the worker would.

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

export interface FederationSwitchesContext {
  db: SupabaseClient
  peer: {
    actorUrl: string
    groupUrl: string
    personalInbox: string
    key: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    bob: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
  }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseFederationSwitches(ctx: FederationSwitchesContext): Promise<void> {
  console.log('\nInstance federation switches -> inbound off refuses, outbound off drops, both off closes')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { invalidateFederationSwitches } = await backend('services/FederationSwitches.ts')
  const { DeliveryQueue } = await backend('activitypub/DeliveryQueue.ts')
  const { handleMemberRemovalJob } = await backend('queue/handlers/memberRemovalHandler.ts')
  const { handleInstanceLeaveJob } = await backend('queue/handlers/instanceLeaveHandler.ts')
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`

  const setSwitches = async (inbound: boolean, outbound: boolean) => {
    const r = await db.from('instance_config').upsert([
      { config_key: 'enable_inbound_federation', config_value: inbound },
      { config_key: 'enable_outbound_federation', config_value: outbound },
    ], { onConflict: 'config_key' })
    assert(!r.error, `switches inbound=${inbound} outbound=${outbound}`, r.error?.message)
    invalidateFederationSwitches()
  }
  const sentSince = (n: number, type: string) => peer.captured.slice(n)
    .map((c) => ({ c, body: JSON.parse(c.raw.toString('utf-8')) }))
    .filter(({ body }) => body.type === type)
  const probe = (label: string) => ({
    '@context': AS,
    id: `https://${instanceDomain}/activities/${crypto.randomUUID()}`,
    type: 'Create',
    actor: `https://${instanceDomain}/users/fx_alice`,
    object: { type: 'Note', id: `https://${instanceDomain}/notes/${crypto.randomUUID()}`, content: label },
  })
  const ensureMembers = async () => {
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
    const remote = await db.from('user_servers').insert({
      server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).hostname,
    })
    assert(!remote.error, 'the peer\'s user is an accepted member of the hosted server', remote.error?.message)
    const bob = await db.from('user_servers').upsert(
      { server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted' }, { onConflict: 'user_id,server_id' })
    assert(!bob.error, 'fx_bob is a member of the peer\'s Group', bob.error?.message)
  }

  const on = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!on.error, 'federate the hosted server', on.error?.message)
  await ensureMembers()

  try {
    // Inbound off.
    await setSwitches(false, true)
    const inbox = `${localUrl}/inbox`
    const create = JSON.stringify({
      '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl,
      object: { type: 'Note', id: `${peer.actorUrl}/notes/${crypto.randomUUID()}`, attributedTo: peer.actorUrl, content: 'hi', to: [AS + '#Public'] },
    })
    eq(await deliver(ctx.post, ctx.signedHeaders, inbox, create, peer.key.privateKey, `${peer.actorUrl}#main-key`),
      403, 'inbound off: the shared inbox refuses the peer\'s signed Create (403)')
    const stub = await ctx.get(`${localUrl}/servers/${ids.hostedServer}`, { Accept: 'application/activity+json' })
    eq(stub.status, 200, 'the Group stub still reads without a signature')
    const pageUrl = `${localUrl}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}/messages?page=1`
    const page = await ctx.get(pageUrl, ctx.signedGetHeaders(pageUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
    assert(page.status !== 200 || !(page.json?.orderedItems ?? []).length,
      'the member\'s signed read of the private channel is anonymous and gets nothing', `${page.status} ${page.body.slice(0, 200)}`)

    await setSwitches(true, true)
    const reopened = await ctx.get(pageUrl, ctx.signedGetHeaders(pageUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
    eq(reopened.status, 200, 'inbound on again: the same signed read is the member\'s')

    // Outbound off.
    await setSwitches(true, false)
    let n = peer.captured.length
    await DeliveryQueue.enqueue(probe('outbound off'), peer.personalInbox, ids.bob)
    eq(sentSince(n, 'Create').length, 0, 'outbound off: a Create to the peer is dropped')

    // Both off: the instance closes.
    n = peer.captured.length
    await setSwitches(false, false)
    const { data: server } = await db.from('servers').select('federation_enabled').eq('id', ids.hostedServer).single()
    eq(server?.federation_enabled, false, 'both off: the hosted server stops federating')
    const { data: removal } = await db.from('federation_member_removals').select('id, reason')
      .eq('server_id', ids.hostedServer).eq('profile_id', ids.remote).is('delivered_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    eq(removal?.reason, 'federation_closed', 'the peer\'s user is removed')
    const { data: leave } = await db.from('instance_server_leaves').select('id, reason')
      .eq('server_id', ids.remoteRef).eq('profile_id', ids.bob).is('delivered_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    eq(leave?.reason, 'federation_off', 'fx_bob leaves the peer\'s Group')

    if (removal) await handleMemberRemovalJob({ type: 'delete', removal_id: removal.id })
    if (leave) await handleInstanceLeaveJob({ type: 'delete', leave_id: leave.id })
    await DeliveryQueue.enqueue(probe('closed'), peer.personalInbox, ids.bob)

    const [remove] = sentSince(n, 'Remove')
    assert(remove, 'the Group\'s Remove reaches the peer')
    if (remove) {
      eq(remove.body.id, `${group}/activities/removal-${removal?.id}`, 'the closing Remove, by its id')
      const refusal = await strictReceiverRefusal(remove.c, localUrl, instanceDomain)
      assert(refusal === null, 'signed with the key the Group publishes', refusal)
    }
    const [leaveSent] = sentSince(n, 'Leave')
    assert(leaveSent, 'fx_bob\'s Leave reaches the peer\'s Group')
    if (leaveSent) {
      eq(leaveSent.body.actor, `https://${instanceDomain}/users/fx_bob`, 'as fx_bob')
      eq(leaveSent.body.id, `https://${instanceDomain}/users/fx_bob/activities/instance-leave-${leave?.id}`, 'named after its row')
    }
    eq(sentSince(n, 'Create').length, 0, 'while closed, a Create is still dropped')

    // One on again.
    await setSwitches(true, false)
    const { data: back } = await db.from('servers').select('federation_enabled').eq('id', ids.hostedServer).single()
    eq(back?.federation_enabled, true, 'one switch on again: the hosted server federates again')
    const { count } = await db.from('user_servers').select('*', { count: 'exact', head: true })
      .eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
    eq(count, 0, 'nobody removed is back')
  } finally {
    await setSwitches(true, true)
    await ensureMembers()
  }
}
