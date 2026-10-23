import { beforeEach, describe, expect, it, vi } from 'vitest'

// drive_link_resolve sends a hidden owner as an object of nulls, for 1.8.11 link pages.

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))

const { resolveDriveLink } = await import('../driveService')

const base = { name: 'photo.png', mime_type: 'image/png', kind: 'image', size_bytes: 10, created_at: '2026-10-23T00:00:00Z', expires_at: null }
const hidden = { id: null, username: null, display_name: null, avatar_url: null, domain: null, emojis: [] }

beforeEach(() => rpc.mockReset())

describe('resolveDriveLink', () => {
  it('reads an owner of nulls as no owner', async () => {
    rpc.mockResolvedValue({ data: { ...base, owner: hidden }, error: null })
    expect((await resolveDriveLink('tok'))?.owner).toBeNull()
  })

  it('keeps a shown owner', async () => {
    const owner = { id: 'u1', username: 'alice', display_name: 'Alice :fire:', avatar_url: null, domain: null, emojis: [{ name: 'fire', url: 'https://x/f.png' }] }
    rpc.mockResolvedValue({ data: { ...base, owner }, error: null })
    expect((await resolveDriveLink('tok'))?.owner).toEqual(owner)
  })

  it('answers null for a dead token', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await resolveDriveLink('tok')).toBeNull()
  })
})
