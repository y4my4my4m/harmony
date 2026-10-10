import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ServerSoundboardManagement from '../ServerSoundboardManagement.vue'

const SERVER = '55555555-0000-0000-0000-000000000005'
const sound = (id: string, name: string) => ({
  id, serverId: SERVER, name, emoji: '📯', volume: 0.8, durationMs: 2100,
  url: `https://cdn.test/${id}.ogg`, storagePath: `${SERVER}/${id}.ogg`,
})

const h = vi.hoisted(() => ({
  list: vi.fn(),
  check: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: { success: vi.fn(), error: vi.fn() },
  setServerSounds: vi.fn(),
  play: vi.fn(),
  getSharing: vi.fn(),
  setSharing: vi.fn(),
}))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }))
vi.mock('@/stores/soundboard', () => ({ useSoundboardStore: () => ({ setServerSounds: h.setServerSounds }) }))
vi.mock('@/services/soundboard/player', () => ({ soundboardPlayer: { play: h.play } }))
vi.mock('@/services/soundboard/sounds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/soundboard/sounds')>()),
  listServerSounds: h.list,
  checkSoundFile: h.check,
  createServerSound: h.create,
  updateServerSound: h.update,
  deleteServerSound: h.remove,
  getServerSoundSharing: h.getSharing,
  setServerSoundSharing: h.setSharing,
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: () => {} }) }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

async function mountManager(canManage: boolean) {
  const wrapper = mount(ServerSoundboardManagement, { props: { serverId: SERVER, canManage } })
  await flushPromises()
  return wrapper
}

async function pickFile(wrapper: VueWrapper, file: File) {
  const input = wrapper.find('[data-testid="soundboard-file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  for (const fn of [h.list, h.check, h.create, h.update, h.remove, h.setServerSounds, h.play, h.toast.success, h.toast.error,
    h.getSharing, h.setSharing]) {
    fn.mockReset()
  }
  h.getSharing.mockResolvedValue(true)
  h.setSharing.mockImplementation(async (_server: string, allow: boolean) => allow)
  h.confirm.mockReset()
  h.confirm.mockResolvedValue(true)
  h.list.mockResolvedValue([sound('a', 'Horn'), sound('b', 'Bell')])
})

