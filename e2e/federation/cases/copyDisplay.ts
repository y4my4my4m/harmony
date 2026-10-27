// What a member instance shows of a server hosted elsewhere: pins, roles, the instance staff of
// remote accounts and channel order (activitypub/copyMirror.ts, services/CopyMirrorService.ts,
// migration 20261030100001), both directions.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - the Group lists its roles (name, colour, position, hoist; no permission bits) and the
//     members page each member's roles; a role change goes out as the Group's Update, an
//     assignment change as Update(harmony:MemberRoles), each signed with the Group's key;
//   - the channel's pins collection serves the pinned Note to the peer's user, the hidden
//     channel's 404s; a pin and an unpin reach the peer's inbox as the Group's Add and Remove
//     naming that collection, and a pin in the hidden channel does not;
//   - a local admin's and moderator's actors carry harmony:instanceRole, a member's none;
//   - a channel Update carries order next to position, 0 included.
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - a sync stores the Group's roles display-only and the members' assignments, and fetches the
//     channel's pins signed as fx_bob, caching the pinned Note it lacks;
//   - the Group's Update renames and drops roles, its Update(harmony:MemberRoles) reassigns, its
//     Add and Remove pin and unpin; each signed by a member instead changes nothing;
//   - the peer's actor stores its instance role; an Update of another host's actor does not;
//   - a channel and a category Update to position 0 move them there;
//   - a Group with none of these properties (1.9.0 and older) leaves the copy as it was.
//
// The BullMQ worker is not part of this harness: the job handlers are called as the worker would.

import crypto from 'node:crypto'
import type http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

// Fixed so a failure names a row.
const HOST_PIN = 'fed00195-0000-0000-0000-000000000001'
const HOST_HIDDEN_PIN = 'fed00195-0000-0000-0000-000000000002'
const PEER_PIN = 'fed00195-0000-0000-0000-000000000003'
const PEER_LATER = 'fed00195-0000-0000-0000-000000000004'
const H_TESTER = 'fed00195-0000-0000-0000-0000000000a1'
const H_MODS = 'fed00195-0000-0000-0000-0000000000a2'
const P_ADMIN = 'fed00195-0000-0000-0000-0000000000b1'
const P_TESTER = 'fed00195-0000-0000-0000-0000000000b2'
const P_CATEGORY = 'fed00195-0000-0000-0000-0000000000c1'
const ELSEWHERE = 'fed00195-0000-0000-0000-0000000000d1'
const ELSEWHERE_URL = 'https://elsewhere.example/users/eve'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface CopyDisplayContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string; publicKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraGet?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
    extraGroupFields: Record<string, unknown>
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    bob: string
    carol: string
    remote: string
    hostedServer: string
    hostedChannel: string
    hiddenChannel: string
    remoteRef: string
    remoteChannel: string
  }
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

async function waitFor<T>(find: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = find()
    if (got !== undefined || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

function keyIdOf(signature: string | undefined): string | null {
  return /keyId="([^"]+)"/.exec(signature ?? '')?.[1] ?? null
}

export async function caseCopyDisplay(ctx: CopyDisplayContext): Promise<void> {
  console.log('\nServers hosted elsewhere -> pins, roles, instance staff and channel order on the copy')
  const { db, peer, ids } = ctx
  const backend = async (p: string): Promise<any> => {
    try {
      return await import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
    } catch (e) {
      ctx.assert(false, `the backend has ${p}`, (e as Error).message)
      return {}
    }
  }
  const peerHost = new URL(peer.base).host
  const staffWas = await db.from('profiles').select('id, is_admin, is_moderator').in('id', [ids.alice, ids.carol])
  try {
    await hostedHere(ctx, backend, peerHost)
    await hostedByPeer(ctx, backend)
  } finally {
    peer.extraGet = undefined
    peer.extraGroupFields = {}
    for (const p of staffWas.data ?? []) {
      await db.from('profiles').update({ is_admin: p.is_admin, is_moderator: p.is_moderator }).eq('id', p.id)
    }
    await db.from('messages').delete().in('id', [HOST_PIN, HOST_HIDDEN_PIN, PEER_PIN, PEER_LATER])
    await db.from('server_roles').delete().in('id', [H_TESTER, H_MODS])
    await db.from('server_roles').delete().eq('server_id', ids.remoteRef).not('ap_id', 'is', null)
    await db.from('channel_categories').delete().eq('id', P_CATEGORY)
    await db.from('profiles').delete().eq('id', ELSEWHERE)
    await db.from('profiles').update({ instance_role: null }).eq('id', ids.remote)
  }
}

