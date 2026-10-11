import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'

// Spatial positions without a pointer: each participant is a focusable button
// in a labelled application region; arrow keys move it (Shift farther), the
// audio follows, and the new distance is announced.

const h = vi.hoisted(() => ({
  spatial: null as any,
  update: vi.fn(),
  polite: vi.fn(),
}))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => h.spatial }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({
  useUnifiedVoiceChannelStore: () => ({
    allParticipants: [
      { userId: 'me', isSpeaking: false, audioLevel: 0, isMuted: false },
      { userId: 'bob', isSpeaking: false, audioLevel: 0, isMuted: false },
    ],
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUserProfile: (id: string) => ({ value: { display_name: id === 'me' ? 'Me' : 'Bob' } }),
    ensureProfilesAvailable: vi.fn(async () => undefined),
  }),
}))
vi.mock('@/services/spatialAudio', () => ({
  spatialAudioService: { updateSpatialEffects: h.update, enableSpatialAudio: vi.fn(), disableSpatialAudio: vi.fn(), updateSettings: vi.fn() },
}))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite: h.polite, assertive: vi.fn(), announce: vi.fn() }) }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('../../common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))

import SpatialAudioPanel from '../SpatialAudioPanel.vue'

function makeSpatial() {
  const positions = new Map<string, { x: number; y: number }>([
    ['me', { x: 300, y: 200 }],
    ['bob', { x: 100, y: 200 }],
  ])
  const store = reactive({
    isPanelVisible: true,
    isDragging: false,
    draggedUserId: null as string | null,
    dragOffset: { x: 0, y: 0 },
    settings: { enabled: true, maxDistance: 300, rolloffFactor: 1, distanceModel: 'linear', panningModel: 'HRTF', enableReverb: false, roomSize: 1 },
    userPositions: positions,
    getUserPosition: (id: string) => store.userPositions.get(id) ?? null,
    initializeUserPosition: vi.fn(),
    removeUserPosition: vi.fn(),
    setUserPosition: vi.fn((id: string, x: number, y: number) => { store.userPositions.set(id, { x, y }) }),
    getDistanceBetween: (a: string, b: string) => {
      const pa = store.userPositions.get(a)!
      const pb = store.userPositions.get(b)!
      return Math.hypot(pa.x - pb.x, pa.y - pb.y)
    },
    setPanelSize: vi.fn(),
    updateSettings: vi.fn(),
    toggleSpatialAudio: vi.fn(),
    hidePanel: vi.fn(),
    togglePanel: vi.fn(),
    startDrag: vi.fn(),
    endDrag: vi.fn(),
  })
  return store
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('SpatialAudioPanel keyboard positioning', () => {
  it('exposes a labelled region of named participant buttons with instructions', async () => {
    h.spatial = makeSpatial()
    wrapper = mount(SpatialAudioPanel, { attachTo: document.body })
    await flushPromises()
    const grid = wrapper.find('.spatial-grid')
    expect(grid.attributes('role')).toBe('application')
    expect(grid.attributes('aria-label')).toBe('voice.spatialPositions')
    expect(document.getElementById(grid.attributes('aria-describedby')!)?.textContent).toBe('voice.spatialInstructions')
    const bob = wrapper.find('[data-testid="spatial-avatar-bob"]')
    expect(bob.attributes('role')).toBe('button')
    expect(bob.attributes('tabindex')).toBe('0')
    expect(bob.attributes('aria-label')).toBe('voice.spatialDistanceLabel')
  })

  it('moves the focused participant with arrow keys, farther with Shift, and updates the audio', async () => {
    h.spatial = makeSpatial()
    h.update.mockClear()
    h.polite.mockClear()
    wrapper = mount(SpatialAudioPanel, { attachTo: document.body })
    await flushPromises()
    const bob = wrapper.find('[data-testid="spatial-avatar-bob"]')

    await bob.trigger('keydown', { key: 'ArrowRight' })
    expect(h.spatial.setUserPosition).toHaveBeenLastCalledWith('bob', 110, 200)
    await bob.trigger('keydown', { key: 'ArrowUp', shiftKey: true })
    expect(h.spatial.setUserPosition).toHaveBeenLastCalledWith('bob', 110, 160)
    expect(h.update).toHaveBeenCalledTimes(2)
    expect(h.polite).toHaveBeenLastCalledWith('voice.spatialDistanceLabel', { key: 'spatial:bob', dedupeMs: 0 })
  })

  it('keeps the participant inside the grid edge', async () => {
    h.spatial = makeSpatial()
    h.spatial.userPositions.set('bob', { x: 21, y: 200 })
    wrapper = mount(SpatialAudioPanel, { attachTo: document.body })
    await flushPromises()
    await wrapper.find('[data-testid="spatial-avatar-bob"]').trigger('keydown', { key: 'ArrowLeft', shiftKey: true })
    expect(h.spatial.setUserPosition).toHaveBeenLastCalledWith('bob', 20, 200)
  })
})
