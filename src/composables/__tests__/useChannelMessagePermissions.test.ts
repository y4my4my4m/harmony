/**
 * MANAGE_MESSAGES and PIN_MESSAGES resolved per channel through get_user_permissions with the
 * channel id, so a channel override decides them.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

const getUserPermissions = vi.hoisted(() => vi.fn())

vi.mock('@/services/RoleService', () => ({
  Permission: {
    ADMINISTRATOR: 'ADMINISTRATOR',
    MANAGE_MESSAGES: 'MANAGE_MESSAGES',
    PIN_MESSAGES: 'PIN_MESSAGES',
  },
  roleService: { getUserPermissions },
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))

import { useChannelMessagePermissions } from '../useChannelMessagePermissions'

const flush = async () => {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function run(server: string | null, channel: ReturnType<typeof ref<string | null>>) {
  const scope = effectScope()
  const perms = scope.run(() => useChannelMessagePermissions(() => server, channel))!
  return { ...perms, stop: () => scope.stop() }
}

beforeEach(() => {
  getUserPermissions.mockReset()
})

describe('useChannelMessagePermissions', () => {
  it('asks for the channel-resolved set and follows the channel', async () => {
    getUserPermissions.mockImplementation(async (_u: string, _s: string, c: string) =>
      c === 'allowed' ? { MANAGE_MESSAGES: true } : { MANAGE_MESSAGES: false })
    const channel = ref<string | null>('allowed')
    const perms = run('s1', channel)
    await flush()
    expect(getUserPermissions).toHaveBeenCalledWith('me', 's1', 'allowed')
    expect(perms.canManageMessages.value).toBe(true)
    expect(perms.canPinMessages.value).toBe(true)

    channel.value = 'other'
    await flush()
    expect(getUserPermissions).toHaveBeenLastCalledWith('me', 's1', 'other')
    expect(perms.canManageMessages.value).toBe(false)
    expect(perms.canPinMessages.value).toBe(false)
    perms.stop()
  })

  it('PIN_MESSAGES alone pins without managing', async () => {
    getUserPermissions.mockResolvedValue({ PIN_MESSAGES: true })
    const perms = run('s1', ref('c1'))
    await flush()
    expect(perms.canPinMessages.value).toBe(true)
    expect(perms.canManageMessages.value).toBe(false)
    perms.stop()
  })

  it('ADMINISTRATOR holds both', async () => {
    getUserPermissions.mockResolvedValue({ ADMINISTRATOR: true })
    const perms = run('s1', ref('c1'))
    await flush()
    expect(perms.canManageMessages.value).toBe(true)
    expect(perms.canPinMessages.value).toBe(true)
    perms.stop()
  })

  it('holds nothing without a channel and asks nothing', async () => {
    const perms = run('s1', ref(null))
    await flush()
    expect(getUserPermissions).not.toHaveBeenCalled()
    expect(perms.canManageMessages.value).toBe(false)
    perms.stop()
  })

  it('drops an answer for a channel no longer shown', async () => {
    let release: (v: unknown) => void = () => {}
    getUserPermissions
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockResolvedValueOnce({ MANAGE_MESSAGES: false })
    const channel = ref<string | null>('slow')
    const perms = run('s1', channel)
    await flush()
    channel.value = 'fast'
    await flush()
    release({ MANAGE_MESSAGES: true })
    await flush()
    expect(perms.canManageMessages.value).toBe(false)
    perms.stop()
  })
})
