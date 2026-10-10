// Follow requests across the round trip: a locked local account, a remote account that
// answers follows itself, blocks, and the Accept/Reject/Undo traffic between them.
//
// The federate-follow and federate-profile jobs the triggers queue go out through
// pg_notify to a worker this run does not start. Where a case depends on one, it runs the
// handler with the payload the trigger queues, as the BullMQ worker would; federation_status
// 'pending' on the row is the marker the worker's sweep requeues from.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'

interface Delivery {
  url: string
  headers: Record<string, string>
  raw: Buffer
}

interface LocalUser {
  id: string
  auth: string
  username: string
}

export interface FollowApprovalHarness {
  /** service_role */
  db: SupabaseClient
  /** A client holding a local user's access token; its writes pass RLS and the client guards. */
  asUser(authUserId: string): SupabaseClient
  instanceDomain: string
  backendRoot: string
  peer: {
    actorUrl: string
    personalInbox: string
    strangerUrl: string
    key: { publicKey: string; privateKey: string }
    strangerKey: { privateKey: string }
    captured: Delivery[]
  }
  /** Delivers an activity to the local shared inbox, signed by `signer` (the peer's user by default). */
  deliver(activity: Record<string, unknown>, signer?: { key: string; actor: string }): Promise<number>
  verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ verified: boolean; actorUrl?: string }>
  /** The peer's user as a local profile row. */
  remoteId: string
  /** Becomes locked, then unlocked. */
  locked: LocalUser
  /** Follows the peer's user, then blocks it. */
  follower: LocalUser
  assert(cond: unknown, msg: string, detail?: unknown): void
  eq(actual: unknown, expected: unknown, msg: string): void
}

const AS = 'https://www.w3.org/ns/activitystreams'
// A local account stored without federated_id, as accounts created before the backfill are.
const NO_FED_ID = 'fed00000-0000-0000-0000-0000000001f0'

type FollowJob = (data: Record<string, unknown>) => Promise<void>

async function loadJobs(backendRoot: string): Promise<{ follow: FollowJob; profile: FollowJob }> {
  const mod = (p: string) => import(pathToFileURL(path.join(backendRoot, 'src', p)).href)
  const [follow, profile] = await Promise.all([
    mod('queue/handlers/followHandler.ts'),
    mod('queue/handlers/profileHandler.ts'),
  ])
  return { follow: follow.handleFollowJob, profile: profile.handleProfileJob }
}

