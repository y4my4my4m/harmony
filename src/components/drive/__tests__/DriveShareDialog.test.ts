/**
 * The Link section of the share dialog: the file's /d/ address and one Copy link, General access
 * (Restricted or Anyone with the link) through drive_link_set, expiry and Show my name while
 * public, and Reset link behind a confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import type { DriveLinkState } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

const { api, copy } = vi.hoisted(() => ({
  api: {
    getDriveFileUsage: vi.fn(),
    getDriveFileCard: vi.fn(),
    setDriveLinkAccess: vi.fn(),
    resetDriveLink: vi.fn(),
    shareDriveFile: vi.fn(),
    unshareDriveFile: vi.fn(),
  },
  copy: vi.fn(async () => true),
}))

vi.mock('@/services/drive/driveService', () => api)
vi.mock('@/composables/useCopyDriveLink', () => ({ useCopyDriveLink: () => copy }))
vi.mock('@/utils/discordBridgeSetup', () => ({ resolveHarmonyBaseUrl: () => 'https://harmony.test' }))
vi.mock('@/utils/internalLinks', () => ({ toInternalPath: () => null }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [] }) }))
vi.mock('@/composables/useUserSearch', () => ({
  normalizeUserQuery: (q: string) => q.trim(),
  useUserSearch: () => ({ query: ref(''), results: ref([]), searching: ref(false), error: ref(null), clear: vi.fn() }),
}))

const Modal = defineComponent({ name: 'UnifiedModal', setup: (_, { slots }) => () => h('div', slots.default?.()) })
const Confirm = defineComponent({
  name: 'DriveConfirmDialog',
  props: ['title', 'message', 'confirmLabel', 'danger'],
  emits: ['confirm', 'cancel'],
  render() { return h('div', { 'data-testid': 'confirm' }, this.message) },
})
vi.mock('@/components/shared/UnifiedModal.vue', () => ({ default: Modal }))
vi.mock('../DriveConfirmDialog.vue', () => ({ default: Confirm }))

const { default: DriveShareDialog } = await import('../DriveShareDialog.vue')

const FILE = { id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', owner_id: 'o1' }
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'

function state(extra: Partial<DriveLinkState> = {}): DriveLinkState {
  return { token: TOKEN, public: false, link_expires_at: null, show_owner: false, ...extra }
}

function answer(link: DriveLinkState) {
  api.getDriveFileCard.mockResolvedValue({ access: true, via: 'file', id: FILE.id, ...link })
  api.getDriveFileUsage.mockResolvedValue({
    messages: [], posts: [],
    shares: link.public ? [{ id: 's1', scope: 'link', target_id: null, token: link.token, expires_at: link.link_expires_at, created_at: new Date().toISOString() }] : [],
  })
}

async function render(linkSharing = true) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const wrapper = mount(DriveShareDialog, {
    props: { file: FILE, name: 'harbor.png', linkSharing },
    global: { plugins: [i18n], stubs: { Icon: true, Avatar: true, LoadingSpinner: true } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  copy.mockClear()
})

describe('DriveShareDialog link section', () => {
  it('shows the /d/ address of a restricted file and copies it', async () => {
    answer(state())
    const wrapper = await render()
    expect((wrapper.get('[data-testid="drive-link-url"]').element as HTMLInputElement).value).toBe(`https://harmony.test/d/${TOKEN}`)
    expect((wrapper.get('[data-testid="drive-link-access"]').element as HTMLSelectElement).value).toBe('restricted')
    expect(wrapper.get('[data-testid="drive-link-access-hint"]').text()).toBe('Opens only for people who can already see this file.')
    expect(wrapper.find('[data-testid="drive-link-expiry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drive-link-show-owner"]').exists()).toBe(false)
    await wrapper.get('[data-testid="drive-link-copy"]').trigger('click')
    expect(copy).toHaveBeenCalledWith(TOKEN)
  })

  it('makes the file public through General access, then offers expiry and Show my name', async () => {
    answer(state())
    const wrapper = await render()
    api.setDriveLinkAccess.mockResolvedValue(state({ public: true }))
    answer(state({ public: true }))
    await wrapper.get('[data-testid="drive-link-access"]').setValue('anyone')
    await flushPromises()
    expect(api.setDriveLinkAccess).toHaveBeenCalledWith(FILE.id, { public: true })
    expect(wrapper.get('[data-testid="drive-link-access-hint"]').text()).toBe('Anyone with the link can view and download.')
    expect(wrapper.find('[data-testid="drive-link-expiry"]').exists()).toBe(true)
    const toggle = wrapper.get('[data-testid="drive-link-show-owner"]')
    expect(toggle.attributes('aria-checked')).toBe('false')

    api.setDriveLinkAccess.mockClear()
    await toggle.trigger('click')
    await flushPromises()
    expect(api.setDriveLinkAccess).toHaveBeenCalledWith(FILE.id, { public: true, expiresAt: null, showOwner: true })
  })

  it('keeps Show my name when the expiry changes', async () => {
    answer(state({ public: true, show_owner: true }))
    const wrapper = await render()
    await wrapper.get('[data-testid="drive-link-expiry"]').setValue('7')
    await flushPromises()
    const [, access] = api.setDriveLinkAccess.mock.calls[0]
    expect(access).toMatchObject({ public: true, showOwner: true })
    expect(Date.parse(access.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
  })

  it('shows a set expiry as its date whatever was toggled since, and Never clears it', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString()
    answer(state({ public: true, link_expires_at: until, show_owner: true }))
    const wrapper = await render()
    const expiry = wrapper.get('[data-testid="drive-link-expiry"]')
    expect((expiry.element as HTMLSelectElement).value).toBe('current')
    expect(expiry.find('option[value="current"]').text()).toMatch(/^Until /)
    await expiry.setValue('never')
    await flushPromises()
    expect(api.setDriveLinkAccess.mock.calls[0][1]).toMatchObject({ public: true, expiresAt: null, showOwner: true })
  })

  it('resets the link only after confirming, and hands the new token up', async () => {
    answer(state({ public: true }))
    const wrapper = await render()
    await wrapper.get('[data-testid="drive-link-reset"]').trigger('click')
    const confirm = wrapper.getComponent(Confirm)
    expect(confirm.props('message')).toContain('stops working for everyone')
    expect(api.resetDriveLink).not.toHaveBeenCalled()
    api.resetDriveLink.mockResolvedValue(state({ token: 'Nn9-new-token-0123456789', public: true }))
    answer(state({ token: 'Nn9-new-token-0123456789', public: true }))
    confirm.vm.$emit('confirm')
    await flushPromises()
    expect(api.resetDriveLink).toHaveBeenCalledWith(FILE.id)
    expect(wrapper.emitted('token')).toEqual([['Nn9-new-token-0123456789']])
    expect((wrapper.get('[data-testid="drive-link-url"]').element as HTMLInputElement).value)
      .toBe('https://harmony.test/d/Nn9-new-token-0123456789')
    expect(wrapper.findComponent(Confirm).exists()).toBe(false)
  })

  it('returns focus to Reset link once the reset is done', async () => {
    answer(state({ public: true }))
    const wrapper = await render()
    document.body.appendChild(wrapper.element)
    await wrapper.get('[data-testid="drive-link-reset"]').trigger('click')
    api.resetDriveLink.mockResolvedValue(state({ token: 'Nn9-new-token-0123456789', public: true }))
    wrapper.getComponent(Confirm).vm.$emit('confirm')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="drive-link-reset"]').element)
  })

  it('offers no public link while the instance turns link sharing off', async () => {
    answer(state())
    const wrapper = await render(false)
    const anyone = wrapper.get('[data-testid="drive-link-access"] option[value="anyone"]')
    expect((anyone.element as HTMLOptionElement).disabled).toBe(true)
  })
})
