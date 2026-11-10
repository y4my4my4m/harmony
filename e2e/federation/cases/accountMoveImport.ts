// What a move leaves behind, across instances: the following list, and the profile.
//
//   - following import: start_following_import queues its job; the job resolves a handle never
//     stored here through WebFinger on its domain, and the Follow reaches the account's inbox signed
//     by the importer. Every remote follow waits for its Accept; a Reject removes it. A moved account
//     and an unknown one fail with their reason. A local account in the same list is followed at once.
//   - copying the profile: the alias and a signed Move make the verified pair; before the Move the
//     route refuses. The bio and fields are read from the stored row, and an actor's Mastodon-style
//     field markup becomes what the client stores. The Update(Person) of the result carries them.
//     This stack has no storage: the image is fetched and the failed store is reported, and the old
//     URL is never written.
//
// The following-import and federate-* jobs are read off pg_notify (JobTap) and run as the worker
// runs them. WebFinger is https on the account's domain: a TLS proxy forwards to the host.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap, startWebFingerProxy } from './outboundFederation.ts'
import { CommunityHost } from './remoteInteractions.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
// Host part of the stack subnet's TLS proxy address; .200 and .201 are taken.
const PROXY_OCTET = 202
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

export interface AccountMoveImportContext {
  db: SupabaseClient
  peer: { base: string }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  env: Record<string, string>
  ids: { carol: string; carolAuth: string; bob: string }
  asUser: (authUserId: string) => SupabaseClient
  bearer: (authUserId: string) => string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  verifySignature: (
    signature: string,
    headers: Record<string, string>,
    method: string,
    p: string,
    body?: unknown,
  ) => Promise<{ verified: boolean; actorUrl?: string; error?: string }>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  fail: (msg: string, detail?: unknown) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function caseAccountMoveImport(ctx: AccountMoveImportContext): Promise<void> {
  console.log('\naccount move -> following import and profile copy across instances')
  const { db, assert, eq, ids } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const local = (p: string) => `https://${ctx.instanceDomain}${p}`
  const carol = ctx.asUser(ids.carolAuth)
  const carolActor = local('/users/fx_carol')
  const inbox = `${ctx.localUrl}/inbox`

  const host = new CommunityHost()
  await host.start(new URL(ctx.peer.base).hostname)
  const proxyIp = `${ctx.env.HMFED_SUBNET.split('/')[0].split('.').slice(0, 3).join('.')}.${PROXY_OCTET}`
  const handle = (name: string) => `${name}@${proxyIp}`
  const person = (name: string, extra: Record<string, unknown> = {}) =>
    host.addActor(`/users/${name}`, 'Person', name, { webfinger: `acct:${handle(name)}`, ...extra })

  const open = person('fx_imp_open')
  const locked = person('fx_imp_locked', { manuallyApprovesFollowers: true })
  const moved = person('fx_imp_moved', { movedTo: `${host.base}/users/fx_imp_open` })
  const origin = person('fx_imp_old', {
    name: 'Carol on the old server',
    summary: '<p>Old bio, first line.<br>Second line.</p>',
    icon: { type: 'Image', url: host.url('/media/avatar.png') },
    image: { type: 'Image', url: host.url('/media/banner.png') },
    attachment: [
      {
        type: 'PropertyValue',
        name: 'Blog',
        value: '<a href="https://blog.example/carol" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span><span class="">blog.example/carol</span><span class="invisible"></span></a>',
      },
      { type: 'PropertyValue', name: 'Tea', value: 'green &amp; black' },
    ],
  })
  host.media.set('/media/avatar.png', PNG)
  host.media.set('/media/banner.png', PNG)

  const names = ['fx_imp_open', 'fx_imp_locked', 'fx_imp_moved', 'fx_imp_old', 'fx_imp_nobody']
  // Rows of an earlier run on this stack name that run's port; profiles.domain carries none.
  await db.from('profiles').delete().in('username', names)

  const restore = await db.from('profiles')
    .select('display_name, bio, avatar_url, banner_url, profile_fields, also_known_as')
    .eq('id', ids.carol)
    .single()

  // The inbox admits 60 deliveries a minute from one signing host: a 429 is sent again once the
  // window turns, for at most 75 s.
  const deliver = async (activity: Record<string, unknown>, signer: string) => {
    const body = JSON.stringify({ '@context': AS, ...activity })
    for (let attempt = 0; ; attempt++) {
      const res = await ctx.post(inbox, ctx.signedHeaders(inbox, body, host.keyOf(signer), `${signer}#main-key`), body)
      if (res.status !== 429 || attempt >= 15) return res.status
      await sleep(5000)
    }
  }
  const accountRoute = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(`${ctx.localUrl}/account${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.bearer(ids.carolAuth)}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const followOf = async (actor: string) => {
    const target = await db.from('profiles').select('id').eq('federated_id', actor).maybeSingle()
    if (!target.data) return null
    return (await db.from('follows').select('id, status').eq('follower_id', ids.carol).eq('following_id', target.data.id).maybeSingle()).data
  }

  let proxy: { stop: () => void } | null = null
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const tap = await JobTap.open(project)
  const [{ handleFollowJob }, { handleProfileJob }, { runFollowingImportBatch }] = await Promise.all([
    backend('queue/handlers/followHandler.ts'),
    backend('queue/handlers/profileHandler.ts'),
    backend('queue/handlers/followingImportHandler.ts'),
  ])

  try {
    proxy = startWebFingerProxy(project, proxyIp, host.base)
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise<boolean>((resolve) => {
        const s = net.connect(443, proxyIp, () => { s.end(); resolve(true) })
        s.on('error', () => resolve(false))
      })
      if (!up) await sleep(200)
    }
    assert(up, `the WebFinger proxy answers on ${proxyIp}:443`)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    // FOLLOWING IMPORT ----------------------------------------------------------------------
    const started = await carol.rpc('start_following_import', {
      p_handles: [handle('fx_imp_open'), handle('fx_imp_locked'), handle('fx_imp_moved'), handle('fx_imp_nobody'), `fx_bob@${ctx.instanceDomain}`],
      p_source: 'mastodon_csv',
    })
    if (started.error || !started.data?.import_id) return ctx.fail('start_following_import', started.error?.message ?? JSON.stringify(started.data))
    const importId = started.data.import_id as string
    const job = await tap.take((j) => j.name === 'following-import' && j.data?.import_id === importId)
    assert(job, 'the import queues a following-import job')

    for (let i = 0; i < 10; i++) {
      const { finished } = await runFollowingImportBatch(importId)
      if (finished) break
    }

    const result = (await carol.rpc('get_my_following_import')).data
    assert(result?.finished_at, 'the job finishes the import', JSON.stringify(result))
    eq(JSON.stringify(result?.counts), JSON.stringify({
      failed: 2, followed: 1, cancelled: 0, requested: 2, already_following: 0, already_requested: 0,
    }), 'the result counts each outcome')
    const reasons = Object.fromEntries((result?.failures ?? []).map((f: any) => [f.handle, f.reason]))
    eq(reasons[handle('fx_imp_moved')], 'moved', 'a moved account is not followed, as Mastodon\'s FollowService')
    eq(reasons[handle('fx_imp_nobody')], 'not_found', 'a handle WebFinger does not know is not found')

    const stored = await db.from('profiles').select('username, domain, inbox_url').eq('federated_id', open).maybeSingle()
    eq(stored.data?.domain, proxyIp, 'a handle never stored here is resolved through WebFinger')
    eq(stored.data?.inbox_url, `${open}/inbox`, 'and stored with its inbox')
    const bobFollow = await db.from('follows').select('status').eq('follower_id', ids.carol).eq('following_id', ids.bob).maybeSingle()
    eq(bobFollow.data?.status, 'accepted', 'a local account in the list is followed at once')

    for (const [actor, label] of [[open, 'unlocked'], [locked, 'locked']] as const) {
      const follow = await followOf(actor)
      eq(follow?.status, 'pending', `a follow of a remote ${label} account waits for its answer`)
      if (!follow) return ctx.fail(`no follow row for ${actor}`)
      const followJob = await tap.take((j) => j.name === 'federate-follow' && j.data?.follow_id === follow.id)
      if (!followJob) return ctx.fail(`the follow of ${actor} queues a federate-follow job`)
      const before = host.captured.length
      await handleFollowJob(followJob.data)
      const sent = host.since(before).find((d) => d.url === `${new URL(actor).pathname}/inbox`)
      eq(sent?.body?.type, 'Follow', `the Follow reaches the ${label} account's inbox`)
      eq(sent?.body?.object, actor, 'and names the account')
      if (sent) {
        const verified = await ctx.verifySignature(sent.headers.signature, sent.headers, 'POST', sent.url, sent.raw)
        eq(verified.actorUrl, carolActor, 'signed by the importer')
      }
      const answer = actor === open ? 'Accept' : 'Reject'
      eq(await deliver({ id: `${actor}#answers/${follow.id}`, type: answer, actor, to: [carolActor], object: sent?.body }, actor), 202,
        `the ${answer} is taken`)
    }
    eq((await followOf(open))?.status, 'accepted', 'the Accept accepts the imported follow')
    eq(await followOf(locked), null, 'the Reject removes the imported follow')

    // COPYING THE PROFILE -------------------------------------------------------------------
    const originRow = async () => (await db.from('profiles').select('id, moved_to_id').eq('federated_id', origin).maybeSingle()).data
    const aliased = await accountRoute('/aliases', { handle: handle('fx_imp_old') })
    eq(aliased.status, 200, 'the new account lists the old one, resolved over WebFinger')
    const before = await originRow()
    if (!before) return ctx.fail('the old account is not stored')

    const early = await accountRoute('/profile/copy', { origin_id: before.id, fields: ['bio'] })
    eq(`${early.status} ${early.json?.error}`, '403 not_verified', 'an alias alone does not open the copy')

    eq(await deliver({ id: `${origin}#moves/1`, type: 'Move', actor: origin, object: origin, target: carolActor }, origin), 202,
      'the Move is taken')
    eq((await originRow())?.moved_to_id, ids.carol, 'the Move points the old account here')

    // A follower on the host receives the Update(Person).
    const follower = await db.from('profiles').select('id').eq('federated_id', open).single()
    await db.from('follows').insert({ follower_id: follower.data?.id, following_id: ids.carol, status: 'accepted' })

    const mediaBefore = host.mediaGets.length
    const copied = await accountRoute('/profile/copy', { origin_id: before.id, fields: ['bio', 'avatar', 'profile_fields'] })
    eq(copied.status, 200, 'after the Move the copy runs')
    eq(JSON.stringify(copied.json?.copied), JSON.stringify(['bio', 'profile_fields']), 'the bio and fields are copied')
    eq(JSON.stringify(copied.json?.failed), JSON.stringify(['avatar']), 'an image that could not be stored is reported')
    eq(host.mediaGets.slice(mediaBefore).join(), '/media/avatar.png', 'only the picked image is fetched from the old server')

    const after = (await db.from('profiles').select('display_name, bio, avatar_url, profile_fields').eq('id', ids.carol).single()).data
    eq(after?.bio, 'Old bio, first line.\nSecond line.', 'the bio is the text stored for the old account')
    eq(after?.display_name, restore.data?.display_name, 'a field not picked stays')
    eq(after?.avatar_url, restore.data?.avatar_url, 'the old server\'s URL is never written')
    eq(JSON.stringify(after?.profile_fields), JSON.stringify([
      { name: 'Blog', value: '<a href="https://blog.example/carol" target="_blank" rel="me nofollow noopener noreferrer">https://blog.example/carol</a>' },
      { name: 'Tea', value: 'green &amp; black' },
    ]), 'the field markup becomes what the client stores')

    const profileJob = await tap.take((j) => j.name === 'federate-profile' && j.data?.profile_id === ids.carol)
    if (!profileJob) return ctx.fail('the copy queues a federate-profile job')
    const mark = host.captured.length
    await handleProfileJob(profileJob.data)
    const update = host.since(mark).find((d) => d.body?.type === 'Update')
    eq(update?.body?.object?.id, carolActor, 'the copy reaches followers as Update(Person)')
    assert(String(update?.body?.object?.summary ?? '').includes('Old bio, first line.'), 'with the copied bio', JSON.stringify(update?.body?.object?.summary))
    eq(update?.body?.object?.attachment?.[1]?.name, 'Tea', 'and the copied fields')

    // A cancelled redirect ends the offer.
    await db.from('profiles').update({ moved_to_id: null, moved_to_uri: null, moved_at: null }).eq('id', before.id)
    const after2 = await accountRoute('/profile/copy', { origin_id: before.id, fields: ['display_name'] })
    eq(`${after2.status} ${after2.json?.error}`, '403 not_verified', 'with no move standing the copy is refused')
  } finally {
    if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting
    proxy?.stop()
    tap.close()
    await host.stop()
    await db.from('following_imports').delete().eq('profile_id', ids.carol)
    await db.from('follows').delete().eq('follower_id', ids.carol).eq('following_id', ids.bob)
    await db.from('follows').delete().eq('following_id', ids.carol)
    await db.from('profiles').delete().in('username', names)
    if (restore.data) await db.from('profiles').update(restore.data).eq('id', ids.carol)
  }
}
