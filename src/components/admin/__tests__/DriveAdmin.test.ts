/**
 * DriveAdmin.vue, storage by account: pages admin_drive_usage 50 at a time with its total_count,
 * searches from the first page, renders names through DisplayName and offers Copy user ID.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import DriveAdmin from '../DriveAdmin.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message
      .replace(/\{'@'\}/g, '@')
      .replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { ...actual, useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/components/common/ToggleSwitch.vue', () => stub('ToggleSwitch'))
vi.mock('@/components/DisplayName.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'DisplayName',
      props: { userId: String, fallback: String, truncate: Boolean },
      render() {
        return h('span', { class: 'display-name-stub', 'data-user-id': this.userId }, this.fallback)
      },
    }),
  }
})

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const ensureUsersLoaded = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/services/userDataService', () => ({ userDataService: { ensureUsersLoaded } }))

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const from = supabase.from as unknown as ReturnType<typeof vi.fn>

const TOTAL = 120

function usageRow(n: number, total = TOTAL) {
  return {
    profile_id: `p-${n}`,
    username: `user${n}`,
    display_name: n === 1 ? 'Ann :blob:' : null,
    used_bytes: 1000 - n,
    quota_bytes: 1048576,
    ephemeral_bytes: 0,
    file_count: 1,
    quota_override: null,
    total_count: total,
  }
}

function page(offset: number, limit: number, total = TOTAL) {
  const rows = []
  for (let n = offset + 1; n <= Math.min(offset + limit, total); n++) rows.push(usageRow(n, total))
  return rows
}

let usageImpl: (args: Record<string, unknown>) => unknown[]

const usageCalls = () => rpc.mock.calls.filter(([fn]) => fn === 'admin_drive_usage').map(([, args]) => args)

beforeEach(() => {
  rpc.mockReset()
  ensureUsersLoaded.mockClear()
  usageImpl = (args) => page(args.p_offset as number, args.p_limit as number)
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'admin_drive_usage') return { data: usageImpl(args), error: null }
    return { data: null, error: null }
  })
  const query: Record<string, any> = {}
  query.select = () => query
  query.in = async () => ({ data: [], error: null })
  query.order = async () => ({ data: [], error: null })
  from.mockReturnValue(query)
})

afterEach(() => {
  vi.useRealTimers()
})

async function render() {
  const w = mount(DriveAdmin)
  await flushPromises()
  return w
}

const rows = (w: Awaited<ReturnType<typeof render>>) => w.findAll('[data-testid="drive-admin-usage-row"]')

describe('DriveAdmin storage by account', () => {
  it('loads the first page with an exact total and renders names through DisplayName', async () => {
    const w = await render()
    expect(usageCalls()).toEqual([{ p_search: null, p_limit: 50, p_offset: 0 }])
    expect(rows(w)).toHaveLength(50)
    const first = rows(w)[0]
    expect(first.get('.display-name-stub').attributes('data-user-id')).toBe('p-1')
    expect(first.get('.display-name-stub').text()).toBe('Ann :blob:')
    expect(first.get('button[data-copy-id]').attributes('aria-label')).toBe('Copy user ID: @user1')
    expect(first.get('button[data-copy-id]').attributes('data-copy-id')).toBe('p-1')
    expect(w.get('[data-testid="drive-admin-range"]').text()).toBe('1–50 of 120')
    expect(ensureUsersLoaded).toHaveBeenCalledWith(page(0, 50).map((r) => r.profile_id))
  })

  it('pages forward to the last page and back', async () => {
    const w = await render()
    await w.get('[data-testid="drive-admin-next"]').trigger('click')
    await flushPromises()
    expect(usageCalls().at(-1)).toEqual({ p_search: null, p_limit: 50, p_offset: 50 })
    expect(rows(w)[0].attributes('data-profile-id')).toBe('p-51')

    await w.get('[data-testid="drive-admin-next"]').trigger('click')
    await flushPromises()
    expect(rows(w)).toHaveLength(20)
    expect(rows(w).at(-1)!.attributes('data-profile-id')).toBe('p-120')
    expect(w.get('[data-testid="drive-admin-range"]').text()).toBe('101–120 of 120')
    expect(w.get('[data-testid="drive-admin-next"]').attributes('disabled')).toBeDefined()

    await w.get('[data-testid="drive-admin-prev"]').trigger('click')
    await flushPromises()
    expect(usageCalls().at(-1)).toMatchObject({ p_offset: 50 })
  })

  it('debounces search into one request from the first page', async () => {
    const w = await render()
    await w.get('[data-testid="drive-admin-next"]').trigger('click')
    await flushPromises()
    vi.useFakeTimers()
    usageImpl = (args) => page(args.p_offset as number, args.p_limit as number, 60)
    const input = w.get('[data-testid="drive-admin-search"]')
    await input.setValue('@us')
    await input.setValue('@user')
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await flushPromises()
    expect(usageCalls().slice(2)).toEqual([{ p_search: '@user', p_limit: 50, p_offset: 0 }])
    expect(w.get('[data-testid="drive-admin-range"]').text()).toBe('1–50 of 60')
  })

  it('steps back to the last page when the requested one is past the end', async () => {
    const w = await render()
    await w.get('[data-testid="drive-admin-next"]').trigger('click')
    await flushPromises()
    usageImpl = (args) => page(args.p_offset as number, args.p_limit as number, 40)
    await w.get('[data-testid="drive-admin-next"]').trigger('click')
    await flushPromises()
    expect(usageCalls().slice(-3).map((a) => a.p_offset)).toEqual([100, 50, 0])
    expect(rows(w)).toHaveLength(40)
  })

  it('says no account matches a search with no rows', async () => {
    usageImpl = () => []
    const w = await render()
    expect(w.get('[data-testid="drive-admin-usage-empty"]').text()).toBe('No account stores files yet.')
    vi.useFakeTimers()
    await w.get('[data-testid="drive-admin-search"]').setValue('nobody')
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await flushPromises()
    expect(w.get('[data-testid="drive-admin-usage-empty"]').text()).toBe('No account matches.')
    expect(w.find('[data-testid="drive-admin-range"]').exists()).toBe(false)
  })
})
