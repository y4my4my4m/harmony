/**
 * UserEmojiService: lists the caller's user-scope emojis, renames through rename_my_emoji,
 * deletes through the owner RLS policy (an empty result is P0002) and refreshes the
 * picker's personal groups.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import { deleteMyEmoji, listMyEmojis, refreshPersonalEmojis, renameMyEmoji } from '../UserEmojiService'

const cleanup = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/services/emojiService', () => ({ cleanupEmojiReferences: cleanup }))

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/services/emojiShortcodeResolver', () => ({ invalidateEmojiResolverCache: invalidate }))

const loadPersonalEmojis = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ loadPersonalEmojis }) }))

const from = supabase.from as unknown as ReturnType<typeof vi.fn>
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

/** A thenable PostgREST builder that records every call. */
function builder(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = []
  const b: any = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result)
      return (...args: unknown[]) => {
        calls.push([prop, args])
        return b
      }
    },
  })
  return { b, calls }
}

const EMOJI = { id: 'e1', name: 'cat', url: 'https://cdn.test/1.png', is_ai_generated: true, usage_count: 0, created_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UserEmojiService', () => {
  it('lists user-scope emojis of the profile, newest first', async () => {
    const { b, calls } = builder({ data: [{ ...EMOJI, usage_count: null }], error: null })
    from.mockReturnValue(b)
    const rows = await listMyEmojis('me')
    expect(from).toHaveBeenCalledWith('emojis')
    expect(calls).toEqual([
      ['select', ['id, name, url, is_ai_generated, usage_count, created_at']],
      ['eq', ['scope', 'user']],
      ['eq', ['uploader', 'me']],
      ['order', ['created_at', { ascending: false }]],
    ])
    expect(rows[0].usage_count).toBe(0)
  })

  it('renames through rename_my_emoji with a trimmed name', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await renameMyEmoji('e1', ' new_cat ')
    expect(rpc).toHaveBeenCalledWith('rename_my_emoji', { p_emoji_id: 'e1', p_name: 'new_cat' })

    rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'taken' } })
    await expect(renameMyEmoji('e1', 'dup')).rejects.toMatchObject({ code: '23505' })
  })

  it('deletes the owned row and clears its references', async () => {
    const { b, calls } = builder({ data: [{ id: 'e1' }], error: null })
    from.mockReturnValue(b)
    await deleteMyEmoji(EMOJI, 'me')
    expect(calls).toEqual([
      ['delete', []],
      ['eq', ['id', 'e1']],
      ['eq', ['scope', 'user']],
      ['eq', ['uploader', 'me']],
      ['select', ['id']],
    ])
    expect(cleanup).toHaveBeenCalledWith({ id: 'e1', name: 'cat', url: 'https://cdn.test/1.png', scope: 'user' })
  })

  it('raises P0002 when RLS filters the row out', async () => {
    from.mockReturnValue(builder({ data: [], error: null }).b)
    await expect(deleteMyEmoji(EMOJI, 'me')).rejects.toMatchObject({ code: 'P0002' })
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('refreshes the personal picker groups past their TTL', async () => {
    await refreshPersonalEmojis('me')
    expect(invalidate).toHaveBeenCalledWith()
    expect(loadPersonalEmojis).toHaveBeenCalledWith('me', true)
  })
})
