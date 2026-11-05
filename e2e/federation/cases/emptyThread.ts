// A thread emptied by a deletion, both directions (migration 20261106200001).
//
// Hosted here (the private server, the peer's user an accepted member):
//   - fx_alice deletes the only message of her standalone thread through PostgREST: the thread
//     is gone, its federate-thread delete job is read off federation_jobs (JobTap) and handed to
//     handleThreadJob, as the worker would after BullMQ, and the peer's shared inbox receives
//     the Group's Delete of the ChatThread, which a strict receiver takes.
//
// Hosted by the peer (its Group, fx_bob a member of the copy):
//   - the Group's Delete of the only message of a copy's thread deletes the message and leaves
//     the thread: the copy follows its host;
//   - a Delete of that thread signed by the peer's other user, not its creator, is refused;
//   - the Group's Delete of a thread of the server hosted here is refused;
//   - the Group's Delete removes the copy's thread by its id on the peer, and fx_bob's thread
//     in the copy by its id here, and queues no Delete back.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap } from './outboundFederation.ts'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface EmptyThreadContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    strangerUrl: string
    groupUrl: string
    strangerKey: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  asUser: (authUserId: string) => SupabaseClient
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function caseEmptyThread(ctx: EmptyThreadContext): Promise<void> {
  console.log('\nEmpty threads -> deleted with their last message here, by the Group\'s Delete on a copy')
  const { db, peer, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const group = `https://${ctx.instanceDomain}/servers/${ids.hostedServer}`
  const hasThread = async (id: string) =>
    !!(await db.from('threads').select('id').eq('id', id).maybeSingle()).data

  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)

  const hostedRows: string[] = []
  const copyRows: string[] = []
  const copyThreads: string[] = []
  const tap = await JobTap.open(process.env.HMFED_PROJECT ?? 'hmfed')
  try {
    // Hosted here ---------------------------------------------------------------------------
    const alice = ctx.asUser(ids.aliceAuth)
    const { data: hostedThread, error: createError } = await alice.rpc('create_channel_thread', {
      p_channel_id: ids.hostedChannel, p_name: 'Gone with its message',
    })
    assert(!createError && hostedThread, 'fx_alice starts a thread in the hosted channel', createError?.message)
    const { data: notice } = await db.from('threads').select('parent_message_id').eq('id', hostedThread).maybeSingle()
    if (notice?.parent_message_id) hostedRows.push(notice.parent_message_id)
    const only = crypto.randomUUID()
    hostedRows.push(only)
    const wrote = await alice.from('messages').insert({
      id: only, channel_id: ids.hostedChannel, thread_id: hostedThread, user_id: ids.alice,
      content: [{ type: 'text', text: 'the only message' }],
    })
    assert(!wrote.error, 'and writes its only message', wrote.error?.message)

    const removed = await alice.from('messages')
      .update({ content: [{ type: 'text', text: '[deleted]' }], is_deleted: true })
      .eq('id', only)
      .select('id')
    eq(removed.data?.length, 1, 'fx_alice deletes it')
    eq(await hasThread(hostedThread), false, 'the thread is gone')

    const job = await tap.take((j) => j.name === 'federate-thread' && j.data?.type === 'delete' && j.data?.thread_id === hostedThread)
    assert(job, 'its Delete is queued')
    const n = peer.captured.length
    if (job) {
      const { handleThreadJob } = await backend('queue/handlers/threadHandler.ts')
      await handleThreadJob(job.data)
    }
    let sent: Captured | undefined
    for (let i = 0; i < 50 && !sent; i++) {
      sent = peer.captured.slice(n).find((c) => {
        if (c.url !== '/inbox') return false
        const body = JSON.parse(c.raw.toString('utf-8'))
        return body.type === 'Delete' && body.object?.type === 'ChatThread'
      })
      if (!sent) await sleep(100)
    }
    assert(sent, 'the peer\'s shared inbox receives a Delete of the ChatThread')
    if (sent) {
      const body = JSON.parse(sent.raw.toString('utf-8'))
      eq(body.actor, group, 'the Delete is the Group\'s')
      eq(body.object?.id, `https://${ctx.instanceDomain}/threads/${hostedThread}`, 'naming the thread')
      eq(body.object?.context, `${group}/channels/${ids.hostedChannel}`, 'in its channel')
      assert((body.to ?? []).includes(peer.actorUrl), 'addressed to the peer\'s member', body.to)
      const refusal = await strictReceiverRefusal(sent, ctx.localUrl, ctx.instanceDomain)
      assert(refusal === null, 'a strict receiver takes it: signed with the key the Group publishes', refusal)
    }

    // Hosted by the peer ----------------------------------------------------------------------
    const peerThread = crypto.randomUUID()
    const peerNotice = crypto.randomUUID()
    const peerMessage = crypto.randomUUID()
    const bobThread = crypto.randomUUID()
    const bobNotice = crypto.randomUUID()
    const bobMessage = crypto.randomUUID()
    copyRows.push(peerNotice, peerMessage, bobNotice, bobMessage)
    copyThreads.push(peerThread, bobThread)
    const notices = await db.from('messages').insert([
      { id: peerNotice, channel_id: ids.remoteChannel, is_system: true, content: [{ type: 'text', text: 'started a thread' }],
        metadata: { type: 'thread_created', standalone: true, thread_id: peerThread, actor_id: ids.remote } },
      { id: bobNotice, channel_id: ids.remoteChannel, is_system: true, content: [{ type: 'text', text: 'started a thread' }],
        metadata: { type: 'thread_created', standalone: true, thread_id: bobThread, actor_id: ids.bob } },
    ])
    assert(!notices.error, 'seed the copy\'s two thread notices', notices.error?.message)
    const threads = await db.from('threads').insert([
      { id: peerThread, channel_id: ids.remoteChannel, parent_message_id: peerNotice, name: 'Peer thread',
        created_by: ids.remote, ap_id: `${peer.base}/threads/${peerThread}` },
      { id: bobThread, channel_id: ids.remoteChannel, parent_message_id: bobNotice, name: 'Bob thread', created_by: ids.bob },
    ])
    assert(!threads.error, 'seed a thread of the peer\'s user and one of fx_bob in the copy', threads.error?.message)
    const peerMessageUrl = `${peer.base}/messages/${peerMessage}`
    const messages = await db.from('messages').insert([
      { id: peerMessage, channel_id: ids.remoteChannel, thread_id: peerThread, user_id: ids.remote,
        content: [{ type: 'text', text: 'peer wrote' }], metadata: { federated: true, ap_id: peerMessageUrl } },
      { id: bobMessage, channel_id: ids.remoteChannel, thread_id: bobThread, user_id: ids.bob,
        content: [{ type: 'text', text: 'bob wrote' }] },
    ])
    assert(!messages.error, 'each holds one message', messages.error?.message)

    const send = (body: Record<string, unknown>, privateKey: string, actor: string) =>
      deliver(ctx.post, ctx.signedHeaders, `${ctx.localUrl}/inbox`, JSON.stringify({ '@context': AS, ...body }),
        privateKey, `${actor}#main-key`)
    const deleteBy = (actor: string, object: unknown) => ({
      id: `${actor}/activities/delete-${crypto.randomUUID()}`, type: 'Delete', actor, object,
    })
    const chatThread = (id: string, channel = peer.groupUrl + `/channels/${ids.remoteChannel}`) =>
      ({ type: 'ChatThread', id, context: channel })

    eq(await send(deleteBy(peer.groupUrl, peerMessageUrl), peer.groupKey.privateKey, peer.groupUrl), 202,
      'the Group\'s Delete of the copy thread\'s only message is taken (202)')
    eq((await db.from('messages').select('is_deleted').eq('id', peerMessage).maybeSingle()).data?.is_deleted, true,
      'the message is deleted')
    eq(await hasThread(peerThread), true, 'the copy\'s thread stays until its host deletes it')

    eq(await send(deleteBy(peer.strangerUrl, chatThread(`${peer.base}/threads/${peerThread}`)),
      peer.strangerKey.privateKey, peer.strangerUrl), 202, 'a Delete of the thread by the peer\'s other user is acknowledged (202)')
    eq(await hasThread(peerThread), true, 'and refused: the signer neither created it nor hosts it')

    const { data: hostedOther } = await alice.rpc('create_channel_thread', {
      p_channel_id: ids.hostedChannel, p_name: 'Not the peer\'s',
    })
    const { data: otherNotice } = await db.from('threads').select('parent_message_id').eq('id', hostedOther).maybeSingle()
    if (otherNotice?.parent_message_id) hostedRows.push(otherNotice.parent_message_id)
    eq(await send(deleteBy(peer.groupUrl, chatThread(`https://${ctx.instanceDomain}/threads/${hostedOther}`, `${group}/channels/${ids.hostedChannel}`)),
      peer.groupKey.privateKey, peer.groupUrl), 202, 'the Group\'s Delete of a thread hosted here is acknowledged (202)')
    eq(await hasThread(hostedOther), true, 'and deletes nothing outside the Group\'s server')

    eq(await send(deleteBy(peer.groupUrl, chatThread(`${peer.base}/threads/${peerThread}`)), peer.groupKey.privateKey, peer.groupUrl),
      202, 'the Group\'s Delete of the copy\'s thread is taken (202)')
    eq(await hasThread(peerThread), false, 'the copy\'s thread is gone')
    eq(await send(deleteBy(peer.groupUrl, chatThread(`https://${ctx.instanceDomain}/threads/${bobThread}`)), peer.groupKey.privateKey, peer.groupUrl),
      202, 'the Group\'s Delete of fx_bob\'s thread, by its id here, is taken (202)')
    eq(await hasThread(bobThread), false, 'fx_bob\'s thread in the copy is gone')
    eq(await tap.take((j) => j.name === 'federate-thread' && j.data?.type === 'delete'
      && (j.data?.thread_id === peerThread || j.data?.thread_id === bobThread), 2000), null,
      'the copy queues no Delete back')
  } finally {
    tap.close()
    await db.from('threads').delete().in('id', copyThreads)
    await db.from('messages').delete().in('id', [...copyRows, ...hostedRows])
  }
}
