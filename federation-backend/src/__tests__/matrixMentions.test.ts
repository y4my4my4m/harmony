import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'shared.example', PUBLIC_URL: 'https://shared.example' } }))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ from: mocks.from }) }))
import { resolveMentionUserIds } from '../utils/mentionResolver.js'
import { normalizeInboundMentions } from '../utils/mentionParts.js'
import { convertContentToHTML, extractActivityPubTags } from '../utils/contentUtils.js'

const matrix = { type: 'mention', userId: '@sam:shared.example', username: 'sam', domain: 'shared.example', isLocal: false, isBridged: true, bridgeSource: 'matrix' }
beforeEach(() => mocks.from.mockReset())

describe('Matrix mention identity across federation', () => {
  it.each([matrix, { ...matrix, isBridged: undefined, bridgeSource: undefined }])('never resolves an MXID to a same-name Harmony profile', async part => {
    const parts = [part]
    expect(await resolveMentionUserIds(parts)).toEqual(parts)
    expect(normalizeInboundMentions(parts, 'sender.example')).toEqual(parts)
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('preserves a Matrix target when the same message resolves a native namesake', async () => {
    const id = '00000000-0000-0000-0000-000000000001'
    const builder: any = { select: () => builder, in: () => builder, eq: async () => ({ data: [{ id, username: 'sam' }] }) }
    mocks.from.mockReturnValue(builder)
    const native = { type: 'mention', userId: 'old-id', username: 'sam', domain: 'shared.example', isLocal: false }
    const resolved = await resolveMentionUserIds([matrix, native])
    expect(resolved[0]).toEqual(matrix)
    expect(resolved[1]).toMatchObject({ userId: id, isLocal: true })
  })

  it('renders a Matrix link without inventing an ActivityPub actor or ping tag', () => {
    const html = convertContentToHTML([matrix])
    expect(html).toContain('https://matrix.to/#/%40sam%3Ashared.example')
    expect(html).not.toContain('/users/sam')
    expect(extractActivityPubTags([matrix])).toEqual([])
  })
})
