import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import KickBanModal from '../KickBanModal.vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    locale: { value: 'en' },
  }),
}))

const h = vi.hoisted(() => ({ banMember: vi.fn(), kickMember: vi.fn() }))

vi.mock('@/services/ModerationService', () => ({
  DELETE_MESSAGE_OPTIONS: [
    { label: "Don't Delete Any", value: 0 },
    { label: 'Last Hour', value: 3600 },
    { label: 'Last 24 Hours', value: 86400 },
    { label: 'Last 7 Days', value: 604800 },
  ],
  moderationService: { banMember: h.banMember, kickMember: h.kickMember },
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getUsersInContext: () => [
      { id: 'u2', username: 'alice', displayName: 'Alice', avatarUrl: null },
      { id: 'u3', username: 'bob', displayName: null, avatarUrl: null },
    ],
  },
}))
vi.mock('@/services/usersService', () => ({ getUserIdsForServer: vi.fn(async () => []), getProfiles: vi.fn(async () => []) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/components/common/Avatar.vue', async () => {
  const { defineComponent, h: render } = await import('vue')
  return { default: defineComponent({ name: 'Avatar', render: () => render('span') }) }
})

enableAutoUnmount(afterEach)

function mountModal(user: { id: string; username: string; display_name?: string | null }, mode: 'kick' | 'ban' = 'ban') {
  return mount(KickBanModal, {
    props: { show: true, mode, user, serverId: 's1' },
    attachTo: document.body,
  })
}

function press(target: EventTarget, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const ENGLISH = ['Member', 'Search for a member', 'No members found', 'Change member', 'permanently banned', 'Reason',
  'Why are you', 'Delete message history', "Don't Delete Any", 'Last Hour', 'Last 24 Hours', 'Last 7 Days']

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
})

describe('KickBanModal', () => {
  it('renders translated labels, placeholders and options', async () => {
    mountModal({ id: 'u2', username: 'alice', display_name: 'Alice' })
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const attrs = Array.from(dialog.querySelectorAll('[aria-label], [title], [placeholder]')).flatMap((el) =>
      ['aria-label', 'title', 'placeholder'].map((name) => el.getAttribute(name) ?? ''),
    )
    const raw = [dialog.textContent ?? '', ...attrs].join('\n')
    // Translation keys (a.b.c) are stripped; what remains is literal text.
    const rendered = raw.replace(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+/g, ' ')

    for (const phrase of ENGLISH) expect(rendered).not.toContain(phrase)
    const options = Array.from(dialog.querySelectorAll('select option')).map((o) => o.textContent?.trim())
    expect(options).toEqual([
      'moderation.kickBan.deleteOptions.none',
      'moderation.kickBan.deleteOptions.hour',
      'moderation.kickBan.deleteOptions.day',
      'moderation.kickBan.deleteOptions.week',
    ])
    const reason = dialog.querySelector<HTMLTextAreaElement>('textarea')!
    expect(dialog.querySelector(`label[for="${reason.id}"]`)?.textContent).toBe('moderation.reason')
    expect(reason.placeholder).toBe('moderation.kickBan.reasonPlaceholderBan')
    const select = dialog.querySelector<HTMLSelectElement>('select')!
    expect(dialog.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('moderation.kickBan.deleteMessages')

    const confirm = dialog.querySelector<HTMLElement>('.btn-confirm')!
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)?.textContent?.trim()).toBe('moderation.kickBan.banWarning')
  })

  it('picks a member from the combobox with the keyboard', async () => {
    mountModal({ id: '', username: '' })
    await flushPromises()

    const input = document.querySelector<HTMLInputElement>('[data-testid="kickban-member-search"]')!
    expect(input.getAttribute('role')).toBe('combobox')
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('moderation.kickBan.member')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const listbox = document.getElementById(input.getAttribute('aria-controls')!)!
    expect(listbox.getAttribute('role')).toBe('listbox')
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(2)

    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    await flushPromises()
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!
    expect(active.getAttribute('aria-selected')).toBe('true')
    expect(active.textContent).toContain('bob')

    const enter = press(input, 'Enter')
    await flushPromises()

    expect(enter.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-testid="kickban-member-search"]')).toBeNull()
    expect(document.querySelector('.user-display-name')?.textContent).toBe('bob')
    expect(document.activeElement).toBe(document.querySelector('textarea'))
    expect(document.querySelector('.clear-member-btn')?.getAttribute('aria-label')).toBe('moderation.kickBan.changeMember{"name":"bob"}')
  })

  it('closes the open list on Escape without closing the dialog', async () => {
    const wrapper = mountModal({ id: '', username: '' })
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-testid="kickban-member-search"]')!
    expect(input.getAttribute('aria-expanded')).toBe('true')

    const first = press(input, 'Escape')
    await flushPromises()
    expect(first.defaultPrevented).toBe(true)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(wrapper.emitted('close')).toBeUndefined()

    press(input, 'Escape')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
