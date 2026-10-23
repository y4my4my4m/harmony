/**
 * HostedServersAdmin.vue: instance staff list the servers hosted here (staff_hosted_servers),
 * open one to act on its members and messages, and suspend or delete it. Each confirmation
 * says the action is taken as staff of this instance, lists what happens, and says where it is
 * recorded; a deletion waits for the server's name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { supabase } from '@/supabase'
import HostedServersAdmin from '../HostedServersAdmin.vue'

enableAutoUnmount(afterEach)

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : 1]
    }
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'BaseModal',
      props: { show: Boolean, title: String },
      setup: (props, { slots }) => () => props.show
        ? h('div', { class: 'modal' }, [h('h2', props.title), slots.default?.(), slots.footer?.()])
        : null,
    }),
  }
})

vi.mock('@/utils/serverUtils', () => ({ getServerIconUrl: () => '/icon.webp' }))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: { domain: 'here.test' } }) }))
const profile = vi.hoisted(() => ({ value: { id: 'me', is_admin: true } as Record<string, unknown> }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: profile.value }) }))

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const LOBBY = {
  id: 's1', name: 'Lobby', icon: null, public: true, federation_enabled: true, created_at: '2026-10-01T00:00:00Z',
  owner_id: 'o1', owner_username: 'olivia', owner_display_name: 'Olivia', owner_avatar_url: null,
  member_count: 3, remote_member_count: 1, suspended_at: null, suspended_reason: null, suspended_by_username: null,
  total_count: 2,
}
const QUIET = {
  ...LOBBY, id: 's2', name: 'Quiet', member_count: 1, remote_member_count: 0,
  suspended_at: '2026-10-20T00:00:00Z', suspended_reason: 'spam wave', suspended_by_username: 'mod',
}
const member = (id: string, extra: Record<string, unknown> = {}) => ({
  user_id: id, username: id, display_name: id.toUpperCase(), avatar_url: null, domain: 'here.test', is_local: true,
  status: 'accepted', joined_at: '2026-10-02T00:00:00Z', is_owner: false, is_instance_staff: false, total_count: 3, ...extra,
})

beforeEach(() => {
  toast.success.mockClear()
  profile.value = { id: 'me', is_admin: true }
  rpc.mockReset()
  rpc.mockImplementation(async (fn: string) => {
    switch (fn) {
      case 'staff_hosted_servers': return { data: [LOBBY, QUIET], error: null }
      case 'staff_server_members': return {
        data: [
          member('o1', { is_owner: true }),
          member('rem', { domain: 'remote.test', is_local: false }),
          member('mod2', { is_instance_staff: true }),
        ],
        error: null,
      }
      default: return { data: { success: true }, error: null }
    }
  })
})

const mountAdmin = async () => {
  const wrapper = mount(HostedServersAdmin, { attachTo: document.body })
  await flushPromises()
  return wrapper
}
const dialogText = (w: VueWrapper) => w.find('[data-testid="staff-action-dialog"]').text()
const confirmButton = (w: VueWrapper) => w.find('[data-testid="staff-action-confirm"]')

describe('HostedServersAdmin', () => {
  it('lists the servers hosted here, marked as staff tools, with suspensions and their reason', async () => {
    const w = await mountAdmin()
    expect(rpc).toHaveBeenCalledWith('staff_hosted_servers', { p_search: null, p_suspended_only: false, p_limit: 25, p_offset: 0 })
    expect(w.text()).toContain('Servers hosted here')
    expect(w.text()).toContain('here.test staff')
    const rows = w.findAll('[data-testid="hosted-server-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('3 members')
    expect(rows[0].text()).toContain('1 from other instances')
    expect(rows[1].text()).toContain('Suspended')
    expect(rows[1].text()).toContain('Reason: spam wave')
  })

  it('suspends as staff after listing what members will see', async () => {
    const w = await mountAdmin()
    await w.find('[data-testid="hosted-server-suspend"]').trigger('click')
    expect(w.find('.modal h2').text()).toBe('Suspend Lobby as here.test staff?')
    const text = dialogText(w)
    expect(text).toContain('You act as here.test staff, not as a moderator of Lobby.')
    expect(text).toContain('Nobody can post new messages in it or join it until the suspension is lifted.')
    expect(text).toContain('here.test staff suspended this server.')
    expect(text).toContain('Recorded in Lobby\'s audit log as an action of here.test staff.')

    await w.find('[data-testid="staff-action-reason"]').setValue('raids')
    await confirmButton(w).trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('staff_set_server_suspended', { p_server_id: 's1', p_suspended: true, p_reason: 'raids' })
    expect(toast.success).toHaveBeenCalledWith('Lobby is suspended.')
    expect(w.find('[data-testid="staff-action-dialog"]').exists()).toBe(false)
  })

  it('deletes only once the server\'s name is typed, and says where it is recorded', async () => {
    const w = await mountAdmin()
    const row = w.findAll('[data-testid="hosted-server-row"]')[0]
    await row.findAll('button').find(b => b.text() === 'Delete server')!.trigger('click')
    const text = dialogText(w)
    expect(text).toContain('Its 3 members lose access to it.')
    expect(text).toContain('Members on other instances are not told')
    expect(text).toContain('Recorded in the here.test moderation log.')
    expect(confirmButton(w).attributes('disabled')).toBeDefined()

    await w.find('[data-testid="staff-action-typed"]').setValue('Lobby')
    expect(confirmButton(w).attributes('disabled')).toBeUndefined()
    await confirmButton(w).trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('staff_delete_server', { p_server_id: 's1', p_reason: null })
  })

  it('removes a member of another instance, saying their instance is told', async () => {
    const w = await mountAdmin()
    await w.find('[data-testid="hosted-server-open"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('staff_server_members', expect.objectContaining({ p_server_id: 's1' }))

    const rows = w.findAll('[data-testid="hosted-member-row"]')
    expect(rows[0].find('[data-testid="hosted-member-remove"]').exists()).toBe(false)
    expect(rows[1].text()).toContain('@rem@remote.test')

    await rows[1].find('[data-testid="hosted-member-remove"]').trigger('click')
    expect(w.find('.modal h2').text()).toBe('Remove REM from Lobby as here.test staff?')
    expect(dialogText(w)).toContain('REM leaves Lobby. They can join again.')
    expect(dialogText(w)).toContain('Their instance, remote.test, is told that here.test staff removed them.')
    await confirmButton(w).trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('staff_remove_member', { p_server_id: 's1', p_profile_id: 'rem', p_ban: false, p_reason: null })
  })

  it('names the server or person in each row\'s buttons', async () => {
    const w = await mountAdmin()
    const row = w.findAll('[data-testid="hosted-server-row"]')[0]
    expect(row.get('[data-testid="hosted-server-open"]').attributes('aria-label')).toBe('Open: Lobby')
    expect(row.get('[data-testid="hosted-server-suspend"]').attributes('aria-label')).toBe('Suspend server: Lobby')
    expect(row.get('[data-testid="hosted-server-delete"]').attributes('aria-label')).toBe('Delete server: Lobby')

    await row.get('[data-testid="hosted-server-open"]').trigger('click')
    await flushPromises()
    const member = w.findAll('[data-testid="hosted-member-row"]')[1]
    expect(member.get('[data-testid="hosted-member-remove"]').attributes('aria-label')).toBe('Remove member: REM (@rem@remote.test)')
    expect(member.get('[data-testid="hosted-member-ban"]').attributes('aria-label')).toBe('Ban member: REM (@rem@remote.test)')
  })

  it('moves focus to the server\'s heading on Open and back to its Open button on Back', async () => {
    const w = await mountAdmin()
    const open = w.findAll('[data-testid="hosted-server-open"]')[1]
    ;(open.element as HTMLElement).focus()
    await open.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(w.get('[data-testid="hosted-server-heading"]').element)
    expect(document.activeElement?.textContent).toContain('Quiet')

    await w.get('[data-testid="hosted-server-back"]').trigger('click')
    await flushPromises()
    const back = w.findAll('[data-testid="hosted-server-open"]')[1]
    expect(back.attributes('data-server-id')).toBe('s2')
    expect(document.activeElement).toBe(back.element)
  })

  it('offers a moderator no action on instance staff', async () => {
    profile.value = { id: 'me', is_admin: false, is_moderator: true }
    const w = await mountAdmin()
    await w.find('[data-testid="hosted-server-open"]').trigger('click')
    await flushPromises()
    const rows = w.findAll('[data-testid="hosted-member-row"]')
    expect(rows[1].find('[data-testid="hosted-member-ban"]').exists()).toBe(true)
    expect(rows[2].find('[data-testid="hosted-member-ban"]').exists()).toBe(false)
  })
})
