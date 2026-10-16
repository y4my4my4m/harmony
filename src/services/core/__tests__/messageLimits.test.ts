import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'

vi.mock('@/utils/a11y/documentTitle', () => ({ setTitleInstance: vi.fn() }))
vi.mock('@/utils/faviconBadge', () => ({ setBaseFavicon: vi.fn() }))

import { clampMessageLength, messageLimits } from '@/services/core/messageLimits'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { MESSAGE_TEXT_HARD_CEILING } from '@/utils/messageContentUtils'

const config: Array<{ config_key: string; config_value: unknown }> = []
let releaseTable: (() => void) | null = null

function configReads(): number {
  return (supabase.from as any).mock.calls.filter(([t]: [string]) => t === 'instance_config').length
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  config.length = 0
  config.push(
    { config_key: 'max_message_length', config_value: 4000 },
    { config_key: 'max_media_attachments_per_post', config_value: '5' },
  )
  releaseTable = null
  ;(supabase.from as any).mockImplementation(() => ({
    select: () => new Promise((resolve) => {
      const answer = () => resolve({ data: [...config], error: null })
      if (releaseTable === null) answer()
      else releaseTable = answer
    }),
  }))
  ;(supabase.rpc as any).mockResolvedValue({ data: { federation_enabled: true }, error: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('message limits', () => {
  it('waits for the first load and answers from the store', async () => {
    expect(await messageLimits()).toEqual({ maxLength: 4000, maxMedia: 5 })
    expect(configReads()).toBe(1)
  })

  it('answers a loaded store without a request', async () => {
    await messageLimits()
    vi.clearAllMocks()
    expect(await messageLimits()).toEqual({ maxLength: 4000, maxMedia: 5 })
    expect(configReads()).toBe(0)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('a stale store answers at once and refreshes behind the answer', async () => {
    vi.useFakeTimers()
    await messageLimits()
    config[0].config_value = 8000
    vi.advanceTimersByTime(5 * 60 * 1000)

    expect((await messageLimits()).maxLength).toBe(4000)
    expect(configReads()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect((await messageLimits()).maxLength).toBe(8000)
    expect(configReads()).toBe(2)
  })

  it('a send during the startup load joins it', async () => {
    releaseTable = () => {}
    const startup = useInstanceSettingsStore().fetchSettings()
    const send = messageLimits()
    // Both reads leave together: the federation RPC does not wait for the table.
    expect(supabase.rpc).toHaveBeenCalledWith('get_public_federation_settings')
    releaseTable!()
    await startup
    expect(await send).toEqual({ maxLength: 4000, maxMedia: 5 })
    expect(configReads()).toBe(1)
  })

  it('clamps max_message_length as enforce_message_length does', () => {
    expect(clampMessageLength(0)).toBe(2000)
    expect(clampMessageLength('300')).toBe(300)
    expect(clampMessageLength('junk')).toBe(2000)
    expect(clampMessageLength(10 ** 9)).toBe(MESSAGE_TEXT_HARD_CEILING)
  })
})
