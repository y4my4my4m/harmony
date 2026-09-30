import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(async () => {}),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))
vi.mock('vue-toastification', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.6.1' }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => 'enabled' }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))

function fakeUpdate() {
  return {
    version: '1.6.2',
    body: null,
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

async function setup() {
  vi.resetModules()
  const service = await import('@/services/desktopUpdater')
  const { default: DesktopUpdatePrompt } = await import('../DesktopUpdatePrompt.vue')
  const update = fakeUpdate()
  mocks.check.mockResolvedValue(update)
  await service.initDesktopUpdater()
  const wrapper = mount(DesktopUpdatePrompt, { global: { stubs: { teleport: true } } })
  return { service, update, wrapper }
}

beforeEach(() => {
  localStorage.clear()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
  mocks.relaunch.mockClear()
})

describe('DesktopUpdatePrompt', () => {
  it('announces a ready update once and opens the prompt from the toast', async () => {
    const { service, wrapper } = await setup()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()

    await service.checkForUpdates()
    await flushPromises()
    expect(service.updaterState.phase).toBe('ready')
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toastSuccess.mock.calls[0]
    expect(message).toContain('updater.readyToast')
    expect(message).toContain('1.6.2')

    expect(wrapper.text()).not.toContain('updater.restartToUpdate')
    options.onClick()
    await flushPromises()
    expect(wrapper.text()).toContain('updater.restartToUpdate')
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('does not toast the same version again after a relaunch', async () => {
    const first = await setup()
    await first.service.checkForUpdates()
    await flushPromises()
    first.wrapper.unmount()
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)

    const second = await setup()
    await second.service.checkForUpdates()
    await flushPromises()
    expect(second.service.updaterState.phase).toBe('ready')
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('installs and relaunches only on "Restart to update"', async () => {
    const { service, update, wrapper } = await setup()
    await service.checkForUpdates()
    await flushPromises()
    service.openUpdatePrompt()
    await flushPromises()

    const later = wrapper.findAll('button').find((b) => b.text() === 'updater.later')
    await later!.trigger('click')
    await flushPromises()
    expect(service.updaterState.promptOpen).toBe(false)
    expect(update.install).not.toHaveBeenCalled()

    service.openUpdatePrompt()
    await flushPromises()
    const restart = wrapper.findAll('button').find((b) => b.text() === 'updater.restartToUpdate')
    await restart!.trigger('click')
    await flushPromises()
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
  })

  it('reports an install failure', async () => {
    const { service, update, wrapper } = await setup()
    update.install.mockRejectedValueOnce(new Error('read-only file system'))
    await service.checkForUpdates()
    await flushPromises()
    service.openUpdatePrompt()
    await flushPromises()

    const restart = wrapper.findAll('button').find((b) => b.text() === 'updater.restartToUpdate')
    await restart!.trigger('click')
    await flushPromises()
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0][0]).toContain('read-only file system')
  })
})
