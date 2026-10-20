import { describe, it, expect, vi, beforeEach } from 'vitest'

// federate-poll-vote: a local account's answers on a remote poll reach the poll author's
// inbox as one Create{Note{name, inReplyTo}} per answer, addressed to the author alone, and
// the votes are marked delivered.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const sent = vi.hoisted(() => [] as Array<{ inbox: string; activity: any; signer: unknown }>)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    sendToInbox: vi.fn(async (inbox: string, activity: any, signer: unknown) => { sent.push({ inbox, activity, signer }) }),
  },
}))

const rows: Record<string, any[]> = {}
const updates: Array<{ table: string; values: any; filters: Array<[string, unknown]> }> = []

function query(table: string) {
  const filters: Array<[string, string, unknown]> = []
  let update: any = null
  const all = () => (rows[table] ?? []).filter((r) => filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : (r[c] ?? null) === v)))
  const q: any = {
    select: () => q,
    update: (values: any) => { update = values; return q },
    eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), q),
    is: (c: string, v: unknown) => (filters.push(['is', c, v]), q),
    order: () => q,
    maybeSingle: async () => ({ data: all()[0] ?? null, error: null }),
    then: (resolve: any) => {
      if (update) {
        const matched = all()
        matched.forEach((r) => Object.assign(r, update))
        updates.push({ table, values: update, filters: filters.map(([, c, v]) => [c, v]) })
        return resolve({ data: null, error: null })
      }
      return resolve({ data: all(), error: null })
    },
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t) }),
}))

const { handlePollVoteJob, pollVoteActivity } = await import('../queue/handlers/pollVoteHandler.js')

const POST = 'f0230000-0000-0000-0000-000000000001'
const QUESTION = 'https://mastodon.test/users/carol/statuses/1'
const CAROL = 'https://mastodon.test/users/carol'
const author = { federated_id: CAROL, inbox_url: `${CAROL}/inbox`, shared_inbox_url: 'https://mastodon.test/inbox', is_local: false }

beforeEach(() => {
  sent.length = 0
  updates.length = 0
  rows.profiles = [{ id: 'alice-id', username: 'alice', is_local: true, deleted_at: null }]
  rows.posts = [{
    id: POST, ap_id: QUESTION, is_deleted: false, author,
    metadata: { is_poll: true, poll_options: [{ name: 'Tea', votes: 1 }, { name: 'Coffee', votes: 0 }, { name: 'Water', votes: 0 }] },
  }]
  rows.post_poll_votes = [
    { post_id: POST, user_id: 'alice-id', choice: 0, delivered_at: null },
    { post_id: POST, user_id: 'alice-id', choice: 2, delivered_at: null },
  ]
})

describe('pollVoteActivity', () => {
  it('is Mastodon\'s vote: a Create of a Note with the answer as name, no content, to the author alone', () => {
    expect(pollVoteActivity('https://harmony.test/users/alice', CAROL, QUESTION, POST, 1, 'Coffee')).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://harmony.test/users/alice#votes/${POST}/1/activity`,
      type: 'Create',
      actor: 'https://harmony.test/users/alice',
      to: [CAROL],
      object: {
        id: `https://harmony.test/users/alice#votes/${POST}/1`,
        type: 'Note',
        attributedTo: 'https://harmony.test/users/alice',
        name: 'Coffee',
        inReplyTo: QUESTION,
        to: [CAROL],
      },
    })
  })
})

describe('handlePollVoteJob', () => {
  it('sends each answer to the author\'s own inbox, signed by the voter, then marks the vote delivered', async () => {
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent.map((s) => [s.inbox, s.activity.object.name, s.signer])).toEqual([
      [`${CAROL}/inbox`, 'Tea', 'alice-id'],
      [`${CAROL}/inbox`, 'Water', 'alice-id'],
    ])
    expect(sent.every((s) => s.activity.object.content === undefined && s.activity.cc === undefined)).toBe(true)
    expect(rows.post_poll_votes.every((v) => typeof v.delivered_at === 'string')).toBe(true)
  })

  it('sends nothing again for a delivered vote', async () => {
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    sent.length = 0
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent).toEqual([])
  })

  it('falls back to the shared inbox', async () => {
    rows.posts[0].author = { ...author, inbox_url: null }
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent.map((s) => s.inbox)).toEqual(['https://mastodon.test/inbox', 'https://mastodon.test/inbox'])
  })

  it('marks delivered without sending for a poll with no remote author, or a deleted voter', async () => {
    rows.posts[0].author = { ...author, is_local: true }
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent).toEqual([])
    expect(rows.post_poll_votes.every((v) => v.delivered_at)).toBe(true)

    rows.posts[0].author = author
    rows.post_poll_votes.forEach((v) => { v.delivered_at = null })
    rows.profiles[0].deleted_at = '2026-10-20T00:00:00Z'
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent).toEqual([])
  })

  it('skips an answer that names no option', async () => {
    rows.post_poll_votes.push({ post_id: POST, user_id: 'alice-id', choice: 7, delivered_at: null })
    await handlePollVoteJob({ type: 'create', post_id: POST, user_id: 'alice-id' })
    expect(sent.map((s) => s.activity.object.name)).toEqual(['Tea', 'Water'])
  })
})
