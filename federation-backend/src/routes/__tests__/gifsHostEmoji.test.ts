import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// A generated emoji is stored without metadata, and its recorded size is the stored size.
const uploads = vi.hoisted(() => [] as Array<{ path: string; bytes: Buffer }>)
const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'https://harmony.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  },
}))

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Buffer) => {
          uploads.push({ path, bytes })
          return { error: null }
        },
        remove: async () => ({ error: null }),
      }),
    },
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        ilike: () => q,
        like: () => q,
        in: () => q,
        limit: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row)
          return { select: () => ({ single: async () => ({ data: { id: 'e1', name: row.name, url: row.url }, error: null }) }) }
        },
      }
      return q
    },
  }),
}))

import { hostAndCreateEmoji } from '../gifs.js'

describe('hostAndCreateEmoji', () => {
  it('stores a generated PNG without its text and Exif chunks', async () => {
    const png = readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata/gps.png'))
    expect(png.toString('latin1')).toContain('HarmonyCam')

    const result = await hostAndCreateEmoji('p1', 'party cat', { buffer: png, mimeType: 'image/png' })

    expect(result).toMatchObject({ emoji: { id: 'e1' } })
    const stored = uploads[0].bytes
    expect(stored.length).toBeLessThan(png.length)
    for (const marker of ['HarmonyCam', 'GPSLatitude', 'fixture comment']) expect(stored.toString('latin1')).not.toContain(marker)
    expect(stored.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(inserts[0].file_size).toBe(stored.length)
  })
})
