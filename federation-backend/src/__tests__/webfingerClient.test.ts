import { describe, it, expect, vi, beforeEach } from 'vitest'

// WebFinger resolution of split-domain accounts (Mastodon LOCAL_DOMAIN +
// WEB_DOMAIN): understars.test names accounts, chat.understars.test serves
// their actors.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))

import { safeFetch } from '../utils/ssrfProtection.js'
import {
  confirmActorAcct,
  parseAcct,
  parseHostMetaTemplate,
  parseWebFinger,
  resolveActorUrl,
  withCanonicalAcct,
  type WebFingerCache,
} from '../activitypub/webfingerClient.js'

const ACTOR = 'https://chat.understars.test/users/doesnm'

const jrd = (subject: string, href: string | null = ACTOR) =>
  new Response(JSON.stringify({
    subject,
    aliases: [href],
    links: href
      ? [
          { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://chat.understars.test/@doesnm' },
          { rel: 'self', type: 'application/activity+json', href },
        ]
      : [],
  }), { status: 200, headers: { 'content-type': 'application/jrd+json' } })

const notFound = () => new Response('', { status: 404 })

let routes: Record<string, () => Response>
let requested: string[]

beforeEach(() => {
  requested = []
  routes = {}
  vi.mocked(safeFetch).mockReset()
  vi.mocked(safeFetch).mockImplementation(async (url: string, init: any) => {
    requested.push(url)
    expect(init?.headers?.Signature).toBeUndefined()
    const route = routes[url]
    return route ? route() : notFound()
  })
})

const wf = (domain: string, acct: string) =>
  `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`

function splitDomainInstance() {
  routes[wf('chat.understars.test', 'doesnm@chat.understars.test')] = () => jrd('acct:doesnm@understars.test')
  // The account domain's WebFinger is served by the web domain behind a
  // redirect; safeFetch follows it, so the stub answers the first URL.
  routes[wf('understars.test', 'doesnm@understars.test')] = () => jrd('acct:doesnm@understars.test')
}

describe('parseAcct', () => {
  it('reads acct: URIs and handles', () => {
    expect(parseAcct('acct:doesnm@Understars.TEST')).toEqual({ username: 'doesnm', domain: 'understars.test' })
    expect(parseAcct('@doesnm@understars.test')).toEqual({ username: 'doesnm', domain: 'understars.test' })
    expect(parseAcct('doesnm@localhost:3000')).toEqual({ username: 'doesnm', domain: 'localhost:3000' })
  })

  it('rejects anything that is not user@host', () => {
    for (const bad of ['', 'doesnm', '@understars.test', 'doesnm@', 'a@b/c', 'a b@c.test', 'a@evil.test/@x', 42, null]) {
      expect(parseAcct(bad)).toBeNull()
    }
  })
})

describe('parseWebFinger', () => {
  it('reads subject and self link from XRD with attributes in any order', () => {
    const xrd = `<?xml version="1.0"?><XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
      <Subject>acct:doesnm@understars.test</Subject>
      <Link href="${ACTOR}" type="application/activity+json" rel="self"/>
    </XRD>`
    expect(parseWebFinger(xrd, 'application/xrd+xml')).toEqual({
      subject: { username: 'doesnm', domain: 'understars.test' },
      actorUrl: ACTOR,
    })
  })

  it('accepts the ld+json ActivityStreams profile and ignores other self links', () => {
    const body = JSON.stringify({
      subject: 'acct:a@b.test',
      links: [
        { rel: 'self', type: 'text/html', href: 'https://b.test/@a' },
        { rel: 'self', type: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"', href: 'https://b.test/u/a' },
      ],
    })
    expect(parseWebFinger(body, 'application/jrd+json')?.actorUrl).toBe('https://b.test/u/a')
  })
})

describe('parseHostMetaTemplate', () => {
  it('reads the lrdd template from XRD and JRD', () => {
    const tpl = 'https://chat.understars.test/.well-known/webfinger?resource={uri}'
    expect(parseHostMetaTemplate(`<XRD><Link rel="lrdd" type="application/xrd+xml" template="${tpl}"/></XRD>`, 'application/xrd+xml')).toBe(tpl)
    expect(parseHostMetaTemplate(JSON.stringify({ links: [{ rel: 'lrdd', template: tpl }] }), 'application/json')).toBe(tpl)
    expect(parseHostMetaTemplate('<XRD><Link rel="lrdd" template="https://x.test/wf"/></XRD>', 'application/xrd+xml')).toBeNull()
  })
})

describe('resolveActorUrl', () => {
  it('resolves the web-domain handle through the subject on the account domain', async () => {
    splitDomainInstance()
    await expect(resolveActorUrl('doesnm', 'chat.understars.test')).resolves.toEqual({
      actorUrl: ACTOR,
      subject: { username: 'doesnm', domain: 'understars.test' },
    })
  })

  it('resolves the account-domain handle to the same actor', async () => {
    splitDomainInstance()
    await expect(resolveActorUrl('doesnm', 'understars.test')).resolves.toEqual({
      actorUrl: ACTOR,
      subject: { username: 'doesnm', domain: 'understars.test' },
    })
  })

  it('falls back to the host-meta lrdd template when WebFinger is 404', async () => {
    routes['https://understars.test/.well-known/host-meta'] = () => new Response(
      '<?xml version="1.0"?><XRD><Link rel="lrdd" template="https://chat.understars.test/.well-known/webfinger?resource={uri}"/></XRD>',
      { status: 200, headers: { 'content-type': 'application/xrd+xml' } },
    )
    routes[wf('chat.understars.test', 'doesnm@understars.test')] = () => jrd('acct:doesnm@understars.test')

    await expect(resolveActorUrl('doesnm', 'understars.test')).resolves.toEqual({
      actorUrl: ACTOR,
      subject: { username: 'doesnm', domain: 'understars.test' },
    })
    expect(requested).toEqual([
      wf('understars.test', 'doesnm@understars.test'),
      'https://understars.test/.well-known/host-meta',
      wf('chat.understars.test', 'doesnm@understars.test'),
    ])
  })

  it('does not consult host-meta for a status other than 404', async () => {
    routes[wf('understars.test', 'doesnm@understars.test')] = () => new Response('', { status: 410 })
    await expect(resolveActorUrl('doesnm', 'understars.test')).resolves.toBeNull()
    expect(requested).toHaveLength(1)
  })

  it('keeps the queried account when the subject\'s domain disowns it', async () => {
    routes[wf('chat.understars.test', 'doesnm@chat.understars.test')] = () => jrd('acct:doesnm@understars.test')
    routes[wf('understars.test', 'doesnm@understars.test')] = () => jrd('acct:someone@else.test')

    await expect(resolveActorUrl('doesnm', 'chat.understars.test')).resolves.toEqual({
      actorUrl: ACTOR,
      subject: { username: 'doesnm', domain: 'chat.understars.test' },
    })
  })

  it('is null without an ActivityPub self link', async () => {
    routes[wf('understars.test', 'doesnm@understars.test')] = () => jrd('acct:doesnm@understars.test', null)
    await expect(resolveActorUrl('doesnm', 'understars.test')).resolves.toBeNull()
  })
})

describe('confirmActorAcct', () => {
  const actor = { id: ACTOR, type: 'Person', preferredUsername: 'doesnm' }

  it('confirms the account domain when both domains link back to the actor', async () => {
    splitDomainInstance()
    await expect(confirmActorAcct(actor)).resolves.toEqual({ username: 'doesnm', domain: 'understars.test' })
  })

  it('confirms an actor on its own host', async () => {
    routes[wf('chat.understars.test', 'doesnm@chat.understars.test')] = () => jrd('acct:doesnm@chat.understars.test')
    await expect(confirmActorAcct(actor)).resolves.toEqual({ username: 'doesnm', domain: 'chat.understars.test' })
  })

  it('refuses an account domain whose WebFinger names another actor', async () => {
    routes[wf('chat.understars.test', 'doesnm@chat.understars.test')] = () => jrd('acct:doesnm@understars.test')
    routes[wf('understars.test', 'doesnm@understars.test')] = () => jrd('acct:doesnm@understars.test', 'https://evil.test/users/doesnm')
    await expect(confirmActorAcct(actor)).resolves.toBeNull()
  })

  it('ignores a claim by a domain the actor\'s host does not name', async () => {
    // evil.test claims the actor, but the actor's host names no other domain.
    routes[wf('chat.understars.test', 'doesnm@chat.understars.test')] = () => jrd('acct:doesnm@chat.understars.test')
    routes[wf('evil.test', 'doesnm@evil.test')] = () => jrd('acct:doesnm@evil.test')
    await expect(confirmActorAcct(actor)).resolves.toEqual({ username: 'doesnm', domain: 'chat.understars.test' })
  })

  it('is null when WebFinger is unreachable', async () => {
    await expect(confirmActorAcct(actor)).resolves.toBeNull()
  })

  it('starts from the FEP-2c59 webfinger property', async () => {
    routes[wf('understars.test', 'doesnm@understars.test')] = () => jrd('acct:doesnm@understars.test')
    await expect(confirmActorAcct({ ...actor, webfinger: 'doesnm@understars.test' }))
      .resolves.toEqual({ username: 'doesnm', domain: 'understars.test' })
    expect(requested).toEqual([wf('understars.test', 'doesnm@understars.test')])
  })

  it('shares answers with resolveActorUrl through a cache', async () => {
    splitDomainInstance()
    const cache: WebFingerCache = new Map()
    await resolveActorUrl('doesnm', 'chat.understars.test', 10_000, cache)
    await confirmActorAcct(actor, 5_000, cache)
    expect(requested).toHaveLength(2)
  })
})

describe('withCanonicalAcct', () => {
  const profile = { username: 'doesnm', domain: 'chat.understars.test', federated_id: ACTOR }

  it('applies an account on another domain', () => {
    expect(withCanonicalAcct(profile, { username: 'doesnm', domain: 'understars.test' }))
      .toEqual({ ...profile, domain: 'understars.test' })
  })

  it('keeps preferredUsername on the actor\'s own host and without an account', () => {
    expect(withCanonicalAcct(profile, { username: 'DoesNM', domain: 'chat.understars.test' })).toBe(profile)
    expect(withCanonicalAcct(profile, null)).toBe(profile)
  })
})
