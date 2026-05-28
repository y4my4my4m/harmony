import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createDeleteActivity } from '../listeners/FederationHandlers.js'

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