async function hostedHere(ctx: CopyDisplayContext, backend: (p: string) => Promise<any>, peerHost: string): Promise<void> {
  const { db, instanceDomain, ids } = ctx
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`

  await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: peerHost },
    { onConflict: 'server_id,user_id' },
  )
  const aliceWasMember = !!(await db.from('user_servers').select('id')
    .eq('server_id', ids.hostedServer).eq('user_id', ids.alice).maybeSingle()).data
  await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.alice, status: 'accepted', member_instance: instanceDomain },
    { onConflict: 'server_id,user_id' },
  )
  try {
    await hostedHereAsMembers(ctx, backend, group)
  } finally {
    if (!aliceWasMember) await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.alice)
  }
}

async function hostedHereAsMembers(ctx: CopyDisplayContext, backend: (p: string) => Promise<any>, group: string): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const asPeer = (url: string) => ctx.signedGetHeaders(url, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const since = (n: number, type: string) => () =>
    peer.captured.slice(n).find((c) => c.url === '/inbox' && JSON.parse(c.raw.toString('utf-8')).type === type)
  const body = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))

  // Roles. fx_alice is a member here for the members page.
  await db.from('server_roles').delete().in('id', [H_TESTER, H_MODS])
  const roles = await db.from('server_roles').insert([
    { id: H_TESTER, server_id: ids.hostedServer, name: 'Tester', color: '#e91e63', position: 5, hoist: true, permissions: 8192 },
    { id: H_MODS, server_id: ids.hostedServer, name: 'Mods', color: '#3498db', position: 10, hoist: true, permissions: 8 },
  ])
  assert(!roles.error, 'seed two hoisted roles on the hosted server', roles.error?.message)
  const assigned = await db.from('user_roles').insert([
    { user_id: ids.remote, role_id: H_TESTER, server_id: ids.hostedServer },
    { user_id: ids.alice, role_id: H_MODS, server_id: ids.hostedServer },
  ])
  assert(!assigned.error, 'assign them to the peer\'s user and fx_alice', assigned.error?.message)

  const groupUrl = `${localUrl}/servers/${ids.hostedServer}`
  const doc = await ctx.get(groupUrl, asPeer(groupUrl))
  eq(doc.status, 200, 'the peer\'s user reads the Group')
  const listed = Array.isArray(doc.json?.['harmony:roles']) ? doc.json['harmony:roles'] : []
  const tester = listed.find((r: any) => r?.id === `${group}/roles/${H_TESTER}`)
  assert(tester, 'the Group lists its roles in harmony:roles', JSON.stringify(doc.json?.['harmony:roles'] ?? null))
  eq(tester?.name, 'Tester', 'with the role\'s name')
  eq(tester?.color, '#e91e63', 'its colour')
  eq(tester?.position, 5, 'its position')
  eq(tester?.hoist, true, 'and its display-separately flag')
  eq(tester?.permissions, undefined, 'and no permission bits')
  assert(!listed.some((r: any) => r?.name === 'everyone'), 'the default role is not listed')

  const pageUrl = `${groupUrl}/members?page=1`
  const page = await ctx.get(pageUrl, asPeer(pageUrl))
  const memberRoles = Array.isArray(page.json?.['harmony:memberRoles']) ? page.json['harmony:memberRoles'] : []
  const ofRemote = memberRoles.find((e: any) => e?.member === peer.actorUrl)
  const ofAlice = memberRoles.find((e: any) => e?.member === `https://${instanceDomain}/users/fx_alice`)
  assert(Array.isArray(page.json?.orderedItems) && page.json.orderedItems.every((i: unknown) => typeof i === 'string'),
    'the members page still lists actor ids', page.body)
  eq(JSON.stringify(ofRemote?.roles ?? null), JSON.stringify([`${group}/roles/${H_TESTER}`]),
    'and names the peer\'s user\'s roles in harmony:memberRoles')
  // fx_alice owns the server: she also holds its Admin role.
  assert(Array.isArray(ofAlice?.roles) && ofAlice.roles.includes(`${group}/roles/${H_MODS}`), 'and fx_alice\'s', JSON.stringify(ofAlice ?? null))

  const { handleServerUpdateJob } = await backend('queue/handlers/serverStructureHandler.ts')
  const { handleMemberRolesJob, handleChannelPinJob } = await backend('queue/handlers/copyMirrorHandler.ts')

  await db.from('server_roles').update({ name: 'QA' }).eq('id', H_TESTER)
  let n = peer.captured.length
  await handleServerUpdateJob?.({ type: 'update', server_id: ids.hostedServer })
  const renamed = await waitFor(since(n, 'Update'))
  assert(renamed, 'a role change reaches the peer as the Group\'s Update')
  if (renamed) {
    const roleList = body(renamed).object?.['harmony:roles'] ?? []
    eq(roleList.find((r: any) => r?.id === `${group}/roles/${H_TESTER}`)?.name, 'QA', 'carrying the renamed role')
    assert(await strictReceiverRefusal(renamed, localUrl, instanceDomain) === null, 'signed with the Group\'s key')
  }

  n = peer.captured.length
  if (typeof handleMemberRolesJob === 'function') {
    await handleMemberRolesJob({ type: 'update', server_id: ids.hostedServer, user_id: ids.alice })
  }
  const reassigned = await waitFor(since(n, 'Update'))
  assert(reassigned, 'an assignment change reaches the peer as the Group\'s Update')
  if (reassigned) {
    const object = body(reassigned).object
    eq(object?.type, 'harmony:MemberRoles', 'of a harmony:MemberRoles')
    eq(object?.member, `https://${instanceDomain}/users/fx_alice`, 'naming the member')
    const { data: held } = await db.from('user_roles').select('role_id, role:server_roles!inner(is_default)')
      .eq('server_id', ids.hostedServer).eq('user_id', ids.alice)
    const expected = (held ?? []).filter((r: any) => !r.role?.is_default).map((r: any) => `${group}/roles/${r.role_id}`).sort()
    assert(expected.includes(`${group}/roles/${H_MODS}`), 'fx_alice holds Mods')
    eq(JSON.stringify(object?.roles ?? null), JSON.stringify(expected),
      'and all their roles')
    assert(await strictReceiverRefusal(reassigned, localUrl, instanceDomain) === null, 'signed with the Group\'s key')
  }

  await db.from('server_roles').delete().eq('id', H_MODS)
  n = peer.captured.length
  await handleServerUpdateJob?.({ type: 'update', server_id: ids.hostedServer })
  const dropped = await waitFor(since(n, 'Update'))
  assert(dropped && !(body(dropped).object?.['harmony:roles'] ?? []).some((r: any) => r?.id === `${group}/roles/${H_MODS}`)
    && (body(dropped).object?.['harmony:roles'] ?? []).length > 0,
    'a deleted role is gone from the next Update', dropped ? JSON.stringify(body(dropped).object?.['harmony:roles']) : 'none')

  // Pins.
  await db.from('messages').delete().in('id', [HOST_PIN, HOST_HIDDEN_PIN])
  const pinnedAt = new Date(Date.now() - 60_000).toISOString()
  const seeded = await db.from('messages').insert([
    { id: HOST_PIN, channel_id: ids.hostedChannel, user_id: ids.alice, content: [{ type: 'text', text: 'pinned rules' }] },
    { id: HOST_HIDDEN_PIN, channel_id: ids.hiddenChannel, user_id: ids.alice, content: [{ type: 'text', text: 'hidden pin' }] },
  ])
  assert(!seeded.error, 'seed a message in the visible and the hidden channel', seeded.error?.message)
  await db.from('messages').update({ is_pinned: true, pinned_at: pinnedAt, pinned_by: ids.alice }).eq('id', HOST_PIN)

  const pinsUrl = `${groupUrl}/channels/${ids.hostedChannel}/pins`
  const pins = await ctx.get(pinsUrl, asPeer(pinsUrl))
  eq(pins.status, 200, 'the peer\'s user reads the channel\'s pins collection')
  const pinnedNote = (pins.json?.orderedItems ?? []).find((o: any) => o?.id === `https://${instanceDomain}/messages/${HOST_PIN}`)
  assert(pinnedNote, 'which serves the pinned Note', pins.body.slice(0, 300))
  eq(pinnedNote?.['harmony:pinnedAt'] ? new Date(pinnedNote['harmony:pinnedAt']).toISOString() : null, pinnedAt,
    'with the time it was pinned')
  const hiddenPinsUrl = `${groupUrl}/channels/${ids.hiddenChannel}/pins`
  eq((await ctx.get(hiddenPinsUrl, asPeer(hiddenPinsUrl))).status, 404, 'the hidden channel\'s pins are 404 to the peer\'s user')
  const withPins = await ctx.get(groupUrl, asPeer(groupUrl))
  const generalEntry = (withPins.json?.['harmony:channels'] ?? []).find((c: any) => c?.localId === ids.hostedChannel)
  eq(generalEntry?.['harmony:pins']?.totalItems, 1, 'the Group\'s channel entry counts the pin')
  eq(generalEntry?.['harmony:pins']?.id, `${group}/channels/${ids.hostedChannel}/pins`, 'and names the collection')

  n = peer.captured.length
  if (typeof handleChannelPinJob === 'function') {
    await handleChannelPinJob({ type: 'update', message_id: HOST_PIN, channel_id: ids.hostedChannel, server_id: ids.hostedServer, pinned: true })
  }
  const add = await waitFor(since(n, 'Add'))
  assert(add, 'a pin reaches the peer\'s inbox as the Group\'s Add')
  if (add) {
    eq(body(add).object, `https://${instanceDomain}/messages/${HOST_PIN}`, 'naming the Note')
    eq(body(add).target, `${group}/channels/${ids.hostedChannel}/pins`, 'added to the channel\'s pins')
    eq(body(add).actor, group, 'by the Group')
    assert(await strictReceiverRefusal(add, localUrl, instanceDomain) === null, 'signed with the Group\'s key')
  }

  await db.from('messages').update({ is_pinned: true, pinned_at: new Date().toISOString(), pinned_by: ids.alice }).eq('id', HOST_HIDDEN_PIN)
  n = peer.captured.length
  if (typeof handleChannelPinJob === 'function') {
    await handleChannelPinJob({ type: 'update', message_id: HOST_HIDDEN_PIN, channel_id: ids.hiddenChannel, server_id: ids.hostedServer, pinned: true })
  }
  await new Promise((r) => setTimeout(r, 1500))
  assert(!since(n, 'Add')(), 'a pin in the channel the peer\'s user cannot view is not sent')

  await db.from('messages').update({ is_pinned: false, pinned_at: null, pinned_by: null }).eq('id', HOST_PIN)
  n = peer.captured.length
  if (typeof handleChannelPinJob === 'function') {
    await handleChannelPinJob({ type: 'update', message_id: HOST_PIN, channel_id: ids.hostedChannel, server_id: ids.hostedServer, pinned: false })
  }
  const remove = await waitFor(since(n, 'Remove'))
  assert(remove && body(remove).target === `${group}/channels/${ids.hostedChannel}/pins`
    && body(remove).object === `https://${instanceDomain}/messages/${HOST_PIN}`,
  'an unpin reaches the peer\'s inbox as the Group\'s Remove from the pins', remove ? remove.raw.toString('utf-8') : 'none')

  // Instance staff.
  await db.from('profiles').update({ is_admin: true }).eq('id', ids.alice)
  await db.from('profiles').update({ is_moderator: true }).eq('id', ids.carol)
  const { handleProfileJob } = await backend('queue/handlers/profileHandler.ts')
  n = peer.captured.length
  await handleProfileJob?.({ type: 'update', profile_id: ids.alice, username: 'fx_alice' })
  await handleProfileJob?.({ type: 'update', profile_id: ids.carol, username: 'fx_carol' })
  const staffUpdate = await waitFor(() => peer.captured.slice(n).find((c) => {
    const b = body(c)
    return b.type === 'Update' && b.object?.id === `https://${instanceDomain}/users/fx_alice`
  }))
  eq(staffUpdate ? body(staffUpdate).object?.['harmony:instanceRole'] : null, 'admin',
    'a staff change goes out as the account\'s Update, carrying harmony:instanceRole')
  const actor = async (name: string) => (await ctx.get(`${localUrl}/users/${name}`, { Accept: 'application/activity+json' })).json
  eq((await actor('fx_alice'))?.['harmony:instanceRole'], 'admin', 'an instance admin\'s actor carries harmony:instanceRole admin')
  eq((await actor('fx_carol'))?.['harmony:instanceRole'], 'moderator', 'a moderator\'s carries moderator')
  eq((await actor('fx_bob'))?.['harmony:instanceRole'], undefined, 'a member\'s carries none')

  // Channel order.
  const { handleChannelUpdated } = await backend('listeners/DatabaseListener.ts')
  n = peer.captured.length
  await handleChannelUpdated?.({
    id: ids.hostedChannel, server_id: ids.hostedServer, name: 'general', description: null, type: 0, order: 0, category: null,
  }, {})
  const moved = await waitFor(since(n, 'Update'))
  eq(moved ? body(moved).object?.position : null, 0, 'a channel Update to the top carries position 0')
  eq(moved ? body(moved).object?.order : null, 0, 'and order 0, which a 1.9.0 member reads')
}

