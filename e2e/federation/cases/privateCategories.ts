// Categories of the private server over ActivityPub (20261026200001_private_categories): a
// category, its name included, reaches an instance with the first channel in it that every
// member the instance hosts views (20261026700002_federation_read_scope).
//   - the Group document read by the peer's member lists no category holding only channels
//     hidden from it, and lists it once member overrides show a channel there to every member
//     the peer hosts;
//   - the category's Add reaches no instance while none of its channels is visible to one;
//   - a channel's Add, at the member's instance, follows an Update of its category, which the
//     receiver creates the category from.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'

// Fixed so a failure names a row.
const CATEGORY = 'fed00172-0000-0000-0000-000000000001'
const CHANNEL = 'fed00172-0000-0000-0000-000000000002'
const CATEGORY_NAME = 'Fed Staff 172'
const CHANNEL_NAME = 'fed-staff-172'

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: any }

interface Captured {
  url: string
  raw: Buffer
}

export interface PrivateCategoriesContext {
  db: SupabaseClient
  peer: { actorUrl: string; key: { privateKey: string }; captured: Captured[] }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: { remote: string; hostedServer: string }
  get: (url: string, headers?: Record<string, string>) => Promise<Got>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function casePrivateCategories(ctx: PrivateCategoriesContext): Promise<void> {
  console.log('\nprivate categories -> a category reaches an instance with a channel in it that instance views')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const groupDoc = async () => {
    const url = `${localUrl}/servers/${ids.hostedServer}`
    const got = await ctx.get(url, ctx.signedGetHeaders(url, peer.key.privateKey, `${peer.actorUrl}#main-key`))
    return ((got.json?.['harmony:channels'] ?? []) as Array<{ name: string }>).map((c) => c.name)
  }
  const deliveredSince = (n: number) => peer.captured.slice(n).map((c) => JSON.parse(c.raw.toString('utf-8')))

  await db.from('channels').delete().eq('id', CHANNEL)
  await db.from('channel_categories').delete().eq('id', CATEGORY)
  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)
  const { data: everyone } = await db.from('server_roles').select('id')
    .eq('server_id', ids.hostedServer).eq('is_default', true).single()

  try {
    const cat = await db.from('channel_categories').insert({ id: CATEGORY, server_id: ids.hostedServer, name: CATEGORY_NAME, order: 50 })
    assert(!cat.error, `seed the category ${CATEGORY_NAME}`, cat.error?.message)
    const chan = await db.from('channels').insert({ id: CHANNEL, server_id: ids.hostedServer, name: CHANNEL_NAME, type: 0, category: CATEGORY })
    assert(!chan.error, `seed #${CHANNEL_NAME} in it`, chan.error?.message)
    const hidden = await db.from('channel_permission_overrides').insert({
      channel_id: CHANNEL, target_type: 'role', role_id: everyone?.id, allow_permissions: 0, deny_permissions: 2,
    })
    assert(!hidden.error, `hide #${CHANNEL_NAME} from @everyone`, hidden.error?.message)

    const before = await groupDoc()
    assert(before.length > 0, 'the member reads the Group document', before)
    assert(!before.includes(CATEGORY_NAME), 'the Group document names no category of channels hidden from the member', before)
    assert(!before.includes(CHANNEL_NAME), 'nor the hidden channel', before)

    const { handleChannelCreated } = await backend('listeners/DatabaseListener.ts')
    let n = peer.captured.length
    await handleChannelCreated({ id: CATEGORY, server_id: ids.hostedServer, name: CATEGORY_NAME, type: 2, order: 50, is_remote: false })
    await sleep(1500)
    // A delivery that fails at once is queued for retry: an attempt counts as sent.
    const { data: queued } = await db.from('federation_delivery_queue').select('target_inbox_url, activity_data')
    const attempted = [
      ...deliveredSince(n),
      ...(queued ?? []).filter((q: any) => JSON.stringify(q.activity_data).includes(CATEGORY)),
    ]
    assert(!JSON.stringify(attempted).includes(CATEGORY_NAME), 'the category\'s Add reaches no instance, not even as an attempt',
      attempted.map((a: any) => a.target_inbox_url ?? a.type))

    // Earlier cases leave other members of the peer in the server; its copy of the server is
    // shown to all of them.
    const { data: peerMembers } = await db.from('user_servers')
      .select('user_id, profiles!inner(domain, is_local)')
      .eq('server_id', ids.hostedServer).eq('status', 'accepted')
      .eq('profiles.is_local', false).eq('profiles.domain', new URL(peer.actorUrl).host)
    const memberIds = [...new Set([ids.remote, ...(peerMembers ?? []).map((m: any) => m.user_id as string)])]
    const shown = await db.from('channel_permission_overrides').insert(memberIds.map((id) => ({
      channel_id: CHANNEL, target_type: 'user', user_id: id, allow_permissions: 2, deny_permissions: 0,
    })))
    assert(!shown.error, 'member overrides show the channel to every member the peer hosts', shown.error?.message)

    const after = await groupDoc()
    assert(after.includes(CATEGORY_NAME), 'the Group document now lists the category', after)
    assert(after.includes(CHANNEL_NAME), 'and its channel', after)

    n = peer.captured.length
    await handleChannelCreated({
      id: CHANNEL, server_id: ids.hostedServer, name: CHANNEL_NAME, type: 0, order: 0, category: CATEGORY, is_remote: false,
    })
    const until = Date.now() + 5000
    const ours = () => deliveredSince(n).filter((a) => JSON.stringify(a).includes(CATEGORY))
    while (ours().length < 2 && Date.now() < until) await sleep(100)
    const sent = ours()
    eq(sent.map((a) => `${a.type} ${a.object?.type}`).join(', '), 'Update harmony:Category, Add harmony:TextChannel',
      'the channel\'s Add follows an Update of its category')
    eq(sent[0]?.object?.id, `${group}/channels/${CATEGORY}`, 'the Update names the category')
    eq(sent[0]?.object?.name, CATEGORY_NAME, 'with its name')
    eq(sent[1]?.object?.category, `${group}/channels/${CATEGORY}`, 'and the Add places the channel in it')
  } finally {
    await db.from('channels').delete().eq('id', CHANNEL)
    await db.from('channel_categories').delete().eq('id', CATEGORY)
  }
}
