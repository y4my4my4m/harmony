// Invite links to servers on another Harmony instance (services/remoteInvitePreview.ts,
// routes/remoteInvite.ts), against a host behind a TLS proxy on the stack network. The host
// publishes NodeInfo naming Harmony and answers GET /api/federation/invites/<code> with this
// instance's own answer to /invites/<code>, its domain renamed: the same backend on both sides.
//
//   host       /invites/<code> of a local invite carries the online and member counts
//              get_invite_preview gives it.
//   preview    a message naming a valid invite, a revoked one and one of a server closed to
//              other instances is enriched as the link-preview worker enriches it:
//              messages.metadata.embeds holds harmony-remote-invite cards, the valid one with the
//              server's name, counts, plain description and Group id on the host, each naming the
//              instance by its NodeInfo nodeName and icon.
//   read       GET /remote-invite answers the card to a signed-in local user, 401 without one,
//              400 for a link that is no invite.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { startWebFingerProxy } from './outboundFederation.ts'

// Host part of the stack subnet's TLS proxy address; outboundFederation.ts takes .200,
// remoteInteractions.ts .201, discovery.ts .202.
const PROXY_OCTET = 203

export interface RemoteInviteCardContext {
  db: SupabaseClient
  localUrl: string
  instanceDomain: string
  backendRoot: string
  env: Record<string, string>
  ids: { alice: string; aliceAuth: string; pubServer: string; pubGeneral: string }
  bearer: (authUserId: string) => string
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** JSON with object keys sorted: jsonb keeps no key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v))
}

