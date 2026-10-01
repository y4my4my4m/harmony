import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import { trendingService } from '@/services/TrendingService'

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at: '2026-09-01T11:00:00Z',
  content: [{ type: 'text', text: id }],
  author_id: 'a1',
  visibility: 'public',
  media_attachments: [],
  favorites_count: 1,
  reblogs_count: 0,
  replies_count: 0,
  is_favorited: false,
  author: { id: 'a1', username: 'rita', domain: 'r.test' },
  score: 1,
  as_of: '2026-09-01T12:00:00Z',
  ...extra,
})

describe('TrendingService.getTrendingPosts', () => {
  const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    rpc.mockReset()
  })

  it('maps filters onto get_trending_posts arguments', async () => {
    rpc.mockResolvedValue({ data: [], error: null })

    await trendingService.getTrendingPosts({ timeRange: '7d', mediaOnly: true, domain: 'r.test', offset: 20, asOf: 'T' })
    expect(rpc).toHaveBeenLastCalledWith('get_trending_posts', {
      p_hours: 168,
      p_media_only: true,
      p_local_only: false,
      p_domain: 'r.test',
      p_limit: 20,
      p_offset: 20,
      p_as_of: 'T',
    })

    await trendingService.getTrendingPosts({ localOnly: true })
    expect(rpc).toHaveBeenLastCalledWith('get_trending_posts', {
      p_hours: 24,
      p_media_only: false,
      p_local_only: true,
      p_domain: null,
      p_limit: 20,
      p_offset: 0,
      p_as_of: null,
    })
  })

  it('reports the as_of and whether a full page leaves more', async () => {
    rpc.mockResolvedValue({ data: [row('p1', { is_favorited: true }), row('p2')], error: null })

    const full = await trendingService.getTrendingPosts({ limit: 2 })
    expect(full.posts.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(full.posts[0].is_favorited).toBe(true)
    expect(full.posts[0].author.handle).toBe('@rita@r.test')
    expect(full.asOf).toBe('2026-09-01T12:00:00Z')
    expect(full.hasMore).toBe(true)

    const short = await trendingService.getTrendingPosts({ limit: 3 })
    expect(short.hasMore).toBe(false)

    const capped = await trendingService.getTrendingPosts({ limit: 2, offset: 400 })
    expect(capped.hasMore).toBe(false)
  })

  it('keeps the caller-supplied as_of on an empty page', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const page = await trendingService.getTrendingPosts({ asOf: 'T' })
    expect(page).toEqual({ posts: [], asOf: 'T', hasMore: false })
  })

  it('throws when the RPC fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(trendingService.getTrendingPosts()).rejects.toEqual({ message: 'boom' })
  })
})
