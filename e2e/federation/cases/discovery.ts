// Server directories across federation (migrations 20261105100001 and 20261107900001,
// activitypub/serverDirectory.ts, services/RemoteDirectoryService.ts,
// services/AdvertisedDirectoryService.ts), each way.
//
//   publishing   the peer reads https://<local>/servers/directory, unsigned and signed: an
//                OrderedCollection whose first page holds exactly the listed Groups; NodeInfo
//                metadata.serverDirectory and the instance actor's streams name it. A new public,
//                federated server is listed without its owner doing anything. A listed Group says
//                discoverable true, a public one its owner unlisted leaves it out, a private one
//                says false; harmony:public says whether anyone may join. Listing and unlisting
//                through update_server reach the peer as the Group's Update; unlisting removes the
//                Group from the collection at once. With outbound federation off nothing is listed.
//   reading      a directory host behind a TLS proxy on the stack network publishes NodeInfo and a
//                collection of four Groups, one listed on its own host. /directory/remote reads it
//                signed by the instance actor and answers that one, then from its cache; the host
//                is listed by /directory/peers, and /directory/servers merges its listed Group
//                with the host named, filtered by text; blocked, it is refused, unlisted and out of
//                the merged list; with federation off the merged list is empty and says so. fx_bob
//                joins the listed Group by its id through /servers/join: a signed Join reaches its
//                inbox and the copy is public.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap, startWebFingerProxy } from './outboundFederation.ts'

// Host part of the stack subnet's TLS proxy address; outboundFederation.ts takes .200,
// remoteInteractions.ts .201.
const PROXY_OCTET = 202
const AS = 'https://www.w3.org/ns/activitystreams'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface DiscoveryContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string }; captured: Captured[] }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  env: Record<string, string>
  ids: { alice: string; bob: string; bobAuth: string; remote: string; pubServer: string; privServer: string }
  asUser: (authUserId: string) => SupabaseClient
  bearer: (authUserId: string) => string
  aliceAuth: string
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function keyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

/** Signature params of a draft-cavage header. */
function signatureParams(signature: string): Record<string, string> {
  const parts: Record<string, string> = {}
  const re = /([A-Za-z0-9]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(signature)) !== null) parts[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? '').trim()
  return parts
}

/**
 * A GET signed with `publicKeyPem`'s key over (request-target), host and date, for `host`: the
 * TLS proxy hands the host its own upstream Host header.
 */
function signedFor(req: Captured, host: string, keyId: string, publicKeyPem: string): boolean {
  const params = signatureParams(req.headers.signature ?? '')
  if (params.keyId !== keyId || !params.signature) return false
  const covered = (params.headers ?? '').split(/\s+/)
  const line = (h: string) => h === '(request-target)' ? `(request-target): get ${req.url}`
    : h === 'host' ? `host: ${host}`
      : `${h}: ${req.headers[h] ?? ''}`
  return crypto.createVerify('SHA256').update(covered.map(line).join('\n'))
    .verify(publicKeyPem, params.signature, 'base64')
}

