import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import SoundboardPopover from '../SoundboardPopover.vue'
import { DEFAULT_SOUNDS } from '@/services/soundboard/sounds'

const SERVER = '55555555-0000-0000-0000-000000000005'
const horn = {
  id: 'b1160000-0000-0000-0000-000000000001', serverId: SERVER, name: 'Horn', emoji: '📯', volume: 1,
  durationMs: 1200, url: 'https://cdn.test/horn.ogg',
}

const h = vi.hoisted(() => ({ store: null as any, voice: null as any, muted: false }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params?.name ? `${key}:${params.name}` : key) }),
}))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/stores/soundboard', () => ({ useSoundboardStore: () => h.store }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.voice }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [{ id: SERVER, name: 'Book Club' }] }) }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: { getAll: () => ({ soundboardMuted: h.muted }) } }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

function mountPopover() {
  return mount(SoundboardPopover, {
    props: { visible: true, anchor: { left: 100, top: 500, width: 40, height: 40 } },
    global: { stubs: { teleport: true } },
  })
}

beforeEach(() => {
  h.muted = false
  h.voice = reactive({ localState: { isDeafened: false } })
  h.store = reactive({
    permitted: true,
    cooldownUntil: 0,
    soundsByServer: { [SERVER]: [horn] },
    currentChannel: () => ({ serverId: SERVER, channelId: 'c', selfId: 'me' }),
    play: vi.fn(() => true),
    preview: vi.fn(),
    refreshPermission: vi.fn(async () => true),
    loadServerSounds: vi.fn(async () => [horn]),
  })
})

describe('SoundboardPopover', () => {
  it('lists the server\'s sounds under its name, then the built-in ones', async () => {
    const wrapper = mountPopover()
    await flushPromises()
    expect(wrapper.findAll('.sbp-section-title').map((n) => n.text())).toEqual(['Book Club', 'soundboard.defaultSounds'])
    const tiles = wrapper.findAll('[data-testid="soundboard-tile"]')
    expect(tiles).toHaveLength(1 + DEFAULT_SOUNDS.length)
    expect(tiles[0].text()).toContain('Horn')
    expect(tiles[1].text()).toContain('soundboard.defaults.ding')
    expect(h.store.loadServerSounds).toHaveBeenCalledWith(SERVER, true)
  })

  it('plays a sound for everyone on click, and previews it locally', async () => {
    const wrapper = mountPopover()
    await flushPromises()
    await wrapper.find('[data-testid="soundboard-tile"]').trigger('click')
    expect(h.store.play).toHaveBeenCalledWith(horn)
    await wrapper.find('.sbp-preview').trigger('click')
    expect(h.store.preview).toHaveBeenCalledWith(horn)
  })

  it('disables the tiles while deafened', async () => {
    h.voice.localState.isDeafened = true
    const wrapper = mountPopover()
    await flushPromises()
    expect(wrapper.find('.sbp-note').text()).toBe('soundboard.deafenedNote')
    expect(wrapper.findAll('[data-testid="soundboard-tile"]').every((t) => t.attributes('disabled') !== undefined)).toBe(true)
  })

  it('disables the tiles during the cooldown', async () => {
    h.store.cooldownUntil = Date.now() + 2000
    const wrapper = mountPopover()
    await flushPromises()
    expect(wrapper.find('[data-testid="soundboard-tile"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.sbp-cooldown').classes()).toContain('active')
  })

  it('says so when the listener muted the soundboard', async () => {
    h.muted = true
    const wrapper = mountPopover()
    await flushPromises()
    expect(wrapper.find('.sbp-note').text()).toBe('soundboard.mutedNote')
  })

  it('shows an empty server section', async () => {
    h.store.soundsByServer = { [SERVER]: [] }
    h.store.loadServerSounds = vi.fn(async () => [])
    const wrapper = mountPopover()
    await flushPromises()
    expect(wrapper.find('.sbp-empty').text()).toBe('soundboard.emptyServer')
  })

  it('closes on Escape', async () => {
    const wrapper = mountPopover()
    await flushPromises()
    await wrapper.find('.sbp').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
