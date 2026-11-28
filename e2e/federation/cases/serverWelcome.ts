// A server's welcome screen and rules on the copies its member instances hold
// (activitypub/groupWelcome.ts harmony:welcome and harmony:instanceRules,
// services/CopyMirrorService.applyGroupWelcome, migration 20261127100001), both directions.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - the Group carries the screen, the rules and when acceptance began, and this instance's rules;
//   - a change goes out as the Group's Update carrying harmony:welcome, signed with the Group's key,
//     without the instance's rules.
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - a sync stores the Group's screen as the copy's;
//   - fx_bob, who joined after acceptance began, cannot post in the copy until they accept, then can;
//   - a Group without harmony:welcome (1.9.8 and older) leaves the copy's screen as it is;
//   - the Group's Update stops requiring acceptance; the same Update signed by a member changes nothing.
//
// The BullMQ worker is not part of this harness: the job handlers are called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

interface Captured { method: string; url: string; headers: Record<string, string>; raw: Buffer }

export interface ServerWelcomeContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraGroupFields: Record<string, unknown>
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  asUser: (authUserId: string) => SupabaseClient
  ids: { bob: string; bobAuth: string; remote: string; hostedServer: string; remoteRef: string; remoteChannel: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

async function poll<T>(find: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = await find()
    if (got || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function caseServerWelcome(ctx: ServerWelcomeContext): Promise<void> {
  console.log('\nServers hosted elsewhere -> their welcome screen and rules on the copy')
  const { db, peer, ids } = ctx
  const backend = async (p: string): Promise<any> => {
    try {
      return await import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
    } catch (e) {
      ctx.assert(false, `the backend has ${p}`, (e as Error).message)
      return {}
    }
  }
  const { data: rulesRow } = await db.from('instance_config').select('config_value').eq('config_key', 'instance_rules').maybeSingle()
  try {
    await hostedHere(ctx, backend)
    await hostedByPeer(ctx, backend)
  } finally {
    peer.extraGroupFields = {}
    await db.from('server_welcome_screens').delete().in('server_id', [ids.hostedServer, ids.remoteRef])
    await db.from('messages').delete().eq('channel_id', ids.remoteChannel).eq('user_id', ids.bob)
    await db.from('user_servers').update({ rules_accepted_at: null, welcome_seen_at: null })
      .eq('server_id', ids.remoteRef).eq('user_id', ids.bob)
    if (rulesRow) {
      await db.from('instance_config').update({ config_value: rulesRow.config_value }).eq('config_key', 'instance_rules')
    } else {
      await db.from('instance_config').delete().eq('config_key', 'instance_rules')
    }
  }
}

async function hostedHere(ctx: ServerWelcomeContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const peerHost = new URL(peer.base).host
  const body = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))
  const updateSince = (n: number) => async () =>
    peer.captured.slice(n).find((c) => c.url === '/inbox' && body(c).type === 'Update' && body(c).object?.type === 'Group')

  await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: peerHost },
    { onConflict: 'server_id,user_id' },
  )
  const rules = await db.from('instance_config').upsert(
    { config_key: 'instance_rules', config_value: ['Follow the law'] }, { onConflict: 'config_key' })
  assert(!rules.error, 'set this instance\'s rules', rules.error?.message)
  const since = '2026-11-01T00:00:00.000Z'
  const seeded = await db.from('server_welcome_screens').upsert({
    server_id: ids.hostedServer, enabled: true, message: 'Welcome in', rules: [{ title: 'Be kind', description: 'To everyone.' }],
    require_acceptance: true, enabled_at: since, acceptance_required_at: since,
  }, { onConflict: 'server_id' })
  assert(!seeded.error, 'set a welcome screen on the hosted server', seeded.error?.message)

  const groupUrl = `${localUrl}/servers/${ids.hostedServer}`
  const doc = await ctx.get(groupUrl, ctx.signedGetHeaders(groupUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  eq(doc.status, 200, 'the peer\'s user reads the Group')
  const welcome = doc.json?.['harmony:welcome']
  eq(JSON.stringify(welcome?.rules), JSON.stringify([{ title: 'Be kind', description: 'To everyone.' }]), 'the Group carries the rules in harmony:welcome')
  eq(welcome?.message, 'Welcome in', 'and the message of the enabled screen')
  eq(welcome?.requireAcceptance, true, 'and that acceptance is required')
  eq(welcome?.acceptanceRequiredAt, since, 'since when')
  eq(JSON.stringify(doc.json?.['harmony:instanceRules']), JSON.stringify(['Follow the law']), 'and this instance\'s rules in harmony:instanceRules')

  const { handleServerUpdateJob } = await backend('queue/handlers/serverStructureHandler.ts')
  await db.from('server_welcome_screens').update({ rules: [{ title: 'Be kinder', description: '' }] }).eq('server_id', ids.hostedServer)
  const n = peer.captured.length
  await handleServerUpdateJob?.({ type: 'update', server_id: ids.hostedServer })
  const update = await poll(updateSince(n))
  assert(update, 'a change of the screen reaches the peer as the Group\'s Update')
  if (update) {
    eq(body(update).object?.['harmony:welcome']?.rules?.[0]?.title, 'Be kinder', 'carrying the changed rules')
    assert(!('harmony:instanceRules' in (body(update).object ?? {})), 'and not the instance\'s rules')
    assert(await strictReceiverRefusal(update, localUrl, instanceDomain) === null, 'signed with the Group\'s key')
  }
}

async function hostedByPeer(ctx: ServerWelcomeContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const screen = async () => (await db.from('server_welcome_screens')
    .select('enabled, message, rules, require_acceptance, acceptance_required_at, updated_by')
    .eq('server_id', ids.remoteRef).maybeSingle()).data
  const welcome = (requireAcceptance: boolean) => ({
    rules: [{ title: 'No spam', description: 'Ever.' }],
    enabled: true,
    message: 'Hello from the peer',
    enabledAt: '2026-01-01T00:00:00Z',
    requireAcceptance,
    acceptanceRequiredAt: requireAcceptance ? '2000-01-01T00:00:00Z' : null,
  })

  await db.from('server_welcome_screens').delete().eq('server_id', ids.remoteRef)
  await db.from('user_servers').update({ rules_accepted_at: null, welcome_seen_at: null })
    .eq('server_id', ids.remoteRef).eq('user_id', ids.bob)

  const { ServerDiscoveryService } = await backend('services/ServerDiscoveryService.ts')
  peer.extraGroupFields = { 'harmony:welcome': welcome(true) }
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  const stored = await screen()
  assert(stored, 'the sync stores the Group\'s screen on the copy')
  eq(stored?.require_acceptance, true, 'requiring acceptance')
  eq(stored?.message, 'Hello from the peer', 'with its message')
  eq(JSON.stringify(stored?.rules), JSON.stringify([{ title: 'No spam', description: 'Ever.' }]), 'and its rules')
  eq(stored?.updated_by ?? null, null, 'set by no one here')

  const bob = ctx.asUser(ids.bobAuth)
  const seen = await bob.rpc('get_server_welcome', { p_server_id: ids.remoteRef })
  eq(seen.data?.must_accept, true, 'fx_bob, who joined after acceptance began, must accept')
  const refused = await bob.from('messages')
    .insert({ channel_id: ids.remoteChannel, user_id: ids.bob, content: [{ type: 'text', text: 'before accepting' }] })
  assert(refused.error && String(refused.error.message).includes('RULES_NOT_ACCEPTED'),
    'and cannot post in the copy until then', refused.error?.message ?? 'stored')
  const accepted = await bob.rpc('accept_server_rules', { p_server_id: ids.remoteRef })
  eq(accepted.data?.must_accept, false, 'accepting records it on the copy')
  const posted = await bob.from('messages')
    .insert({ channel_id: ids.remoteChannel, user_id: ids.bob, content: [{ type: 'text', text: 'after accepting' }] })
  assert(!posted.error, 'then fx_bob posts', posted.error?.message)

  peer.extraGroupFields = {}
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  eq((await screen())?.require_acceptance, true, 'a Group without harmony:welcome leaves the copy\'s screen as it is')

  // Live, from the Group.
  const inbox = `${localUrl}/inbox`
  const activity = (actor: string) => ({
    '@context': [AS, HARMONY], id: `${actor}/activities/${crypto.randomUUID()}`, type: 'Update', actor,
    published: new Date().toISOString(),
    object: { id: peer.groupUrl, type: 'Group', name: 'Peer private', 'harmony:ChatServer': true, 'harmony:welcome': welcome(false) },
  })
  await deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(activity(peer.actorUrl)),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  await new Promise((r) => setTimeout(r, 1000))
  eq((await screen())?.require_acceptance, true, 'the Update signed by a member changes nothing')

  assert(await deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(activity(peer.groupUrl)),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`) < 300, 'the inbox takes the Group\'s Update')
  const relaxed = await poll(async () => {
    const s = await screen()
    return s?.require_acceptance === false ? s : null
  })
  assert(relaxed, 'the Group\'s Update stops requiring acceptance on the copy')
}
