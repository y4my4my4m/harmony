/**
 * UserEmojiService: lists the caller's user-scope emojis, uploads through the shared emoji
 * pipeline and create_my_emoji (a refused record removes the object), renames through
 * rename_my_emoji, deletes through the owner RLS policy (an empty result is P0002) and
 * refreshes the picker's personal groups.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import {
  deleteMyEmoji,
  deleteMyEmojis,
  listMyEmojis,
  refreshPersonalEmojis,
  renameMyEmoji,
  uploadMyEmoji,
} from '../UserEmojiService'

const pipeline = vi.hoisted(() => ({
  cleanupEmojiReferences: vi.fn(async () => {}),
  prepareEmojiImage: vi.fn(),
  storeEmojiImage: vi.fn(),
  emojiNameFromFile: vi.fn((name: string) => name.replace(/\..*$/, '')),
}))
vi.mock('@/services/emojiService', () => pipeline)

vi.mock('uuid', () => ({ v4: () => '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d' }))

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/services/emojiShortcodeResolver', () => ({ invalidateEmojiResolverCache: invalidate }))

const loadPersonalEmojis = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ loadPersonalEmojis }) }))

const from = supabase.from as unknown as ReturnType<typeof vi.fn>
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const storageFrom = supabase.storage.from as unknown as ReturnType<typeof vi.fn>

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

const EMOJI = {
  id: 'e1', name: 'cat', url: 'https://cdn.test/1.png', is_ai_generated: true, usage_count: 0, file_size: null, created_at: '',
}
const PATH = 'me/0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d.png'
const URL_ = `https://db.test/storage/v1/object/public/emojis/${PATH}`

let remove: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  remove = vi.fn(async () => ({ data: [], error: null }))
  storageFrom.mockReturnValue({ remove })
  pipeline.prepareEmojiImage.mockImplementation(async (file: File) => ({ file, extension: 'png', contentType: 'image/png', reencoded: false }))
  pipeline.storeEmojiImage.mockResolvedValue(URL_)
})

describe('UserEmojiService', () => {
  it('lists user-scope emojis of the profile, newest first', async () => {
    const { b, calls } = builder({ data: [{ ...EMOJI, usage_count: null }], error: null })
    from.mockReturnValue(b)
    const rows = await listMyEmojis('me')
    expect(from).toHaveBeenCalledWith('emojis')
    expect(calls).toEqual([
      ['select', ['id, name, url, is_ai_generated, usage_count, file_size, created_at']],
      ['eq', ['scope', 'user']],
      ['eq', ['uploader', 'me']],
      ['order', ['created_at', { ascending: false }]],
    ])
    expect(rows[0].usage_count).toBe(0)
  })

  it('uploads to <profile>/<uuid>.<ext> and records it through create_my_emoji', async () => {
    rpc.mockResolvedValue({ data: { ...EMOJI, id: 'n1', name: 'party', url: URL_, is_ai_generated: false, file_size: 900 }, error: null })
    const file = new File(['png'], 'party.png', { type: 'image/png' })
    const row = await uploadMyEmoji('me', file)
    expect(pipeline.prepareEmojiImage).toHaveBeenCalledWith(file)
    expect(pipeline.storeEmojiImage).toHaveBeenCalledWith(PATH, expect.objectContaining({ extension: 'png' }), { label: 'party.png' })
    expect(rpc).toHaveBeenCalledWith('create_my_emoji', { p_name: 'party', p_path: PATH, p_url: URL_ })
    expect(row).toMatchObject({ id: 'n1', name: 'party', is_ai_generated: false, file_size: 900 })
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes the object and rethrows when create_my_emoji refuses', async () => {
    const refusal = { code: '23514', message: 'PERSONAL_EMOJI_LIMIT: at most 1 personal emojis per user' }
    rpc.mockResolvedValue({ data: null, error: refusal })
    await expect(uploadMyEmoji('me', new File(['png'], 'x.png', { type: 'image/png' }))).rejects.toBe(refusal)
    expect(storageFrom).toHaveBeenCalledWith('emojis')
    expect(remove).toHaveBeenCalledWith([PATH])
  })

  it('stops before storage when the pipeline rejects the file', async () => {
    pipeline.prepareEmojiImage.mockRejectedValueOnce(new Error('too big'))
    await expect(uploadMyEmoji('me', new File(['x'], 'x.png', { type: 'image/png' }))).rejects.toThrow('too big')
    expect(pipeline.storeEmojiImage).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
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
      ['in', ['id', ['e1']]],
      ['eq', ['scope', 'user']],
      ['eq', ['uploader', 'me']],
      ['select', ['id']],
    ])
    expect(pipeline.cleanupEmojiReferences).toHaveBeenCalledWith({ id: 'e1', name: 'cat', url: 'https://cdn.test/1.png', scope: 'user' })
  })

  it('raises P0002 when RLS filters the row out', async () => {
    from.mockReturnValue(builder({ data: [], error: null }).b)
    await expect(deleteMyEmoji(EMOJI, 'me')).rejects.toMatchObject({ code: 'P0002' })
    expect(pipeline.cleanupEmojiReferences).not.toHaveBeenCalled()
  })

  it('deletes several in one request and reports the ones RLS kept', async () => {
    from.mockReturnValue(builder({ data: [{ id: 'e1' }], error: null }).b)
    const result = await deleteMyEmojis([EMOJI, { ...EMOJI, id: 'e2', name: 'dog' }], 'me')
    expect(result).toEqual({ success: ['e1'], failed: ['e2'] })
    expect(pipeline.cleanupEmojiReferences).toHaveBeenCalledTimes(1)
  })

  it('refreshes the personal picker groups past their TTL', async () => {
    await refreshPersonalEmojis('me')
    expect(invalidate).toHaveBeenCalledWith()
    expect(loadPersonalEmojis).toHaveBeenCalledWith('me', true)
  })
})
