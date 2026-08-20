import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import { createFakePostgrest } from '../../../tests/helpers/fakePostgrest'

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'me' }),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({
      isAuthenticated: true,
      authUser: { id: 'auth-me' },
      profileId: 'me',
    }),
    getCurrentProfileId: async () => 'me',
  },
}))

vi.mock('@/utils/unifiedContentProcessing', () => ({
  parseContentToMessageParts: (text: string) => [{ type: 'text', text }],
  resolveMentionsUserData: async () => new Map(),
  resolveEmojisData: async () => new Map(),
}))

import { activityPubService } from '@/services/activityPubService'

const ORIGINAL = {
  id: 'orig-1',
  content: [{ type: 'text', text: 'original' }],
  visibility: 'public',
  conversation_id: 'conv-1',
  conversation_root_id: 'orig-1',
  favorites_count: 3,
  reblogs_count: 1,
  replies_count: 0,
  author: { id: 'author-1' },
  is_deleted: false,
}

function seed(extraPosts: any[] = [], interactions: any[] = []) {
  const db = createFakePostgrest({
    timeline_posts: [{ ...ORIGINAL }],
    posts: [{ ...ORIGINAL }, ...extraPosts],
    post_interactions: interactions,
  })
  ;(supabase.from as any).mockImplementation(db.from)
  return db
}

describe('ActivityPubService reblog/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Bug #3: the quote's post_interactions row makes the Boost button render
  // active, and the un-boost branch then deletes the quote post.
  it('createQuoteReblog writes no reblog interaction row', async () => {
    const db = seed()

    await activityPubService.createQuoteReblog('orig-1', 'my take')

    expect(db.tables.post_interactions).toHaveLength(0)
    const quote = db.tables.posts.find((p: any) => p.metadata?.is_quote)
    expect(quote).toBeTruthy()
    expect(quote.metadata.reblog_of).toBe('orig-1')
  })

  // Bug #3: quote, then press Boost. The quote used to be the row the un-boost
  // branch soft-deleted, and trigger_queue_post_federation federated a Delete.
  it('quoting then boosting keeps the quote and adds a boost', async () => {
    const db = seed()

    await activityPubService.createQuoteReblog('orig-1', 'my take')
    const quoteId = db.tables.posts.find((p: any) => p.metadata?.is_quote).id

    const result = await activityPubService.toggleReblog('orig-1')

    expect(db.tables.posts.find((p: any) => p.id === quoteId).is_deleted).toBeFalsy()
    expect(result.reblogged).toBe(true)
    expect(db.tables.posts.filter((p: any) => p.metadata?.reblog_of === 'orig-1')).toHaveLength(2)
  })

  // Bug #3: a legacy quote interaction row still routes a Boost click into the
  // un-boost branch. The quote post is not the row that branch retracts.
  it('un-boost leaves a quote post alone', async () => {
    const quote = {
      id: 'quote-1',
      author_id: 'me',
      is_deleted: false,
      metadata: { reblog_of: 'orig-1', is_quote: true },
    }
    const db = seed([quote], [
      { id: 'int-1', user_id: 'me', post_id: 'orig-1', interaction_type: 'reblog' },
    ])

    const result = await activityPubService.toggleReblog('orig-1')

    expect(result.reblogged).toBe(false)
    expect(db.tables.posts.find((p: any) => p.id === 'quote-1').is_deleted).toBe(false)
  })

  // Bug #5: holding both a quote and a boost made the posts lookup return two
  // rows; maybeSingle reported data=null, so nothing was retracted.
  it('un-boost retracts the boost while a quote exists', async () => {
    const quote = {
      id: 'quote-1',
      author_id: 'me',
      is_deleted: false,
      metadata: { reblog_of: 'orig-1', is_quote: true },
    }
    const boost = {
      id: 'boost-1',
      author_id: 'me',
      is_deleted: false,
      metadata: { reblog_of: 'orig-1' },
    }
    const db = seed([quote, boost], [
      { id: 'int-1', user_id: 'me', post_id: 'orig-1', interaction_type: 'reblog' },
    ])

    await activityPubService.toggleReblog('orig-1')

    expect(db.tables.posts.find((p: any) => p.id === 'boost-1').is_deleted).toBe(true)
    expect(db.tables.posts.find((p: any) => p.id === 'quote-1').is_deleted).toBe(false)
    expect(db.tables.post_interactions).toHaveLength(0)
  })

  // Bug #5: duplicate boost rows are the other >1-row case.
  it('un-boost retracts every boost row it holds', async () => {
    const boosts = [
      { id: 'boost-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
      { id: 'boost-2', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
    ]
    const db = seed(boosts, [
      { id: 'int-1', user_id: 'me', post_id: 'orig-1', interaction_type: 'reblog' },
    ])

    await activityPubService.toggleReblog('orig-1')

    expect(db.tables.posts.filter((p: any) => p.is_deleted === true).map((p: any) => p.id))
      .toEqual(['boost-1', 'boost-2'])
  })

  // Bug #5: an un-boost that removed only the interaction row left the boost
  // post behind, and the next toggle added a second one.
  it('boosting again reuses the boost already held', async () => {
    const db = seed([
      { id: 'boost-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
    ])

    await activityPubService.toggleReblog('orig-1')

    const boosts = db.tables.posts.filter((p: any) => p.metadata?.reblog_of === 'orig-1' && !p.metadata?.is_quote)
    expect(boosts.map((p: any) => p.id)).toEqual(['boost-1'])
  })

  it('boosting a post it already quotes creates a boost', async () => {
    const db = seed([
      { id: 'quote-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1', is_quote: true } },
    ])

    const result = await activityPubService.toggleReblog('orig-1')

    expect(result.reblogged).toBe(true)
    const boosts = db.tables.posts.filter((p: any) => p.metadata?.reblog_of === 'orig-1' && !p.metadata?.is_quote)
    expect(boosts).toHaveLength(1)
  })

  it('un-boost does not touch another account\'s boost', async () => {
    const db = seed([
      { id: 'boost-other', author_id: 'someone-else', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
      { id: 'boost-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
    ], [
      { id: 'int-1', user_id: 'me', post_id: 'orig-1', interaction_type: 'reblog' },
    ])

    await activityPubService.toggleReblog('orig-1')

    expect(db.tables.posts.find((p: any) => p.id === 'boost-other').is_deleted).toBe(false)
    expect(db.tables.posts.find((p: any) => p.id === 'boost-1').is_deleted).toBe(true)
  })
})
