/**
 * VoiceIceSettings.vue: the instance's STUN and TURN servers for peer-to-peer calls. URLs of the
 * wrong scheme and TURN servers without credentials are refused before anything is written; only
 * changed keys and an entered secret are saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const setInstanceConfigs = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const rows = vi.hoisted(() => ({ value: [] as Array<{ config_key: string; config_value: unknown }> }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params?.url ? `${key}:${params.url}` : key),
    locale: { value: 'en' },
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-1' } } }) }))
vi.mock('@/services/AdminService', () => ({ adminService: { setInstanceConfigs } }))
vi.mock('@/supabase', () => {
  const query: any = { select: () => query, in: async () => ({ data: rows.value, error: null }) }
  return { supabase: { from: () => query } }
})

import VoiceIceSettings from '@/components/admin/VoiceIceSettings.vue'

let wrapper: VueWrapper | null = null
const q = (id: string) => wrapper!.get(`[data-testid="${id}"]`)

async function mountCard() {
  wrapper = mount(VoiceIceSettings, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  setInstanceConfigs.mockClear()
  rows.value = [
    { config_key: 'voice_stun_urls', config_value: 'default' },
    { config_key: 'voice_turn_urls', config_value: [] },
    { config_key: 'voice_turn_auth', config_value: 'secret' },
    { config_key: 'voice_turn_username', config_value: '' },
    { config_key: 'voice_turn_secret', config_value: '' },
  ]
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('VoiceIceSettings', () => {
  it('starts on the default STUN servers with nothing to save', async () => {
    await mountCard()
    expect((q('voice-ice-stun-default').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper!.find('[data-testid="voice-ice-stun-urls"]').exists()).toBe(false)
    expect(q('voice-ice-save').attributes('disabled')).toBeDefined()
  })

  it('saves own STUN servers and a coturn shared secret, only what changed', async () => {
    await mountCard()
    await q('voice-ice-stun-default').setValue(false)
    await q('voice-ice-stun-urls').setValue('stun:turn.example.org:3478\n')
    await q('voice-ice-turn-urls').setValue('turn:turn.example.org:3478\nturns:turn.example.org:5349')
    await q('voice-ice-secret').setValue(' s3cret ')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    expect(setInstanceConfigs).toHaveBeenCalledWith({
      voice_stun_urls: ['stun:turn.example.org:3478'],
      voice_turn_urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'],
      voice_turn_secret: 's3cret',
    }, 'admin-1')
    expect(q('voice-ice-secret').attributes('placeholder')).toBe('adminVoiceIce.secretKept')
  })

  it('refuses a URL of the wrong scheme', async () => {
    await mountCard()
    await q('voice-ice-turn-urls').setValue('stun:turn.example.org:3478')
    await q('voice-ice-secret').setValue('s3cret')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(setInstanceConfigs).not.toHaveBeenCalled()
    expect(q('voice-ice-error').text()).toBe('adminVoiceIce.invalidTurn:stun:turn.example.org:3478')
  })

  it('refuses TURN servers without credentials', async () => {
    await mountCard()
    await q('voice-ice-turn-urls').setValue('turn:turn.example.org:3478')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(q('voice-ice-error').text()).toBe('adminVoiceIce.needsSecret')

    await q('voice-ice-auth-password').setValue(true)
    await q('voice-ice-secret').setValue('pw')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(q('voice-ice-error').text()).toBe('adminVoiceIce.needsUsername')
    expect(setInstanceConfigs).not.toHaveBeenCalled()
  })

  it('back to the default STUN servers writes "default"', async () => {
    rows.value[0] = { config_key: 'voice_stun_urls', config_value: [] }
    await mountCard()
    expect((q('voice-ice-stun-default').element as HTMLInputElement).checked).toBe(false)
    await q('voice-ice-stun-default').setValue(true)
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(setInstanceConfigs).toHaveBeenCalledWith({ voice_stun_urls: 'default' }, 'admin-1')
  })
})
