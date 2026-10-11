/**
 * Settings > Notifications: quiet-hours times and the master volume carry
 * programmatic labels; every per-type test button names its type, and the
 * button keeps focus while its test runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'

const { store } = vi.hoisted(() => ({
  store: {
    preferences: null as Record<string, unknown> | null,
    isDndActive: false,
    updatePreferences: vi.fn(async () => {}),
    showToast: vi.fn(),
    playNotificationSound: vi.fn(async () => {}),
    setVolume: vi.fn(),
  },
}))

const translate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: translate, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => store }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getUserAvatarUrlCurrent: computed(() => '') }),
}))
vi.mock('@/composables/usePushNotifications', () => ({
  usePushNotifications: () => ({
    isSupported: ref(false),
    permission: ref('default'),
    isSubscribed: ref(false),
    subscriptions: ref([]),
    error: ref(null),
    isLoading: ref(false),
    canSubscribe: ref(true),
    requiresPWA: ref(false),
    currentEndpoint: ref(null),
    androidChoice: ref(null),
    reconcile: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
  }),
}))
vi.mock('@/composables/useHapticSettings', () => ({
  useHapticSettings: () => ({ isEnabled: ref(false), hapticTriggers: ref({}), hapticManager: { trigger: vi.fn() } }),
}))
vi.mock('@/utils/platform', () => ({
  isTauri: () => false,
  isTauriMobile: () => false,
  isMobileDevice: () => false,
  supportsHaptics: () => false,
}))
vi.mock('@/services/androidPush', () => ({ isAndroidApp: () => false }))

import NotificationSettings from '../NotificationSettings.vue'

let wrapper: VueWrapper

function labelFor(el: Element): string {
  return document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? ''
}

beforeEach(async () => {
  store.preferences = reactive({ dnd_enabled: true, dnd_start_time: '22:00:00', dnd_end_time: '08:00:00' })
  store.showToast.mockClear()
  wrapper = mount(NotificationSettings, {
    attachTo: document.body,
    global: {
      mocks: { $t: translate },
      stubs: { Icon: true, AndroidPushSettings: true },
    },
  })
  await flushPromises()
})

afterEach(() => wrapper.unmount())

describe('NotificationSettings labels', () => {
  it('labels both quiet-hours times inside a group named by the heading', () => {
    const start = wrapper.get('[data-testid="quiet-hours-start"]').element
    const end = wrapper.get('[data-testid="quiet-hours-end"]').element
    expect(labelFor(start)).toBe('settings.notifications.quietHours.start')
    expect(labelFor(end)).toBe('settings.notifications.quietHours.end')

    const group = start.closest('[role="group"]')!
    expect(group).toBe(end.closest('[role="group"]'))
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent?.trim())
      .toBe('settings.notifications.quietHours.title')
  })

  it('labels the master volume slider and speaks its value as a percentage', async () => {
    const slider = wrapper.get('[data-testid="notification-volume"]')
    expect(labelFor(slider.element)).toBe('a11y.notifications.volume')
    expect(slider.attributes('aria-valuetext')).toBe('70%')
    expect(document.getElementById(slider.attributes('aria-describedby')!)).not.toBeNull()
    await slider.setValue('40')
    expect(slider.attributes('aria-valuetext')).toBe('40%')
  })
})

describe('NotificationSettings test buttons', () => {
  it('names each test button after its type, fediverse types qualified', () => {
    const names = wrapper.findAll('[data-testid="notification-test"]').map((b) => b.attributes('aria-label'))
    expect(names.length).toBeGreaterThan(5)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('a11y.notifications.testFor {"type":"settings.notifications.types.mentions.label"}')
    expect(names).toContain('a11y.notifications.testFor {"type":"settings.notifications.types.apMentions.name"}')
  })

  it('keeps the pressed button focusable and busy while its test runs', async () => {
    const button = wrapper.findAll('[data-testid="notification-test"]')[0]
    ;(button.element as HTMLButtonElement).focus()
    await button.trigger('click')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(button.element)
    await button.trigger('click')
    expect(store.showToast).toHaveBeenCalledTimes(1)
  })
})
