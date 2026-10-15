// Threads of the hosted servers, dereferenced over ActivityPub (threadRoutes.ts) by the peer,
// whose user is a member of the private server:
//   - the member, signing with its key, reads a thread of the private server's general
//     channel, its members and the channel's threads;
//   - unsigned, or signed by a user of an instance with no member, the same thread is 404,
//     answered as an id that does not exist;
//   - a thread of the channel @everyone cannot view is 404 to the member too;
//   - a thread of the public server's general channel is served to anyone, cacheable;
//   - any Accept but ActivityPub's is 406.

import type { SupabaseClient } from '@supabase/supabase-js'
import { Instance } from './groupRelay.ts'

// Fixed so a failure names a row.
const THREAD_GENERAL = 'fed00187-0000-0000-0000-000000000001'
const THREAD_SECRET = 'fed00187-0000-0000-0000-000000000002'
const THREAD_PUBLIC = 'fed00187-0000-0000-0000-000000000003'
const UNKNOWN = 'fed00187-0000-0000-0000-0000000000ff'
const parentOf = (thread: string) => thread.replace('fed00187-0000-0000-0000-0000000000', 'fed00187-0000-0000-0000-0000000001')

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: any }

export interface ThreadRoutesContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  ids: { alice: string; remote: string; privServer: string; privGeneral: string; privSecret: string; pubServer: string; pubGeneral: string }
  get: (url: string, headers?: Record<string, string>) => Promise<Got>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseThreadRoutes(ctx: ThreadRoutesContext): Promise<void> {
  console.log('\nthreads of hosted servers -> dereferenced by a member instance under the channel\'s read rules')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const AP = { Accept: 'application/activity+json' }
  const local = (p: string) => `https://${instanceDomain}${p}`

  const threads = [
    [THREAD_GENERAL, ids.privGeneral, 'general thread'],
    [THREAD_SECRET, ids.privSecret, 'secret thread'],
    [THREAD_PUBLIC, ids.pubGeneral, 'public thread'],
  ] as const
  await db.from('threads').delete().in('id', threads.map(([id]) => id))
  await db.from('messages').delete().in('id', threads.map(([id]) => parentOf(id)))
  const parents = await db.from('messages').insert(threads.map(([id, channelId]) => ({
    id: parentOf(id), channel_id: channelId, user_id: ids.alice, content: [{ type: 'text', text: `parent of ${id}` }],
  })))
  assert(!parents.error, 'seed the parent messages', parents.error?.message)
  const seeded = await db.from('threads').insert(threads.map(([id, channelId, name]) => ({
    id, channel_id: channelId, parent_message_id: parentOf(id), name, created_by: ids.alice,
  })))
  assert(!seeded.error, 'seed a thread in general, in secret and in the public server', seeded.error?.message)
  const members = await db.from('thread_members').insert([
    { thread_id: THREAD_GENERAL, user_id: ids.alice },
    { thread_id: THREAD_GENERAL, user_id: ids.remote },
  ])
  assert(!members.error, 'fx_alice and the peer\'s user are members of the general thread', members.error?.message)

  const outsider = new Instance(['fx_thread_outsider'])
  await outsider.start(new URL(peer.base).hostname)
  try {
    const signedBy = (privateKey: string, actor: string) => (url: string) =>
      ctx.get(url, ctx.signedGetHeaders(url, privateKey, `${actor}#main-key`))
    const asMember = signedBy(peer.key.privateKey, peer.actorUrl)
    const outsiderUrl = outsider.actor('fx_thread_outsider')
    const asOutsider = signedBy(outsider.keys.get('fx_thread_outsider')!.privateKey, outsiderUrl)
    const thread = (id: string) => `${localUrl}/threads/${id}`

    const read = await asMember(thread(THREAD_GENERAL))
    eq(read.status, 200, 'the member reads the private server\'s thread with its signed GET')
    assert(String(read.headers['content-type']).startsWith('application/activity+json'), 'as ActivityPub', read.headers['content-type'])
    const t = read.json ?? {}
    eq(t.type, 'ChatThread', 'a ChatThread')
    eq(t.id, local(`/threads/${THREAD_GENERAL}`), 'whose id is the URL it was read at')
    eq(t.name, 'general thread', 'named')
    eq(t.context, local(`/servers/${ids.privServer}/channels/${ids.privGeneral}`), 'in the general channel')
    eq(t.inReplyTo, local(`/messages/${parentOf(THREAD_GENERAL)}`), 'opened on its parent message')
    eq(t.attributedTo, local('/users/fx_alice'), 'by fx_alice')
    eq(t['harmony:serverId'], ids.privServer, 'of the private server')
    eq(read.headers['cache-control'], 'private, no-store', 'and not cacheable')

    const unknown = await ctx.get(thread(UNKNOWN), AP)
    const unsigned = await ctx.get(thread(THREAD_GENERAL), AP)
    assert(unsigned.status === 404 && unsigned.body === unknown.body, 'unsigned it is 404, as an unknown id', `${unsigned.status} ${unsigned.body}`)
    const outside = await asOutsider(thread(THREAD_GENERAL))
    assert(outside.status === 404 && outside.body === unknown.body, 'signed by an instance with no member it is 404', `${outside.status}`)
    eq((await asMember(thread(THREAD_SECRET))).status, 404, 'a thread of the channel @everyone cannot view is 404 to the member')

    const pub = await ctx.get(thread(THREAD_PUBLIC), AP)
    eq(pub.status, 200, 'a thread of the public server\'s general channel is served unsigned')
    eq(pub.headers['cache-control'], 'public, max-age=60', 'and cacheable')

    const memberPage = await asMember(`${thread(THREAD_GENERAL)}/members?page=1`)
    eq(JSON.stringify(memberPage.json?.orderedItems ?? []), JSON.stringify([local('/users/fx_alice'), peer.actorUrl]),
      'the member reads the thread\'s members')
    eq((await ctx.get(`${thread(THREAD_GENERAL)}/members?page=1`, AP)).status, 404, 'unsigned, its members are 404')

    const channelThreads = `${localUrl}/channels/${ids.privGeneral}/threads`
    const listed = await asMember(`${channelThreads}?page=1`)
    eq(JSON.stringify((listed.json?.orderedItems ?? []).map((x: any) => x.id)), JSON.stringify([local(`/threads/${THREAD_GENERAL}`)]),
      'the member reads the general channel\'s threads')
    eq((await asMember(channelThreads)).json?.totalItems, 1, 'counted by the collection')
    eq((await ctx.get(channelThreads, AP)).status, 404, 'unsigned, the channel\'s threads are 404')

    eq((await ctx.get(thread(THREAD_PUBLIC), { Accept: 'text/html' })).status, 406, 'a browser\'s Accept is answered 406')
  } finally {
    await outsider.stop()
    await db.from('threads').delete().in('id', threads.map(([id]) => id))
    await db.from('messages').delete().in('id', threads.map(([id]) => parentOf(id)))
  }
}
