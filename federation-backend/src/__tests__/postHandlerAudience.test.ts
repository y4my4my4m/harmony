import { describe, it, expect, vi, beforeEach } from 'vitest'

// Delivery audience of post Create/Update/Delete jobs.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', USE_BULLMQ_QUEUE: true },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const post: any = {}
let parentRow: any = null
const CAROL_INBOX = 'https://misskey.test/inbox'
const author = { id: 'author-X', username: 'poring', domain: 'harmony.test', is_local: true }
const BOB = { username: 'bob', domain: 'mastodon.test', inbox_url: 'https://mastodon.test/users/bob/inbox' }

function chain(table: string) {
  const c: any = {
    select: () => c,
    eq: () => c,
    or: () => Promise.resolve({ data: table === 'profiles' ? [BOB] : [], error: null }),
    single: () => Promise.resolve({ data: table === 'posts' ? post : author, error: null }),
    maybeSingle: () => Promise.resolve({ data: table === 'posts' ? parentRow : null, error: null }),
    update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
  }
  return c
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}))

const loadQuoteTarget = vi.fn().mockResolvedValue(null)
const quoteRequestFor = vi.fn().mockResolvedValue(null)
const broadcastToFollowers = vi.fn().mockResolvedValue(undefined)
const sendToInbox = vi.fn().mockResolvedValue(undefined)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { broadcastToFollowers, sendToInbox },
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
const resolveRemoteAccount = vi.fn()
vi.mock('../activitypub/ActorService.js', () => ({ resolveRemoteAccount }))

vi.mock('../listeners/FederationHandlers.js', () => ({
  createPostActivity: vi.fn().mockResolvedValue({ type: 'Create' }),
  createDeleteActivity: vi.fn().mockReturnValue({ type: 'Delete' }),
  createPostUpdateActivity: vi.fn().mockResolvedValue({ type: 'Update' }),
  createAddToFeaturedActivity: vi.fn().mockReturnValue({ type: 'Add' }),
  createRemoveFromFeaturedActivity: vi.fn().mockReturnValue({ type: 'Remove' }),
  loadQuoteTarget,
  quoteRequestFor,
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn().mockResolvedValue(false),
}))

const { handlePostJob } = await import('../queue/handlers/postHandler.js')

const mentionBob = { type: 'mention', username: 'bob', domain: 'mastodon.test', isLocal: false }

beforeEach(() => {
  broadcastToFollowers.mockClear()
  sendToInbox.mockClear()
  parentRow = null
  loadQuoteTarget.mockResolvedValue(null)
  quoteRequestFor.mockResolvedValue(null)
  Object.keys(post).forEach((k) => delete post[k])
  Object.assign(post, {
    id: 'post-1',
    author_id: 'author-X',
    ap_id: 'https://harmony.test/posts/post-1',
    ap_type: 'Note',
    created_at: '2026-05-28T00:00:00Z',
    metadata: {},
  })
})

describe('post Update audience', () => {
  it('sends a direct post edit only to the mentioned recipients', async () => {
    post.visibility = 'direct'
    post.content = [mentionBob, { type: 'text', text: ' edited secret' }]

    await handlePostJob({ type: 'update', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(broadcastToFollowers).not.toHaveBeenCalled()
    expect(sendToInbox).toHaveBeenCalledWith(BOB.inbox_url, { type: 'Update' }, 'author-X')
  })

  it('sends a public post edit to followers and to mentioned non-followers', async () => {
    post.visibility = 'public'
    post.content = [mentionBob, { type: 'text', text: ' hi' }]

    await handlePostJob({ type: 'update', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1)
    expect(sendToInbox).toHaveBeenCalledWith(BOB.inbox_url, { type: 'Update' }, 'author-X')
  })
})

describe('post Delete audience', () => {
  it('reaches followers and any mention still present', async () => {
    post.visibility = 'public'
    post.content = [mentionBob]

    await handlePostJob({ type: 'delete', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1)
    expect(sendToInbox).toHaveBeenCalledWith(BOB.inbox_url, { type: 'Delete' }, 'author-X')
  })

  it('reaches the mentions the job carries once the content is blanked', async () => {
    post.visibility = 'direct'
    post.content = [{ type: 'text', text: '[Deleted]' }]

    await handlePostJob({
      type: 'delete', post_id: 'post-1', author_id: 'author-X',
      mentions: [{ username: 'bob', domain: 'mastodon.test' }],
    } as any)

    expect(sendToInbox).toHaveBeenCalledWith(BOB.inbox_url, { type: 'Delete' }, 'author-X')
    expect(resolveRemoteAccount).not.toHaveBeenCalled()
  })
})

describe('post Create audience', () => {
  it('reaches the remote author of the parent of a public reply', async () => {
    post.visibility = 'public'
    post.content = [{ type: 'text', text: 'agreed' }]
    post.in_reply_to = 'parent-1'
    parentRow = { author: { is_local: false, inbox_url: 'https://mastodon.test/users/strypey/inbox', shared_inbox_url: 'https://mastodon.test/inbox' } }

    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1)
    expect(sendToInbox).toHaveBeenCalledWith('https://mastodon.test/inbox', { type: 'Create' }, 'author-X')
  })

  it('does not hand a followers-only reply to a parent author outside its audience', async () => {
    post.visibility = 'followers'
    post.content = [{ type: 'text', text: 'quiet' }]
    post.in_reply_to = 'parent-1'
    parentRow = { author: { is_local: false, inbox_url: 'https://mastodon.test/users/strypey/inbox' } }

    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(sendToInbox).not.toHaveBeenCalled()
  })

  it('sends a quote to the quoted remote author, then asks them to approve it', async () => {
    post.visibility = 'public'
    post.content = [{ type: 'text', text: 'look' }]
    loadQuoteTarget.mockResolvedValue({ authorInbox: CAROL_INBOX })
    quoteRequestFor.mockResolvedValue({ inbox: CAROL_INBOX, activity: { type: 'QuoteRequest' } })

    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: 'author-X' } as any)

    expect(sendToInbox.mock.calls.map((c) => [c[0], c[1].type])).toEqual([
      [CAROL_INBOX, 'Create'],
      [CAROL_INBOX, 'QuoteRequest'],
    ])
  })
})
