import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

// The transfers indicator lists running, failed and just-finished transfers after the show
// delay, with Cancel while running, Dismiss once failed, and Reconnecting while a dropped
// connection is retried.

vi.mock('@/composables/useT', () => ({
  useT: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}` }),
}))

import TransfersIndicator from '@/components/common/TransfersIndicator.vue'
import {
  TRANSFER_SHOW_DELAY_MS,
  registerTransfer,
  resetTransfers,
  settleTransfer,
  transfers,
  type TransferProgress,
} from '@/services/transfers'

const progress = (loaded: number, total: number): TransferProgress =>
  reactive({ loaded, total, status: 'running', error: null, reconnecting: false })

beforeEach(() => {
  vi.useFakeTimers()
  resetTransfers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TransfersIndicator', () => {
  it('shows a transfer once it has run past the show delay, with its progress and Cancel', async () => {
    const cancel = vi.fn()
    const p = progress(25, 100)
    registerTransfer({ id: 'a', direction: 'upload', name: 'clip.mp4', progress: p, cancel })
    const wrapper = mount(TransfersIndicator)
    expect(wrapper.find('[data-testid="transfers-indicator"]').exists()).toBe(false)

    vi.advanceTimersByTime(TRANSFER_SHOW_DELAY_MS)
    await flushPromises()
    const item = wrapper.get('[data-testid="transfer-item"]')
    expect(item.text()).toContain('clip.mp4')
    expect(item.text()).toContain('25%')
    expect(item.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25')
    expect(wrapper.text()).toContain('transfers.uploading{"count":1}')

    p.reconnecting = true
    await flushPromises()
    expect(item.find('[data-testid="transfer-reconnecting"]').exists()).toBe(true)

    await item.get('[data-testid="transfer-cancel"]').trigger('click')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('never shows a transfer that finishes within the delay', async () => {
    const p = progress(0, 10)
    const entry = registerTransfer({ id: 'b', direction: 'download', name: 'a.zip', progress: p })
    const wrapper = mount(TransfersIndicator)
    p.status = 'completed'
    settleTransfer(entry)
    vi.advanceTimersByTime(TRANSFER_SHOW_DELAY_MS)
    await flushPromises()
    expect(wrapper.find('[data-testid="transfers-indicator"]').exists()).toBe(false)
    expect(transfers()).toHaveLength(0)
  })

  it('keeps a failed transfer with its reason until dismissed', async () => {
    const p = progress(5, 10)
    const entry = registerTransfer({ id: 'c', direction: 'upload', name: 'b.png', progress: p })
    const wrapper = mount(TransfersIndicator)
    p.status = 'error'
    p.error = 'Upload stalled'
    settleTransfer(entry)
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    const item = wrapper.get('[data-testid="transfer-item"]')
    expect(item.attributes('data-status')).toBe('error')
    expect(item.get('[role="alert"]').text()).toBe('Upload stalled')
    await item.get('[data-testid="transfer-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="transfers-indicator"]').exists()).toBe(false)
  })
})
