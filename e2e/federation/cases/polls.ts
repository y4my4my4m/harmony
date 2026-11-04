// Chat message polls over federation (federation-backend activitypub/messagePolls.ts,
// 20261105990001_federated_message_polls.sql). The holder of a poll's tally is the server's host
// for a channel poll and the author's instance for a direct message poll.
//
// The peer hosts its Group, copied here with fx_bob as a member:
//   - a poll in its channel arrives as a Note with harmony:poll and is stored as a copy with the
//     peer's counts; fx_bob's vote is final, counts here at once and reaches the Group's inbox
//     as Mastodon's vote Note; the Group's Update(Question) sets counts and the end, anyone
//     else's is refused;
//   - fx_bob's own poll there goes to the Group's inbox with harmony:poll, is a copy from the
//     start, and his ending it reaches the Group as Update(Question) with closed; a copy whose
//     host does not federate polls takes none;
//   - a Note from a host before 1.9.3 carries the text only and stays text.
// This instance hosts a server with the peer's user as a member:
//   - fx_alice's poll reaches the peer as a Note with harmony:poll beside the text fallback, its
//     line breaks as <br />;
//   - the peer's votes at the server's inbox are recorded once, refused for an unknown answer,
//     an account that is no member, and after the end; the Group sends the counts and the end;
//   - the peer's own poll is held here from no votes, and its author ends it from the peer.
// Direct messages, fx_alice <-> the peer and fx_bob <-> the peer:
//   - fx_alice's poll goes to an instance of unknown software as a Note with harmony:poll, to
//     Mastodon as a Question;
//   - the peer's vote at fx_alice's inbox counts and is no message; fx_alice sends the counts;
//   - a Mastodon Question sent to fx_bob lands in the conversation as a poll, not as a post, and
//     fx_bob's vote goes to its author.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'
import { JobTap } from './outboundFederation.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface PollsContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    personalInbox: string
    strangerUrl: string
    groupUrl: string
    key: { privateKey: string }
    strangerKey: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  asUser: (authUserId: string) => SupabaseClient
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    remote: string
    conversation: string
    callConversation: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const body = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))
