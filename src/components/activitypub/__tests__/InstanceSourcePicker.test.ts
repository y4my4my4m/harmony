/**
 * InstanceSourcePicker.vue: suggestion list, debounced search, keyboard picks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const service = vi.hoisted(() => ({
  getRecentInstanceDomains: vi.fn(async () => [] as string[]),
  searchInstanceDomains: vi.fn(async () => [] as string[]),
}))
vi.mock('@/services/TrendingService', () => ({ trendingService: service }))
vi.mock('@/components/common/Icon.vue', () => ({ default: { name: 'Icon', render: () => null } }))

import InstanceSourcePicker from '../InstanceSourcePicker.vue'
import { runtimeConfig } from '@/services/runtimeConfig'
import type { DomainCount } from '@/utils/instanceSourceRanking'

const ranked = (...domains: string[]): DomainCount[] => domains.map((domain, i) => ({ domain, count: 10 - i, kind: 'posts' }))

const field = () => document.body.querySelector<HTMLInputElement>('[role="combobox"]')
const values = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map(el => el.dataset.value)

async function setup(props: Record<string, unknown> = {}) {
  const wrapper = mount(InstanceSourcePicker, {
    props: { modelValue: '', label: 'Source', 'data-testid': 'src', ...props },
    attachTo: document.body,
  })
  await wrapper.find('button').trigger('click')
  await flushPromises()
  return wrapper
}

const key = async (k: string) => {
  field()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await flushPromises()
}

const type = async (text: string) => {
  const input = field()!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

describe('InstanceSourcePicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(runtimeConfig, 'domain', 'get').mockReturnValue('here.test')
    service.getRecentInstanceDomains.mockReset().mockResolvedValue([])
    service.searchInstanceDomains.mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('lists all, local, then ranked domains, filled with recent ones up to eight', async () => {
    service.getRecentInstanceDomains.mockResolvedValue(['b.test', 'here.test', 'r1.test'])
    const wrapper = await setup({ postDomains: ranked('a.test', 'b.test') })
    expect(values()).toEqual(['', 'local', 'a.test', 'b.test', 'r1.test'])
    expect(document.activeElement).toBe(field())
    wrapper.unmount()
  })

  it('asks for no recent instances when the ranking fills the list', async () => {
    const wrapper = await setup({ postDomains: ranked(...Array.from({ length: 9 }, (_, i) => `d${i}.test`)) })
    expect(service.getRecentInstanceDomains).not.toHaveBeenCalled()
    expect(values()).toHaveLength(10)
    wrapper.unmount()
  })

  it('searches 250 ms after the last keystroke and keeps only the latest answer', async () => {
    let first!: (v: string[]) => void
    service.searchInstanceDomains
      .mockImplementationOnce(() => new Promise(r => { first = r }))
      .mockResolvedValueOnce(['far.test'])
    const wrapper = await setup({ postDomains: ranked('a.test', 'fab.test') })

    await type('f')
    await type('fa')
    vi.advanceTimersByTime(249)
    expect(service.searchInstanceDomains).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(service.searchInstanceDomains).toHaveBeenCalledWith('fa', 20)
    expect(values()).toEqual(['fab.test'])

    await type('far')
    vi.advanceTimersByTime(250)
    first(['stale.test'])
    await flushPromises()
    expect(values()).toEqual(['far.test'])
    wrapper.unmount()
  })

  it('Enter picks the highlighted match; Escape closes without a change', async () => {
    service.searchInstanceDomains.mockResolvedValue(['found.test'])
    const wrapper = await setup()
    const chip = wrapper.find('button').element

    await type('found')
    vi.advanceTimersByTime(250)
    await flushPromises()
    await key('Enter')
    expect(wrapper.emitted('update:modelValue')).toEqual([['found.test']])
    expect(field()).toBeNull()
    expect(document.activeElement).toBe(chip)

    await wrapper.find('button').trigger('click')
    await flushPromises()
    await key('ArrowDown')
    await key('Escape')
    expect(field()).toBeNull()
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    expect(document.activeElement).toBe(chip)
    wrapper.unmount()
  })

  it('opens on the current value, pinned under This instance', async () => {
    const wrapper = await setup({ modelValue: 'b.test', postDomains: ranked('a.test', 'b.test') })
    expect(values()).toEqual(['', 'local', 'b.test', 'a.test'])
    const active = document.getElementById(field()!.getAttribute('aria-activedescendant')!)
    expect(active?.dataset.value).toBe('b.test')
    await key('ArrowUp')
    await key('Enter')
    expect(wrapper.emitted('update:modelValue')).toEqual([['local']])
    wrapper.unmount()
  })
})
