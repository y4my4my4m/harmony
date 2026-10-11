/**
 * Settings > Account: the banner upload is a keyboard-reachable, named file
 * input; every field has a programmatic label; save-time errors are tied to
 * their fields and move focus there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const { toast, polite } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  polite: vi.fn(),
}))

const translate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: translate, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }),
}))
vi.mock('@/composables/useImageCrop', () => ({
  useImageCrop: () => ({ cropImage: vi.fn(async (file: File) => file) }),
}))
vi.mock('@/composables/useAutoSuggest', () => ({
  useAutoSuggest: () => ({
    state: ref({ isActive: false, selectedIndex: 0, position: { top: 0, left: 0 } }),
    suggestions: ref([]),
    headerText: ref(''),
    handleInput: vi.fn(),
    handleKeyDown: vi.fn(),
    selectSuggestion: vi.fn(),
  }),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { resolveDisplayNameParts: vi.fn(() => undefined) },
}))
vi.mock('@/services/FundingService', () => ({
  fundingService: {
    getFundingConfig: vi.fn(async () => null),
    getSupporterBadge: vi.fn(async () => null),
    getDonationHistory: vi.fn(async () => []),
  },
  donationLinkHref: () => '#',
  isStripeLink: () => false,
  needsHandleInMessage: () => false,
  orderDonationLinks: (links: unknown[]) => links,
}))

import UserAccountSettings from '../UserAccountSettings.vue'

const PROFILE = {
  id: 'p1',
  username: 'alice',
  display_name: 'Alice',
  bio: 'Hi',
  color: '#0EA5E9',
  banner_url: null,
  avatar_url: null,
  created_at: '2026-01-01T00:00:00Z',
  profile_fields: [],
}

let wrapper: VueWrapper

function mountSettings(props: Record<string, unknown> = {}) {
  wrapper = mount(UserAccountSettings, {
    attachTo: document.body,
    props: { profile: { ...PROFILE }, loading: false, bannerUploading: false, ...props } as never,
    global: {
      mocks: { $t: translate },
      stubs: {
        BannerImage: true,
        Avatar: true,
        Icon: true,
        AutoSuggest: true,
        DisplayName: true,
        SupporterBadgeIcon: true,
        PlatformIcon: true,
        ColorPicker: true,
      },
    },
  })
  return wrapper
}

function labelText(input: Element): string {
  const id = input.getAttribute('id')
  const label = id ? document.querySelector(`label[for="${id}"]`) : null
  return label?.textContent?.trim() ?? ''
}

beforeEach(() => {
  setActivePinia(createPinia())
  polite.mockClear()
  toast.error.mockClear()
})

afterEach(() => wrapper?.unmount())

describe('UserAccountSettings banner upload', () => {
  it('is a named file input inside the banner label, reachable by Tab', () => {
    mountSettings()
    const input = wrapper.get<HTMLInputElement>('[data-testid="profile-banner-input"]')
    expect(input.element.type).toBe('file')
    expect(input.attributes('aria-label')).toBe('settings.userAccount.changeBanner')
    expect(input.attributes('tabindex')).toBeUndefined()
    expect(input.attributes('style') ?? '').not.toContain('display: none')
    expect(input.classes()).toContain('sr-only')
    expect(input.element.closest('label')?.getAttribute('data-testid')).toBe('profile-banner-upload')
    input.element.focus()
    expect(document.activeElement).toBe(input.element)
  })

  it('announces the upload and marks the input busy', async () => {
    mountSettings()
    await wrapper.setProps({ bannerUploading: true })
    expect(polite).toHaveBeenCalledWith('settings.userAccount.bannerUploading')
    expect(wrapper.get('[data-testid="profile-banner-input"]').attributes('aria-busy')).toBe('true')
  })

  it('ignores a second pick while uploading', async () => {
    mountSettings({ bannerUploading: true })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.get('[data-testid="profile-banner-input"]').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('UserAccountSettings field labels', () => {
  it('ties display name, username, bio and color to their labels and hints', () => {
    mountSettings()
    const inputs = wrapper.findAll('input[type="text"], textarea').map((w) => w.element)
    const labelled = inputs.map(labelText)
    expect(labelled).toEqual(expect.arrayContaining([
      'auth.displayName',
      'auth.username',
      'user.bio',
      'settings.userAccount.displayColor',
    ]))
    for (const input of inputs) {
      const hint = input.getAttribute('aria-describedby')
      expect(hint, labelText(input)).toBeTruthy()
      for (const id of hint!.split(' ')) expect(document.getElementById(id), id).not.toBeNull()
    }
  })

  it('keeps the read-only username focusable', () => {
    mountSettings()
    const username = Array.from(document.querySelectorAll('input')).find((i) => labelText(i) === 'auth.username')!
    expect(username.disabled).toBe(false)
    expect(username.readOnly).toBe(true)
  })

  it('names the color swatch with its expanded state', async () => {
    mountSettings()
    const swatch = wrapper.get('.color-hex-swatch')
    expect(swatch.attributes('aria-label')).toBe('settings.userAccount.openColorPicker')
    expect(swatch.attributes('aria-expanded')).toBe('false')
    await swatch.trigger('click')
    expect(swatch.attributes('aria-expanded')).toBe('true')
    expect(document.getElementById(swatch.attributes('aria-controls')!)).not.toBeNull()
  })

  it('labels profile field rows by number and names their remove buttons', async () => {
    mountSettings({ profile: { ...PROFILE, profile_fields: [{ name: 'Website', value: 'https://a.example' }] } })
    await wrapper.get('.profile-field-add').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="profile-field-row"]')
    expect(rows).toHaveLength(2)
    const second = rows[1].findAll('input').map((w) => labelText(w.element))
    expect(second).toEqual([
      'settings.userAccount.fieldNameLabel {"n":2}',
      'settings.userAccount.fieldValueLabel {"n":2}',
    ])
    expect(document.activeElement).toBe(rows[1].find('input').element)
    const removes = wrapper.findAll('.profile-field-remove').map((b) => b.attributes('aria-label'))
    expect(removes).toEqual([
      'settings.userAccount.removeFieldNamed {"name":"Website"}',
      'settings.userAccount.removeFieldNumbered {"n":2}',
    ])
  })
})

describe('UserAccountSettings save errors', () => {
  it('marks an empty display name invalid, links the alert and focuses the field', async () => {
    mountSettings()
    const input = Array.from(document.querySelectorAll('input')).find((i) => labelText(i) === 'auth.displayName')!
    await wrapper.find(`[id="${input.id}"]`).setValue('   ')
    await wrapper.get('.settings-actions .btn-primary').trigger('click')

    expect(wrapper.emitted('update-profile')).toBeUndefined()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const [errorId] = input.getAttribute('aria-describedby')!.split(' ')
    const error = document.getElementById(errorId)!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('settings.userAccount.displayNameRequired')
    expect(document.activeElement).toBe(input)
  })

  it('marks the missing half of a profile field and focuses it', async () => {
    mountSettings({ profile: { ...PROFILE, profile_fields: [{ name: 'Website', value: '' }] } })
    await wrapper.get('textarea').setValue('Changed bio')
    await wrapper.get('.settings-actions .btn-primary').trigger('click')
    expect(wrapper.emitted('update-profile')).toBeUndefined()

    const [name, value] = wrapper.get('[data-testid="profile-field-row"]').findAll('input').map((w) => w.element)
    expect(name.getAttribute('aria-invalid')).toBeNull()
    expect(value.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(value.getAttribute('aria-describedby')!)!
    expect(error.getAttribute('role')).toBe('alert')
    expect(document.activeElement).toBe(value)
  })
})
