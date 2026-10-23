import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

// With SUPABASE_URL on the internal network (self-host's http://supabase-kong:8000), every
// storage URL an actor carries names PUBLIC_SUPABASE_URL: supabase-js getPublicUrl builds on
// the client's own URL.

vi.mock('../config/index.js', () => {
  const c = { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_URL: 'http://supabase-kong:8000', PUBLIC_SUPABASE_URL: 'https://db.harmony.test' }
  return { default: c, config: c }
})
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../config/supabase.js', async () => {
  const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js')
  const client = createClient('http://supabase-kong:8000', 'service-key', { auth: { persistSession: false } })
  return { getSupabaseClient: () => client }
})

const { profileToActor } = await import('../activitypub/converters/toActivityPub.js')

describe('actor storage URLs', () => {
  it('name the public host, the custom status emoji included', () => {
    const actor = profileToActor({
      id: 'p1',
      username: 'alice',
      display_name: 'Alice',
      avatar_url: 'p1/avatar-1.webp',
      banner_url: 'p1/p1_banner.webp',
      custom_status: { text: 'Coding', emoji_url: 'ai/blob.png' },
      public_key: 'k',
    })
    const json = JSON.stringify(actor)
    expect(json).not.toContain('supabase-kong')
    expect(actor['harmony:customStatus'].emoji_url).toBe('https://db.harmony.test/storage/v1/object/public/emojis/ai/blob.png')
    expect(actor.icon.url.startsWith('https://db.harmony.test/storage/v1/render/image/public/avatars/p1/avatar-1.webp')).toBe(true)
  })
})