export async function caseRemoteInviteCard(ctx: RemoteInviteCardContext): Promise<void> {
  console.log('\ninvite link to a server on another Harmony instance -> its server card')
  const { db, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { enrichMessageLinkPreviews } = await backend('listeners/DatabaseListener.ts')
  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const proxyIp = `${ctx.env.HMFED_SUBNET.split('/')[0].split('.').slice(0, 3).join('.')}.${PROXY_OCTET}`
  const remote = (p: string) => `https://${proxyIp}${p}`
  const tag = crypto.randomUUID().slice(0, 6).toUpperCase()
  const codes = { valid: `RIV${tag}`, revoked: `RIR${tag}`, closed: `RIC${tag}` }
  const messageId = crypto.randomUUID()

  // HOST ----------------------------------------------------------------------------------------
  const seeded = await db.from('invites').insert([
    { code: codes.valid, server_id: ids.pubServer, created_by: ids.alice, max_uses: 0 },
    { code: codes.revoked, server_id: ids.pubServer, created_by: ids.alice, used: true },
  ])
  assert(!seeded.error, 'seed the local invites', seeded.error?.message)

  const hostAnswer = await fetch(`${localUrl}/invites/${codes.valid}`, { headers: { Accept: 'application/json' } })
  const hosted = await hostAnswer.json().catch(() => null)
  const { data: preview } = await db.rpc('get_invite_preview', { p_code: codes.valid })
  eq(hostAnswer.status, 200, 'this instance answers another instance for its own invite')
  assert(typeof hosted?.server?.onlineCount === 'number' && hosted.server.onlineCount === preview?.online_count
    && hosted.server.memberCount === preview?.member_count,
  'with the online and member counts get_invite_preview gives', JSON.stringify({ server: hosted?.server, preview }))

  // REMOTE HOST ---------------------------------------------------------------------------------
  const requests: string[] = []
  const nodeinfo = {
    version: '2.1',
    software: { name: 'harmony', version: '1.9.4' },
    metadata: { nodeName: '  Peer‮ Harmony ', icon: '/instance-icon.png' },
  }
  const host = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/.well-known/nodeinfo') {
      return json(200, { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: remote('/nodeinfo/2.1') }] })
    }
    if (req.url === '/nodeinfo/2.1') return json(200, nodeinfo)
    if (req.url === `/api/federation/invites/${codes.closed}`) {
      return json(403, { error: 'This server does not accept members from other instances', code: 'federation_disabled', federationEnabled: false })
    }
    const code = req.url?.match(/^\/api\/federation\/invites\/([A-Za-z0-9]+)$/)?.[1]
    if (!code) return json(404, { error: 'Not found' })
    void fetch(`${localUrl}/invites/${code}`, { headers: { Accept: 'application/json' } }).then(async (answer) => {
      const body = (await answer.text()).split(`https://${instanceDomain}`).join(`https://${proxyIp}`)
      res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(body)
    })
  })
  await new Promise<void>((resolve) => host.listen(0, '0.0.0.0', resolve))
  const hostBase = `http://${ctx.env.HMFED_PEER_HOST}:${(host.address() as { port: number }).port}`

  const links = {
    valid: remote(`/invite/${codes.valid}`),
    revoked: remote(`/invite/${codes.revoked}`),
    closed: remote(`/invite/${codes.closed}`),
  }
  const groupId = remote(`/servers/${ids.pubServer}`)

  let proxy: { stop: () => void } | null = null
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
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
    assert(up, `the invite host's TLS proxy answers on ${proxyIp}:443`)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    // PREVIEW -----------------------------------------------------------------------------------
    const content = [
      { type: 'text', text: 'come over ' },
      { type: 'url', url: links.valid, preview: true },
      { type: 'url', url: links.revoked, preview: true },
      { type: 'url', url: links.closed, preview: true },
    ]
    const inserted = await db.from('messages').insert({
      id: messageId, channel_id: ids.pubGeneral, user_id: ids.alice, content, federation_status: 'skipped',
    }).select('id, content, metadata').single()
    assert(!inserted.error, 'alice posts the invite links', inserted.error?.message)
    await enrichMessageLinkPreviews(inserted.data)

    const { data: row } = await db.from('messages').select('metadata').eq('id', messageId).single()
    const embeds = (row?.metadata?.embeds ?? {}) as Record<string, any>
    const instance = { name: 'Peer Harmony', icon: remote('/instance-icon.png') }

    const valid = embeds[links.valid]
    eq(valid?.provider, 'harmony-remote-invite', 'the valid invite is stored as a remote invite card')
    assert(canonical(valid?.remoteInvite) === canonical({
      status: 'valid', code: codes.valid, domain: proxyIp, instance,
      server: {
        name: 'Hosted public', description: hosted?.server?.description || null, icon: null,
        memberCount: hosted?.server?.memberCount, onlineCount: hosted?.server?.onlineCount, id: groupId,
      },
    }), 'with the host\'s server, counts and Group id, and the instance named by NodeInfo', JSON.stringify(valid?.remoteInvite))
    assert(valid?.title === 'Hosted public' && valid?.siteName === 'Peer Harmony' && !valid?.failed,
      'its title is the server and its site the instance', JSON.stringify({ title: valid?.title, siteName: valid?.siteName }))

    eq(canonical(embeds[links.revoked]?.remoteInvite),
      canonical({ status: 'invalid', code: codes.revoked, domain: proxyIp, instance }),
      'a revoked invite is stored as invalid, naming no server')
    eq(canonical(embeds[links.closed]?.remoteInvite),
      canonical({ status: 'closed', code: codes.closed, domain: proxyIp, instance }),
      'an invite of a server closed to other instances is stored as closed')
    eq(requests.filter((r) => r === '/nodeinfo/2.1').length, 1, 'the host\'s NodeInfo is read once for the three links')

    // READ --------------------------------------------------------------------------------------
    const read = (url: string, auth?: string) => fetch(`${localUrl}/remote-invite?${new URLSearchParams({ url })}`, {
      headers: { Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    })
    const anonymous = await read(links.valid)
    eq(anonymous.status, 401, 'reading a remote invite needs a session')
    const asked = requests.length
    const answered = await read(links.valid, ctx.bearer(ids.aliceAuth))
    const answer = await answered.json().catch(() => null)
    eq(answered.status, 200, 'a signed-in local user reads the card')
    eq(canonical(answer?.invite), canonical(valid?.remoteInvite), 'the same card the message stores')
    eq(requests.length, asked, 'from the cache: the host is not asked again')
    eq((await read(remote('/about'), ctx.bearer(ids.aliceAuth))).status, 400, 'a link that is no invite is refused')
  } catch (e) {
    assert(false, 'remote invite card case', (e as Error)?.stack ?? e)
  } finally {
    if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting
    proxy?.stop()
    await new Promise<void>((resolve) => host.close(() => resolve()))
    await db.from('messages').delete().eq('id', messageId)
    await db.from('invites').delete().in('code', [codes.valid, codes.revoked])
  }
}
