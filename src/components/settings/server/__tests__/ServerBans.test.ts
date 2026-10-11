import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ServerBans from '../ServerBans.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

const h = vi.hoisted(() => ({
  getServerBans: vi.fn(),
  unbanMember: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/services/ModerationService', () => ({
  moderationService: { getServerBans: h.getServerBans, unbanMember: h.unbanMember },
}))

enableAutoUnmount(afterEach)

const ban = (id: string, username: string, display: string | null) => ({
  id: `ban-${id}`,
  user_id: id,
  username,
  display_name: display,
  avatar_url: null,
  reason: id === 'u1' ? 'Spam' : null,
  banned_by_username: 'mod',
  created_at: '2026-03-04T00:00:00Z',
})

async function mountBans() {
  const wrapper = mount(ServerBans, { props: { serverId: 's1' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  document.body.innerHTML = ''
  h.getServerBans.mockReset()
  h.unbanMember.mockReset()
  h.toast.success.mockReset()
  h.toast.error.mockReset()
  h.getServerBans.mockResolvedValue([ban('u1', 'alice', 'Alice'), ban('u2', 'bob', null)])
})

describe('ServerBans', () => {
  it('lists bans and names each revoke button after the user', async () => {
    const wrapper = await mountBans()

    const list = wrapper.get('ul.bans-list')
    expect(list.findAll('li')).toHaveLength(2)
    const buttons = wrapper.findAll('[data-testid="ban-revoke"]')
    expect(buttons.map((b) => b.attributes('aria-label'))).toEqual(['Revoke ban for Alice', 'Revoke ban for bob'])
    expect(buttons[0].text()).toBe('Revoke ban')
    expect(wrapper.text()).toContain('Banned by mod on')
    expect(wrapper.find('.ban-reason .sr-only').text()).toBe('Reason:')
  })

  it('moves focus to the next revoke button after an unban', async () => {
    h.unbanMember.mockResolvedValue({ success: true })
    const wrapper = await mountBans()
    const first = wrapper.findAll('[data-testid="ban-revoke"]')[0]
    ;(first.element as HTMLElement).focus()

    await first.trigger('click')
    expect(first.attributes('aria-busy')).toBe('true')
    expect(first.attributes('aria-disabled')).toBe('true')
    await flushPromises()

    expect(h.unbanMember).toHaveBeenCalledWith('s1', 'u1')
    expect(h.toast.success).toHaveBeenCalledWith('Alice has been unbanned')
    const remaining = wrapper.findAll('[data-testid="ban-revoke"]')
    expect(remaining).toHaveLength(1)
    expect(document.activeElement).toBe(remaining[0].element)
  })

  it('announces a load failure as an alert', async () => {
    h.getServerBans.mockRejectedValue(new Error(''))
    const wrapper = await mountBans()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('Failed to load bans')
  })
})
