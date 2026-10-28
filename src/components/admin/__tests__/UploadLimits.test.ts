/**
 * UploadLimitsAdmin.vue and UploadLimitDialog.vue: instance admins set the three tiers under the
 * operator's ceiling, and one account's limit or its return to the tier; moderators read both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import UploadLimitsAdmin from '../UploadLimitsAdmin.vue'
import UploadLimitDialog from '../UploadLimitDialog.vue'

enableAutoUnmount(afterEach)

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t, locale: { value: 'en' } }) }
})

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
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

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const MiB = 1048576

const TIERS = { user_mb: 50, moderator_mb: 100, admin_mb: 200, ceiling_bytes: 500 * MiB, can_edit: true }
const ACCOUNT = { override_bytes: null, tier: 'user', tier_bytes: 50 * MiB, effective_bytes: 50 * MiB, ceiling_bytes: 500 * MiB, can_edit: true }

beforeEach(() => {
  rpc.mockReset()
})

describe('UploadLimitsAdmin', () => {
  it('shows the tiers and the ceiling, and saves new tiers', async () => {
    rpc.mockImplementation(async (name: string, args?: Record<string, number>) => {
      if (name === 'admin_upload_limits') return { data: TIERS, error: null }
      if (name === 'admin_set_upload_limits') {
        return { data: { ...TIERS, user_mb: args!.p_user_mb, moderator_mb: args!.p_moderator_mb, admin_mb: args!.p_admin_mb }, error: null }
      }
      return { data: null, error: null }
    })
    const wrapper = mount(UploadLimitsAdmin)
    await flushPromises()
    expect((wrapper.get('[data-testid="upload-limit-user"]').element as HTMLInputElement).value).toBe('50')
    expect(wrapper.get('[data-testid="upload-limit-ceiling"]').text()).toBe('500 MB')

    await wrapper.get('[data-testid="upload-limit-user"]').setValue('10')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_set_upload_limits', { p_user_mb: 10, p_moderator_mb: 100, p_admin_mb: 200 })
    expect(wrapper.text()).toContain('Saved')
  })

  it('will not save a tier above the ceiling', async () => {
    rpc.mockResolvedValue({ data: TIERS, error: null })
    const wrapper = mount(UploadLimitsAdmin)
    await flushPromises()
    await wrapper.get('[data-testid="upload-limit-admin"]').setValue('600')
    expect(wrapper.text()).toContain('Above the ceiling of 500 MB')
    expect(wrapper.get('[data-testid="upload-limits-save"]').attributes('disabled')).toBeDefined()
  })

  it('is read-only for a moderator', async () => {
    rpc.mockResolvedValue({ data: { ...TIERS, can_edit: false }, error: null })
    const wrapper = mount(UploadLimitsAdmin)
    await flushPromises()
    expect(wrapper.get('[data-testid="upload-limit-user"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="upload-limits-save"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Only instance admins change upload limits.')
  })
})

describe('UploadLimitDialog', () => {
  it('sets a custom limit in MB and returns the account to its tier', async () => {
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'admin_get_upload_limit') return { data: ACCOUNT, error: null }
      if (name === 'admin_set_upload_limit') {
        const bytes = args!.p_limit_bytes as number | null
        return { data: { ...ACCOUNT, override_bytes: bytes, effective_bytes: bytes ?? ACCOUNT.tier_bytes }, error: null }
      }
      return { data: null, error: null }
    })
    const wrapper = mount(UploadLimitDialog, { props: { show: true, profileId: 'p1', name: 'Ada' } })
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_get_upload_limit', { p_profile: 'p1' })
    expect(wrapper.get('[data-testid="upload-limit-tier"]').text()).toBe('Tier: account, 50 MB')
    expect((wrapper.get('[data-testid="upload-limit-use-tier"]').element as HTMLInputElement).checked).toBe(true)

    await wrapper.get('[data-testid="upload-limit-custom"]').setValue(true)
    await wrapper.get('[data-testid="upload-limit-custom-mb"]').setValue('200')
    await wrapper.get('[data-testid="upload-limit-save"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_set_upload_limit', { p_profile: 'p1', p_limit_bytes: 200 * MiB })
    expect(wrapper.get('[data-testid="upload-limit-effective"]').text()).toBe('Largest file now: 200 MB')

    await wrapper.get('[data-testid="upload-limit-use-tier"]').setValue(true)
    await wrapper.get('[data-testid="upload-limit-save"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('admin_set_upload_limit', { p_profile: 'p1', p_limit_bytes: null })
  })

  it('refuses a custom limit above the ceiling, and is read-only for a moderator', async () => {
    rpc.mockResolvedValue({ data: ACCOUNT, error: null })
    const admin = mount(UploadLimitDialog, { props: { show: true, profileId: 'p1', name: 'Ada' } })
    await flushPromises()
    await admin.get('[data-testid="upload-limit-custom"]').setValue(true)
    await admin.get('[data-testid="upload-limit-custom-mb"]').setValue('501')
    expect(admin.get('[data-testid="upload-limit-save"]').attributes('disabled')).toBeDefined()

    rpc.mockResolvedValue({ data: { ...ACCOUNT, can_edit: false }, error: null })
    const moderator = mount(UploadLimitDialog, { props: { show: true, profileId: 'p1', name: 'Ada' } })
    await flushPromises()
    expect(moderator.find('[data-testid="upload-limit-save"]').exists()).toBe(false)
    expect(moderator.get('fieldset').attributes('disabled')).toBeDefined()
  })
})
