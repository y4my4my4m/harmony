/**
 * RoleMenuCreateModal.vue: a title is stored when the poster typed one, and a refusal shows its
 * own reason.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  sendToTarget: vi.fn(),
  notifyModerationRejection: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: mocks.toastError }) }))
vi.mock('@/stores/shared/sendToTarget', () => ({ sendToTarget: mocks.sendToTarget }))
vi.mock('@/services/AutoModService', () => ({
  notifyModerationRejection: mocks.notifyModerationRejection,
  isModerationRejectionCode: () => false,
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useServerRoles', () => ({
  useServerRolesStore: () => ({
    rolesByServer: new Map([['s1', [
      { id: 'red', name: 'Red', position: 1, color: '', self_assignable: true, self_assign_group: null, permissions: {} },
      { id: 'everyone', name: '@everyone', position: 0, color: '', is_default: true, permissions: {} },
    ]]]),
    ensureServerLoaded: vi.fn(async () => {}),
  }),
}))

import RoleMenuCreateModal from '../RoleMenuCreateModal.vue'

const render = () => mount(RoleMenuCreateModal, {
  props: { show: true, serverId: 's1', channelId: 'c1' },
  global: {
    stubs: {
      BaseModal: { template: '<div><slot /><slot name="footer" /></div>' },
      UnifiedButton: { template: '<button />' },
      RoleChipGroup: true,
    },
  },
})
const post = async (title?: string) => {
  const w = render()
  if (title !== undefined) await w.get('[data-testid="role-menu-title"]').setValue(title)
  await w.get('[data-testid="role-menu-create"]').trigger('submit')
  await flushPromises()
  return w
}
const sentParts = () => mocks.sendToTarget.mock.calls[0][2]

beforeEach(() => {
  mocks.sendToTarget.mockReset().mockResolvedValue('ok')
  mocks.notifyModerationRejection.mockReset().mockReturnValue(false)
  mocks.toastError.mockReset()
})

describe('the title of a posted role menu', () => {
  it.each([undefined, '', '   '])('is not stored when left blank (%j)', async (title) => {
    const w = await post(title)
    expect(sentParts()).toEqual([
      { type: 'role_menu', serverId: 's1', group: null },
      { type: 'text', text: 'roleMenu.defaultTitle: Red' },
    ])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('is stored as typed', async () => {
    await post(' Colours ')
    expect(sentParts()).toEqual([
      { type: 'role_menu', serverId: 's1', group: null, title: 'Colours' },
      { type: 'text', text: 'Colours: Red' },
    ])
  })
})

describe('a refused role menu', () => {
  it('names the missing permission and stays open', async () => {
    mocks.sendToTarget.mockRejectedValue(Object.assign(new Error('Missing permission: MANAGE_ROLES'), { code: 'INSERT_FAILED' }))
    const w = await post()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('Missing permission: MANAGE_ROLES')
    expect(w.emitted('close')).toBeUndefined()
  })

  it('leaves a moderation rejection to its own notice', async () => {
    mocks.notifyModerationRejection.mockReturnValue(true)
    mocks.sendToTarget.mockRejectedValue(new Error('AUTOMOD_BLOCKED'))
    await post()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says the menu was not posted for any other failure', async () => {
    mocks.sendToTarget.mockRejectedValue(new Error('network'))
    await post()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('roleMenu.postFailed')
  })
})
