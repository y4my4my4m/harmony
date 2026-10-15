/**
 * USE_EXTERNAL_EMOJIS in a server channel: which custom emoji count as the server's own, and
 * when the policy restricts (resolved per channel through get_user_permissions).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

const getUserPermissions = vi.hoisted(() => vi.fn())
const channels = vi.hoisted(() => [{ id: 'c1', server_id: 's1' }])
const index = vi.hoisted(() => new Map<string, { emoji: Record<string, unknown> }>())

vi.mock('@/services/RoleService', () => ({
  Permission: { ADMINISTRATOR: 'ADMINISTRATOR', USE_EXTERNAL_EMOJIS: 'USE_EXTERNAL_EMOJIS' },
  roleService: { getUserPermissions },
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels, currentServerId: 's1' }) }))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ globalEmojiIndex: index }) }))

import { isExternalEmoji, useExternalEmojiPolicy } from '../useExternalEmojiPolicy'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

// The profile store is imported on first use.
const flush = async () => {
  await vi.dynamicImportSettled()
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

beforeEach(() => {
  getUserPermissions.mockReset()
  index.clear()
})

describe('isExternalEmoji', () => {
  it('never counts unicode or bundled artwork', () => {
    expect(isExternalEmoji({ id: '🎉', url: '' }, 's1')).toBe(false)
    expect(isExternalEmoji({ id: '🎉', url: '/assets/twemoji/1f389.svg' }, 's1')).toBe(false)
  })

  it('counts the server\'s own emoji as local and everything else as external', () => {
    expect(isExternalEmoji({ id: LOCAL, url: 'https://cdn/l.png', server_id: 's1', scope: 'server' }, 's1')).toBe(false)
    expect(isExternalEmoji({ id: OTHER, url: 'https://cdn/o.png', server_id: 's2', scope: 'server' }, 's1')).toBe(true)
    expect(isExternalEmoji({ id: OTHER, url: 'https://cdn/i.png', server_id: null, scope: 'instance' }, 's1')).toBe(true)
    expect(isExternalEmoji({ id: OTHER, url: 'https://cdn/u.png', server_id: 's1', scope: 'user' }, 's1')).toBe(true)
    expect(isExternalEmoji({ id: 'discord:blob:900000000000009999', url: 'https://cdn.discordapp.com/emojis/900000000000009999.png' }, 's1')).toBe(true)
    expect(isExternalEmoji({ id: LOCAL, url: 'https://cdn/l.png', server_id: 's1' }, null)).toBe(true)
  })

  it('takes server and scope from the emoji index when the pick omits them', () => {
    const lookup = (id: string) => (id === LOCAL ? { server_id: 's1', scope: 'server' } : undefined)
    expect(isExternalEmoji({ id: LOCAL, url: 'https://cdn/l.png' }, 's1', lookup)).toBe(false)
    expect(isExternalEmoji({ id: OTHER, url: 'https://cdn/o.png' }, 's1', lookup)).toBe(true)
  })
})

describe('useExternalEmojiPolicy', () => {
  function run(channel: ReturnType<typeof ref<string | null>>) {
    const scope = effectScope()
    const policy = scope.run(() => useExternalEmojiPolicy(channel))!
    return { ...policy, stop: () => scope.stop() }
  }

  it('restricts without USE_EXTERNAL_EMOJIS in the channel', async () => {
    getUserPermissions.mockResolvedValue({ USE_EXTERNAL_EMOJIS: false })
    index.set(LOCAL, { emoji: { id: LOCAL, server_id: 's1', scope: 'server' } })
    const policy = run(ref<string | null>('c1'))
    await flush()
    expect(getUserPermissions).toHaveBeenCalledWith('me', 's1', 'c1')
    expect(policy.restricted.value).toBe(true)
    expect(policy.refuses({ id: LOCAL, url: 'https://cdn/l.png' })).toBe(false)
    expect(policy.refuses({ id: OTHER, url: 'https://cdn/o.png', server_id: 's2' })).toBe(true)
    expect(policy.refuses({ id: '🎉', url: '' })).toBe(false)
    policy.stop()
  })

  it('allows with the permission, with ADMINISTRATOR, and outside a channel', async () => {
    getUserPermissions.mockResolvedValueOnce({ USE_EXTERNAL_EMOJIS: true })
    const granted = run(ref<string | null>('c1'))
    await flush()
    expect(granted.restricted.value).toBe(false)
    granted.stop()

    getUserPermissions.mockResolvedValueOnce({ ADMINISTRATOR: true, USE_EXTERNAL_EMOJIS: false })
    const admin = run(ref<string | null>('c1'))
    await flush()
    expect(admin.restricted.value).toBe(false)
    admin.stop()

    const dm = run(ref<string | null>(null))
    await flush()
    expect(dm.restricted.value).toBe(false)
    expect(dm.refuses({ id: OTHER, url: 'https://cdn/o.png', server_id: 's2' })).toBe(false)
    dm.stop()
  })
})