describe('ServerSoundboardManagement', () => {
  it('lists the server\'s sounds read-only for members', async () => {
    const wrapper = await mountManager(false)
    expect(wrapper.findAll('[data-testid="soundboard-row"]').map((r) => r.find('.sound-name').text())).toEqual(['Horn', 'Bell'])
    expect(wrapper.find('[data-testid="soundboard-upload"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="soundboard-edit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="soundboard-delete"]').exists()).toBe(false)
    expect(h.setServerSounds).toHaveBeenCalledWith(SERVER, expect.any(Array))
  })

  it('refuses a file the check rejects', async () => {
    h.check.mockResolvedValue({ ok: false, problem: 'tooLong' })
    const wrapper = await mountManager(true)
    await pickFile(wrapper, new File(['x'], 'long.mp3', { type: 'audio/mpeg' }))
    expect(wrapper.find('[data-testid="soundboard-file-error"]').text()).toContain('soundboard.errors.tooLong')
    expect(wrapper.find('[data-testid="soundboard-name"]').exists()).toBe(false)
  })

  it('uploads a checked file with its name, emoji and volume', async () => {
    const checked = { type: { mime: 'audio/mpeg', ext: 'mp3' }, durationMs: 1800 }
    h.check.mockResolvedValue({ ok: true, file: checked })
    h.create.mockResolvedValue(sound('c', 'Air horn'))
    const wrapper = await mountManager(true)
    const file = new File(['ID3'], 'air_horn.mp3', { type: 'audio/mpeg' })
    await pickFile(wrapper, file)

    const name = wrapper.find('[data-testid="soundboard-name"]')
    expect((name.element as HTMLInputElement).value).toBe('air horn')
    await name.setValue('Air horn')
    await wrapper.find('[data-testid="soundboard-upload-submit"]').trigger('click')
    await flushPromises()

    expect(h.create).toHaveBeenCalledWith(SERVER, file, checked, { name: 'Air horn', emoji: '', volume: 1 })
    expect(wrapper.findAll('[data-testid="soundboard-row"]')).toHaveLength(3)
    expect(h.toast.success).toHaveBeenCalled()
  })

  it('reports a refused upload', async () => {
    h.check.mockResolvedValue({ ok: true, file: { type: { mime: 'audio/mpeg', ext: 'mp3' }, durationMs: 1800 } })
    h.create.mockRejectedValue({ code: '23514', message: 'SOUNDBOARD_FULL: a server holds at most 48 sounds' })
    const wrapper = await mountManager(true)
    await pickFile(wrapper, new File(['ID3'], 'x.mp3'))
    await wrapper.find('[data-testid="soundboard-upload-submit"]').trigger('click')
    await flushPromises()
    expect(h.toast.error.mock.calls[0][0]).toContain('soundboard.errors.full')
  })

  it('renames a sound', async () => {
    h.update.mockResolvedValue({ ...sound('a', 'Big horn'), volume: 0.8 })
    const wrapper = await mountManager(true)
    await wrapper.find('[data-testid="soundboard-edit"]').trigger('click')
    await wrapper.find('[data-testid="soundboard-edit-name"]').setValue('Big horn')
    await wrapper.find('[data-testid="soundboard-edit-save"]').trigger('click')
    await flushPromises()
    expect(h.update).toHaveBeenCalledWith('a', { name: 'Big horn', emoji: '📯', volume: 0.8 })
    expect(wrapper.findAll('.sound-name').map((n) => n.text())).toEqual(['Big horn', 'Bell'])
  })

  it('deletes a sound once confirmed', async () => {
    const wrapper = await mountManager(true)
    await wrapper.findAll('[data-testid="soundboard-delete"]')[1].trigger('click')
    await flushPromises()
    expect(h.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    expect(wrapper.findAll('.sound-name').map((n) => n.text())).toEqual(['Horn'])
  })

  it('keeps a sound when the delete is cancelled', async () => {
    h.confirm.mockResolvedValue(false)
    const wrapper = await mountManager(true)
    await wrapper.findAll('[data-testid="soundboard-delete"]')[0].trigger('click')
    await flushPromises()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('stops offering uploads at 48 sounds', async () => {
    h.list.mockResolvedValue(Array.from({ length: 48 }, (_, i) => sound(`s${i}`, `Sound ${i}`)))
    const wrapper = await mountManager(true)
    expect(wrapper.find('[data-testid="soundboard-file"]').exists()).toBe(false)
    expect(wrapper.find('.card-note').text()).toContain('soundboard.errors.full')
  })
  it('shows whether the server shares its sounds', async () => {
    h.getSharing.mockResolvedValue(false)
    const wrapper = await mountManager(false)
    expect(h.getSharing).toHaveBeenCalledWith(SERVER)
    const toggle = wrapper.find('[data-testid="soundboard-share-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(toggle.attributes('aria-disabled')).toBe('true')
    await toggle.trigger('click')
    expect(h.setSharing).not.toHaveBeenCalled()
  })

  it('lets a sound manager stop sharing, and puts it back when the write is refused', async () => {
    const wrapper = await mountManager(true)
    const toggle = wrapper.find('[data-testid="soundboard-share-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    await flushPromises()
    expect(h.setSharing).toHaveBeenCalledWith(SERVER, false)
    expect(toggle.attributes('aria-checked')).toBe('false')

    h.setSharing.mockRejectedValueOnce({ code: '42501' })
    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(h.toast.error).toHaveBeenCalledWith('soundboard.errors.permission:{"kb":512,"max":48}')
  })
})
