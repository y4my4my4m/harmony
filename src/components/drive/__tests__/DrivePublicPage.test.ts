/**
 * The public page of a Drive address: the file, a footer crediting Harmony and the instance in new
 * tabs, and the owner only when drive_link_resolve sends one (the link's Show my name), with the
 * custom emoji of the display name and a link to the profile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount, RouterLinkStub } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import en from '@/locales/en.json'
import DrivePublicPage from '../DrivePublicPage.vue'
import type { DriveCardOwner, DriveLinkInfo } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

const { resolveDisplayNameParts } = vi.hoisted(() => ({ resolveDisplayNameParts: vi.fn() }))

vi.mock('@/services/userDataService', () => ({ userDataService: { resolveDisplayNameParts } }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUser: () => ref(null),
    getUserDisplayName: () => ref(''),
    getUserDisplayNameParts: () => ref(undefined),
    fetchUserProfile: vi.fn(),
  }),
}))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    resolveEmoji: (s: string) => ({ display: { type: 'text', content: s } }),
    isNativePack: ref(true),
    isLoaded: ref(true),
  }),
}))
vi.mock('@/composables/useVideoPlayerPreference', () => ({ useNativeVideoControls: () => ref(true) }))
vi.mock('@/services/instanceConfig', () => ({
  getInstanceDomain: () => 'harmony.test',
  apiUrl: (path: string) => path,
}))
vi.mock('@/utils/discordBridgeSetup', () => ({ resolveHarmonyBaseUrl: () => 'https://harmony.test' }))

const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const INFO: DriveLinkInfo = {
  name: 'harbor.png', mime_type: 'image/png', kind: 'image', size_bytes: 2048,
  created_at: '2026-10-20T00:00:00Z', expires_at: null, owner: null,
}
const OWNER: DriveCardOwner = {
  id: '11111111-0000-0000-0000-000000000001', username: 'alice', display_name: 'Alice :wave:',
  avatar_url: null, domain: null, emojis: [{ name: 'wave', url: 'https://cdn.test/wave.png' }],
}

function render(info: DriveLinkInfo | null | undefined) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return mount(DrivePublicPage, {
    props: { token: TOKEN, info },
    global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub, Avatar: true, VideoControls: true, Icon: true } },
  })
}

describe('DrivePublicPage', () => {
  it('credits Harmony and the instance in the footer, both opening in a new tab', () => {
    const wrapper = render(INFO)
    const footer = wrapper.get('[data-testid="drive-link-footer"]')
    expect(footer.text()).toBe('Powered by Harmony on harmony.test')
    const harmony = wrapper.get('[data-testid="drive-link-harmony"]')
    expect(harmony.attributes()).toMatchObject({ href: 'https://mony.lol', target: '_blank', rel: 'noopener' })
    const instance = wrapper.get('[data-testid="drive-link-instance"]')
    expect(instance.attributes()).toMatchObject({ href: 'https://harmony.test', target: '_blank', rel: 'noopener' })
  })

  it('names no owner unless the link shows one', () => {
    const wrapper = render(INFO)
    expect(wrapper.get('[data-testid="drive-link-name"]').text()).toBe('harbor.png')
    expect(wrapper.find('[data-testid="drive-link-owner"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Shared by')
  })

  it('shows the owner with the emoji of the display name, linking to the profile', () => {
    resolveDisplayNameParts.mockReturnValue([
      { type: 'text', text: 'Alice ' },
      { type: 'emoji', emoji: { id: 'wave', name: 'wave', url: 'https://cdn.test/wave.png' } },
    ])
    const wrapper = render({ ...INFO, owner: OWNER })
    expect(resolveDisplayNameParts).toHaveBeenCalledWith('Alice :wave:', [
      { id: 'wave', name: 'wave', url: 'https://cdn.test/wave.png' },
    ])
    const owner = wrapper.get('[data-testid="drive-link-owner"]')
    expect(owner.text()).toContain('Shared by Alice')
    expect(owner.get('img.display-name-emoji').attributes('alt')).toBe(':wave:')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/social/profile/alice')
  })

  it('says a link that opens nothing does not work', () => {
    const wrapper = render(null)
    expect(wrapper.find('[data-testid="drive-link-missing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drive-link-name"]').exists()).toBe(false)
  })
})
