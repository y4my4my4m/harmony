/**
 * uploadInstanceEmoji: stores the prepared image under the instance emoji folder through the
 * shared emoji upload steps, records it with create_instance_emoji, and removes the object when
 * the record is refused.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { uploadInstanceEmoji } from '@/services/instanceEmojiUpload'

const emoji = vi.hoisted(() => ({
  prepareEmojiImage: vi.fn(),
  storeEmojiImage: vi.fn(),
  emojiNameFromFile: vi.fn((name: string) => name.replace(/\.[^.]+$/, '')),
}))
vi.mock('@/services/emojiService', () => emoji)

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const storageFrom = supabase.storage.from as unknown as ReturnType<typeof vi.fn>
const remove = vi.fn(async () => ({ data: null, error: null }))

// create_instance_emoji's path rule.
const PATH = /^00000000-0000-0000-0000-000000000000\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/

beforeEach(() => {
  rpc.mockReset()
  remove.mockClear()
  storageFrom.mockReturnValue({ remove })
  emoji.prepareEmojiImage.mockReset().mockResolvedValue({ file: new File(['x'], 'cat.webp'), extension: 'webp' })
  emoji.storeEmojiImage.mockReset().mockImplementation(async (path: string) => `https://db.test/storage/v1/object/public/emojis/${path}`)
})

describe('uploadInstanceEmoji', () => {
  it('stores under the instance folder with progress and records the emoji', async () => {
    rpc.mockResolvedValue({
      data: { id: 'e1', name: 'cat', url: 'u', uploader: 'p1', created_at: '2026-10-27T00:00:00Z', usage_count: 0 },
      error: null,
    })
    const onProgress = vi.fn()
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    const row = await uploadInstanceEmoji(file, { onProgress })

    const [path, , options] = emoji.storeEmojiImage.mock.calls[0]
    expect(path).toMatch(PATH)
    expect(options).toMatchObject({ label: 'cat.png', onProgress })
    expect(rpc).toHaveBeenCalledWith('create_instance_emoji', {
      p_name: 'cat',
      p_path: path,
      p_url: `https://db.test/storage/v1/object/public/emojis/${path}`,
    })
    expect(row).toMatchObject({ id: 'e1', name: 'cat', scope: 'instance', domain: null, reaction_count: 0 })
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes the stored object and rethrows when the record is refused', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Instance admins only' } })
    await expect(uploadInstanceEmoji(new File(['x'], 'cat.png', { type: 'image/png' }))).rejects.toMatchObject({ code: '42501' })
    const [path] = emoji.storeEmojiImage.mock.calls[0]
    expect(storageFrom).toHaveBeenCalledWith('emojis')
    expect(remove).toHaveBeenCalledWith([path])
  })
})