async function hostedByPeer(ctx: CopyDisplayContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const peerOrigin = new URL(peer.base).origin
  const bobUrl = `https://${instanceDomain}/users/fx_bob`
  const roleUrl = (id: string) => `${peer.groupUrl}/roles/${id}`
  const channelApId = `${peer.groupUrl}/channels/${ids.remoteChannel}`
  const pinsUrl = `${channelApId}/pins`
  const inbox = `${localUrl}/inbox`
  const pinnedAt = new Date(Date.now() - 120_000).toISOString()
  const note = (id: string, text: string) => ({
    type: 'Note',
    id: `${peerOrigin}/messages/${id}`,
    attributedTo: peer.actorUrl,
    content: `<p>${text}</p>`,
    context: channelApId,
    published: new Date(Date.now() - 600_000).toISOString(),
    'harmony:rawContent': [{ type: 'text', text }],
    'harmony:serverId': ids.remoteRef,
  })
  const servedPins: Record<string, unknown>[] = [{ ...note(PEER_PIN, 'peer rules'), 'harmony:pinnedAt': pinnedAt }]
  const pinsGets: (string | null)[] = []
  const memberPageGets: (string | null)[] = []
  let instanceRole: string | null = 'admin'

  await db.from('user_servers').upsert(
    { server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted', member_instance: instanceDomain },
    { onConflict: 'server_id,user_id' },
  )
  await db.from('messages').delete().in('id', [PEER_PIN, PEER_LATER])

  const send = (res: http.ServerResponse, json: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/activity+json' })
    res.end(JSON.stringify(json))
  }
  peer.extraGet = (req, res) => {
    const url = req.url ?? ''
    if (url === `/servers/${ids.remoteRef}/members?page=1`) {
      memberPageGets.push(keyIdOf(req.headers.signature as string | undefined))
      send(res, {
        '@context': [AS, HARMONY],
        id: `${peer.groupUrl}/members?page=1`,
        type: 'OrderedCollectionPage',
        orderedItems: [peer.actorUrl, bobUrl],
        'harmony:memberRoles': [
          { member: peer.actorUrl, roles: [roleUrl(P_ADMIN)] },
          { member: bobUrl, roles: [roleUrl(P_TESTER)] },
        ],
      })
      return true
    }
    if (url === `/servers/${ids.remoteRef}/channels/${ids.remoteChannel}/pins`) {
      pinsGets.push(keyIdOf(req.headers.signature as string | undefined))
      send(res, { '@context': [AS, HARMONY], id: pinsUrl, type: 'OrderedCollection', totalItems: servedPins.length, orderedItems: servedPins })
      return true
    }
    if (url === '/users/fx_remote') {
      send(res, {
        '@context': [AS, 'https://w3id.org/security/v1', HARMONY],
        id: peer.actorUrl,
        type: 'Person',
        preferredUsername: 'fx_remote',
        name: 'Remote',
        inbox: `${peer.actorUrl}/inbox`,
        endpoints: { sharedInbox: `${peerOrigin}/inbox` },
        publicKey: { id: `${peer.actorUrl}#main-key`, owner: peer.actorUrl, publicKeyPem: peer.key.publicKey },
        ...(instanceRole ? { 'harmony:instanceRole': instanceRole } : {}),
      })
      return true
    }
    return false
  }
  const groupFields = (opts: { roles: boolean; pins: boolean }) => ({
    ...(opts.roles ? {
      'harmony:roles': [
        { type: 'harmony:Role', id: roleUrl(P_ADMIN), name: 'ADMIN', color: '#f1c40f', position: 10, hoist: true, mentionable: true },
        { type: 'harmony:Role', id: roleUrl(P_TESTER), name: 'TESTER', color: '#2ecc71', position: 5, hoist: true, mentionable: false },
        // Another Group's role: never stored.
        { type: 'harmony:Role', id: `https://elsewhere.example/servers/${ids.remoteRef}/roles/${P_ADMIN}`, name: 'Forged', position: 99, hoist: true },
      ],
    } : {}),
    'harmony:channels': [
      {
        id: channelApId, localId: ids.remoteChannel, name: 'peer-general', type: 'harmony:TextChannel', channelType: 'text', order: 0,
        ...(opts.pins ? { 'harmony:pins': { type: 'OrderedCollection', id: pinsUrl, totalItems: servedPins.length, updated: pinnedAt } } : {}),
      },
    ],
  })

  const { ServerDiscoveryService } = await backend('services/ServerDiscoveryService.ts')
  const { ActivityProcessor } = await backend('activitypub/ActivityProcessor.ts')
  const copyRole = async (id: string) => (await db.from('server_roles')
    .select('id, name, color, position, hoist, permissions, is_admin, is_default')
    .eq('server_id', ids.remoteRef).eq('ap_id', roleUrl(id)).maybeSingle()).data
  const rolesOf = async (userId: string) => {
    const { data } = await db.from('user_roles').select('role:server_roles!inner(ap_id)').eq('server_id', ids.remoteRef).eq('user_id', userId)
    return (data ?? []).map((r: any) => r.role?.ap_id).filter(Boolean).sort()
  }
  const pinState = async (id: string) => (await db.from('messages').select('id, user_id, channel_id, is_pinned, pinned_at').eq('id', id).maybeSingle()).data

  // An older host: no roles, no pins advert.
  peer.extraGroupFields = groupFields({ roles: false, pins: false })
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  eq(pinsGets.length, 0, 'a Group that advertises no pins is not asked for them')
  const before = await db.from('server_roles').select('id').eq('server_id', ids.remoteRef).not('ap_id', 'is', null)
  eq(before.data?.length ?? -1, 0, 'nor are roles stored from a Group that lists none')

  // A 1.9.1 host.
  peer.extraGroupFields = groupFields({ roles: true, pins: true })
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  await ServerDiscoveryService?.syncRemoteServerMembers?.(ids.remoteRef, `${peer.groupUrl}/members`, { signAs: ids.bob, serverApId: peer.groupUrl })
  const admin = await copyRole(P_ADMIN)
  assert(admin, 'the sync stores the Group\'s role on the copy')
  eq(admin?.name, 'ADMIN', 'with its name')
  eq(admin?.color, '#f1c40f', 'its colour')
  eq(admin?.position, 10, 'its position')
  eq(admin?.hoist, true, 'and its display-separately flag')
  eq(Number(admin?.permissions ?? -1), 0, 'holding no permission bits')
  eq(admin?.is_admin, false, 'and no administrator flag')
  const forged = await db.from('server_roles').select('id').eq('name', 'Forged')
  eq(forged.data?.length ?? -1, 0, 'a role under another Group\'s id is not stored')
  const leftovers = await db.from('server_roles').select('id').eq('server_id', ids.remoteRef).is('ap_id', null).eq('is_default', false)
  eq(leftovers.data?.length ?? -1, 0, 'the copy\'s own Admin role gives way to the host\'s')
  eq(JSON.stringify(await rolesOf(ids.remote)), JSON.stringify([roleUrl(P_ADMIN)]), 'the peer\'s user holds ADMIN on the copy')
  eq(JSON.stringify(await rolesOf(ids.bob)), JSON.stringify([roleUrl(P_TESTER)]), 'fx_bob holds TESTER')
  assert(memberPageGets.length > 0 && memberPageGets.every((k) => k === `${bobUrl}#main-key`), 'the members page is read signed as fx_bob', memberPageGets)

  assert(pinsGets.length > 0 && pinsGets.every((k) => k === `${bobUrl}#main-key`), 'the advertised pins are fetched signed as fx_bob', pinsGets)
  const cachedPin = await pinState(PEER_PIN)
  assert(cachedPin, 'the pinned Note the copy lacked is cached')
  eq(cachedPin?.channel_id, ids.remoteChannel, 'in its channel')
  eq(cachedPin?.user_id, ids.remote, 'by its author')
  eq(cachedPin?.is_pinned, true, 'and pinned')
  eq(cachedPin?.pinned_at ? new Date(cachedPin.pinned_at).toISOString() : null, pinnedAt, 'at the host\'s pin time')
  const fetchesAfterSync = pinsGets.length
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  eq(pinsGets.length, fetchesAfterSync, 'a second sync with the same pins advert fetches nothing')

  const refreshed = await ActivityProcessor?.refreshRemoteActor?.(peer.actorUrl)
  assert(refreshed, 'the peer\'s actor is refreshed')
  const remoteProfile = async () => (await db.from('profiles').select('instance_role').eq('id', ids.remote).maybeSingle()).data
  eq((await remoteProfile())?.instance_role, 'admin', 'its harmony:instanceRole is stored on its profile')

  // Live, from the Group.
  const asGroup = (body: unknown) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(body),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
  const asMember = (body: unknown) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(body),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const activity = (type: string, actor: string, extra: Record<string, unknown>) => ({
    '@context': [AS, HARMONY], id: `${actor}/activities/${crypto.randomUUID()}`, type, actor, published: new Date().toISOString(), ...extra,
  })

  assert(await asGroup(activity('Update', peer.groupUrl, {
    object: {
      id: peer.groupUrl, type: 'Group', name: 'Peer private', 'harmony:ChatServer': true,
      'harmony:roles': [{ type: 'harmony:Role', id: roleUrl(P_ADMIN), name: 'Admins', color: '#9b59b6', position: 12, hoist: true }],
    },
  })) < 300, 'the inbox takes the Group\'s Update')
  const renamed = await poll(async () => {
    const r = await copyRole(P_ADMIN)
    return r?.name === 'Admins' ? r : null
  })
  eq(renamed?.color, '#9b59b6', 'the Group\'s Update renames and recolours a role')
  eq(await copyRole(P_TESTER), null, 'and a role it no longer lists is deleted')
  eq(JSON.stringify(await rolesOf(ids.bob)), '[]', 'with its assignments')

  const reassign = (roles: string[]) => ({ object: { type: 'harmony:MemberRoles', id: `${peer.groupUrl}/members/${ids.bob}/roles`, member: bobUrl, roles } })
  assert(await asGroup(activity('Update', peer.groupUrl, reassign([roleUrl(P_ADMIN)]))) < 300, 'the inbox takes the Group\'s Update(harmony:MemberRoles)')
  const bobAdmin = await poll(async () => ((await rolesOf(ids.bob)).length ? await rolesOf(ids.bob) : null))
  eq(JSON.stringify(bobAdmin ?? []), JSON.stringify([roleUrl(P_ADMIN)]), 'which assigns fx_bob the role')
  await asMember(activity('Update', peer.actorUrl, reassign([])))
  await new Promise((r) => setTimeout(r, 1000))
  eq(JSON.stringify(await rolesOf(ids.bob)), JSON.stringify([roleUrl(P_ADMIN)]), 'the same Update by a member changes nothing')

  // Pins, live.
  const pinActivity = (type: 'Add' | 'Remove', actor: string, noteId: string) =>
    activity(type, actor, { object: noteId, target: pinsUrl })
  assert(await asGroup(pinActivity('Remove', peer.groupUrl, `${peerOrigin}/messages/${PEER_PIN}`)) < 300, 'the inbox takes the Group\'s Remove')
  const unpinned = await poll(async () => ((await pinState(PEER_PIN))?.is_pinned === false ? true : null))
  assert(unpinned, 'the Group\'s Remove from the pins unpins the message on the copy')
  await asMember(pinActivity('Add', peer.actorUrl, `${peerOrigin}/messages/${PEER_PIN}`))
  await new Promise((r) => setTimeout(r, 1000))
  eq((await pinState(PEER_PIN))?.is_pinned, false, 'an Add to the pins by a member pins nothing')
  assert(await asGroup(pinActivity('Add', peer.groupUrl, `${peerOrigin}/messages/${PEER_PIN}`)) < 300, 'the inbox takes the Group\'s Add')
  const repinned = await poll(async () => ((await pinState(PEER_PIN))?.is_pinned === true ? true : null))
  assert(repinned, 'the Group\'s Add pins it again')

  servedPins.unshift({ ...note(PEER_LATER, 'pinned before this copy knew it'), 'harmony:pinnedAt': new Date().toISOString() })
  const gets = pinsGets.length
  await asGroup(pinActivity('Add', peer.groupUrl, `${peerOrigin}/messages/${PEER_LATER}`))
  const later = await poll(async () => ((await pinState(PEER_LATER))?.is_pinned === true ? true : null))
  assert(pinsGets.length > gets, 'an Add naming a Note the copy lacks reads the pins collection')
  assert(later, 'which caches and pins it')

  // Instance staff, live.
  instanceRole = 'moderator'
  const person = (id: string, role: string) => ({
    id, type: 'Person', preferredUsername: id.split('/').pop(), inbox: `${id}/inbox`, 'harmony:instanceRole': role,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: peer.key.publicKey },
  })
  await asMember(activity('Update', peer.actorUrl, { object: person(peer.actorUrl, 'moderator') }))
  const moderator = await poll(async () => ((await remoteProfile())?.instance_role === 'moderator' ? true : null))
  assert(moderator, 'the actor\'s own Update sets its instance role')
  await db.from('profiles').delete().eq('id', ELSEWHERE)
  const other = await db.from('profiles').insert({
    id: ELSEWHERE, username: 'eve', domain: 'elsewhere.example', federated_id: ELSEWHERE_URL, inbox_url: `${ELSEWHERE_URL}/inbox`, is_local: false,
  })
  assert(!other.error, 'seed an account of a third instance', other.error?.message)
  await asMember(activity('Update', peer.actorUrl, { object: person(ELSEWHERE_URL, 'admin') }))
  await new Promise((r) => setTimeout(r, 1000))
  eq((await db.from('profiles').select('instance_role').eq('id', ELSEWHERE).maybeSingle()).data?.instance_role ?? null, null,
    'the peer cannot name another instance\'s account its staff')

  // Channel order.
  await db.from('channels').update({ order: 3 }).eq('id', ids.remoteChannel)
  await db.from('channel_categories').delete().eq('id', P_CATEGORY)
  await db.from('channel_categories').insert({ id: P_CATEGORY, server_id: ids.remoteRef, name: 'peer-cat', order: 4 })
  await asGroup(activity('Update', peer.groupUrl, {
    object: { type: 'harmony:TextChannel', id: channelApId, name: 'peer-general', position: 0, category: null },
  }))
  const top = await poll(async () => ((await db.from('channels').select('order').eq('id', ids.remoteChannel).single()).data?.order === 0 ? true : null))
  assert(top, 'a 1.9.0 host\'s channel Update to position 0 moves the channel to the top')
  await asGroup(activity('Update', peer.groupUrl, {
    object: { type: 'harmony:Category', id: `${peer.groupUrl}/channels/${P_CATEGORY}`, name: 'peer-cat', position: 0, order: 0, category: null },
  }))
  const catTop = await poll(async () => ((await db.from('channel_categories').select('order').eq('id', P_CATEGORY).single()).data?.order === 0 ? true : null))
  assert(catTop, 'a category Update to position 0 moves the category to the top')
}
