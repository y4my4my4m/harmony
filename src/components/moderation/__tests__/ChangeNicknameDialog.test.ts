/** Moderator nickname dialog and server profile reset (moderate_server_profile). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const h = vi.hoisted(() => ({
  moderate: vi.fn(async (..._args: unknown[]) => ({})),
  setMember: vi.fn(),
  confirm: vi.fn(async (..._args: unknown[]) => true),
  toast: { success: vi.fn(), error: vi.fn() },
  nickname: 'Old' as string | null,
  logError: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (k: string) => k, locale: { value: 'en' } }),
}))
vi.mock('@/utils/debug', () => ({ debug: { error: h.logError, log: vi.fn(), warn: vi.fn() } }))
vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/services/serverProfileService', () => ({ moderateServerProfile: h.moderate }))
vi.mock('@/services/userDataService', () => ({ userDataService: { setMemberServerProfile: h.setMember } }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }))
vi.mock('@/composables/useMemberProfile', () => ({
  getMemberServerProfile: () => ({ value: h.nickname ? { nickname: h.nickname } : null }),
}))
vi.mock('@/components/common/Avatar.vue', async () => {
  const { defineComponent, h: render } = await import('vue')
  return { default: defineComponent({ name: 'Avatar', render: () => render('span') }) }
})

import ChangeNicknameDialog from '../ChangeNicknameDialog.vue'
import { useModerateServerProfile } from '@/composables/useModerateServerProfile'

enableAutoUnmount(afterEach)

const USER = { id: 'u-bob', username: 'bob', display_name: 'Bob', avatar_url: null }

async function open() {
  const wrapper = mount(ChangeNicknameDialog, {
    props: { show: true, serverId: 's1', user: USER },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}
const input = () => document.querySelector<HTMLInputElement>('[data-testid="moderate-nickname-input"]')!
const submit = () => document.querySelector<HTMLElement>('[data-testid="moderate-nickname-submit"]')!

beforeEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
  h.nickname = 'Old'
  h.confirm.mockResolvedValue(true)
})

describe('ChangeNicknameDialog', () => {
  it('submits the typed nickname and updates the local cache', async () => {
    const wrapper = await open()
    input().value = 'X'
    input().dispatchEvent(new Event('input'))
    submit().click()
    await flushPromises()
    expect(h.moderate).toHaveBeenCalledWith('s1', 'u-bob', { nickname: 'X' })
    expect(h.setMember).toHaveBeenCalledWith('s1', 'u-bob', { nickname: 'X' })
    expect(wrapper.emitted('done')).toBeTruthy()
  })

  it('submits null when the value is empty', async () => {
    await open()
    input().value = '   '
    input().dispatchEvent(new Event('input'))
    submit().click()
    await flushPromises()
    expect(h.moderate).toHaveBeenCalledWith('s1', 'u-bob', { nickname: null })
    expect(h.setMember).toHaveBeenCalledWith('s1', 'u-bob', { nickname: null })
  })

  it('shows an error toast and stays open when the RPC fails', async () => {
    h.moderate.mockRejectedValueOnce(new Error('denied'))
    const wrapper = await open()
    input().value = 'X'
    input().dispatchEvent(new Event('input'))
    submit().click()
    await flushPromises()
    expect(h.toast.error).toHaveBeenCalledWith('moderation.serverProfile.failed')
    expect(h.logError).toHaveBeenCalled()
    expect(wrapper.emitted('done')).toBeUndefined()
    expect(h.setMember).not.toHaveBeenCalled()
  })

  it('maps a 42501 to the permission message and never shows the raw RPC text', async () => {
    h.moderate.mockRejectedValueOnce(Object.assign(new Error('Cannot change the server profile of a member with an equal or higher role'), { code: '42501' }))
    await open()
    input().value = 'X'
    input().dispatchEvent(new Event('input'))
    submit().click()
    await flushPromises()
    expect(h.toast.error).toHaveBeenCalledWith('moderation.serverProfile.noPermission')
  })
})

describe('resetServerProfileWithConfirm', () => {
  const { resetServerProfileWithConfirm } = useModerateServerProfile()

  it('asks for confirmation, then resets and clears the cached fields', async () => {
    const ok = await resetServerProfileWithConfirm('s1', USER)
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.moderate).toHaveBeenCalledWith('s1', 'u-bob', { resetProfile: true })
    expect(h.setMember).toHaveBeenCalledWith('s1', 'u-bob', { avatar_url: null, banner_url: null, bio: null, pronouns: null })
    expect(ok).toBe(true)
  })

  it('does nothing when the confirmation is declined', async () => {
    h.confirm.mockResolvedValue(false)
    const ok = await resetServerProfileWithConfirm('s1', USER)
    expect(h.moderate).not.toHaveBeenCalled()
    expect(ok).toBe(false)
  })

  it('shows only translated text on failure and logs the raw error', async () => {
    h.moderate.mockRejectedValueOnce(new Error('raw rpc detail'))
    await resetServerProfileWithConfirm('s1', USER)
    expect(h.toast.error).toHaveBeenCalledWith('moderation.serverProfile.failed')
    expect(h.logError).toHaveBeenCalled()
  })

  it('maps 42501 to the permission message', async () => {
    h.moderate.mockRejectedValueOnce(Object.assign(new Error('Missing MANAGE_NICKNAMES permission'), { code: '42501' }))
    await resetServerProfileWithConfirm('s1', USER)
    expect(h.toast.error).toHaveBeenCalledWith('moderation.serverProfile.noPermission')
  })

  it('ignores a second call while a reset is pending, and allows one afterwards', async () => {
    let release!: (v: boolean) => void
    h.confirm.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r }))
    const first = resetServerProfileWithConfirm('s1', USER)
    const second = await resetServerProfileWithConfirm('s1', USER)
    expect(second).toBe(false)
    expect(h.confirm).toHaveBeenCalledTimes(1)
    release(true)
    await first
    expect(h.moderate).toHaveBeenCalledTimes(1)
    await resetServerProfileWithConfirm('s1', USER)
    expect(h.moderate).toHaveBeenCalledTimes(2)
  })
})
