/**
 * RetentionCohorts.vue: one get_signup_cohorts call per period and range, newest cohort
 * first, counts behind every rate, and the loading, empty and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import en from '@/locales/en.json'
import RetentionCohorts from '../RetentionCohorts.vue'

vi.mock('vue-i18n', async () => {
  const { ref } = await import('vue')
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t, locale: ref('en-US') }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

const row = (start: string, counts: Record<string, number> = {}) => ({
  cohort_start: start,
  signups: 0, joined_server: 0, joined_other_server: 0,
  day1_eligible: 0, wrote_day1: 0, days1_7_eligible: 0, active_days1_7: 0,
  days8_30_eligible: 0, active_days8_30: 0, days31_90_eligible: 0, active_days31_90: 0,
  first_message_eligible: 0, answered_1h: 0, answered_24h: 0, has_push: 0, follows_anyone: 0,
  ...counts,
})

const MAY = row('2026-05-01', {
  signups: 66, joined_server: 53, joined_other_server: 40,
  day1_eligible: 66, wrote_day1: 50, days1_7_eligible: 66, active_days1_7: 52,
  days8_30_eligible: 66, active_days8_30: 2, days31_90_eligible: 66, active_days31_90: 0,
  first_message_eligible: 48, answered_1h: 20, answered_24h: 30, has_push: 4, follows_anyone: 9,
})
const JUNE = row('2026-06-01', { signups: 3, day1_eligible: 3, wrote_day1: 1, days1_7_eligible: 3 })
const EMPTY_JULY = row('2026-07-01')

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  rpc.mockReset()
})

describe('RetentionCohorts', () => {
  it('shows the loading state, then one row per cohort, newest first', async () => {
    const pending = deferred<any>()
    rpc.mockReturnValueOnce(pending.promise)
    const wrapper = mount(RetentionCohorts)

    expect(wrapper.text()).toContain(en.adminRetention.loading)
    expect(rpc).toHaveBeenCalledWith('get_signup_cohorts', { p_months: 12, p_period: 'month' })

    pending.resolve({ data: [MAY, JUNE, EMPTY_JULY], error: null })
    await flushPromises()

    const labels = wrapper.findAll('tbody th').map(th => th.text().replace('*', '').trim())
    expect(labels).toEqual(['Jul 2026', 'Jun 2026', 'May 2026'])
    expect(wrapper.find('tfoot th').text()).toBe(en.adminRetention.total)
  })

  it('puts the counts behind each rate in the cell title', async () => {
    rpc.mockResolvedValueOnce({ data: [MAY], error: null })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    const cells = wrapper.findAll('tbody tr')[0].findAll('td.cell')
    const wroteDay1 = cells[2]
    expect(wroteDay1.text()).toBe('76%')
    expect(wroteDay1.attributes('title')).toBe('50 of 66 (76%)')
    expect(wroteDay1.classes()).toContain('heat-4')
    expect(cells[4].text()).toBe('3%')
    expect(cells[5].text()).toBe('0%')
  })

  it('shows a dash where no account has reached the window', async () => {
    rpc.mockResolvedValueOnce({ data: [JUNE], error: null })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    const cells = wrapper.findAll('tbody tr')[0].findAll('td.cell')
    expect(cells[4].text()).toBe('—')
    expect(cells[4].attributes('title')).toBe(en.adminRetention.notReached)
    expect(cells[4].classes()).toContain('heat-none')
    expect(wrapper.find('tbody tr').classes()).toContain('small')
  })

  it('reloads by ISO week and by range', async () => {
    rpc.mockResolvedValue({ data: [MAY], error: null })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    const week = wrapper.findAll('.segment').find(b => b.text() === en.adminRetention.week)!
    await week.trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('get_signup_cohorts', { p_months: 12, p_period: 'week' })
    expect(week.attributes('aria-pressed')).toBe('true')

    rpc.mockResolvedValue({ data: [row('2026-09-28', { signups: 12 })], error: null })
    await wrapper.find('select').setValue('3')
    await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('get_signup_cohorts', { p_months: 3, p_period: 'week' })
    expect(wrapper.find('tbody th').text()).toBe('Week of Sep 28, 2026')
  })

  it('shows the empty state when no cohort has a signup', async () => {
    rpc.mockResolvedValueOnce({ data: [EMPTY_JULY], error: null })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.text()).toContain(en.adminRetention.emptyTitle)
  })

  it('shows the error and retries', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Permission denied: instance admin required' } })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    expect(wrapper.text()).toContain(en.adminRetention.loadFailed)
    expect(wrapper.text()).toContain('Permission denied: instance admin required')

    rpc.mockResolvedValueOnce({ data: [MAY], error: null })
    await wrapper.find('.list-empty__button').trigger('click')
    await flushPromises()
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('explains every column', async () => {
    rpc.mockResolvedValueOnce({ data: [MAY], error: null })
    const wrapper = mount(RetentionCohorts)
    await flushPromises()

    const terms = wrapper.findAll('.metric-legend dt').map(dt => dt.text())
    expect(terms).toHaveLength(Object.keys(en.adminRetention.help).length)
    expect(terms).toContain(en.adminRetention.columns.answered1h)
  })
})
