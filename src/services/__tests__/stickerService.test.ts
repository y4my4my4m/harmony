/**
 * stickerService: uploads go to bucket stickers under the scope's folder, then create_sticker
 * records them with the decoded size and duration; a refused record removes the object.
 * Files and text outside the limits are refused before anything is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  remove: vi.fn(async () => ({ error: null })),
  select: vi.fn(),
}))
vi.mock('@/supabase', () => ({
  supabase: {
    rpc: db.rpc,
    storage: {
      from: () => ({ remove: db.remove }),
      getBucket: async () => ({ data: null, error: new Error('offline') }),
    },
    from: () => ({ select: () => ({ in: db.select }) }),
  },
}))
const store = vi.hoisted(() => ({ storePublicImage: vi.fn() }))
vi.mock('@/services/uploads/storageUpload', () => store)
vi.mock('uuid', () => ({ v4: () => '2060e000-0000-4000-8000-000000000001' }))

import {
  deleteSticker,
  existingStickerIds,
  stickerErrorMessage,
  uploadSticker,
} from '@/services/stickerService'
import { UploadRejectedError } from '@/utils/uploadValidation'

const bytes = (...parts: Array<number[] | string>): Uint8Array => {
  const arrays = parts.map(p => (typeof p === 'string' ? Uint8Array.from(p, c => c.charCodeAt(0)) : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) { out.set(a, o); o += a.length }
  return out
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const pngChunk = (type: string, data: number[] = []) => bytes(be32(data.length), type, data, [0, 0, 0, 0])
const png = (w: number, h: number) => bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  pngChunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
  pngChunk('IDAT', [1, 2, 3]),
  pngChunk('IEND'),
)
const gifFrame = (cs: number) => bytes([0x21, 0xf9, 0x04, 0x00, ...le16(cs), 0x00, 0x00], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00], [0x02, 0x02, 0x44, 0x01, 0x00])
const gif = (w: number, h: number, delays: number[]) =>
  bytes('GIF89a', [...le16(w), ...le16(h), 0x80, 0, 0], [0, 0, 0, 255, 255, 255], ...delays.map((d) => gifFrame(d)).map((b) => Array.from(b)), [0x3b])
const file = (data: Uint8Array, name: string, type: string) => new File([data], name, { type })

const row = (over: Record<string, unknown> = {}) => ({ id: 's1', name: 'Cat wave', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  store.storePublicImage.mockImplementation(async (_bucket: string, path: string) => `https://h.test/storage/v1/object/public/stickers/${path}`)
})

describe('uploadSticker', () => {
  it('stores a server sticker under server/<id>/ and records its decoded size', async () => {
    db.rpc.mockResolvedValue({ data: row(), error: null })
    await uploadSticker({
      scope: 'server', serverId: 'srv', profileId: 'me',
      file: file(png(160, 120), 'cat.png', 'image/png'), name: ' Cat wave ', description: ' A cat waving ',
    })
    const path = 'server/srv/2060e000-0000-4000-8000-000000000001.png'
    expect(store.storePublicImage).toHaveBeenCalledWith('stickers', path, expect.anything(), expect.anything())
    expect(db.rpc).toHaveBeenCalledWith('create_sticker', {
      p_scope: 'server', p_server_id: 'srv', p_path: path,
      p_url: `https://h.test/storage/v1/object/public/stickers/${path}`,
      p_name: 'Cat wave', p_description: 'A cat waving',
      p_width: 160, p_height: 120, p_duration_ms: null,
    })
  })

  it('stores a personal sticker under user/<profile>/ with its loop duration', async () => {
    db.rpc.mockResolvedValue({ data: row(), error: null })
    await uploadSticker({
      scope: 'user', profileId: 'me',
      file: file(gif(100, 100, [100, 150]), 'spin.gif', 'image/gif'), name: 'spin', description: 'A spinning top',
    })
    expect(db.rpc).toHaveBeenCalledWith('create_sticker', expect.objectContaining({
      p_scope: 'user', p_server_id: null,
      p_path: 'user/me/2060e000-0000-4000-8000-000000000001.gif',
      p_duration_ms: 2500,
    }))
  })

  it('removes the object when create_sticker refuses it, and rethrows', async () => {
    const refusal = { code: '23514', message: 'STICKER_LIMIT: at most 0 user stickers' }
    db.rpc.mockResolvedValue({ data: null, error: refusal })
    await expect(uploadSticker({
      scope: 'user', profileId: 'me', file: file(png(10, 10), 'a.png', 'image/png'), name: 'aa', description: 'b',
    })).rejects.toBe(refusal)
    expect(db.remove).toHaveBeenCalledWith(['user/me/2060e000-0000-4000-8000-000000000001.png'])
    expect(stickerErrorMessage(refusal)).toBe('These stickers are turned off on this instance.')
  })

  it('refuses an animation over 320 px or 5 s before sending anything', async () => {
    await expect(uploadSticker({
      scope: 'user', profileId: 'me', file: file(gif(400, 100, [10, 10]), 'big.gif', 'image/gif'), name: 'big', description: 'b',
    })).rejects.toBeInstanceOf(UploadRejectedError)
    await expect(uploadSticker({
      scope: 'user', profileId: 'me', file: file(gif(100, 100, [300, 300]), 'long.gif', 'image/gif'), name: 'long', description: 'b',
    })).rejects.toThrow('That animation runs 6.0 s; the limit is 5 s.')
    expect(store.storePublicImage).not.toHaveBeenCalled()
  })

  it('refuses SVG and a missing description before sending anything', async () => {
    await expect(uploadSticker({
      scope: 'user', profileId: 'me', file: file(bytes('<svg/>'), 'x.svg', 'image/svg+xml'), name: 'svg', description: 'b',
    })).rejects.toThrow('A sticker is a PNG, APNG, WebP or GIF image.')
    await expect(uploadSticker({
      scope: 'user', profileId: 'me', file: file(png(10, 10), 'a.png', 'image/png'), name: 'aa', description: '  ',
    })).rejects.toThrow('Describe the sticker for people who cannot see it.')
    expect(store.storePublicImage).not.toHaveBeenCalled()
  })
})

describe('deleteSticker', () => {
  it('removes the row, then the object it names', async () => {
    db.rpc.mockResolvedValue({ data: 'server/srv/x.png', error: null })
    await deleteSticker('s1')
    expect(db.rpc).toHaveBeenCalledWith('delete_sticker', { p_sticker_id: 's1' })
    expect(db.remove).toHaveBeenCalledWith(['server/srv/x.png'])
  })
})

describe('existingStickerIds', () => {
  it('asks existing_sticker_ids for uuids only, once each, and answers each row\'s url', async () => {
    const a = '2060e000-0000-4000-8000-00000000000a'
    db.rpc.mockResolvedValue({ data: [{ id: a, url: 'https://db.test/storage/v1/object/public/stickers/a.png' }], error: null })
    expect(await existingStickerIds([a, a.toUpperCase(), 'remote-id']))
      .toEqual(new Map([[a, 'https://db.test/storage/v1/object/public/stickers/a.png']]))
    expect(db.rpc).toHaveBeenCalledWith('existing_sticker_ids', { p_ids: [a] })
    db.rpc.mockClear()
    expect(await existingStickerIds(['remote-id'])).toEqual(new Map())
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('stickerErrorMessage', () => {
  it('names the limit or the field at fault', () => {
    expect(stickerErrorMessage({ code: '23514', message: 'STICKER_LIMIT: at most 15 server stickers' })).toBe('Sticker limit reached (15).')
    expect(stickerErrorMessage({ code: '23505', message: 'STICKER_NAME_TAKEN: wave is taken' })).toBe('A sticker here already has that name.')
    expect(stickerErrorMessage({ code: '42501', message: 'STICKER_FORBIDDEN: x' })).toBe('You cannot manage these stickers.')
    expect(stickerErrorMessage({ code: 'P0002', message: 'Sticker not found' })).toBe('That sticker no longer exists.')
  })
})