export async function caseDiscovery(ctx: DiscoveryContext): Promise<void> {
  console.log('\nserver directories -> published, read signed, filtered, joined from')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { invalidateFederationSwitches } = await backend('services/FederationSwitches.ts')
  const { handleServerUpdateJob } = await backend('queue/handlers/serverStructureHandler.ts')
  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const local = (p: string) => `https://${instanceDomain}${p}`
  const directory = local('/servers/directory')
  const groupOf = (id: string) => local(`/servers/${id}`)
  const alice = ctx.asUser(ctx.aliceAuth)
  const listed = crypto.randomUUID()
  const suspended = crypto.randomUUID()
  const closed = crypto.randomUUID()

  const readDirectory = async (signed: boolean) => {
    const url = `${localUrl}/servers/directory`
    const collection = await ctx.get(url, signed
      ? ctx.signedGetHeaders(url, peer.key.privateKey, `${peer.actorUrl}#main-key`)
      : { Accept: 'application/activity+json' })
    const first = typeof collection.json?.first === 'string' ? collection.json.first : ''
    const pageUrl = `${localUrl}${first.slice(local('').length)}`
    const page = first ? await ctx.get(pageUrl, { Accept: 'application/activity+json' }) : null
    return { collection, page, ids: (page?.json?.orderedItems ?? []).map((g: any) => g.id) }
  }
  const groupDoc = async (id: string, signedBy?: { key: string; actor: string }) => {
    const url = `${localUrl}/servers/${id}`
    return (await ctx.get(url, signedBy
      ? ctx.signedGetHeaders(url, signedBy.key, `${signedBy.actor}#main-key`)
      : { Accept: 'application/activity+json' })).json
  }
  const updatesSince = (n: number, serverId: string) => peer.captured.slice(n)
    .map((c) => JSON.parse(c.raw.toString('utf-8')))
    .filter((a) => a.type === 'Update' && a.object?.id === groupOf(serverId))

  // PUBLISHING ----------------------------------------------------------------------------------
  const seeded = await db.from('servers').insert([
    { id: listed, name: 'Directory Hall', description: 'Listed here', owner: ids.alice, public: true, is_local_server: true, federation_enabled: true },
    { id: suspended, name: 'Directory Suspended', owner: ids.alice, public: true, is_local_server: true, federation_enabled: true },
    { id: closed, name: 'Directory Closed', owner: ids.alice, public: true, is_local_server: true, federation_enabled: false },
  ])
  assert(!seeded.error, 'seed the directory servers', seeded.error?.message)
  const forced = await db.from('servers').update({ federation_discoverable: true }).in('id', [suspended, closed])
  assert(!forced.error, 'force the flag on a server to suspend and a server not federating', forced.error?.message)
  await db.from('servers').update({ suspended_at: new Date().toISOString(), suspended_reason: 'directory case' }).eq('id', suspended)
  await db.from('user_servers').upsert(
    { server_id: ids.pubServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).host },
    { onConflict: 'user_id,server_id' })

  const tap = await JobTap.open(project)
  const runServerUpdate = async (serverId: string) => {
    const job = await tap.take((j) => j.name === 'federate-server-update' && j.data?.server_id === serverId)
    assert(job, `a change of the flag queues federate-server-update for ${serverId}`)
    if (job) await handleServerUpdateJob(job.data)
  }

  try {
    const { data: defaults } = await db.from('servers').select('id, federation_discoverable').in('id', [listed, ids.privServer])
    assert((defaults ?? []).length === 2 && (defaults ?? []).every((r: any) => r.federation_discoverable === true),
      'a new server, public or private, carries the flag on', JSON.stringify(defaults))
    const unlisting = await alice.rpc('update_server', { p_server_id: ids.pubServer, p_changes: { federation_discoverable: false } })
    eq(unlisting.data?.federation_discoverable, false, 'the owner unlists a public, federated server through update_server')
    await tap.take((j) => j.name === 'federate-server-update' && j.data?.server_id === ids.pubServer, 2000)

    const before = await readDirectory(false)
    eq(before.collection.status, 200, 'the directory answers')
    eq(before.collection.json?.type, 'OrderedCollection', 'the directory is an OrderedCollection')
    eq(before.collection.json?.id, directory, 'under its own id')
    eq(before.page?.json?.type, 'OrderedCollectionPage', 'its first page is an OrderedCollectionPage')
    eq(JSON.stringify(before.ids), JSON.stringify([groupOf(listed)]),
      'the peer sees exactly the Group listed by default: not the suspended, the unfederated, the unlisted or the private one')
    const item = before.page?.json?.orderedItems?.[0]
    assert(item?.type === 'Group' && item.discoverable === true && item['harmony:public'] === true
      && item.name === 'Directory Hall' && item.inbox === `${groupOf(listed)}/inbox` && typeof item['harmony:memberCount'] === 'number',
    'an item is the Group\'s public summary', JSON.stringify(item))
    eq(JSON.stringify((await readDirectory(true)).ids), JSON.stringify(before.ids), 'a signed read lists the same')

    const nodeinfo = await ctx.get(`${localUrl}/nodeinfo/2.1`, { Accept: 'application/json' })
    eq(nodeinfo.json?.metadata?.serverDirectory, directory, 'NodeInfo names the directory')
    const actor = await ctx.get(`${localUrl}/users/instance.actor`, { Accept: 'application/activity+json' })
    assert(actor.json?.streams?.includes(directory) && actor.json?.['harmony:directory'] === directory,
      'the instance actor links the directory', JSON.stringify({ streams: actor.json?.streams, d: actor.json?.['harmony:directory'] }))

    const listedDoc = await groupDoc(listed)
    assert(listedDoc?.discoverable === true && listedDoc['harmony:public'] === true
      && JSON.stringify(listedDoc['@context']).includes('"discoverable":"toot:discoverable"'),
    'the listed Group says discoverable, as toot:discoverable', JSON.stringify(listedDoc?.['@context']))
    const publicDoc = await groupDoc(ids.pubServer)
    assert(publicDoc && !('discoverable' in publicDoc) && publicDoc['harmony:public'] === true,
      'a public unlisted Group leaves discoverable out and says harmony:public', JSON.stringify(publicDoc))
    const privateStub = await groupDoc(ids.privServer)
    eq(privateStub?.discoverable, false, 'a private Group\'s stub says discoverable false')
    const privateFull = await groupDoc(ids.privServer, { key: peer.key.privateKey, actor: peer.actorUrl })
    assert(privateFull?.discoverable === false && privateFull['harmony:public'] === false,
      'a private Group read by its member says discoverable false and harmony:public false', JSON.stringify(privateFull))

    // Listing and unlisting a server with a member on the peer.
    let n = peer.captured.length
    await alice.rpc('update_server', { p_server_id: ids.pubServer, p_changes: { federation_discoverable: true } })
    await runServerUpdate(ids.pubServer)
    const [listedUpdate] = updatesSince(n, ids.pubServer)
    assert(listedUpdate?.object?.discoverable === true && listedUpdate.object['harmony:public'] === true,
      'listing reaches the peer as the Group\'s Update, discoverable true', JSON.stringify(listedUpdate?.object))
    eq(JSON.stringify((await readDirectory(false)).ids), JSON.stringify([groupOf(ids.pubServer), groupOf(listed)]),
      'the listed server joins the directory, most members first')

    n = peer.captured.length
    await alice.rpc('update_server', { p_server_id: ids.pubServer, p_changes: { federation_discoverable: false } })
    eq(JSON.stringify((await readDirectory(false)).ids), JSON.stringify([groupOf(listed)]),
      'unlisting removes the server from the directory at once')
    const unlistedDoc = await groupDoc(ids.pubServer)
    assert(unlistedDoc && !('discoverable' in unlistedDoc), 'and the Group no longer says discoverable')
    await runServerUpdate(ids.pubServer)
    const [unlistedUpdate] = updatesSince(n, ids.pubServer)
    assert(unlistedUpdate && !('discoverable' in unlistedUpdate.object) && unlistedUpdate.object['harmony:public'] === true,
      'the Group\'s Update without discoverable reaches the peer', JSON.stringify(unlistedUpdate?.object))

    const off = await db.from('instance_config').upsert(
      { config_key: 'enable_outbound_federation', config_value: false }, { onConflict: 'config_key' })
    assert(!off.error, 'outbound federation off', off.error?.message)
    invalidateFederationSwitches()
    const closedDirectory = await readDirectory(false)
    eq(closedDirectory.collection.json?.totalItems, 0, 'with outbound federation off nothing is listed')
    eq((await groupDoc(listed))?.discoverable, undefined, 'and the listed Group no longer says discoverable')
  } finally {
    await db.from('instance_config').upsert(
      { config_key: 'enable_outbound_federation', config_value: true }, { onConflict: 'config_key' })
    invalidateFederationSwitches()
    tap.close()
  }

  // READING -------------------------------------------------------------------------------------
  const proxyIp = `${ctx.env.HMFED_SUBNET.split('/')[0].split('.').slice(0, 3).join('.')}.${PROXY_OCTET}`
  const remote = (p: string) => `https://${proxyIp}${p}`
  const joinable = crypto.randomUUID()
  const channel = crypto.randomUUID()
  const groupKey = keyPair()
  const hostRequests: Captured[] = []
  const remoteGroup = (id: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'Group', preferredUsername: `g${id.slice(-6)}`, name: `Remote ${id.slice(-6)}`, summary: '<p>Come <b>in</b></p>',
    inbox: `${id}/inbox`, discoverable: true, 'harmony:public': true, 'harmony:federationEnabled': true, 'harmony:memberCount': 3,
    ...extra,
  })
  const joinableId = remote(`/servers/${joinable}`)
  const docs: Record<string, unknown> = {
    '/.well-known/nodeinfo': { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: remote('/nodeinfo/2.1') }] },
    '/nodeinfo/2.1': { version: '2.1', software: { name: 'harmony', version: '1.9.3' }, metadata: { serverDirectory: remote('/servers/directory') } },
    '/servers/directory': {
      '@context': AS, id: remote('/servers/directory'), type: 'OrderedCollection', totalItems: 4, first: remote('/servers/directory?page=1'),
    },
    '/servers/directory?page=1': {
      '@context': AS, id: remote('/servers/directory?page=1'), type: 'OrderedCollectionPage', partOf: remote('/servers/directory'),
      orderedItems: [
        remoteGroup(joinableId),
        remoteGroup(`https://elsewhere.example/servers/${crypto.randomUUID()}`),
        remoteGroup(remote(`/servers/${crypto.randomUUID()}`), { discoverable: false }),
        remoteGroup(remote(`/servers/${crypto.randomUUID()}`), { 'harmony:federationEnabled': false }),
      ],
    },
    [`/servers/${joinable}`]: {
      '@context': [AS, 'https://w3id.org/security/v1'],
      ...remoteGroup(joinableId),
      outbox: `${joinableId}/outbox`,
      'harmony:channels': [{ type: 'harmony:TextChannel', id: `${joinableId}/channels/${channel}`, localId: channel, name: 'lobby', channelType: 'text', order: 0 }],
      publicKey: { id: `${joinableId}#main-key`, owner: joinableId, publicKeyPem: groupKey.publicKey },
    },
  }
  const host = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      hostRequests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers as Record<string, string>, raw: Buffer.concat(chunks) })
      if (req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}')
        return
      }
      // The collection is served signed only, as an instance in authorized fetch mode serves it.
      if (req.url?.startsWith('/servers/directory') && !req.headers.signature) {
        res.writeHead(401).end()
        return
      }
      const doc = docs[req.url ?? '']
      if (!doc) {
        res.writeHead(404).end()
        return
      }
      const json = req.url!.startsWith('/servers/') ? 'application/activity+json' : 'application/json'
      res.writeHead(200, { 'Content-Type': json }).end(JSON.stringify(doc))
    })
  })
  await new Promise<void>((resolve) => host.listen(0, '0.0.0.0', resolve))
  const hostBase = `http://${ctx.env.HMFED_PEER_HOST}:${(host.address() as { port: number }).port}`

  const bob = ctx.bearer(ids.bobAuth)
  const call = async (p: string) => {
    const res = await fetch(`${localUrl}${p}`, { headers: { Authorization: `Bearer ${bob}`, Accept: 'application/json' } })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const browse = () => call(`/directory/remote?domain=${encodeURIComponent(proxyIp)}`)

  let proxy: { stop: () => void } | null = null
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  await db.from('federated_instances').delete().eq('domain', proxyIp)
  const known = await db.from('federated_instances').insert({ domain: proxyIp, software: 'harmony', last_seen_at: new Date().toISOString() })
  assert(!known.error, 'the directory host is a known instance', known.error?.message)
  try {
    proxy = startWebFingerProxy(project, proxyIp, hostBase)
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise<boolean>((resolve) => {
        const s = net.connect(443, proxyIp, () => { s.end(); resolve(true) })
        s.on('error', () => resolve(false))
      })
      if (!up) await sleep(200)
    }
    assert(up, `the directory host's TLS proxy answers on ${proxyIp}:443`)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const unauthenticated = await fetch(`${localUrl}/directory/remote?domain=${encodeURIComponent(proxyIp)}`)
    eq(unauthenticated.status, 401, 'reading another instance\'s directory needs a session')

    const first = await browse()
    eq(first.status, 200, 'the directory of the host is read')
    eq(JSON.stringify((first.json?.items ?? []).map((i: any) => i.id)), JSON.stringify([joinableId]),
      'exactly the listed Group on the host is kept: not one elsewhere, undiscoverable or closed')
    const entry = first.json?.items?.[0]
    assert(entry?.name === `Remote ${joinable.slice(-6)}` && entry.summary === 'Come in' && entry.memberCount === 3
      && entry.handle === `g${joinable.slice(-6)}@${proxyIp}`, 'an entry carries the Group\'s name, plain summary, member count and handle', JSON.stringify(entry))
    eq(first.json?.totalItems, 4, 'with the collection\'s totalItems')

    const { data: keys } = await db.from('instance_actor_keys').select('public_key').eq('id', true).single()
    const collectionGets = hostRequests.filter((r) => r.method === 'GET' && r.url.startsWith('/servers/directory'))
    assert(collectionGets.length === 2 && collectionGets.every((r) => keys?.public_key
      && signedFor(r, proxyIp, local('/users/instance.actor#main-key'), keys.public_key)),
    'the collection and its page are fetched signed by the instance actor',
    JSON.stringify(collectionGets.map((r) => [r.url, r.headers.signature?.slice(0, 80)])))

    const seen = hostRequests.length
    eq((await browse()).json?.items?.length, 1, 'a second read answers the same')
    eq(hostRequests.length, seen, 'from the cache: the host is not asked again')

    const peers = await call('/directory/peers')
    assert((peers.json?.peers ?? []).some((p: any) => p.domain === proxyIp),
      'the host is listed among the known instances that publish a directory', JSON.stringify(peers.json))

    const unsignedMerged = await fetch(`${localUrl}/directory/servers`)
    eq(unsignedMerged.status, 401, 'the merged list needs a session')
    const merged = await call('/directory/servers')
    eq(merged.status, 200, 'the merged list of the known instances answers')
    const ofHost = (merged.json?.items ?? []).filter((i: any) => i.instance?.domain === proxyIp)
    eq(JSON.stringify(ofHost.map((i: any) => i.id)), JSON.stringify([joinableId]),
      'it holds exactly the host\'s listed Group, with nothing typed')
    assert(ofHost[0]?.name === `Remote ${joinable.slice(-6)}` && ofHost[0]?.memberCount === 3
      && ofHost[0]?.handle === `g${joinable.slice(-6)}@${proxyIp}` && ofHost[0]?.instance?.name === null,
    'an item is the directory entry plus the instance that hosts it', JSON.stringify(ofHost[0]))
    assert(!(merged.json?.failed ?? []).includes(proxyIp) && merged.json?.federationOff === false,
      'the host is not among the failed', JSON.stringify(merged.json))
    const named = await call(`/directory/servers?q=${encodeURIComponent(`REMOTE ${joinable.slice(-6)}`)}`)
    eq(JSON.stringify((named.json?.items ?? []).map((i: any) => i.id)), JSON.stringify([joinableId]),
      'a filter by its name keeps it, case folded')
    eq((await call('/directory/servers?q=no-server-is-called-this')).json?.total, 0, 'a filter matching nothing leaves none')

    await db.from('federated_instances').update({ is_blocked: true }).eq('domain', proxyIp)
    const blocked = await browse()
    eq(blocked.json?.code, 'instance_blocked', 'a blocked instance\'s directory is not read')
    assert(!((await call('/directory/peers')).json?.peers ?? []).some((p: any) => p.domain === proxyIp),
      'and it is not listed among the known instances')
    assert(!((await call('/directory/servers')).json?.items ?? []).some((i: any) => i.instance?.domain === proxyIp),
      'nor are its servers in the merged list')
    await db.from('federated_instances').update({ is_blocked: false }).eq('domain', proxyIp)

    await db.from('instance_config').upsert(
      { config_key: 'enable_inbound_federation', config_value: false }, { onConflict: 'config_key' })
    invalidateFederationSwitches()
    const closedMerged = await call('/directory/servers')
    eq(JSON.stringify([closedMerged.json?.federationOff, closedMerged.json?.items?.length]), '[true,0]',
      'with inbound federation off the merged list is empty and says federation is off')
    await db.from('instance_config').upsert(
      { config_key: 'enable_inbound_federation', config_value: true }, { onConflict: 'config_key' })
    invalidateFederationSwitches()
    eq(JSON.stringify(((await call('/directory/servers')).json?.items ?? [])
      .filter((i: any) => i.instance?.domain === proxyIp).map((i: any) => i.id)), JSON.stringify([joinableId]),
    'and it comes back with federation')

    const before = hostRequests.length
    const join = await fetch(`${localUrl}/servers/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ serverUrl: joinableId, userId: ids.bob }),
    })
    const joined = await join.json().catch(() => null)
    eq(join.status, 200, 'fx_bob joins the listed Group by its id')
    eq(joined?.status, 'accepted', 'at once: the Group says harmony:public')
    const delivered = hostRequests.slice(before).find((r) => r.method === 'POST' && r.url === `/servers/${joinable}/inbox`)
    const joinActivity = delivered ? JSON.parse(delivered.raw.toString('utf-8')) : null
    assert(joinActivity?.type === 'Join' && joinActivity.object === joinableId && joinActivity.actor === local('/users/fx_bob')
      && /keyId="[^"]*\/users\/fx_bob#main-key"/.test(delivered?.headers.signature ?? ''),
    'a Join signed by fx_bob reaches the Group\'s inbox', JSON.stringify({ joinActivity, sig: delivered?.headers.signature?.slice(0, 120) }))
    const { data: copy } = await db.from('servers').select('id, public, is_local_server').eq('ap_id', joinableId).maybeSingle()
    assert(copy?.public === true && copy.is_local_server === false, 'the copy of the Group is public', JSON.stringify(copy))
  } catch (e) {
    assert(false, 'server directory reading case', (e as Error)?.stack ?? e)
  } finally {
    if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting
    proxy?.stop()
    await new Promise<void>((resolve) => host.close(() => resolve()))
    const { data: copy } = await db.from('servers').select('id').eq('ap_id', joinableId).maybeSingle()
    if (copy) {
      await db.from('user_servers').delete().eq('server_id', copy.id)
      await db.from('servers').delete().eq('id', copy.id)
    }
    await db.from('federated_instances').delete().eq('domain', proxyIp)
    await db.from('servers').delete().in('id', [listed, suspended, closed])
  }
}
