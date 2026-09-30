import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
}))
const profilesIn = vi.fn()
const parentSingle = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    from: (table: string) => {
      const c: any = {
        select: () => c,
        eq: () => c,
        in: (...args: any[]) => profilesIn(table, ...args),
        single: () => parentSingle(table),
      }
      return c
    },
  })),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createDeleteActivity, createPostUpdateActivity } from '../listeners/FederationHandlers.js'

describe('FederationHandlers.createPostUpdateActivity', () => {
  const author = { username: 'alice' }
  const base = {
    id: 'p1',
    ap_id: 'https://harmony.test/posts/p1',
    visibility: 'public',
    created_at: '2026-01-01T00:00:00.000Z',
    content: [{ type: 'text', text: 'edited' }],
  }

  it('stamps object.updated, without which Mastodon discards the edit', async () => {
    profilesIn.mockResolvedValue({ data: [], error: null })
    const activity = await createPostUpdateActivity({ ...base, updated_at: '2026-01-02T00:00:00.000Z' }, author)

    expect(activity.type).toBe('Update')
    expect(activity.object.updated).toBe('2026-01-02T00:00:00.000Z')
  })

  it('carries the parent AP id in inReplyTo, not the row UUID', async () => {
    profilesIn.mockResolvedValue({ data: [], error: null })
    parentSingle.mockResolvedValue({ data: { ap_id: 'https://mastodon.test/users/bob/statuses/1' }, error: null })
    const activity = await createPostUpdateActivity(
      { ...base, in_reply_to: '11111111-1111-4111-8111-111111111111' },
      author,
    )

    expect(activity.object.inReplyTo).toBe('https://mastodon.test/users/bob/statuses/1')
  })

  it('uses the stored actor id for mentions', async () => {
    profilesIn.mockResolvedValue({
      data: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', federated_id: 'https://misskey.test/users/9abc' }],
      error: null,
    })
    const activity = await createPostUpdateActivity(
      {
        ...base,
        content: [{ type: 'mention', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'bob', domain: 'misskey.test' }],
      },
      author,
    )

    expect(activity.object.cc).toContain('https://misskey.test/users/9abc')
  })
})

describe('FederationHandlers.createDeleteActivity', () => {
  const author = { username: 'y4my4m', id: '67750a0f-7514-43ed-a5ed-89ac873a08f0' }
  const post = {
    id: '53b4e1c9-c11d-4a8f-8feb-74b6e4c06495',
    ap_id: 'https://harmony.test/posts/53b4e1c9-c11d-4a8f-8feb-74b6e4c06495',
  }

  it('sets actor from author.username and object from post ap_id', () => {
    const activity = createDeleteActivity(author, post)

    expect(activity.type).toBe('Delete')
    expect(activity.actor).toBe('https://harmony.test/users/y4my4m')
    expect(activity.object).toBe(post.ap_id)
  })

  it('regression: swapped (post, author) yields undefined actor (postHandler bug)', () => {
    const activity = createDeleteActivity(post as any, author as any)

    expect(activity.actor).toBe('https://harmony.test/users/undefined')
  })
})
