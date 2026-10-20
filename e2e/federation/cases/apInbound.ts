// ActivityPub conformance, what this instance accepts. The peer delivers; a second remote
// instance, the origin, serves its actors, notes and gone documents.
//
//   - activity types the inbox does not implement (PeerTube View, GoToSocial LikeRequest,
//     Lemmy Dislike, Pleroma ChatMessage) are answered 202 ignored and stored nowhere;
//   - a blocked domain refuses its subdomains, not its look-alikes;
//   - a Lemmy Page, an Article, a PeerTube Video and a Note carrying only contentMap are
//     stored as posts with their title, link, thumbnail and language;
//   - an actor's Delete of itself marks the account deleted, drops its follows both ways,
//     soft-deletes its posts and silences it; the Delete of an actor whose key answers 410
//     is acknowledged;
//   - an activity forwarded by another signer is applied as its origin serves it: a Create
//     with the origin's content, a Delete once the origin answers 410; a Create the origin
//     contradicts, a Delete the origin still serves and a forwarded Like are refused 403.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`

export interface ApInboundContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  backendRoot: string
  ids: { alice: string; remote: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

function keyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

/** A second remote instance: actors with their own keys, documents and statuses set per URL. */
class Origin {
  readonly actors = new Map<string, ReturnType<typeof keyPair>>()
  readonly docs = new Map<string, { status: number; doc?: unknown }>()
  readonly userAgents: string[] = []
  base = ''
  private server?: http.Server

  actorUrl(name: string): string {
    return `${this.base}/users/${name}`
  }

  addActor(name: string): string {
    this.actors.set(this.actorUrl(name), keyPair())
    return this.actorUrl(name)
  }

  keyOf(actorUrl: string): string {
    return this.actors.get(actorUrl)!.privateKey
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const url = `${this.base}${req.url ?? ''}`
        if (req.method !== 'GET') {
          res.writeHead(202).end()
          return
        }
        this.userAgents.push(String(req.headers['user-agent'] ?? ''))
        const set = this.docs.get(url)
        const key = this.actors.get(url)
        const doc = set ? set.doc : key
          ? {
              '@context': [AS, 'https://w3id.org/security/v1'],
              id: url,
              type: 'Person',
              preferredUsername: url.split('/').pop(),
              inbox: `${url}/inbox`,
              publicKey: { id: `${url}#main-key`, owner: url, publicKeyPem: key.publicKey },
            }
          : undefined
        const status = set?.status ?? (doc ? 200 : 404)
        if (status !== 200 || !doc) {
          res.writeHead(status, { 'Content-Type': 'application/activity+json' })
          res.end(status === 410 ? JSON.stringify({ '@context': AS, id: url, type: 'Tombstone' }) : '')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify(doc))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    this.base = `http://${host}:${(this.server!.address() as { port: number }).port}`
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

/** Text of a content array, parts joined. */
function textOf(content: unknown): string {
  return Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : ''
}

export async function caseApInbound(ctx: ApInboundContext): Promise<void> {
  const { db, peer, localUrl, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const inbox = `${localUrl}/inbox`

  // The inbox admits 60 deliveries a minute from one signing host, and the peer and the
  // origin share one: a 429 is sent again once the window turns, for at most 75 s.
  const deliver = async (activity: Record<string, unknown>, signer: { key: string; actor: string }) => {
    const body = JSON.stringify({ '@context': AS, ...activity })
    for (let attempt = 0; ; attempt++) {
      const res = await ctx.post(inbox, ctx.signedHeaders(inbox, body, signer.key, `${signer.actor}#main-key`), body)
      if (res.status !== 429 || attempt >= 15) {
        let json: any = null
        try { json = JSON.parse(res.body) } catch { json = null }
        return { status: res.status, json }
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
  const asPeer = { key: peer.key.privateKey, actor: peer.actorUrl }
  const postByApId = async (apId: string) => (await db.from('posts').select('*').eq('ap_id', apId).maybeSingle()).data
  const create = (actor: string, object: Record<string, unknown>) => ({
    id: `${object.id}/activity`, type: 'Create', actor, to: [PUBLIC], object: { to: [PUBLIC], cc: [], published: new Date().toISOString(), ...object },
  })

  const origin = new Origin()
  await origin.start(new URL(peer.base).hostname)
  const ann = origin.addActor('fx_ann')
  const leaving = origin.addActor('fx_leaving')
  const blockedDomains = ['blocked-ap.test']

  try {
    console.log('\ninbound conformance -> activity types the inbox does not implement')
    for (const type of ['View', 'LikeRequest', 'Dislike', 'ChatMessage']) {
      const id = `${peer.actorUrl}#${type}-${crypto.randomUUID()}`
      const res = await deliver({ id, type, actor: peer.actorUrl, object: `${peer.base}/notes/x` }, asPeer)
      eq(`${res.status} ${res.json?.status}`, '202 ignored', `${type} is answered 202 ignored`)
      eq((await db.from('ap_activities').select('id').eq('ap_id', id).maybeSingle()).data, null, `and the ${type} is stored nowhere`)
    }

    console.log('\ninbound conformance -> a domain block covers its subdomains')
    {
      const { BlockedInstancesCache } = await backend('services/BlockedInstancesCache.ts')
      await db.from('federated_instances').delete().in('domain', blockedDomains)
      const ins = await db.from('federated_instances').insert({ domain: 'blocked-ap.test', is_blocked: true })
      assert(!ins.error, 'block blocked-ap.test', ins.error?.message)
      await BlockedInstancesCache.refresh()
      const from = (actor: string) => deliver({ id: `${actor}#x-${crypto.randomUUID()}`, type: 'Like', actor, object: `${peer.base}/notes/x` }, { key: peer.key.privateKey, actor })
      eq((await from('https://sub.blocked-ap.test/users/x')).status, 403, 'an actor on a subdomain of a blocked domain is refused (403)')
      eq((await from('https://blocked-ap.test/users/x')).status, 403, 'as on the domain itself')
      eq((await from('https://notblocked-ap.test/users/x')).status, 401, 'a look-alike domain is not blocked: it fails on its signature (401)')
      await db.from('federated_instances').delete().in('domain', blockedDomains)
      await BlockedInstancesCache.refresh()
    }

    console.log('\ninbound conformance -> Page, Article, Video and contentMap posts')
    {
      const page = `${peer.base}/post/page-${crypto.randomUUID()}`
      eq((await deliver(create(peer.actorUrl, {
        id: page, type: 'Page', name: 'Lemmy title', content: '<p>Lemmy body</p>',
        attachment: [{ type: 'Link', href: 'https://news.example/story' }], language: { identifier: 'de', name: 'Deutsch' },
      }), asPeer)).status, 202, 'a Create(Page) is accepted (202)')
      const pageRow = await postByApId(page)
      eq(pageRow?.ap_type, 'Page', 'the Page is stored as a post')
      assert(textOf(pageRow?.content).startsWith('Lemmy title') && textOf(pageRow?.content).includes('Lemmy body'),
        'with its title before its body', textOf(pageRow?.content))
      assert(pageRow?.content?.some((p: any) => p.type === 'url' && p.url === 'https://news.example/story'), 'and its link', pageRow?.content)
      eq(pageRow?.language, 'de', 'in the language Lemmy names')

      const article = `${peer.base}/articles/${crypto.randomUUID()}`
      await deliver(create(peer.actorUrl, { id: article, type: 'Article', name: 'Blog title', summary: 'an excerpt', content: '<p>Long read</p>' }), asPeer)
      const articleRow = await postByApId(article)
      assert(textOf(articleRow?.content).startsWith('Blog title'), 'an Article is stored with its name', textOf(articleRow?.content))
      eq(articleRow?.content_warning, null, 'its excerpt is no content warning')

      const video = `${peer.base}/videos/watch/${crypto.randomUUID()}`
      await deliver(create(peer.actorUrl, {
        id: video, type: 'Video', name: 'A video', mediaType: 'text/markdown', content: 'the description',
        url: [
          { type: 'Link', mediaType: 'application/x-mpegURL', href: `${video}/master.m3u8` },
          { type: 'Link', mediaType: 'text/html', href: `${video}/watch` },
        ],
        icon: [
          { type: 'Image', url: 'https://media.example/thumb-small.jpg', mediaType: 'image/jpeg', width: 280, height: 157 },
          { type: 'Image', url: 'https://media.example/thumb-large.jpg', mediaType: 'image/jpeg', width: 850, height: 480 },
        ],
      }), asPeer)
      const videoRow = await postByApId(video)
      eq(videoRow?.ap_type, 'Video', 'a PeerTube Video is stored as a post')
      assert(textOf(videoRow?.content).includes('A video') && textOf(videoRow?.content).includes('the description'),
        'with its name and description', textOf(videoRow?.content))
      assert(videoRow?.content?.some((p: any) => p.type === 'url' && p.url === `${video}/watch`), 'a link to its page', videoRow?.content)
      eq(videoRow?.media_attachments?.[0]?.url, 'https://media.example/thumb-large.jpg', 'and its largest thumbnail')
      eq(videoRow?.url, `${video}/watch`, 'whose url is the watch page')

      const mapped = `${peer.base}/notes/map-${crypto.randomUUID()}`
      await deliver(create(peer.actorUrl, { id: mapped, type: 'Note', contentMap: { ja: '<p>こんにちは</p>' } }), asPeer)
      const mappedRow = await postByApId(mapped)
      eq(textOf(mappedRow?.content), 'こんにちは', 'a Note without content is read from contentMap')
      eq(mappedRow?.language, 'ja', 'in its contentMap language')
    }

    console.log('\ninbound conformance -> an actor\'s Delete of itself')
    {
      const asLeaving = { key: origin.keyOf(leaving), actor: leaving }
      const note = `${origin.base}/notes/leaving-${crypto.randomUUID()}`
      eq((await deliver(create(leaving, { id: note, type: 'Note', attributedTo: leaving, content: '<p>bye soon</p>' }), asLeaving)).status, 202,
        'the leaving account posts (202)')
      const { data: account } = await db.from('profiles').select('id').eq('federated_id', leaving).maybeSingle()
      assert(account?.id, 'its account is stored')
      if (account?.id) {
        await db.from('follows').insert([
          { follower_id: ctx.ids.alice, following_id: account.id, status: 'accepted' },
          { follower_id: account.id, following_id: ctx.ids.alice, status: 'accepted' },
        ])

        eq((await deliver({ id: `${leaving}#delete`, type: 'Delete', actor: leaving, to: [PUBLIC], object: leaving }, asLeaving)).status, 202,
          'its Delete of itself is accepted (202)')
        const { data: after } = await db.from('profiles').select('deleted_at').eq('id', account.id).maybeSingle()
        assert(after?.deleted_at, 'the account is marked deleted', after)
        const { data: follows } = await db.from('follows').select('id').or(`follower_id.eq.${account.id},following_id.eq.${account.id}`)
        eq(follows?.length, 0, 'its follows are gone both ways')
        eq((await postByApId(note))?.is_deleted, true, 'its post is soft-deleted')

        const later = `${origin.base}/notes/leaving-later-${crypto.randomUUID()}`
        await deliver(create(leaving, { id: later, type: 'Note', attributedTo: leaving, content: '<p>still here?</p>' }), asLeaving)
        eq(await postByApId(later), null, 'and what it sends afterwards is dropped')
      }

      const vanished = origin.actorUrl('fx_vanished')
      origin.docs.set(vanished, { status: 410 })
      const throwaway = keyPair()
      const res = await deliver({ id: `${vanished}#delete`, type: 'Delete', actor: vanished, object: vanished },
        { key: throwaway.privateKey, actor: vanished })
      eq(`${res.status} ${res.json?.status}`, '202 ignored', 'the Delete of an actor whose key answers 410 is acknowledged, not retried')
      origin.docs.set(vanished, { status: 503 })
      eq((await deliver({ id: `${vanished}#delete-2`, type: 'Delete', actor: vanished, object: vanished },
        { key: throwaway.privateKey, actor: vanished })).status, 401, 'one whose key answers 503 is refused (401)')
    }

    console.log('\ninbound conformance -> activities forwarded by another signer')
    {
      const note = `${origin.base}/notes/forwarded-${crypto.randomUUID()}`
      const served = { '@context': AS, id: note, type: 'Note', attributedTo: ann, to: [PUBLIC], cc: [], published: new Date().toISOString(), content: '<p>as ann wrote it</p>' }
      origin.docs.set(note, { status: 200, doc: served })
      const forged = create(ann, { id: note, type: 'Note', attributedTo: ann, content: '<p>forged by the forwarder</p>' })

      const agentsBefore = origin.userAgents.length
      eq((await deliver(forged, asPeer)).status, 202, 'a Create of ann\'s note forwarded by the peer is accepted (202)')
      eq(textOf((await postByApId(note))?.content), 'as ann wrote it', 'and stored as the origin serves it, not as forwarded')
      assert(origin.userAgents.slice(agentsBefore).some((ua) => /^Harmony\/\S+ \(\+https:\/\/local\.hmfed\.test\/\)$/.test(ua)),
        'the origin is asked under Harmony/<version> (+https://<domain>/)', origin.userAgents.slice(agentsBefore))
      eq((await db.from('ap_activities').select('id').eq('ap_id', forged.id).maybeSingle()).data, null,
        'the forwarded id is not recorded, so ann\'s own delivery of it is not a duplicate')

      const other = `${origin.base}/notes/not-anns-${crypto.randomUUID()}`
      origin.docs.set(other, { status: 200, doc: { ...served, id: other, attributedTo: origin.actorUrl('fx_eve') } })
      eq((await deliver(create(ann, { id: other, type: 'Note', attributedTo: ann }), asPeer)).status, 403,
        'a forwarded Create the origin attributes to another account is refused (403)')
      eq(await postByApId(other), null, 'and stores nothing')

      eq((await deliver({ id: `${ann}#likes-${crypto.randomUUID()}`, type: 'Like', actor: ann, object: note }, asPeer)).status, 403,
        'a forwarded Like is refused (403)')

      const del = { id: `${note}#delete`, type: 'Delete', actor: ann, to: [PUBLIC], object: { id: note, type: 'Tombstone' } }
      eq((await deliver(del, asPeer)).status, 403, 'a forwarded Delete of a note its origin still serves is refused (403)')
      eq((await postByApId(note))?.is_deleted, false, 'and the note stays')
      origin.docs.set(note, { status: 410 })
      eq((await deliver(del, asPeer)).status, 202, 'once the origin answers 410 the forwarded Delete is accepted (202)')
      eq((await postByApId(note))?.is_deleted, true, 'and the note is deleted')
    }
  } finally {
    await db.from('federated_instances').delete().in('domain', blockedDomains)
    await origin.stop()
  }
}
