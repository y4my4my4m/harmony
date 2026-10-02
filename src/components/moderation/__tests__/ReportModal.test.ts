import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import { waitForInitialLocale } from '@/i18n'
import ReportModal from '@/components/moderation/ReportModal.vue'

// Partial: ReportService reaches @/i18n, which calls createI18n.
vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})

// The modal submits through create_report: the forward option appears only for
// a remote account, and a message report carries what the reporter saw.

const stubs = {
  Teleport: true,
  Avatar: true,
  Icon: true,
  DisplayName: true,
}

function mountModal(props: Record<string, unknown>) {
  return mount(ReportModal, { props, global: { stubs: { ...stubs, Teleport: { template: '<div><slot /></div>' } } } })
}

const rpc = vi.mocked(supabase.rpc)

beforeAll(async () => {
  await waitForInitialLocale()
})

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: 'report-1', error: null } as never)
})

async function submit(wrapper: ReturnType<typeof mountModal>, reason = 'spam') {
  await wrapper.find(`input[type="radio"][value="${reason}"]`).setValue(true)
  await wrapper.find('.btn-submit').trigger('click')
  await flushPromises()
}

describe('ReportModal', () => {
  it('offers forwarding for a remote account and sends it', async () => {
    const wrapper = mountModal({
      reportType: 'post',
      targetUserId: 'u1',
      targetPostId: 'p1',
      targetUser: { username: 'spammer', domain: 'mastodon.social', is_local: false },
    })
    const forward = wrapper.find('.forward-option')
    expect(forward.exists()).toBe(true)
    expect(forward.text()).toContain('mastodon.social')
    await forward.find('input[type="checkbox"]').setValue(true)

    await submit(wrapper)

    expect(rpc).toHaveBeenCalledWith('create_report', expect.objectContaining({
      p_report_type: 'post',
      p_reported_post_id: 'p1',
      p_reason: 'spam',
      p_forward: true,
    }))
    expect(wrapper.find('.success-overlay').exists()).toBe(true)
  })

  it('has no forwarding option for a local account', async () => {
    const wrapper = mountModal({
      reportType: 'user',
      targetUserId: 'u2',
      targetUser: { username: 'neighbour', domain: 'harmony.test', is_local: true },
    })
    expect(wrapper.find('.forward-option').exists()).toBe(false)

    await submit(wrapper, 'harassment')

    expect(rpc).toHaveBeenCalledWith('create_report', expect.objectContaining({
      p_report_type: 'user',
      p_reported_user_id: 'u2',
      p_forward: false,
    }))
  })

  it('sends the message text the reporter saw as evidence', async () => {
    const wrapper = mountModal({
      reportType: 'message',
      targetUserId: 'u3',
      targetMessageId: 'm1',
      targetMessagePreview: 'decrypted words',
      targetUser: { username: 'someone' },
    })

    await submit(wrapper)

    expect(rpc).toHaveBeenCalledWith('create_report', expect.objectContaining({
      p_reported_message_id: 'm1',
      p_evidence_text: 'decrypted words',
    }))
  })

  it('shows why a report was refused', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PT429', message: 'Report rate limit exceeded' } } as never)
    const wrapper = mountModal({ reportType: 'user', targetUserId: 'u4', targetUser: { username: 'x' } })

    await submit(wrapper)

    expect(wrapper.find('.report-error').text()).toMatch(/too many reports/)
    expect(wrapper.find('.success-overlay').exists()).toBe(false)
  })
})
