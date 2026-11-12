/** BridgeImportAdmin.vue: Admin → Instance → Discord bridge → Discord history import. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeImportAdmin from '../BridgeImportAdmin.vue'
import { installBackend, makeI18n, missingKeys, rpcCalls } from './bridgeTestKit'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const config = (over: Record<string, unknown> = {}) =>
  Object.entries({
    bridge_history_import: 'off',
    bridge_import_max_running: 1,
    bridge_import_messages_per_minute: 600,
    bridge_mirror_server_limit_mb: 5120,
    ...over,
  }).map(([config_key, config_value]) => ({ config_key, config_value }))

const mountAdmin = () => mount(BridgeImportAdmin, { global: { plugins: [makeI18n()] } })
const saves = () => rpcCalls('batch_set_instance_config').map((c) => [(c.p_keys as string[])[0], (c.p_values as unknown[])[0]])

beforeEach(() => {
  missingKeys.length = 0
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

describe('BridgeImportAdmin', () => {
  it('shows the stored switch and limits; off shows no warning', async () => {
    installBackend({ instance_config: config() })
    const w = mountAdmin()
    await flushPromises()

    expect((w.get('[data-testid="import-mode"]').element as HTMLSelectElement).value).toBe('off')
    expect(w.find('[data-testid="import-warning"]').exists()).toBe(false)
    expect((w.get('[data-testid="import-maxRunning"]').element as HTMLInputElement).value).toBe('1')
    expect((w.get('[data-testid="import-messagesPerMinute"]').element as HTMLInputElement).value).toBe('600')
    expect((w.get('[data-testid="import-mirrorServerLimitMb"]').element as HTMLInputElement).value).toBe('5120')
    expect(w.get('[data-testid="import-save"]').attributes('disabled')).toBeDefined()
  })

  it('falls back to the defaults for keys an older database lacks', async () => {
    installBackend({ instance_config: [] })
    const w = mountAdmin()
    await flushPromises()
    expect((w.get('[data-testid="import-mode"]').element as HTMLSelectElement).value).toBe('off')
    expect((w.get('[data-testid="import-maxRunning"]').element as HTMLInputElement).value).toBe('1')
    expect((w.get('[data-testid="import-mirrorServerLimitMb"]').element as HTMLInputElement).value).toBe('5120')
  })

  it('turning import on saves at once and shows what the admin takes on', async () => {
    installBackend({ instance_config: config() }, (name) => (name === 'batch_set_instance_config' ? true : null))
    const w = mountAdmin()
    await flushPromises()
    await w.get('[data-testid="import-mode"]').setValue('self_run')
    await flushPromises()

    expect(saves()).toEqual([['bridge_history_import', 'self_run']])
    const warning = w.get('[data-testid="import-warning"]').text()
    expect(warning).toContain('did not ask for the copy')
    expect(warning).toContain('/bridge-privacy')
    expect(warning).toContain('Deletion requests')
    expect(toast.success).toHaveBeenCalledWith('History import settings saved')
  })

  it('a refused save puts the switch back', async () => {
    installBackend({ instance_config: config() }, (name) => {
      if (name === 'batch_set_instance_config') throw Object.assign(new Error('Unauthorized: Admin role required'), { code: '42501' })
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    await w.get('[data-testid="import-mode"]').setValue('self_run')
    await flushPromises()

    expect((w.get('[data-testid="import-mode"]').element as HTMLSelectElement).value).toBe('off')
    expect(w.find('[data-testid="import-warning"]').exists()).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('saves only the limits that changed; 0 is allowed, a fraction or a negative number is not', async () => {
    installBackend({ instance_config: config() }, (name) => (name === 'batch_set_instance_config' ? true : null))
    const w = mountAdmin()
    await flushPromises()

    await w.get('[data-testid="import-messagesPerMinute"]').setValue('-5')
    expect(w.get('[data-testid="import-save"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('Enter whole numbers, 0 or more.')
    await w.get('[data-testid="import-messagesPerMinute"]').setValue('1.5')
    expect(w.get('[data-testid="import-save"]').attributes('disabled')).toBeDefined()

    await w.get('[data-testid="import-messagesPerMinute"]').setValue('1200')
    await w.get('[data-testid="import-mirrorServerLimitMb"]').setValue('0')
    await w.get('[data-testid="import-save"]').trigger('click')
    await flushPromises()

    expect(saves()).toEqual([['bridge_import_messages_per_minute', 1200], ['bridge_mirror_server_limit_mb', 0]])
    expect(w.get('[data-testid="import-save"]').attributes('disabled')).toBeDefined()
  })

  it('shows what is running and what has been stored', async () => {
    installBackend({ instance_config: config() }, (name) => {
      if (name === 'bridge_import_status') return { running: 1, queued: 2, imported: 3400 }
      if (name === 'bridge_mirror_status') return { queued: 0, done: 5, too_large: 0, too_large_bytes: 0, failed: 0, stored_bytes: 2 * 1024 * 1024 }
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    const totals = w.get('[data-testid="import-totals"]').text()
    expect(totals).toContain('1 running, 2 waiting, 3400 messages imported')
    expect(totals).toContain('of Discord files stored')
  })

  it('removes every Discord message of the instance after a confirmation, repeating until nothing is left', async () => {
    const answers = [{ erased: 200, more: true }, { erased: 30, more: false }]
    installBackend({ instance_config: config() }, (name) => (name === 'bridge_privacy_purge_instance' ? answers.shift() : null))
    const w = mountAdmin()
    await flushPromises()

    await w.get('[data-testid="instance-purge"]').trigger('click')
    expect(rpcCalls('bridge_privacy_purge_instance')).toEqual([])
    expect(w.get('[data-testid="instance-purge-confirm"]').text()).toContain('every server of this instance')
    await w.get('[data-testid="instance-purge-yes"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_purge_instance')).toEqual([{ p_platform: 'discord' }, { p_platform: 'discord' }])
    expect(toast.success).toHaveBeenCalledWith('Removed 230 bridged messages')
  })
})
