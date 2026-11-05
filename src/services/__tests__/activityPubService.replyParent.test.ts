// Timeline reads carry the parent a reply answers in the same request: the PostgREST embed
// reply_parent:in_reply_to(...) and get_home_timeline_page's reply_parent, moved to
// reply_context (services/replyContext.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ id: 'me' }) } }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { activityPubService } from '@/services/activityPubService'
import { REPLY_PARENT_EMBED } from '@/services/replyContext'

const parent = {
  id: 'p1',
  content: [{ type: 'text', text: 'the parent' }],
  content_warning: null,
  visibility: 'public',
  is_deleted: false,
  media_attachments: [],
  created_at: '2026-11-01T00:00:00Z',
  author: { id: 'a1', username: 'toonie', display_name: 'Toonie', avatar_url: null, domain: 'meow.example', is_local: false },
}
const reply = { id: 'r1', in_reply_to: 'p1', created_at: '2026-11-02T00:00:00Z', author: { id: 'a2' }, my_interactions: [], reply_parent: parent }

function recordSelects(rows: unknown[]) {
  const selects: string[] = []
  ;(supabase.from as any).mockImplementation(() => {
    const chain: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
        return (...args: unknown[]) => {
          if (prop === 'select') selects.push(String(args[0]))
          return chain
        }
      },
    })
    return chain
  })
  return selects
}

const expectContext = (post: any) => {
  expect('reply_parent' in post).toBe(false)
  expect(post.reply_context).toMatchObject({ id: 'p1', state: 'post', content_preview: 'the parent', author: { username: 'toonie' } })
}

describe('timeline reads embed the parent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('the public feed', async () => {
    const selects = recordSelects([reply])
    const { posts } = await activityPubService.getEnhancedPublicTimeline({ limit: 20 })
    expect(selects[0]).toContain(REPLY_PARENT_EMBED)
    expectContext(posts[0])
  })

  it('the local feed', async () => {
    const selects = recordSelects([reply])
    const { posts } = await activityPubService.getUserTimeline('me', 'local', { limit: 20 })
    expect(selects[0]).toContain(REPLY_PARENT_EMBED)
    expectContext(posts[0])
  })

  it('a profile', async () => {
    const selects = recordSelects([reply])
    const posts = await activityPubService.getUserPosts('a2', { limit: 20 })
    expect(selects[0]).toContain(REPLY_PARENT_EMBED)
    expectContext(posts[0])
  })

  it('the home feed, from get_home_timeline_page', async () => {
    ;(supabase.rpc as any).mockResolvedValue({ data: [reply], error: null })
    const { posts } = await activityPubService.getUserTimeline('me', 'home', { limit: 20 })
    expect(supabase.rpc).toHaveBeenCalledWith('get_home_timeline_page', { p_limit: 20, p_before: null })
    expectContext(posts[0])
  })
})
