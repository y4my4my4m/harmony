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
type Wrapper = ReturnType<typeof mountAdmin>
/** The checked radio's value; '' when none is. */
const chosen = (w: Wrapper) => w.findAll<HTMLInputElement>('[data-testid="import-mode"] input[type="radio"]').find((r) => r.element.checked)?.element.value ?? ''
const choose = (w: Wrapper, mode: string) => w.get(`[data-testid="import-mode-${mode}"] input`).setValue(true)
const fieldset = (w: Wrapper) => w.get('[data-testid="import-mode"]').element as HTMLFieldSetElement
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

    expect(chosen(w)).toBe('off')
    expect(w.findAll('[data-testid="import-mode"] input[type="radio"]').map((r) => r.attributes('value'))).toEqual(['off', 'self_run', 'all'])
    expect(w.get('[data-testid="import-mode"] legend').text()).toBe('History import')
    expect(w.get('[data-testid="import-mode-all"]').text()).toContain("this instance's Discord bot")
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
    expect(chosen(w)).toBe('off')
    expect((w.get('[data-testid="import-maxRunning"]').element as HTMLInputElement).value).toBe('1')
    expect((w.get('[data-testid="import-mirrorServerLimitMb"]').element as HTMLInputElement).value).toBe('5120')
  })

  it('turning import on saves at once and shows what the admin takes on', async () => {
    installBackend({ instance_config: config() }, (name) => (name === 'batch_set_instance_config' ? true : null))
    const w = mountAdmin()
    await flushPromises()
    await choose(w, 'self_run')
    await flushPromises()

    expect(saves()).toEqual([['bridge_history_import', 'self_run']])
    expect(chosen(w)).toBe('self_run')
    expect(w.get('[data-testid="import-mode-self_run"]').classes()).toContain('selected')
    const warning = w.get('[data-testid="import-warning"]').text()
    expect(warning).toContain('did not ask for the copy')
    expect(warning).toContain('/bridge-privacy')
    expect(warning).toContain('Deletion requests')
    expect(w.find('[data-testid="import-warning-instance-bot"]').exists()).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('History import settings saved')
  })

  it('all bridges saves all and adds the instance bot line to the warning', async () => {
    installBackend({ instance_config: config() }, (name) => (name === 'batch_set_instance_config' ? true : null))
    const w = mountAdmin()
    await flushPromises()
    await choose(w, 'all')
    await flushPromises()

    expect(saves()).toEqual([['bridge_history_import', 'all']])
    expect(w.get('[data-testid="import-warning-instance-bot"]').text()).toContain("Discord's developer terms")
  })

  it('reads a stored all, and treats an unknown value as off', async () => {
    installBackend({ instance_config: config({ bridge_history_import: 'all' }) })
    const w = mountAdmin()
    await flushPromises()
    expect(chosen(w)).toBe('all')

    installBackend({ instance_config: config({ bridge_history_import: 'everything' }) })
    const other = mountAdmin()
    await flushPromises()
    expect(chosen(other)).toBe('off')
  })

  it('keeps the choices enabled while saving and stores the last one chosen, in order', async () => {
    const pending: Array<() => void> = []
    installBackend({ instance_config: config() }, (name) => {
      if (name !== 'batch_set_instance_config') return null
      return new Promise((resolve) => pending.push(() => resolve(true)))
    })
    const w = mountAdmin()
    await flushPromises()
    await choose(w, 'self_run')
    await choose(w, 'all')
    expect(fieldset(w).disabled).toBe(false)
    expect(fieldset(w).getAttribute('aria-busy')).toBe('true')
    expect(chosen(w)).toBe('all')

    while (pending.length) {
      pending.shift()!()
      await flushPromises()
    }
    expect(saves()).toEqual([['bridge_history_import', 'self_run'], ['bridge_history_import', 'all']])
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(fieldset(w).getAttribute('aria-busy')).toBe('false')
  })

  it('a refused save puts the switch back', async () => {
    installBackend({ instance_config: config() }, (name) => {
      if (name === 'batch_set_instance_config') throw Object.assign(new Error('Unauthorized: Admin role required'), { code: '42501' })
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    await choose(w, 'self_run')
    await flushPromises()

    expect(chosen(w)).toBe('off')
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

  it('shows history import off once a purge batch lands, even when a later batch fails, and holds the switch meanwhile', async () => {
    let calls = 0
    installBackend({ instance_config: config({ bridge_history_import: 'self_run' }) }, (name) => {
      if (name !== 'bridge_privacy_purge_instance') return null
      calls++
      if (calls === 1) return { erased: 200, more: true }
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    })
    const w = mountAdmin()
    await flushPromises()
    await w.get('[data-testid="instance-purge"]').trigger('click')
    await w.get('[data-testid="instance-purge-yes"]').trigger('click')
    expect(fieldset(w).disabled).toBe(true)
    await flushPromises()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(chosen(w)).toBe('off')
    expect(fieldset(w).disabled).toBe(false)
  })

  it('shows history import off after a purge, which turned it off', async () => {
    installBackend({ instance_config: config({ bridge_history_import: 'self_run' }) },
      (name) => (name === 'bridge_privacy_purge_instance' ? { erased: 0, more: false } : null))
    const w = mountAdmin()
    await flushPromises()
    expect(chosen(w)).toBe('self_run')

    await w.get('[data-testid="instance-purge"]').trigger('click')
    await w.get('[data-testid="instance-purge-yes"]').trigger('click')
    await flushPromises()

    expect(chosen(w)).toBe('off')
    expect(w.text()).toContain('History import is turned off and unfinished imports stop.')
  })
})