/** JSON with object keys sorted: jsonb stores keys in its own order. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
      : v
  return JSON.stringify(sort(value))
}
const inHour = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()
const answers = (names: string[], votes: number[] = []) =>
  names.map((name, i) => ({ type: 'Note', name, replies: { type: 'Collection', totalItems: votes[i] ?? 0 } }))

export async function casePolls(ctx: PollsContext): Promise<void> {
  console.log('\npolls -> harmony:poll in Notes, copies with the holder\'s counts, Mastodon votes and Questions')
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const [{ handleMessagePollJob }, { handleChannelMessageJob }, { handleNewDM }, { forgetInstanceSoftware }] = await Promise.all([
    backend('queue/handlers/messagePollHandler.ts'),
    backend('queue/handlers/channelMessageHandler.ts'),
    backend('listeners/DatabaseListener.ts'),
    backend('activitypub/instanceSoftware.ts'),
  ])
  const tap = await JobTap.open(process.env.HMFED_PROJECT ?? 'hmfed')
  const peerHost = new URL(ctx.peer.base).host
  const { data: copyMembership } = await ctx.db.from('user_servers').select('user_id')
    .eq('server_id', ctx.ids.remoteRef).eq('user_id', ctx.ids.remote).maybeSingle()
  const { data: knownPeer } = await ctx.db.from('federated_instances').select('domain, software').eq('domain', peerHost).maybeSingle()
  const { data: copyRow } = await ctx.db.from('servers').select('federation_metadata').eq('id', ctx.ids.remoteRef).single()
  try {
    if (!copyMembership) {
      await ctx.db.from('user_servers').insert({ server_id: ctx.ids.remoteRef, user_id: ctx.ids.remote, status: 'accepted', member_instance: peerHost })
    }
    await peerHostsPoll(ctx, tap, handleMessagePollJob)
    await copyMemberPolls(ctx, tap, handleMessagePollJob, handleChannelMessageJob)
    await hostedPolls(ctx, tap, handleMessagePollJob, handleChannelMessageJob)
    await directPolls(ctx, tap, handleMessagePollJob, handleNewDM, forgetInstanceSoftware)
  } finally {
    tap.close()
    if (!copyMembership) await ctx.db.from('user_servers').delete().eq('server_id', ctx.ids.remoteRef).eq('user_id', ctx.ids.remote)
    await ctx.db.from('servers').update({ federation_metadata: copyRow?.federation_metadata ?? {} }).eq('id', ctx.ids.remoteRef)
    if (knownPeer) await ctx.db.from('federated_instances').update({ software: knownPeer.software }).eq('domain', peerHost)
    else await ctx.db.from('federated_instances').delete().eq('domain', peerHost)
    forgetInstanceSoftware(peerHost)
  }
}

type Job = { name: string; data: any }
type Handler = (data: any) => Promise<void>

async function runPollJob(tap: JobTap, handle: Handler, match: (data: any) => boolean): Promise<Job | null> {
  const job = await tap.take((j) => j.name === 'federate-message-poll' && match(j.data))
  if (job) await handle(job.data)
  return job
}

async function captured(ctx: PollsContext, since: number, match: (c: Captured, b: any) => boolean, ms = 5000): Promise<Array<{ c: Captured; b: any }>> {
  const until = Date.now() + ms
  for (;;) {
    const got = ctx.peer.captured.slice(since).map((c) => ({ c, b: body(c) })).filter(({ c, b }) => match(c, b))
    if (got.length > 0 || Date.now() > until) return got
    await sleep(100)
  }
}

async function pollOf(db: SupabaseClient, messageId: string) {
  const { data } = await db.from('message_polls')
    .select('id, remote, ap_id, remote_voters, expires_at, options:message_poll_options!message_poll_options_poll_id_fkey(position, text, remote_votes)')
    .eq('message_id', messageId).maybeSingle()
  if (data) (data as any).options.sort((a: any, b: any) => a.position - b.position)
  return data as any
}

async function storedByApId(db: SupabaseClient, apId: string) {
  for (let i = 0; i < 30; i++) {
    const { data } = await db.from('messages').select('id, content, conversation_id').eq('metadata->>ap_id', apId).maybeSingle()
    if (data) return data as any
    await sleep(200)
  }
  return null
}

async function readPoll(ctx: PollsContext, auth: string, pollId: string) {
  const { data } = await ctx.asUser(auth).rpc('get_message_polls', { p_poll_ids: [pollId] })
  return (Array.isArray(data) ? data[0] : null) as any
}

// ---------------------------------------------------------------------------------------------

async function peerHostsPoll(ctx: PollsContext, tap: JobTap, handlePoll: Handler): Promise<void> {
  console.log('  the peer\'s Group holds a poll; this instance copies it')
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const asPeer = (url: string, json: string) => deliver(ctx.post, ctx.signedHeaders, url, json, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const asGroup = (url: string, json: string) => deliver(ctx.post, ctx.signedHeaders, url, json, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)

  const noteId = `${peer.base}/messages/${crypto.randomUUID()}`
  const end = inHour(24)
  const note = {
    type: 'Note', id: noteId, attributedTo: peer.actorUrl,
    content: '📊 Lunch?<br />1. Pizza<br />2. Soup',
    context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef,
    'harmony:rawContent': [{ type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Soup' }],
    'harmony:poll': { type: 'Question', name: 'Lunch?', oneOf: answers(['Pizza', 'Soup'], [2, 1]), endTime: end, votersCount: 3 },
  }
  const create = JSON.stringify({
    '@context': [AS, HARMONY], id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl,
    to: [`https://${ctx.instanceDomain}/users/fx_bob`], object: note,
  })
  eq(await asPeer(`${localUrl}/inbox`, create), 202, 'the peer\'s poll in its Group channel is taken (202)')
  const row = await storedByApId(db, noteId)
  assert(row, 'and stored on the copy')
  eq(row?.content?.[0]?.type, 'poll', 'its content opens with a poll part the client renders')
  eq(row?.content?.[1]?.text, '📊 Lunch?\n1. Pizza\n2. Soup', 'beside the text fallback')
  const poll = await pollOf(db, row?.id ?? '')
  eq(row?.content?.[0]?.pollId, poll?.id, 'the part names the stored poll')
  eq(JSON.stringify({ remote: poll?.remote, ap: poll?.ap_id, voters: poll?.remote_voters, votes: poll?.options?.map((o: any) => o.remote_votes) }),
    JSON.stringify({ remote: true, ap: noteId, voters: 3, votes: [2, 1] }), 'a copy linked to the Note with the peer\'s counts')

  const read = await readPoll(ctx, ids.bobAuth, poll?.id ?? '')
  eq(JSON.stringify({ remote: read?.remote, voters: read?.total_voters }), JSON.stringify({ remote: true, voters: 3 }),
    'fx_bob reads the copy with the peer\'s counts')

  // fx_bob votes: final, counted here at once, sent to the Group.
  const soup = read?.options?.find((o: any) => o.text === 'Soup')?.id
  const voted = await ctx.asUser(ids.bobAuth).rpc('vote_message_poll', { p_poll_id: poll?.id, p_option_ids: [soup] })
  const after = Array.isArray(voted.data) ? voted.data[0] : null
  eq(JSON.stringify({ voters: after?.total_voters, mine: after?.my_option_ids }), JSON.stringify({ voters: 4, mine: [soup] }),
    'fx_bob\'s vote counts on the copy at once')
  const again = await ctx.asUser(ids.bobAuth).rpc('vote_message_poll', { p_poll_id: poll?.id, p_option_ids: [read?.options?.[0]?.id] })
  assert(String(again.error?.message ?? '').includes('POLL_ALREADY_VOTED'), 'and is final', again.error?.message)

  const n = ctx.peer.captured.length
  const job = await runPollJob(tap, handlePoll, (d) => d.kind === 'vote' && d.poll_id === poll?.id)
  assert(job, 'the vote is queued for the Group')
  const groupInbox = new URL(`${peer.groupUrl}/inbox`).pathname
  const [vote] = await captured(ctx, n, (c, b) => c.url === groupInbox && b.type === 'Create' && b.object?.inReplyTo === noteId)
  assert(vote, 'the Group\'s inbox receives the vote')
  eq(JSON.stringify({ actor: vote?.b.actor, type: vote?.b.object?.type, name: vote?.b.object?.name, content: vote?.b.object?.content, to: vote?.b.object?.to }),
    JSON.stringify({ actor: `https://${ctx.instanceDomain}/users/fx_bob`, type: 'Note', name: 'Soup', content: undefined, to: [peer.groupUrl] }),
    'as fx_bob\'s Mastodon vote: a Note named by the answer, no content, to the Group alone')
  if (vote) eq(await strictReceiverRefusal(vote.c, localUrl, ctx.instanceDomain), null, 'signed by fx_bob')
  const { count: left } = await db.from('message_poll_outbox').select('poll_id', { count: 'exact', head: true }).eq('poll_id', poll?.id)
  eq(left, 0, 'and leaves the outbox')

  // The Group's counts.
  const update = (actor: string, object: Record<string, unknown>) => JSON.stringify({
    '@context': [AS, HARMONY], id: `${actor}/activities/${crypto.randomUUID()}`, type: 'Update', actor, object,
  })
  const question = (votes: number[], voters: number, extra: Record<string, unknown> = {}) => ({
    type: 'Question', id: noteId, context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef,
    oneOf: answers(['Pizza', 'Soup'], votes), endTime: end, votersCount: voters, ...extra,
  })
  eq(await asPeer(`${localUrl}/inbox`, update(peer.actorUrl, question([9, 9], 18))), 202, 'an Update(Question) from the poll\'s author, not the Group, is acknowledged (202)')
  eq((await pollOf(db, row?.id ?? ''))?.remote_voters, 4, 'and changes nothing: the Group holds the tally')
  eq(await asGroup(`${localUrl}/inbox`, update(peer.groupUrl, question([2, 3], 5))), 202, 'the Group\'s Update(Question) is taken (202)')
  const updated = await pollOf(db, row?.id ?? '')
  eq(JSON.stringify({ voters: updated?.remote_voters, votes: updated?.options?.map((o: any) => o.remote_votes) }),
    JSON.stringify({ voters: 5, votes: [2, 3] }), 'its counts replace the copy\'s')
  const mine = await readPoll(ctx, ids.bobAuth, poll?.id ?? '')
  eq(JSON.stringify(mine?.my_option_ids), JSON.stringify([soup]), 'fx_bob still reads his own answer')

  const closedAt = new Date(Date.now() - 1000).toISOString()
  eq(await asGroup(`${localUrl}/inbox`, update(peer.groupUrl, question([2, 3], 5, { closed: closedAt }))), 202, 'the Group ends the poll (202)')
  eq((await readPoll(ctx, ids.bobAuth, poll?.id ?? ''))?.closed, true, 'the copy reads closed')

  // A host before 1.9.3: the Note carries the text only.
  const oldId = `${peer.base}/messages/${crypto.randomUUID()}`
  const old = JSON.stringify({
    '@context': [AS, HARMONY], id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl,
    to: [`https://${ctx.instanceDomain}/users/fx_bob`],
    object: { ...note, id: oldId, 'harmony:poll': undefined },
  })
  eq(await asPeer(`${localUrl}/inbox`, old), 202, 'a poll from a host before 1.9.3 is taken (202)')
  const oldRow = await storedByApId(db, oldId)
  eq(canonical(oldRow?.content), canonical([{ type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Soup' }]), 'as its text, line by line')
  eq(await pollOf(db, oldRow?.id ?? ''), null, 'with no poll')
}

// ---------------------------------------------------------------------------------------------

async function copyMemberPolls(ctx: PollsContext, tap: JobTap, handlePoll: Handler, handleChannelMessage: Handler): Promise<void> {
  console.log('  fx_bob\'s poll in the copy: the Group holds it')
  const { db, peer, ids, assert, eq } = ctx
  const bob = ctx.asUser(ids.bobAuth)
  const groupInbox = new URL(`${peer.groupUrl}/inbox`).pathname

  await db.from('servers').update({ federation_metadata: {} }).eq('id', ids.remoteRef)
  const refused = await bob.rpc('create_message_poll', {
    p_channel_id: ids.remoteChannel, p_conversation_id: null, p_question: 'Where?', p_options: ['Here', 'There'],
  })
  assert(String(refused.error?.message ?? '').includes('POLL_HOST_UNSUPPORTED'), 'a copy whose host does not federate polls takes none', refused.error?.message)

  await db.from('servers').update({ federation_metadata: { message_polls: true } }).eq('id', ids.remoteRef)
  const created = await bob.rpc('create_message_poll', {
    p_channel_id: ids.remoteChannel, p_conversation_id: null, p_question: 'Where?', p_options: ['Here', 'There'], p_duration_hours: 4,
  })
  assert(!created.error && created.data?.id, 'fx_bob posts a poll in the copy', created.error?.message)
  const messageId = created.data?.id as string
  const poll = await pollOf(db, messageId)
  eq(JSON.stringify({ remote: poll?.remote, ap: poll?.ap_id }), JSON.stringify({ remote: true, ap: null }), 'a copy from the start, named by its message here')

  const n = ctx.peer.captured.length
  const job = await tap.take((j) => j.name === 'federate-channel-message' && j.data?.message_id === messageId)
  assert(job, 'the message is queued for the Group')
  if (job) await handleChannelMessage(job.data)
  const noteId = `https://${ctx.instanceDomain}/messages/${messageId}`
  const [sent] = await captured(ctx, n, (c, b) => c.url === groupInbox && b.type === 'Create' && b.object?.id === noteId)
  assert(sent, 'the Group\'s inbox receives it')
  eq(sent?.b.object?.['harmony:poll']?.name, 'Where?', 'with harmony:poll naming the question')
  eq(JSON.stringify(sent?.b.object?.['harmony:poll']?.oneOf?.map((o: any) => [o.name, o.replies?.totalItems])),
    JSON.stringify([['Here', 0], ['There', 0]]), 'and the answers');

  // The Group's counts name the poll by this instance's id for it.
  const counts = JSON.stringify({
    '@context': [AS, HARMONY], id: `${peer.groupUrl}/polls/${crypto.randomUUID()}`, type: 'Update', actor: peer.groupUrl,
    object: {
      type: 'Question', id: noteId, context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef,
      oneOf: answers(['Here', 'There'], [2, 1]), votersCount: 3, endTime: inHour(4),
    },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, `${ctx.localUrl}/inbox`, counts, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202,
    'the Group\'s counts of fx_bob\'s poll are taken (202)')
  const counted = await pollOf(db, messageId)
  eq(JSON.stringify({ voters: counted?.remote_voters, votes: counted?.options?.map((o: any) => o.remote_votes) }),
    JSON.stringify({ voters: 3, votes: [2, 1] }), 'and fx_bob reads the Group\'s tally of his poll')

  const ended = await bob.rpc('end_message_poll', { p_poll_id: poll?.id })
  eq((Array.isArray(ended.data) ? ended.data[0] : null)?.closed, true, 'fx_bob ends his poll')
  const m = ctx.peer.captured.length
  assert(await runPollJob(tap, handlePoll, (d) => d.kind === 'end' && d.poll_id === poll?.id), 'the end is queued for the Group')
  const [endSent] = await captured(ctx, m, (c, b) => c.url === groupInbox && b.type === 'Update' && b.object?.id === noteId)
  assert(endSent, 'the Group\'s inbox receives it')
  eq(JSON.stringify({ actor: endSent?.b.actor, type: endSent?.b.object?.type, closed: typeof endSent?.b.object?.closed }),
    JSON.stringify({ actor: `https://${ctx.instanceDomain}/users/fx_bob`, type: 'Question', closed: 'string' }),
    'as fx_bob\'s Update(Question) carrying closed')
}

// ---------------------------------------------------------------------------------------------

async function hostedPolls(ctx: PollsContext, tap: JobTap, handlePoll: Handler, handleChannelMessage: Handler): Promise<void> {
  console.log('  polls of a server hosted here: held here, voted on from the peer')
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const alice = ctx.asUser(ids.aliceAuth)
  const inbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const group = `https://${ctx.instanceDomain}/servers/${ids.hostedServer}`

  const created = await alice.rpc('create_message_poll', {
    p_channel_id: ids.hostedChannel, p_conversation_id: null, p_question: 'Meet when?', p_options: ['Monday', 'Friday'],
  })
  assert(!created.error && created.data?.id, 'fx_alice posts a poll in the hosted channel', created.error?.message)
  const messageId = created.data?.id as string
  const noteId = `https://${ctx.instanceDomain}/messages/${messageId}`
  const poll = await pollOf(db, messageId)
  eq(poll?.remote, false, 'held here')

  let n = ctx.peer.captured.length
  const job = await tap.take((j) => j.name === 'federate-channel-message' && j.data?.message_id === messageId)
  if (job) await handleChannelMessage(job.data)
  const [sent] = await captured(ctx, n, (c, b) => c.url === '/inbox' && b.type === 'Create' && b.object?.id === noteId)
  assert(sent, 'the peer receives the poll')
  const object = sent?.b.object ?? {}
  eq(object.type, 'Note', 'as a Note, which Harmony before 1.9.3 stores as a message')
  eq(object.content, '📊 Meet when?<br />1. Monday<br />2. Friday', 'its HTML keeps the lines of the text fallback')
  eq(canonical(object['harmony:rawContent']), canonical([{ type: 'text', text: '📊 Meet when?\n1. Monday\n2. Friday' }]),
    'harmony:rawContent carries the text fallback alone')
  eq(JSON.stringify({ type: object['harmony:poll']?.type, name: object['harmony:poll']?.name, voters: object['harmony:poll']?.votersCount,
    answers: object['harmony:poll']?.oneOf?.map((o: any) => o.name), end: typeof object['harmony:poll']?.endTime }),
  JSON.stringify({ type: 'Question', name: 'Meet when?', voters: 0, answers: ['Monday', 'Friday'], end: 'string' }),
  'harmony:poll carries the question, the answers, the end and no votes')

  // The peer's votes at the server's inbox.
  const voteBy = (actor: string, name: string, key: string) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify({
    '@context': AS, id: `${actor}#votes/${crypto.randomUUID()}/activity`, type: 'Create', actor, to: [group],
    object: { id: `${actor}#votes/${crypto.randomUUID()}`, type: 'Note', attributedTo: actor, name, inReplyTo: noteId, to: [group] },
  }), key, `${actor}#main-key`)
  const votes = async () => {
    const { data } = await db.from('message_poll_votes').select('user_id, option:message_poll_options!inner(text)').eq('poll_id', poll?.id)
    return (data ?? []).map((v: any) => `${v.user_id === ids.remote ? 'peer' : v.user_id}:${v.option.text}`).sort()
  }
  const messageCount = async () => (await db.from('messages').select('id', { count: 'exact', head: true }).eq('channel_id', ids.hostedChannel)).count
  const messagesBefore = await messageCount()
  eq(await voteBy(peer.actorUrl, 'Friday', peer.key.privateKey), 202, 'the peer\'s vote is taken (202)')
  eq(JSON.stringify(await votes()), JSON.stringify(['peer:Friday']), 'and recorded against the peer\'s member')
  await voteBy(peer.actorUrl, 'Monday', peer.key.privateKey)
  await voteBy(peer.strangerUrl, 'Monday', peer.strangerKey.privateKey)
  eq(JSON.stringify(await votes()), JSON.stringify(['peer:Friday']), 'a second answer on a single-choice poll and an account that is no member are refused')
  eq(await messageCount(), messagesBefore, 'a vote is no message')

  n = ctx.peer.captured.length
  assert(await runPollJob(tap, handlePoll, (d) => d.kind === 'state' && d.poll_id === poll?.id), 'the counts are queued for the copies')
  const [state] = await captured(ctx, n, (c, b) => c.url === '/inbox' && b.type === 'Update' && b.object?.id === noteId)
  assert(state, 'the peer receives the counts')
  eq(JSON.stringify({ actor: state?.b.actor, type: state?.b.object?.type, votes: state?.b.object?.oneOf?.map((o: any) => o.replies.totalItems), voters: state?.b.object?.votersCount }),
    JSON.stringify({ actor: group, type: 'Question', votes: [0, 1], voters: 1 }), 'as the Group\'s Update(Question), counts only')
  if (state) eq(await strictReceiverRefusal(state.c, localUrl, ctx.instanceDomain), null, 'signed by the Group')
  assert(state && !JSON.stringify(state.b.object).includes(peer.actorUrl), 'naming no voter')

  const ended = await alice.rpc('end_message_poll', { p_poll_id: poll?.id })
  eq((Array.isArray(ended.data) ? ended.data[0] : null)?.closed, true, 'fx_alice ends the poll')
  n = ctx.peer.captured.length
  await runPollJob(tap, handlePoll, (d) => d.kind === 'state' && d.poll_id === poll?.id)
  const [closed] = await captured(ctx, n, (c, b) => c.url === '/inbox' && b.type === 'Update' && b.object?.id === noteId)
  eq(typeof closed?.b.object?.closed, 'string', 'the peer is told it closed')
  await voteBy(ctx.peer.actorUrl, 'Monday', peer.key.privateKey)
  const { data: late } = await db.from('message_poll_votes').select('user_id').eq('poll_id', poll?.id)
  eq(late?.length, 1, 'a vote after the end is refused')

  // The peer's member posts a poll: held here.
  const peerNoteId = `${peer.base}/messages/${crypto.randomUUID()}`
  const peerPoll = JSON.stringify({
    '@context': [AS, HARMONY], id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl,
    object: {
      type: 'Note', id: peerNoteId, attributedTo: peer.actorUrl, content: '📊 Sing?<br />1. Yes<br />2. No',
      context: `${group}/channels/${ids.hostedChannel}`, 'harmony:serverId': ids.hostedServer,
      'harmony:rawContent': [{ type: 'text', text: '📊 Sing?\n1. Yes\n2. No' }],
      'harmony:poll': { type: 'Question', name: 'Sing?', oneOf: answers(['Yes', 'No'], [7, 7]), endTime: inHour(2), votersCount: 14 },
    },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, peerPoll, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202, 'the peer\'s poll is taken by the server\'s inbox (202)')
  const row = await storedByApId(db, peerNoteId)
  const held = await pollOf(db, row?.id ?? '')
  eq(JSON.stringify({ remote: held?.remote, ap: held?.ap_id, votes: held?.options?.map((o: any) => o.remote_votes) }),
    JSON.stringify({ remote: false, ap: peerNoteId, votes: [0, 0] }), 'and held here, from no votes')
  const before = Date.parse(held?.expires_at ?? '')
  const end = JSON.stringify({
    '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Update', actor: peer.actorUrl,
    object: { type: 'Question', id: peerNoteId, closed: new Date().toISOString(), oneOf: answers(['Yes', 'No']) },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, end, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202, 'its author ends it from the peer (202)')
  const after = Date.parse((await pollOf(db, row?.id ?? ''))?.expires_at ?? '')
  assert(after < before && after <= Date.now(), 'and it ends here', `${held?.expires_at} -> ${after}`)
}

// ---------------------------------------------------------------------------------------------

async function directPolls(
  ctx: PollsContext,
  tap: JobTap,
  handlePoll: Handler,
  handleNewDM: (m: unknown) => Promise<void>,
  forgetInstanceSoftware: (host?: string) => void,
): Promise<void> {
  console.log('  direct messages: the author\'s instance holds the poll')
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const alice = ctx.asUser(ids.aliceAuth)
  const peerHost = new URL(peer.base).host
  const personal = new URL(peer.personalInbox).pathname

  const dmPoll = async (question: string) => {
    const created = await alice.rpc('create_message_poll', {
      p_channel_id: null, p_conversation_id: ids.conversation, p_question: question, p_options: ['Yes', 'No'],
    })
    assert(!created.error && created.data?.id, `fx_alice asks "${question}" in the DM`, created.error?.message)
    const { data: row } = await db.from('messages').select('*').eq('id', created.data?.id ?? '').single()
    const n = ctx.peer.captured.length
    await handleNewDM(row)
    const noteId = `https://${ctx.instanceDomain}/messages/${row?.id}`
    const [sent] = await captured(ctx, n, (c, b) => c.url === personal && b.type === 'Create' && b.object?.id === noteId)
    return { messageId: row?.id as string, noteId, object: sent?.b.object }
  }

  // Unknown software: possibly Harmony before 1.9.3, which would store a Question as a post.
  await db.from('federated_instances').delete().eq('domain', peerHost)
  forgetInstanceSoftware(peerHost)
  const toHarmony = await dmPoll('Call later?')
  eq(toHarmony.object?.type, 'Note', 'to software not known, the DM is a Note')
  eq(toHarmony.object?.['harmony:poll']?.name, 'Call later?', 'with harmony:poll')
  eq(toHarmony.object?.content, '📊 Call later?<br />1. Yes<br />2. No', 'and the text fallback, line by line')

  await db.from('federated_instances').upsert({ domain: peerHost, software: 'mastodon' }, { onConflict: 'domain' })
  forgetInstanceSoftware(peerHost)
  const toMastodon = await dmPoll('Lunch at noon?')
  eq(JSON.stringify({ type: toMastodon.object?.type, content: toMastodon.object?.content, oneOf: toMastodon.object?.oneOf?.map((o: any) => o.name),
    direct: toMastodon.object?.directMessage, extension: toMastodon.object?.['harmony:poll'] }),
  JSON.stringify({ type: 'Question', content: '<p>Lunch at noon?</p>', oneOf: ['Yes', 'No'], direct: true }),
  'to Mastodon, a Question whose content is the question')

  // The peer votes on fx_alice's DM poll at her inbox.
  const before = await db.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', ids.conversation)
  const aliceUrl = `https://${ctx.instanceDomain}/users/fx_alice`
  // Mastodon 4.6.8's ActivityPub::VoteSerializer output: `to` a single IRI.
  const vote = JSON.stringify({
    '@context': AS, id: `${peer.actorUrl}#votes/1/activity`, type: 'Create', actor: peer.actorUrl, to: aliceUrl,
    object: { id: `${peer.actorUrl}#votes/1`, type: 'Note', name: 'Yes', attributedTo: peer.actorUrl, inReplyTo: toMastodon.noteId, to: aliceUrl },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/users/fx_alice/inbox`, vote, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202,
    'the peer\'s Mastodon vote is taken (202)')
  const poll = await pollOf(db, toMastodon.messageId)
  const { data: recorded } = await db.from('message_poll_votes').select('user_id').eq('poll_id', poll?.id)
  eq(JSON.stringify(recorded?.map((r: any) => r.user_id)), JSON.stringify([ids.remote]), 'and counts')
  const afterCount = await db.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', ids.conversation)
  eq(afterCount.count, before.count, 'without a message in the conversation')
  const n = ctx.peer.captured.length
  assert(await runPollJob(tap, handlePoll, (d) => d.kind === 'state' && d.poll_id === poll?.id), 'the counts are queued for the peer')
  const [state] = await captured(ctx, n, (c, b) => c.url === personal && b.type === 'Update' && b.object?.id === toMastodon.noteId)
  eq(JSON.stringify({ actor: state?.b.actor, type: state?.b.object?.type, votes: state?.b.object?.oneOf?.map((o: any) => o.replies.totalItems) }),
    JSON.stringify({ actor: aliceUrl, type: 'Question', votes: [1, 0] }), 'fx_alice sends the counts as Update(Question)')

  // A Mastodon Question sent to fx_bob.
  const questionId = `${peer.base}/statuses/${crypto.randomUUID()}`
  const bobUrl = `https://${ctx.instanceDomain}/users/fx_bob`
  const question = JSON.stringify({
    '@context': [AS, { toot: 'http://joinmastodon.org/ns#', votersCount: 'toot:votersCount' }],
    id: `${questionId}/activity`, type: 'Create', actor: peer.actorUrl, to: [bobUrl], cc: [],
    object: {
      id: questionId, type: 'Question', attributedTo: peer.actorUrl, to: [bobUrl], cc: [],
      content: `<p><span class="h-card"><a href="${bobUrl}" class="u-url mention">@<span>fx_bob</span></a></span> Coffee or tea?</p>`,
      tag: [{ type: 'Mention', href: bobUrl, name: '@fx_bob' }],
      endTime: inHour(24), votersCount: 0, oneOf: answers(['Coffee', 'Tea']),
    },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/users/fx_bob/inbox`, question, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202,
    'a Mastodon Question to fx_bob is taken (202)')
  const row = await storedByApId(db, questionId)
  assert(row?.conversation_id, 'it lands in a direct conversation', JSON.stringify(row))
  const { data: asPost } = await db.from('posts').select('id').eq('ap_id', questionId).maybeSingle()
  eq(asPost, null, 'not as a post')
  eq(row?.content?.[0]?.question, 'Coffee or tea?', 'as a poll, its question without the mention')
  const copy = await pollOf(db, row?.id ?? '')
  eq(JSON.stringify({ remote: copy?.remote, ap: copy?.ap_id }), JSON.stringify({ remote: true, ap: questionId }), 'a copy of the peer\'s poll')

  const read = await readPoll(ctx, ids.bobAuth, copy?.id ?? '')
  const tea = read?.options?.find((o: any) => o.text === 'Tea')?.id
  const voted = await ctx.asUser(ids.bobAuth).rpc('vote_message_poll', { p_poll_id: copy?.id, p_option_ids: [tea] })
  assert(!voted.error, 'fx_bob votes', voted.error?.message)
  const m = ctx.peer.captured.length
  await runPollJob(tap, handlePoll, (d) => d.kind === 'vote' && d.poll_id === copy?.id)
  const [sentVote] = await captured(ctx, m, (c, b) => c.url === personal && b.type === 'Create' && b.object?.inReplyTo === questionId)
  eq(JSON.stringify({ actor: sentVote?.b.actor, name: sentVote?.b.object?.name, to: sentVote?.b.object?.to }),
    JSON.stringify({ actor: bobUrl, name: 'Tea', to: [peer.actorUrl] }), 'his vote reaches the author alone')

  const counts = JSON.stringify({
    '@context': AS, id: `${questionId}#updates/1`, type: 'Update', actor: peer.actorUrl, to: [bobUrl],
    object: {
      id: questionId, type: 'Question', attributedTo: peer.actorUrl, to: [bobUrl],
      oneOf: answers(['Coffee', 'Tea'], [3, 2]), votersCount: 5, endTime: inHour(24),
    },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/users/fx_bob/inbox`, counts, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202,
    'the author\'s Update(Question) is taken (202)')
  const updated = await pollOf(db, row?.id ?? '')
  eq(JSON.stringify({ voters: updated?.remote_voters, votes: updated?.options?.map((o: any) => o.remote_votes) }),
    JSON.stringify({ voters: 5, votes: [3, 2] }), 'and its counts apply')
}
