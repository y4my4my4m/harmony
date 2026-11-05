// Another instance for journeys that read its server directory: an HTTPS server publishing
// NodeInfo with metadata.serverDirectory, the directory (OrderedCollection and one page) and the
// Groups it lists, and taking deliveries to their inboxes.
//
// The federation backend refuses loopback and private addresses (utils/ssrfProtection.ts), so
// the server listens on the gateway of a Docker bridge network on E2E_PEER_SUBNET (default
// 198.51.100.0/24, TEST-NET-2): the host holds that address. A network already holding the
// gateway, such as a running e2e/federation stack on the same subnet, is reused. The certificate
// is self-signed: start the backend with NODE_TLS_REJECT_UNAUTHORIZED=0.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface PeerGroup {
  id: string
  name: string
  summary?: string
  /** Listed in the directory with discoverable true; false lists it with discoverable false. */
  discoverable?: boolean
  memberCount?: number
}

export interface PeerRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface DirectoryPeer {
  /** host:port, as typed into Other instances. */
  domain: string
  groupUrl(id: string): string
  channelId(id: string): string
  requests: PeerRequest[]
  stop(): Promise<void>
}

/**
 * The host can listen on `ip`. os.networkInterfaces() leaves out a bridge with no container
 * attached (no carrier, not RUNNING), whose address still binds and connects.
 */
function hostHolds(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, ip, () => probe.close(() => resolve(true)))
  })
}

export async function startDirectoryPeer(groups: PeerGroup[]): Promise<DirectoryPeer> {
  const subnet = process.env.E2E_PEER_SUBNET ?? '198.51.100.0/24'
  const ip = `${subnet.split('/')[0].split('.').slice(0, 3).join('.')}.1`
  const network = `${process.env.E2E_PROJECT ?? 'hme2e'}-directory-peer`
  let created = false
  if (!(await hostHolds(ip))) {
    // A network left by an interrupted run.
    try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* absent */ }
    execFileSync('docker', ['network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', ip, network], { stdio: 'ignore' })
    created = true
    for (let i = 0; i < 50 && !(await hostHolds(ip)); i++) await new Promise((r) => setTimeout(r, 100))
    if (!(await hostHolds(ip))) throw new Error(`docker network ${network} gave the host no ${ip}`)
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-peer-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${ip}`,
    '-addext', `subjectAltName=IP:${ip}`,
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
  ], { stdio: 'ignore' })

  const requests: PeerRequest[] = []
  const channelIds = new Map(groups.map((g) => [g.id, crypto.randomUUID()]))
  const groupKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  let domain = ''
  const base = () => `https://${domain}`
  const groupUrl = (id: string) => `${base()}/servers/${id}`
  const AS = 'https://www.w3.org/ns/activitystreams'
  const groupDoc = (g: PeerGroup) => ({
    '@context': [AS, 'https://w3id.org/security/v1'],
    id: groupUrl(g.id),
    type: 'Group',
    preferredUsername: g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: g.name,
    summary: g.summary ?? '',
    inbox: `${groupUrl(g.id)}/inbox`,
    outbox: `${groupUrl(g.id)}/outbox`,
    discoverable: g.discoverable !== false,
    'harmony:public': true,
    'harmony:federationEnabled': true,
    'harmony:memberCount': g.memberCount ?? 0,
    'harmony:channels': [{
      type: 'harmony:TextChannel', id: `${groupUrl(g.id)}/channels/${channelIds.get(g.id)}`,
      localId: channelIds.get(g.id), name: 'lobby', channelType: 'text', order: 0,
    }],
    publicKey: { id: `${groupUrl(g.id)}#main-key`, owner: groupUrl(g.id), publicKeyPem: groupKey.publicKey },
  })
  const routes = (url: string): { type: string; body: unknown } | null => {
    if (url === '/.well-known/nodeinfo') {
      return { type: 'application/json', body: { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${base()}/nodeinfo/2.1` }] } }
    }
    if (url === '/nodeinfo/2.1') {
      return {
        type: 'application/json',
        body: { version: '2.1', software: { name: 'harmony', version: '1.9.3' }, protocols: ['activitypub'], metadata: { serverDirectory: `${base()}/servers/directory` } },
      }
    }
    if (url === '/servers/directory') {
      return { type: 'application/activity+json', body: { '@context': AS, id: `${base()}/servers/directory`, type: 'OrderedCollection', totalItems: groups.length, first: `${base()}/servers/directory?page=1` } }
    }
    if (url === '/servers/directory?page=1') {
      return {
        type: 'application/activity+json',
        body: {
          '@context': AS, id: `${base()}/servers/directory?page=1`, type: 'OrderedCollectionPage', partOf: `${base()}/servers/directory`,
          orderedItems: groups.map(groupDoc),
        },
      }
    }
    for (const g of groups) {
      if (url === `/servers/${g.id}`) return { type: 'application/activity+json', body: groupDoc(g) }
      if (url.startsWith(`/servers/${g.id}/channels/`) || url.startsWith(`/servers/${g.id}/members`) || url.startsWith(`/servers/${g.id}/outbox`)) {
        return { type: 'application/activity+json', body: { '@context': AS, id: `${base()}${url}`, type: 'OrderedCollectionPage', totalItems: 0, orderedItems: [] } }
      }
    }
    return null
  }

  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}')
        return
      }
      const route = routes(req.url ?? '')
      if (!route) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': route.type }).end(JSON.stringify(route.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, ip, resolve))
  domain = `${ip}:${(server.address() as { port: number }).port}`

  return {
    domain,
    groupUrl,
    channelId: (id: string) => channelIds.get(id) ?? '',
    requests,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
      if (created) {
        try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* gone */ }
      }
    },
  }
}
