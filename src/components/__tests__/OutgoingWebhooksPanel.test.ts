/**
 * The outgoing webhooks panel of a bot or a server (migration 20261028600001): the secret shows
 * once after create and rotate and never stays in the list; switching off, the test event and the
 * delivery log go through their RPCs; RPC errors read by their stable code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import en from '@/locales/en.json'

function t(key: string, params: Record<string, unknown> = {}): string {
  const message = key.split('.').reduce<any>((node, part) => node?.[part], en)
  return typeof message === 'string' ? message.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : key
}

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t, locale: { value: 'en' } }),
}))
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'Icon', render: () => h('span') }) }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
const confirm = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))

const { default: OutgoingWebhooksPanel } = await import('../OutgoingWebhooksPanel.vue')

const WEBHOOK = {
  id: 'w1', bot_id: 'b1', server_id: null, name: 'Deploys', url: 'https://hooks.example/deploys',
  events: ['MESSAGE_CREATE'], secret_hint: 'AbC=', is_active: true, disabled_reason: null, failing_since: null,
  verified_at: '2026-10-24T00:00:01Z', paused: false, dropped_events: 0, last_dropped_at: null, last_drop_reason: null,
  last_success_at: null, last_failure_at: null, last_status: null, last_error: null, created_at: '2026-10-24T00:00:00Z',
}

let webhooks: any[]
let availability: any
beforeEach(() => {
  vi.clearAllMocks()
  webhooks = [WEBHOOK]
  availability = { outgoing_mode: 'everyone', incoming_enabled: true, can_create_outgoing: true, per_user: 10 }
  rpc.mockImplementation(async (fn: string, args: any) => {
    switch (fn) {
      case 'webhook_availability': return { data: availability, error: null }
      case 'list_outgoing_webhooks': return { data: webhooks, error: null }
      case 'create_outgoing_webhook':
        return { data: { ...WEBHOOK, id: 'w2', name: args.p_name, url: args.p_url, events: args.p_events, verified_at: null, secret: 'whsec_NEWSECRET' }, error: null }
      case 'rotate_outgoing_webhook_secret': return { data: { ...WEBHOOK, secret: 'whsec_ROTATED', secret_hint: 'TED' }, error: null }
      case 'update_outgoing_webhook': return { data: { ...WEBHOOK, is_active: args.p_active ?? true, disabled_reason: args.p_active === false ? 'owner' : null }, error: null }
      case 'test_outgoing_webhook': return { data: 'd1', error: null }
      case 'list_outgoing_webhook_deliveries':
        return { data: [{ id: 'd1', event: 'PING', status: 'delivered', attempts: 1, last_status: 204, last_error: null, created_at: '2026-10-24T00:00:00Z', delivered_at: '2026-10-24T00:00:01Z', next_attempt_at: null }], error: null }
      case 'delete_outgoing_webhook': return { data: null, error: null }
      default: throw new Error(`unexpected rpc ${fn}`)
    }
  })
})

async function mountPanel(props: Record<string, string> = { botId: 'b1' }) {
  const wrapper = mount(OutgoingWebhooksPanel, { props, global: { mocks: { $t: t } } })
  await flushPromises()
  return wrapper
}

describe('OutgoingWebhooksPanel', () => {
  it('lists the bot\'s webhooks by its id', async () => {
    const wrapper = await mountPanel()
    expect(rpc).toHaveBeenCalledWith('list_outgoing_webhooks', { p_bot_id: 'b1', p_server_id: null })
    expect(wrapper.get('[data-testid="outgoing-webhook-w1"]').text()).toContain('Deploys')
    expect(wrapper.text()).toContain('Secret ends in AbC=')
  })

  it('shows a new webhook\'s secret once, and keeps it out of the list', async () => {
    const wrapper = await mountPanel({ serverId: 's1' })
    await wrapper.get('[data-testid="outgoing-webhook-new"]').trigger('click')
    await wrapper.get('[data-testid="outgoing-webhook-url"]').setValue('https://hooks.example/new')
    await wrapper.get('[data-testid="outgoing-webhook-event-SERVER_BAN_ADD"]').setValue(true)
    await wrapper.get('[data-testid="outgoing-webhook-form"]').trigger('submit')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('create_outgoing_webhook', expect.objectContaining({
      p_bot_id: null, p_server_id: 's1', p_url: 'https://hooks.example/new', p_events: ['MESSAGE_CREATE', 'SERVER_BAN_ADD'],
    }))
    expect(wrapper.get('[data-testid="outgoing-webhook-secret-value"]').text()).toBe('whsec_NEWSECRET')
    expect(wrapper.get('[data-testid="outgoing-webhook-w2"]').text()).not.toContain('whsec_')
  })

  it('rotates after asking, and shows the new secret', async () => {
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="outgoing-webhook-rotate-w1"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rotate the secret?', dangerAction: true }))
    expect(wrapper.get('[data-testid="outgoing-webhook-secret-value"]').text()).toBe('whsec_ROTATED')
  })

  it('switches a webhook off, queues a test event and shows the delivery log', async () => {
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="outgoing-webhook-test-w1"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('test_outgoing_webhook', { p_webhook_id: 'w1' })
    expect(wrapper.get('[data-testid="outgoing-webhook-deliveries-w1"]').text()).toContain('PING')
    expect(wrapper.get('[data-testid="outgoing-webhook-deliveries-w1"]').text()).toContain('Delivered')

    await wrapper.get('[data-testid="outgoing-webhook-active-w1"]').setValue(false)
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('update_outgoing_webhook', expect.objectContaining({ p_webhook_id: 'w1', p_active: false }))
    expect(wrapper.get('[data-testid="outgoing-webhook-w1"] [data-testid="outgoing-webhook-state"]').text()).toBe('Off')
  })

  it('reads a webhook turned off for failing, with its last answer', async () => {
    webhooks = [{ ...WEBHOOK, is_active: false, disabled_reason: 'failing', last_error: 'HTTP 502' }]
    const wrapper = await mountPanel()
    expect(wrapper.get('[data-testid="outgoing-webhook-state"]').text())
      .toBe('Turned off after three days of failed deliveries. Last answer: HTTP 502')
  })

  it('reads a new webhook as waiting for its test event, a paused one, one staff turned off, and skipped events', async () => {
    webhooks = [
      { ...WEBHOOK, id: 'a', verified_at: null },
      { ...WEBHOOK, id: 'b', paused: true, last_error: 'HTTP 500', dropped_events: 4, last_drop_reason: 'paused', last_dropped_at: '2026-10-24T01:00:00Z' },
      { ...WEBHOOK, id: 'c', is_active: false, disabled_reason: 'staff' },
    ]
    const wrapper = await mountPanel()
    expect(wrapper.get('[data-testid="outgoing-webhook-a"] [data-testid="outgoing-webhook-state"]').text())
      .toBe('Waiting for a 2xx answer to the test event before events are sent')
    expect(wrapper.get('[data-testid="outgoing-webhook-b"] [data-testid="outgoing-webhook-state"]').text()).toContain('Paused after 10 failed attempts')
    expect(wrapper.get('[data-testid="outgoing-webhook-b"] [data-testid="outgoing-webhook-dropped"]').text()).toContain('4 events skipped (while paused)')
    expect(wrapper.get('[data-testid="outgoing-webhook-c"] [data-testid="outgoing-webhook-state"]').text()).toBe('Turned off by this instance\'s staff')
    expect((wrapper.get('[data-testid="outgoing-webhook-active-c"]').element as HTMLInputElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('offers no new webhook where the instance does not let the viewer create one', async () => {
    availability = { outgoing_mode: 'staff', incoming_enabled: true, can_create_outgoing: false, per_user: 10 }
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="outgoing-webhook-new"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="outgoing-webhook-unavailable"]').text()).toBe('On this instance, only its staff create outgoing webhooks.')
  })

  it('names a refused URL by the RPC\'s code', async () => {
    rpc.mockImplementation(async (fn: string) => fn === 'list_outgoing_webhooks'
      ? { data: [], error: null }
      : fn === 'webhook_availability'
        ? { data: availability, error: null }
        : { data: null, error: { message: 'OUTGOING_WEBHOOK_INVALID_URL: an https URL of at most 2048 characters' } })
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="outgoing-webhook-new"]').trigger('click')
    await wrapper.get('[data-testid="outgoing-webhook-url"]').setValue('http://example.com')
    await wrapper.get('[data-testid="outgoing-webhook-form"]').trigger('submit')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Use an https URL of at most 2048 characters.')
  })
})
