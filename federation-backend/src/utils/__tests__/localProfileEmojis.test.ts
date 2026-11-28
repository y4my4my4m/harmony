import { describe, it, expect, vi } from 'vitest'

// A local account's actor names the emojis its name and bio show now. The stored
// display_name_emojis (derive_display_name_emojis) may name one the text no longer shows or that
// was removed since: both lists are replaced, empty included.

vi.mock('../../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let emojis: Row[] = []

function db() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const q: any = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q },
        not: (col: string, _op: string, val: unknown) => { filters.push((r) => (r[col] ?? null) !== val); return q },
        is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return q },
        then: (resolve: any) => resolve({ data: table === 'emojis' ? emojis.filter((r) => filters.every((f) => f(r))) : [], error: null }),
      }
      return q
    },
  }
}
vi.mock('../../config/supabase.js', () => ({ getSupabaseClient: () => db() }))

const { resolveLocalProfileEmojis } = await import('../emojiResolvers.js')

const WAVE = { id: 'e1', name: 'wave', url: 'https://harmony.test/storage/v1/object/public/emojis/wave.webp', deleted_at: null }
const stale = () => ({
  ap_published: '2026-01-01T00:00:00.000Z',
  display_name_emojis: [{ name: 'wave', url: WAVE.url, id: 'e1' }],
  bio_emojis: [{ name: 'wave', url: WAVE.url, id: 'e1' }],
})

describe('resolveLocalProfileEmojis', () => {
  it('lists the emojis the name and bio show', async () => {
    emojis = [WAVE]
    const profile: any = { username: 'alice', display_name: 'Alice :wave:', bio: 'hi', federation_metadata: {} }
    await resolveLocalProfileEmojis(profile, db())
    expect(profile.federation_metadata.display_name_emojis).toEqual([{ name: 'wave', url: WAVE.url, id: 'e1' }])
    expect(profile.federation_metadata.bio_emojis).toEqual([])
  })

  it('empties stored lists when the text names no emoji, keeping other keys', async () => {
    emojis = [WAVE]
    const profile: any = { username: 'alice', display_name: 'Alice', bio: 'hi', federation_metadata: stale() }
    await resolveLocalProfileEmojis(profile, db())
    expect(profile.federation_metadata).toEqual({ ap_published: '2026-01-01T00:00:00.000Z', display_name_emojis: [], bio_emojis: [] })
  })

  it('empties stored lists when the emoji the text names is gone', async () => {
    emojis = []
    const profile: any = { username: 'alice', display_name: 'Alice :wave:', bio: ':wave:', federation_metadata: stale() }
    await resolveLocalProfileEmojis(profile, db())
    expect(profile.federation_metadata.display_name_emojis).toEqual([])
    expect(profile.federation_metadata.bio_emojis).toEqual([])
  })
})
