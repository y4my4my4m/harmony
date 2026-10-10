/**
 * The Webhooks tab of the channel settings. A webhook's URL carries its token, which the
 * server returns only from create_channel_webhook and regenerate_channel_webhook_token; the
 * list shows the token's hint alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { supabase } from '@/supabase'
import ChannelWebhooksSection from '../ChannelWebhooksSection.vue'

const { toast, confirmMock } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  confirmMock: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    locale: ref('en'),
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock }),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))

const CHANNEL = 'c0000000-0000-4000-8000-000000000001'
const TOKEN = 'ab'.repeat(32)
const NEW_TOKEN = 'cd'.repeat(32)

function row(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    server_id: 's1',
    channel_id: CHANNEL,
    channel_name: 'ops',
    name,
    avatar_url: null,
    token_hint: 'beef',
    is_active: true,
    created_by: 'p1',
    created_by_username: 'alice',
    created_by_display_name: 'Alice',
    created_at: '2026-10-01T00:00:00Z',
    last_used_at: null,
    use_count: 0,
    ...extra,
  }
}

let rpcResults: Record<string, { data: unknown; error: unknown }>
const writeText = vi.fn()

function mountSection() {
  return mount(ChannelWebhooksSection, { props: { channelId: CHANNEL } })
}

beforeEach(() => {
  vi.clearAllMocks()
  confirmMock.mockResolvedValue(true)
  rpcResults = {
    list_channel_webhooks: { data: [row('w1', 'CI')], error: null },
    create_channel_webhook: { data: { ...row('w2', 'Deploys'), token: TOKEN }, error: null },
    regenerate_channel_webhook_token: { data: { ...row('w1', 'CI', { token_hint: 'cdcd' }), token: NEW_TOKEN }, error: null },
    delete_channel_webhook: { data: true, error: null },
  }
  vi.mocked(supabase.rpc).mockImplementation(((fn: string) =>
    Promise.resolve(rpcResults[fn] ?? { data: null, error: null })) as never)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  writeText.mockResolvedValue(undefined)
})

describe('ChannelWebhooksSection', () => {
  it('lists the channel\'s webhooks by name, creator and token hint', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect(supabase.rpc).toHaveBeenCalledWith('list_channel_webhooks', { p_channel_id: CHANNEL })
    const item = wrapper.find('[data-testid="webhook-w1"]')
    expect(item.text()).toContain('CI')
    expect(item.text()).toContain('webhooks.createdBy {"name":"Alice"}')
    expect(item.text()).toContain('webhooks.urlHint {"hint":"beef"}')
    expect(wrapper.find('[data-testid="webhook-secret"]').exists()).toBe(false)
  })

  it('shows the empty state', async () => {
    rpcResults.list_channel_webhooks = { data: [], error: null }
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="webhook-empty"]').exists()).toBe(true)
  })

  it('creates a webhook and shows its URL once', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="webhook-new"]').trigger('click')
    await wrapper.find('[data-testid="webhook-name"]').setValue('  Deploys ')
    await wrapper.find('[data-testid="webhook-form"]').trigger('submit')
    await flushPromises()

    expect(supabase.rpc).toHaveBeenCalledWith('create_channel_webhook', {
      p_channel_id: CHANNEL,
      p_name: 'Deploys',
      p_avatar_url: null,
    })
    const url = wrapper.find('[data-testid="webhook-url"]').text()
    expect(url).toMatch(new RegExp(`/webhooks/channels/w2/${TOKEN}$`))
    expect(wrapper.find('[data-testid="webhook-w2"]').text()).not.toContain(TOKEN)

    await wrapper.find('[data-testid="webhook-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(url)
  })

  it('reports a refusal by its code', async () => {
    rpcResults.create_channel_webhook = {
      data: null,
      error: { message: 'WEBHOOK_CHANNEL_ENCRYPTED: this channel is end-to-end encrypted' },
    }
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.find('[data-testid="webhook-new"]').trigger('click')
    await wrapper.find('[data-testid="webhook-form"]').trigger('submit')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('webhooks.errors.encrypted')
    expect(wrapper.find('[data-testid="webhook-secret"]').exists()).toBe(false)
  })

  it('regenerates a URL after confirmation and shows the new one', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="webhook-regenerate-w1"]').trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ dangerAction: true }))
    expect(supabase.rpc).toHaveBeenCalledWith('regenerate_channel_webhook_token', { p_id: 'w1' })
    expect(wrapper.find('[data-testid="webhook-url"]').text()).toMatch(new RegExp(`/w1/${NEW_TOKEN}$`))
    expect(wrapper.find('[data-testid="webhook-w1"]').text()).toContain('"hint":"cdcd"')
  })

  it('deletes only after confirmation', async () => {
    const wrapper = mountSection()
    await flushPromises()

    confirmMock.mockResolvedValueOnce(false)
    await wrapper.find('[data-testid="webhook-delete-w1"]').trigger('click')
    await flushPromises()
    expect(supabase.rpc).not.toHaveBeenCalledWith('delete_channel_webhook', expect.anything())

    await wrapper.find('[data-testid="webhook-delete-w1"]').trigger('click')
    await flushPromises()
    expect(supabase.rpc).toHaveBeenCalledWith('delete_channel_webhook', { p_id: 'w1' })
    expect(wrapper.find('[data-testid="webhook-w1"]').exists()).toBe(false)
  })

  it('explains a missing permission instead of listing', async () => {
    rpcResults.list_channel_webhooks = { data: null, error: { message: 'Permission denied: MANAGE_WEBHOOKS required' } }
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('webhooks.errors.permission')
  })

  it('stops offering creation at the channel cap', async () => {
    rpcResults.list_channel_webhooks = {
      data: Array.from({ length: 10 }, (_, i) => row(`w${i}`, `hook ${i}`)),
      error: null,
    }
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="webhook-new"]').attributes('disabled')).toBeDefined()
  })
})
