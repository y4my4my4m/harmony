// ActivityPub conformance, what this instance publishes and sends:
//
//   - the Person actor: url is the public profile page /@<name>, the context defines every
//     extension term, indexable follows discoverable, field values are inline HTML with
//     rel="me" links and no stored markup;
//   - WebFinger by acct:, by the actor id, by the profile page and by the web app's page,
//     the profile page among the aliases; a public chat server by its Group URL;
//   - the profile Update a field change federates reaches a follower with the same actor,
//     under the instance's User-Agent;
//   - each follows row is its own Follow id, the Undo names it, a re-follow is a new id;
//   - a Follow of a chat server's Group is answered with the Group's Reject;
//   - a deleted post is a Tombstone with a context, formerType and deleted;
//   - the Create a delivery carries is served at its id, as the outbox lists it;
//   - NodeInfo counts signed-up, unsuspended, undeleted accounts and names the homepage;
//   - a delivery an inbox answers 503 is queued for 17 attempts.
//
// The federate-profile and federate-follow jobs go out through pg_notify to a worker this
// run does not start; the handlers run with the payload the triggers queue.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const POST_PUBLIC = 'fed00187-0000-0000-0000-000000000001'
const POST_FOLLOWERS = 'fed00187-0000-0000-0000-000000000002'
const POST_DELETED = 'fed00187-0000-0000-0000-000000000003'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

type Get = (url: string, headers?: Record<string, string>) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; json: any }>

