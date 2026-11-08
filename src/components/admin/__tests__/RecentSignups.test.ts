/**
 * RecentSignups.vue and BulkSuspendDialog.vue: staff read signups with email domains and group
 * them; a staff row cannot be selected; a group selects its members; the dialog lists what the
 * server's preview says, requires one reason and sends only accounts the preview allows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import RecentSignups from '../RecentSignups.vue'

enableAutoUnmount(afterEach)

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : forms.length - 1]
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
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('../CopyIdButton.vue', () => stub('CopyIdButton'))
vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'BaseModal',
      props: ['show', 'title'],
      setup(props, { slots }) {
        return () => (props.show
          ? h('div', { 'data-testid': 'modal' }, [h('h2', props.title), slots.default?.(), slots.footer?.()])
          : null)
      },
    }),
  }
})

const profile = vi.hoisted(() => ({ is_admin: false }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const row = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id,
  username,
  display_name: null,
  avatar_url: null,
  signed_up_at: '2026-11-08T03:00:00Z',
  email_domain: 'hoard.test',
  email_confirmed: true,
  last_sign_in_at: null,
  is_staff: false,
  is_suspended: false,
  suspended_at: null,
  suspension_reason: null,
  post_count: 0,
  message_count: 2,
  server_count: 1,
  owned_server_count: 0,
  first_server_id: null,
  first_server_name: null,
  first_server_after_seconds: null,
  total_count: 3,
  ...extra,
})

const preview = (id: string, username: string, skip: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  username,
  display_name: null,
  avatar_url: null,
  skip_reason: skip,
  post_count: 1,
  message_count: 2,
  local_follows: 3,
  remote_followers: 0,
  owned_servers: [],
  ...extra,
})

const rpc = vi.mocked(supabase.rpc) as unknown as ReturnType<typeof vi.fn>

function answer(previewRows: unknown[] = []) {
  rpc.mockImplementation(async (name: string) => {
    switch (name) {
      case 'staff_recent_signups':
        return {
          data: [
            row('a', 'hoard1', { first_server_name: 'Hall', first_server_after_seconds: 120 }),
            row('b', 'hoard2'),
            row('s', 'mod1', { is_staff: true }),
          ],
          error: null,
        }
      case 'staff_signup_groups':
        return {
          data: [{
            kind: 'email_domain', key: 'hoard.test', label: 'hoard.test', size: 2, suspended: 0, prior_count: 0,
            first_at: '2026-11-08T03:00:00Z', last_at: '2026-11-08T03:10:00Z', member_ids: ['a', 'b'],
          }],
          error: null,
        }
      case 'staff_signup_daily':
        return { data: [{ day: '2026-11-08', signups: 74, suspended: 0, email_domains: 9, top_domain_count: 51, peak_hour_count: 22, refused: 0, would_refuse: 0 }], error: null }
      case 'staff_bulk_suspend_preview':
        return { data: previewRows, error: null }
      case 'staff_bulk_set_suspended':
        return { data: { batch_id: 'x', suspended: true, changed: [{ id: 'a', username: 'hoard1' }], skipped: [], sessions_revoked: 1 }, error: null }
      default:
        return { data: null, error: null }
    }
  })
}

async function mounted() {
  const wrapper = mount(RecentSignups, { attachTo: document.body, global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  await flushPromises()
  return wrapper
}

const calls = (name: string) => rpc.mock.calls.filter((c) => c[0] === name)

describe('RecentSignups', () => {
  beforeEach(() => {
    rpc.mockReset()
    toast.success.mockReset()
    profile.is_admin = false
  })

  it('shows the domain and activity, and no address', async () => {
    answer()
    const wrapper = await mounted()
    const first = wrapper.find('[data-username="hoard1"]')
    expect(first.text()).toContain('hoard.test')
    expect(first.text()).toContain('2 messages')
    expect(first.text()).toContain('Joined Hall after 2 min')
    expect(wrapper.text()).not.toContain('@hoard.test')
    expect(wrapper.find('[data-testid="signup-daily"]').text()).toContain('74')
  })

  it('does not let a staff row be selected', async () => {
    answer()
    const wrapper = await mounted()
    const staff = wrapper.find('[data-username="mod1"] input[type="checkbox"]')
    expect((staff.element as HTMLInputElement).disabled).toBe(true)
  })

  it('shows a group alone and selects its members', async () => {
    answer()
    const wrapper = await mounted()
    await wrapper.find('[data-testid="signup-group-show"]').trigger('click')
    await flushPromises()
    expect(calls('staff_recent_signups').at(-1)?.[1]).toMatchObject({ p_profile_ids: ['a', 'b'] })

    expect(wrapper.find('[data-testid="signup-selection"]').exists()).toBe(false)
    await wrapper.find('[data-testid="signup-group-select"]').trigger('click')
    expect(wrapper.find('[data-testid="signup-selection"]').text()).toContain('2 selected')
  })

  it('lists affected and skipped accounts, requires a reason and sends only the affected', async () => {
    answer([
      preview('a', 'hoard1', null, { owned_servers: [{ id: 'h', name: 'Hall', suspended: false, member_count: 5, remote_member_count: 0 }] }),
      preview('b', 'hoard2', 'already_suspended'),
    ])
    const wrapper = await mounted()
    await wrapper.find('[data-testid="signup-group-select"]').trigger('click')
    await wrapper.find('[data-testid="signup-bulk-suspend"]').trigger('click')
    await flushPromises()

    expect(calls('staff_bulk_suspend_preview')[0][1]).toEqual({ p_profile_ids: ['a', 'b'], p_suspended: true })
    expect(wrapper.find('[data-testid="bulk-affected"]').text()).toContain('hoard1')
    expect(wrapper.find('[data-testid="bulk-affected"]').text()).not.toContain('hoard2')
    expect(wrapper.find('[data-testid="bulk-skipped"]').text()).toContain('Already suspended')
    expect(wrapper.find('[data-testid="bulk-owned"]').text()).toContain('Hall')
    expect(wrapper.find('[data-testid="bulk-consequences"]').text()).toContain('3 follows')

    const confirm = wrapper.find('[data-testid="bulk-confirm"]')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-testid="bulk-reason"]').setValue('   ')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-testid="bulk-reason"]').setValue('hoarding')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(false)

    await confirm.trigger('click')
    await flushPromises()
    expect(calls('staff_bulk_set_suspended')[0][1]).toEqual({ p_profile_ids: ['a'], p_suspended: true, p_reason: 'hoarding' })
    expect(toast.success).toHaveBeenCalledWith('1 account suspended')
    expect(wrapper.find('[data-testid="signup-selection"]').exists()).toBe(false)
  })

  it('cannot confirm when the preview leaves nobody', async () => {
    answer([preview('a', 'hoard1', 'not_suspended'), preview('b', 'hoard2', 'not_suspended')])
    const wrapper = await mounted()
    await wrapper.find('[data-testid="signup-group-select"]').trigger('click')
    await wrapper.find('[data-testid="signup-bulk-unsuspend"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bulk-nothing"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="bulk-confirm"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('links an admin to the sign-up limits, and not a moderator', async () => {
    answer()
    const moderator = await mounted()
    expect(moderator.find('[data-testid="signups-limits-link"]').exists()).toBe(false)
    profile.is_admin = true
    const adminView = await mounted()
    expect(adminView.find('[data-testid="signups-limits-link"]').text()).toBe('Sign-up limits are in the Invites tab.')
  })

  it('reports a load failure', async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: 'Instance admins and moderators only' } }))
    const wrapper = await mounted()
    expect(wrapper.find('[role="alert"]').text()).toBe('This could not be loaded.')
  })
})