export async function caseFollowApproval(h: FollowApprovalHarness): Promise<void> {
  console.log('\nfollow requests -> locked accounts, remote answers, blocks')

  const { db, peer, assert, eq } = h
  const jobs = await loadJobs(h.backendRoot)
  const actor = (username: string) => `https://${h.instanceDomain}/users/${username}`
  const lockedUrl = actor(h.locked.username)
  const followerUrl = actor(h.follower.username)
  const strangerInbox = `${peer.strangerUrl}/inbox`
  const asLocked = h.asUser(h.locked.auth)
  const asFollower = h.asUser(h.follower.auth)

  const sent = (from: number, url: string) =>
    peer.captured
      .slice(from)
      .filter((c) => c.url === new URL(url).pathname)
      .map((c) => ({ req: c, body: JSON.parse(c.raw.toString('utf-8')) }))
  const signer = async (d: { req: Delivery }) =>
    (await h.verifySignature(d.req.headers.signature, d.req.headers, 'POST', d.req.url, d.req.raw)).actorUrl
  const followRow = async (followerId: string, followingId: string) => {
    const { data } = await db
      .from('follows')
      .select('id, status, ap_id, federation_status')
      .eq('follower_id', followerId)
      .eq('following_id', followingId)
      .maybeSingle()
    return data as { id: string; status: string; ap_id: string | null; federation_status: string } | null
  }
  const requestNotifications = async (userId: string, followerId: string) => {
    const { data } = await db
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'activitypub_follow_request')
      .eq('data->>follower_id', followerId)
    return (data ?? []).length
  }
  const followFrom = (from: string, to: string) => ({
    '@context': AS,
    id: `${from}#follows/${crypto.randomUUID()}`,
    type: 'Follow',
    actor: from,
    object: to,
  })

  const reset = async () => {
    const { data: stranger } = await db.from('profiles').select('id').eq('federated_id', peer.strangerUrl).maybeSingle()
    await db.from('follows').delete().eq('following_id', h.locked.id).in('follower_id', [h.remoteId, stranger?.id ?? h.remoteId])
    await db.from('follows').delete().eq('follower_id', h.follower.id).eq('following_id', h.remoteId)
    await db.from('user_blocks').delete().eq('blocker_id', h.follower.id).eq('blocked_user_id', h.remoteId)
    await db.from('profiles').update({ manually_approves_followers: false }).in('id', [h.locked.id, h.remoteId])
    await db.from('profiles').delete().eq('id', NO_FED_ID)
  }
  await reset()

  try {
    // A locked account holds a remote Follow until it answers -----------------------------
    const lock = await asLocked.from('profiles').update({ manually_approves_followers: true }).eq('id', h.locked.id)
    eq(lock.error?.message ?? null, null, 'a local user turns follow approval on')

    let mark = peer.captured.length
    const follow = followFrom(peer.actorUrl, lockedUrl)
    eq(await h.deliver(follow), 202, 'a Follow of the locked account is accepted (202)')
    let row = await followRow(h.remoteId, h.locked.id)
    eq(row?.status, 'pending', 'the Follow of a locked account is stored as a request')
    eq(row?.ap_id, follow.id, 'the request keeps the Follow id')
    eq(sent(mark, peer.personalInbox).length, 0, 'no Accept goes out before approval')
    eq(await requestNotifications(h.locked.id, h.remoteId), 1, 'the locked account is notified of the request')

    const answered = await asLocked
      .from('follows')
      .update({ status: 'accepted' })
      .eq('follower_id', h.remoteId)
      .eq('following_id', h.locked.id)
      .select('id, status, federation_status')
      .single()
    eq(answered.data?.federation_status, 'pending', 'approving the request queues its Accept')
    mark = peer.captured.length
    await jobs.follow({
      type: 'respond', follow_id: row!.id, follower_id: h.remoteId, following_id: h.locked.id,
      status: 'accepted', ap_id: follow.id,
    })
    let got = sent(mark, peer.personalInbox)
    eq(got.map((d) => d.body.type).join(' '), 'Accept', 'the approval delivers one Accept to the follower')
    eq(got[0]?.body.object?.id, follow.id, 'the Accept names the Follow it answers')
    eq(await (got[0] ? signer(got[0]) : null), lockedUrl, 'the Accept is signed by the locked account')
    eq((await followRow(h.remoteId, h.locked.id))?.federation_status, 'completed', 'the request is marked federated')
    eq(await requestNotifications(h.locked.id, h.remoteId), 0, 'the answered request takes its notification with it')

    // Unlocking accepts what waits ---------------------------------------------------------
    const second = followFrom(peer.strangerUrl, lockedUrl)
    eq(await h.deliver(second, { key: peer.strangerKey.privateKey, actor: peer.strangerUrl }), 202,
      'a second remote account asks to follow')
    const { data: strangerRow } = await db.from('profiles').select('id').eq('federated_id', peer.strangerUrl).single()
    row = await followRow(strangerRow!.id, h.locked.id)
    eq(row?.status, 'pending', 'its Follow waits')

    const unlock = await asLocked.from('profiles').update({ manually_approves_followers: false }).eq('id', h.locked.id)
    eq(unlock.error?.message ?? null, null, 'the local user turns follow approval off')
    row = await followRow(strangerRow!.id, h.locked.id)
    eq(`${row?.status}/${row?.federation_status}`, 'accepted/pending', 'turning approval off accepts the waiting request and queues its Accept')
    mark = peer.captured.length
    await jobs.follow({
      type: 'respond', follow_id: row!.id, follower_id: strangerRow!.id, following_id: h.locked.id,
      status: 'accepted', ap_id: second.id,
    })
    got = sent(mark, strangerInbox)
    eq(`${got[0]?.body.type}:${got[0]?.body.object?.id === second.id}`, 'Accept:true', 'the waiting follower gets its Accept')

    mark = peer.captured.length
    await jobs.profile({ type: 'update', profile_id: h.locked.id, username: h.locked.username })
    const updates = peer.captured.slice(mark)
      .map((c) => JSON.parse(c.raw.toString('utf-8')))
      .filter((a) => a.type === 'Update' && a.object?.id === lockedUrl)
    assert(updates.length > 0 && updates.every((a) => a.object.manuallyApprovesFollowers === false),
      'the actor Update to followers carries manuallyApprovesFollowers: false',
      JSON.stringify(updates.map((a) => a.object?.manuallyApprovesFollowers)))

    // Removing a remote follower sends a Reject ---------------------------------------------
    row = await followRow(h.remoteId, h.locked.id)
    const removed = await asLocked
      .from('follows')
      .delete()
      .eq('follower_id', h.remoteId)
      .eq('following_id', h.locked.id)
      .select('id')
    eq(removed.data?.length, 1, 'the local user removes the remote follower')
    eq(await followRow(h.remoteId, h.locked.id), null, 'the follow is gone')
    mark = peer.captured.length
    await jobs.follow({
      type: 'respond', follow_id: row!.id, follower_id: h.remoteId, following_id: h.locked.id,
      status: 'rejected', ap_id: follow.id,
    })
    got = sent(mark, peer.personalInbox)
    eq(got.map((d) => `${d.body.type}:${d.body.object?.id === follow.id}:${d.body.object?.actor}`).join(' '),
      `Reject:true:${peer.actorUrl}`, 'the removed follower gets a Reject of its Follow, though the row is gone')

    // A remote account that approves followers ----------------------------------------------
    eq(await h.deliver({
      '@context': [AS, 'https://w3id.org/security/v1'],
      id: `${peer.actorUrl}#updates/${crypto.randomUUID()}`,
      type: 'Update',
      actor: peer.actorUrl,
      object: {
        id: peer.actorUrl,
        type: 'Person',
        preferredUsername: 'fx_remote',
        name: 'Remote',
        inbox: peer.personalInbox,
        manuallyApprovesFollowers: true,
        publicKey: { id: `${peer.actorUrl}#main-key`, owner: peer.actorUrl, publicKeyPem: peer.key.publicKey },
      },
    }), 202, 'an Update(Person) with manuallyApprovesFollowers is accepted (202)')
    const { data: remote } = await db.from('profiles').select('manually_approves_followers').eq('id', h.remoteId).single()
    eq(remote?.manually_approves_followers, true, 'the remote account is stored as locked')

    const inserted = await asFollower
      .from('follows')
      .insert({ follower_id: h.follower.id, following_id: h.remoteId, status: 'accepted' })
      .select('id, status')
      .single()
    eq(inserted.data?.status, 'pending', 'a local follow of the remote account is a request, whatever the client sends')
    const outbound = inserted.data?.id as string
    mark = peer.captured.length
    await jobs.follow({ type: 'create', follow_id: outbound, follower_id: h.follower.id, following_id: h.remoteId, status: 'pending' })
    got = sent(mark, peer.personalInbox)
    const followId = `https://${h.instanceDomain}/activities/follow/${outbound}`
    eq(got.map((d) => `${d.body.type}:${d.body.id}`).join(' '), `Follow:${followId}`, 'the Follow reaches the remote account')
    eq((await followRow(h.follower.id, h.remoteId))?.status, 'pending', 'and stays a request until it answers')

    eq(await h.deliver({ '@context': AS, id: `${peer.actorUrl}#accepts/${crypto.randomUUID()}`, type: 'Accept', actor: peer.actorUrl, object: followId }),
      202, 'an Accept naming only the Follow id is accepted (202)')
    eq((await followRow(h.follower.id, h.remoteId))?.status, 'accepted', 'the Accept completes the follow')
    const { data: told } = await db.from('notifications').select('id').eq('user_id', h.follower.id)
      .eq('type', 'activitypub_follow_accepted').eq('data->>followed_id', h.remoteId)
    eq((told ?? []).length, 1, 'the local follower is told')

    // A Reject from the remote side ends the follow without an Undo ------------------------
    const { data: before } = await db.rpc('hmfed_broadcasts', { p_topic: `user:${h.follower.id}` })
    const seen = (before ?? []).length
    mark = peer.captured.length
    eq(await h.deliver({
      '@context': AS, id: `${peer.actorUrl}#rejects/${crypto.randomUUID()}`, type: 'Reject', actor: peer.actorUrl,
      object: { id: followId, type: 'Follow', actor: followerUrl, object: peer.actorUrl },
    }), 202, 'a Reject of the accepted follow is accepted (202)')
    eq(await followRow(h.follower.id, h.remoteId), null, 'the rejected follow is deleted')
    const { data: after } = await db.rpc('hmfed_broadcasts', { p_topic: `user:${h.follower.id}` })
    const changes = ((after ?? []) as any[]).slice(seen)
      .filter((p) => p?.type === 'follow:change' && p.following_id === h.remoteId)
      .map((p) => `${p.op}:${p.status}`)
    eq(changes.join(' '), 'UPDATE:rejected DELETE:rejected',
      'the follow is deleted as rejected, which the delete trigger answers with no Undo')
    eq(peer.captured.length - mark, 0, 'nothing goes back to the remote account')

    // A follower its target blocks ----------------------------------------------------------
    const block = await asFollower.from('user_blocks').insert({ blocker_id: h.follower.id, blocked_user_id: h.remoteId })
    eq(block.error?.message ?? null, null, 'the local user blocks the remote account')
    mark = peer.captured.length
    const blocked = followFrom(peer.actorUrl, followerUrl)
    eq(await h.deliver(blocked), 202, 'a Follow from the blocked account is answered (202)')
    eq(await followRow(h.remoteId, h.follower.id), null, 'no follow is stored')
    got = sent(mark, peer.personalInbox)
    eq(got.map((d) => `${d.body.type}:${d.body.object?.id === blocked.id}`).join(' '), 'Reject:true',
      'the blocked account gets a Reject of its Follow')
    eq(await (got[0] ? signer(got[0]) : null), followerUrl, 'signed by the blocking account')

    // Undo(Follow) of a local account stored without federated_id -------------------------
    await db.from('profiles').insert({
      id: NO_FED_ID, username: 'fx_nofed', display_name: 'No fed id', domain: h.instanceDomain, is_local: true,
    })
    await db.from('follows').insert({ follower_id: h.remoteId, following_id: NO_FED_ID, status: 'accepted', is_local: false })
    eq(await h.deliver({
      '@context': AS, id: `${peer.actorUrl}#undo/${crypto.randomUUID()}`, type: 'Undo', actor: peer.actorUrl,
      object: { id: `${peer.actorUrl}#follows/nofed`, type: 'Follow', actor: peer.actorUrl, object: actor('fx_nofed') },
    }), 202, 'an Undo(Follow) of a local account without federated_id is accepted (202)')
    eq(await followRow(h.remoteId, NO_FED_ID), null, 'the Undo deletes the follow')
  } finally {
    await reset()
  }
}