export interface ApConformanceContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    personalInbox: string
    sharedInbox: string
    key: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: { alice: string; carol: string; remote: string; pubServer: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  get: Get
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

/** An inbox that answers every POST with 503. */
async function busyInbox(host: string): Promise<{ url: string; hits: () => number; stop: () => Promise<void> }> {
  let hits = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      hits += 1
      res.writeHead(503).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    url: `http://${host}:${(server.address() as { port: number }).port}/inbox`,
    hits: () => hits,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

export async function caseApConformance(ctx: ApConformanceContext): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const base = `https://${instanceDomain}`
  const aliceUrl = `${base}/users/fx_alice`
  const profilePage = `${base}/@fx_alice`
  const ap = (p: string) => ctx.get(`${localUrl}${p}`, { Accept: 'application/activity+json' })
  const finger = (resource: string) => ctx.get(`${localUrl}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`, { Accept: 'application/jrd+json' })
  const bodyOf = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))
  const after = (n: number, inboxUrl: string, type: string) => () =>
    peer.captured.slice(n).find((c) => c.url === new URL(inboxUrl).pathname && bodyOf(c).type === type)

  const fields = [
    { name: 'Site', value: '<a href="https://alice.example/" target="_blank" rel="me nofollow noopener noreferrer">https://alice.example/</a>' },
    { name: 'Note', value: 'tea &amp; <script>alert(1)</script>cake' },
  ]
  const { data: saved } = await db.from('profiles').select('profile_fields, federation_discoverable').eq('id', ids.alice).single()
  const { data: pub } = await db.from('servers').select('slug, federation_enabled').eq('id', ids.pubServer).single()

  try {
    console.log('\nActivityPub conformance -> the Person actor')
    {
      await db.from('profiles').update({ profile_fields: fields, federation_discoverable: true }).eq('id', ids.alice)
      const res = await ap('/users/fx_alice')
      eq(res.status, 200, 'the actor is served')
      eq(res.json?.url, profilePage, 'its url is the public profile page')
      eq(res.json?.id, aliceUrl, 'its id stays the actor URL')
      const terms = res.json?.['@context']?.[2] ?? {}
      eq(JSON.stringify([terms.toot, terms.discoverable, terms.indexable, terms.Emoji, terms.manuallyApprovesFollowers, terms.PropertyValue, terms.value]),
        JSON.stringify(['http://joinmastodon.org/ns#', 'toot:discoverable', 'toot:indexable', 'toot:Emoji', 'as:manuallyApprovesFollowers', 'schema:PropertyValue', 'schema:value']),
        'its context defines the toot and schema terms it uses')
      eq(JSON.stringify([res.json?.discoverable, res.json?.indexable]), '[true,true]', 'indexable follows discoverable')
      eq(res.json?.attachment?.[0]?.value,
        '<a href="https://alice.example/" rel="me nofollow noopener noreferrer" target="_blank">https://alice.example/</a>',
        'a link field is one rel="me" anchor')
      eq(res.json?.attachment?.[1]?.value, 'tea &amp; alert(1)cake', 'stored markup goes out as text')
    }

    console.log('\nActivityPub conformance -> WebFinger by handle and by URL')
    {
      for (const resource of [`acct:fx_alice@${instanceDomain}`, aliceUrl, profilePage, `${base}/social/profile/fx_alice`]) {
        const res = await finger(resource)
        eq(res.status, 200, `${resource} resolves`)
        eq(res.json?.subject, `acct:fx_alice@${instanceDomain}`, `${resource} names the account`)
        assert(res.json?.aliases?.includes(profilePage) && res.json?.aliases?.includes(aliceUrl), 'the aliases hold the actor and its page', res.json?.aliases)
        assert(res.json?.links?.some((l: any) => l.rel === 'http://webfinger.net/rel/profile-page' && l.href === profilePage),
          'the profile-page link is the page', res.json?.links)
      }
      eq((await finger('https://elsewhere.test/users/fx_alice')).status, 404, 'a URL on another host is 404')

      await db.from('servers').update({ slug: 'fx_lounge', federation_enabled: true }).eq('id', ids.pubServer)
      const group = await finger(`${base}/servers/${ids.pubServer}`)
      eq(group.json?.subject, `acct:fx_lounge@${instanceDomain}`, 'a public chat server resolves by its Group URL')
      eq(group.json?.links?.[0]?.href, `${base}/servers/${ids.pubServer}`, 'to the Group')
    }

    console.log('\nActivityPub conformance -> profile Update to a follower')
    {
      await db.from('follows').delete().eq('follower_id', ids.remote).eq('following_id', ids.alice)
      await db.from('follows').insert({ follower_id: ids.remote, following_id: ids.alice, status: 'accepted' })
      const { handleProfileJob } = await backend('queue/handlers/profileHandler.ts')
      const n = peer.captured.length
      await handleProfileJob({ type: 'update', profile_id: ids.alice, username: 'fx_alice' })
      const update = await waitFor(after(n, peer.sharedInbox, 'Update'))
      assert(update, 'the profile Update reaches the follower\'s shared inbox')
      if (update) {
        const actor = bodyOf(update).object
        eq(actor?.url, profilePage, 'with the profile page as url')
        eq(actor?.indexable, true, 'with indexable')
        eq(actor?.attachment?.[0]?.value?.includes('rel="me nofollow noopener noreferrer"'), true, 'with the fields as HTML')
        assert(/^Harmony\/\S+ \(\+https:\/\/local\.hmfed\.test\/\)$/.test(update.headers['user-agent'] ?? ''),
          'delivered under Harmony/<version> (+https://<domain>/)', update.headers['user-agent'])
      }
      await db.from('follows').delete().eq('follower_id', ids.remote).eq('following_id', ids.alice)
    }

    console.log('\nActivityPub conformance -> one Follow id per follows row')
    {
      const { handleFollowJob } = await backend('queue/handlers/followHandler.ts')
      const follow = async () => {
        const { data, error } = await db.from('follows')
          .insert({ follower_id: ids.carol, following_id: ids.remote, status: 'pending' }).select('id').single()
        assert(!error, 'fx_carol follows the peer\'s user', error?.message)
        const n = peer.captured.length
        await handleFollowJob({ type: 'create', follow_id: data!.id, follower_id: ids.carol, following_id: ids.remote })
        const sent = await waitFor(after(n, peer.personalInbox, 'Follow'))
        return { row: data!.id as string, activity: sent ? bodyOf(sent) : null }
      }
      await db.from('follows').delete().eq('follower_id', ids.carol).eq('following_id', ids.remote)
      const first = await follow()
      eq(first.activity?.id, `${base}/activities/follow/${first.row}`, 'the Follow is named by its follows row')

      await db.from('follows').delete().eq('id', first.row)
      const n = peer.captured.length
      await handleFollowJob({ type: 'delete', follow_id: first.row, follower_id: ids.carol, following_id: ids.remote })
      const undo = await waitFor(after(n, peer.personalInbox, 'Undo'))
      eq(undo ? bodyOf(undo).object?.id : null, first.activity?.id, 'the Undo names that Follow')

      const again = await follow()
      assert(again.activity?.id && again.activity.id !== first.activity?.id, 'a re-follow is a new Follow id', again.activity?.id)
    }

    console.log('\nActivityPub conformance -> Follow of a chat server\'s Group')
    {
      const group = `${base}/servers/${ids.pubServer}`
      const follow = { '@context': AS, id: `${peer.actorUrl}#follows/${crypto.randomUUID()}`, type: 'Follow', actor: peer.actorUrl, object: group }
      const body = JSON.stringify(follow)
      const n = peer.captured.length
      eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/servers/${ids.pubServer}/inbox`, body, peer.key.privateKey, `${peer.actorUrl}#main-key`),
        202, 'the Follow is taken (202)')
      const reject = await waitFor(after(n, peer.personalInbox, 'Reject'))
      assert(reject, 'the Group answers with a Reject at the follower\'s inbox')
      if (reject) {
        eq(bodyOf(reject).actor, group, 'the Reject is the Group\'s')
        eq(bodyOf(reject).object?.id, follow.id, 'naming the Follow')
        const refusal = await strictReceiverRefusal(reject, localUrl, instanceDomain)
        assert(refusal === null, 'signed with the key the Group publishes', refusal)
      }
    }

    console.log('\nActivityPub conformance -> Tombstone and activity ids')
    {
      await db.from('posts').delete().in('id', [POST_PUBLIC, POST_FOLLOWERS, POST_DELETED])
      const row = (id: string, visibility: string) => ({
        id, author_id: ids.alice, is_local: true, visibility, content: [{ type: 'text', text: `post ${id}` }],
        ap_id: `${base}/posts/${id}`,
      })
      const ins = await db.from('posts').insert([row(POST_PUBLIC, 'public'), row(POST_FOLLOWERS, 'followers'), row(POST_DELETED, 'public')])
      assert(!ins.error, 'seed fx_alice\'s posts', ins.error?.message)
      const deletedAt = new Date(Date.now() - 60_000).toISOString()
      await db.from('posts').update({ is_deleted: true, deleted_at: deletedAt }).eq('id', POST_DELETED)

      const gone = await ap(`/posts/${POST_DELETED}`)
      eq(gone.status, 410, 'a deleted public post answers 410')
      eq(JSON.stringify(gone.json), JSON.stringify({
        '@context': AS, id: `${base}/posts/${POST_DELETED}`, type: 'Tombstone', formerType: 'Note', deleted: deletedAt,
      }), 'with a Tombstone carrying its context, formerType and deleted')

      const create = await ap(`/users/fx_alice/activities/${POST_PUBLIC}`)
      eq(create.status, 200, 'the Create of a public post is served at its id')
      eq(create.json?.id, `${base}/users/fx_alice/activities/${POST_PUBLIC}`, 'under that id')
      eq(create.json?.object?.id, `${base}/posts/${POST_PUBLIC}`, 'wrapping the post')
      eq((await ap(`/users/fx_alice/activities/${POST_FOLLOWERS}`)).status, 404, 'a followers-only post\'s Create is 404')
      const outbox = await ap('/users/fx_alice/outbox?cursor=start&limit=50')
      const listed = (outbox.json?.orderedItems ?? []).find((i: any) => i.object?.id === `${base}/posts/${POST_PUBLIC}`)
      eq(listed?.id, create.json?.id, 'the outbox lists it under the same id')
    }

    console.log('\nActivityPub conformance -> NodeInfo')
    {
      const { __resetNodeInfoUsageCache } = await backend('activitypub/NodeInfoService.ts')
      __resetNodeInfoUsageCache()
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true })
        .eq('is_local', true).not('auth_user_id', 'is', null).not('is_suspended', 'is', true).is('deleted_at', null)
      const { count: all } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('is_local', true)
      const info = await ctx.get(`${localUrl}/nodeinfo/2.1`, { Accept: 'application/json' })
      eq(info.json?.usage?.users?.total, count, 'users.total counts signed-up accounts neither suspended nor deleted')
      assert((all ?? 0) >= (count ?? 0), 'not every local profile', { all, count })
      eq(info.json?.software?.homepage, 'https://mony.lol', 'software.homepage is the project home')
    }

    console.log('\nActivityPub conformance -> a failed delivery is queued for 17 attempts')
    {
      const busy = await busyInbox(new URL(peer.base).hostname)
      try {
        const { DeliveryQueue } = await backend('activitypub/DeliveryQueue.ts')
        const activity = { '@context': AS, id: `${aliceUrl}#retry-${crypto.randomUUID()}`, type: 'Update', actor: aliceUrl, object: aliceUrl }
        const before = Date.now()
        await DeliveryQueue.enqueue(activity, busy.url, ids.alice)
        eq(busy.hits(), 1, 'the immediate attempt reaches the inbox')
        const { data: queued } = await db.from('federation_delivery_queue')
          .select('id, attempts, max_attempts, next_attempt_at').eq('target_inbox_url', busy.url).maybeSingle()
        eq(JSON.stringify([queued?.attempts, queued?.max_attempts]), '[1,17]', 'the 503 is queued: one attempt made of 17')
        const minutes = Math.round((Date.parse(queued?.next_attempt_at ?? '') - before) / 60_000)
        eq(minutes, 5, 'the first retry is due in 5 minutes')
        await db.from('federation_delivery_queue').delete().eq('target_inbox_url', busy.url)
        await db.from('federation_endpoint_health').delete().eq('endpoint_url', busy.url)
      } finally {
        await busy.stop()
      }
    }
  } finally {
    await db.from('profiles').update({ profile_fields: saved?.profile_fields ?? [], federation_discoverable: saved?.federation_discoverable ?? true }).eq('id', ids.alice)
    await db.from('servers').update({ slug: pub?.slug ?? null, federation_enabled: pub?.federation_enabled ?? false }).eq('id', ids.pubServer)
    await db.from('follows').delete().eq('follower_id', ids.carol).eq('following_id', ids.remote)
    await db.from('posts').delete().in('id', [POST_PUBLIC, POST_FOLLOWERS, POST_DELETED])
  }
}
