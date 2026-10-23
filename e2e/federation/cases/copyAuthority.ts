// A copy of the peer's Group holds no server authority here (migrations 20261027100002 and
// 20261027200001, ServerDiscoveryService.resolveGroupOwner).
//
//   - a sync replaces a local owner of the copy with the owner the Group names, stored as the
//     peer's profile;
//   - instance staff hiding a local author's message in the copy queue no Delete and send none
//     to the Group;
//   - the author's own delete reaches the Group's inbox as the author's Delete.
//
// Writes go through PostgREST as the user, so the table triggers run. Jobs are read off
// federation_jobs (JobTap) and handed to their handler, as the worker would after BullMQ.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap } from './outboundFederation.ts'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface CopyAuthorityContext {
  db: SupabaseClient
  peer: { actorUrl: string; groupUrl: string; captured: Captured[] }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  get: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>
  bearer: (authUserId: string) => string
  asUser: (authUserId: string) => SupabaseClient
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    carol: string
    carolAuth: string
    remote: string
    remoteRef: string
    remoteChannel: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function caseCopyAuthority(ctx: CopyAuthorityContext): Promise<void> {
  console.log('\nCopy of the peer\'s Group -> the Group\'s owner; a staff hide stays here, the author\'s delete goes to the Group')
  const { db, peer, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const groupInbox = new URL(`${peer.groupUrl}/inbox`).pathname
  const deletesSince = (n: number, object: string) => peer.captured.slice(n)
    .filter((c) => c.url === groupInbox)
    .map((c) => JSON.parse(c.raw.toString('utf-8')))
    .filter((body) => body.type === 'Delete' && body.object === object)

  // Owner -----------------------------------------------------------------------------------
  const legacy = await db.from('servers').update({ owner: ids.alice }).eq('id', ids.remoteRef)
  assert(!legacy.error, 'the copy starts owned by a local profile, as before 1.8.12', legacy.error?.message)
  const sync = await ctx.get(`${ctx.localUrl}/servers/${ids.remoteRef}/sync`, {
    Accept: 'application/json',
    Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}`,
  })
  eq(sync.status, 200, 'a member syncs the copy')
  const { data: synced } = await db.from('servers').select('owner, federation_metadata').eq('id', ids.remoteRef).single()
  eq(synced?.owner, ids.remote, 'the copy is owned by the profile the Group names, not the local one')
  eq(synced?.federation_metadata?.attributedTo, peer.actorUrl, 'the Group\'s attributedTo is kept')

  // Deletes ---------------------------------------------------------------------------------
  const staffWas = (await db.from('profiles').select('is_admin').eq('id', ids.carol).single()).data?.is_admin ?? false
  await db.from('profiles').update({ is_admin: true }).eq('id', ids.carol)
  const joined = await db.from('user_servers').upsert([
    { server_id: ids.remoteRef, user_id: ids.alice, status: 'accepted', member_instance: ctx.instanceDomain },
    { server_id: ids.remoteRef, user_id: ids.carol, status: 'accepted', member_instance: ctx.instanceDomain },
  ], { onConflict: 'user_id,server_id' })
  assert(!joined.error, 'fx_alice and fx_carol (instance staff) are members of the copy', joined.error?.message)

  const hidden = crypto.randomUUID()
  const own = crypto.randomUUID()
  const posted = await db.from('messages').insert([
    { id: hidden, channel_id: ids.remoteChannel, user_id: ids.alice, content: [{ type: 'text', text: 'staff hides this' }] },
    { id: own, channel_id: ids.remoteChannel, user_id: ids.alice, content: [{ type: 'text', text: 'alice deletes this' }] },
  ])
  assert(!posted.error, 'fx_alice posts two messages in the copy', posted.error?.message)

  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const tap = await JobTap.open(project)
  try {
    const { handleChannelMessageDeleteJob } = await backend('queue/handlers/channelMessageHandler.ts')
    const isDeleteOf = (id: string) => (job: { name: string; data: any }) =>
      job.name === 'federate-channel-message-delete' && job.data?.message_id === id

    let n = peer.captured.length
    const staffHide = await ctx.asUser(ids.carolAuth).from('messages')
      .update({ content: [{ type: 'text', text: '[deleted]' }], is_deleted: true })
      .eq('id', hidden)
      .select('id')
    eq(staffHide.data?.length, 1, 'instance staff hide fx_alice\'s message in the copy')
    eq(await tap.take(isDeleteOf(hidden), 3000), null, 'the hide queues no Delete')
    await sleep(500)
    eq(deletesSince(n, `https://${ctx.instanceDomain}/messages/${hidden}`).length, 0, 'and the Group receives none')

    n = peer.captured.length
    const ownDelete = await ctx.asUser(ids.aliceAuth).from('messages')
      .update({ content: [{ type: 'text', text: '[deleted]' }], is_deleted: true })
      .eq('id', own)
      .select('id')
    eq(ownDelete.data?.length, 1, 'fx_alice deletes her own message in the copy')
    const job = await tap.take(isDeleteOf(own))
    assert(job, 'her delete queues a Delete')
    if (job) await handleChannelMessageDeleteJob(job.data)
    for (let i = 0; i < 20 && deletesSince(n, `https://${ctx.instanceDomain}/messages/${own}`).length === 0; i++) await sleep(100)
    const [sent] = deletesSince(n, `https://${ctx.instanceDomain}/messages/${own}`)
    assert(sent, 'the Group\'s inbox receives the Delete')
    eq(sent?.actor, `https://${ctx.instanceDomain}/users/fx_alice`, 'signed as the author')
  } finally {
    tap.close()
    await db.from('messages').delete().in('id', [hidden, own])
    await db.from('user_servers').delete().eq('server_id', ids.remoteRef).in('user_id', [ids.alice, ids.carol])
    await db.from('profiles').update({ is_admin: staffWas }).eq('id', ids.carol)
    await db.from('federation_delivery_queue').delete().eq('sender_id', ids.alice).like('target_inbox_url', `%${groupInbox}`)
  }
}
