/** BridgePrivacyPanel.vue: Server settings → Discord Bridge → Bridge privacy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgePrivacyPanel from '../BridgePrivacyPanel.vue'
import { SERVER_ID, installBackend, makeI18n, missingKeys, rpcCalls } from './bridgeTestKit'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const DANA = '400000000000000001'
const EVE = '400000000000000002'
const scope = { p_server_id: SERVER_ID, p_platform: 'discord' }

const optouts = () => [
  { server_id: SERVER_ID, platform: 'discord', remote_user_id: DANA, source: 'self', created_at: '2026-11-12T10:00:00Z' },
  { server_id: SERVER_ID, platform: 'discord', remote_user_id: EVE, source: 'manager', created_at: '2026-11-12T09:00:00Z' },
  { server_id: 'another-server', platform: 'discord', remote_user_id: '400000000000000009', source: 'manager', created_at: '2026-11-12T08:00:00Z' },
]

const mountPanel = () => mount(BridgePrivacyPanel, { props: { serverId: SERVER_ID }, global: { plugins: [makeI18n()] } })

beforeEach(() => {
  missingKeys.length = 0
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

describe('BridgePrivacyPanel', () => {
  it('lists the Discord users left out of this server; only a removal made here can be restored', async () => {
    installBackend({ bridge_remote_optouts: optouts() })
    const w = mountPanel()
    await flushPromises()

    const rows = w.findAll('[data-testid="privacy-row"]')
    expect(rows.map((r) => r.find('code').text())).toEqual([DANA, EVE])
    expect(rows[0].text()).toContain('Opted out on Discord')
    expect(rows[0].find('[data-testid="privacy-restore"]').exists()).toBe(false)
    expect(rows[1].text()).toContain('Removed by a manager')
    expect(rows[1].get('[data-testid="privacy-restore"]').attributes('aria-label')).toBe(`Bridge Discord user ${EVE} again`)
  })

  it('says when a user a manager removed also opted out on Discord: Restore leaves them out', async () => {
    installBackend({ bridge_remote_optouts: [
      { server_id: SERVER_ID, platform: 'discord', remote_user_id: EVE, source: 'manager', self_opted_out: true, created_at: '2026-11-12T09:00:00Z' },
    ] })
    const w = mountPanel()
    await flushPromises()
    const row = w.get('[data-testid="privacy-row"]')
    expect(row.text()).toContain('Removed by a manager')
    expect(row.get('[data-testid="privacy-also-self"]').text()).toBe('Also opted out on Discord')
    expect(row.find('[data-testid="privacy-restore"]').exists()).toBe(true)
  })

  it('restores a user a manager removed', async () => {
    const backend = installBackend({ bridge_remote_optouts: optouts() }, (name, args) => {
      if (name === 'bridge_privacy_restore_remote_user') {
        const rows = backend.tables.bridge_remote_optouts
        rows.splice(rows.findIndex((r) => r.remote_user_id === args.p_remote_user_id), 1)
        return true
      }
      return null
    })
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-restore"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_restore_remote_user')).toEqual([{ ...scope, p_remote_user_id: EVE }])
    expect(w.findAll('[data-testid="privacy-row"]')).toHaveLength(1)
  })

  it('refuses something that is not a Discord user ID without asking the server', async () => {
    installBackend({ bridge_remote_optouts: [] })
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-id"]').setValue('dana#1234')
    await w.get('form').trigger('submit')

    expect(w.get('[data-testid="privacy-id-help"]').text()).toBe('A Discord user ID is 5 to 20 digits.')
    expect(w.get('[data-testid="privacy-id"]').attributes('aria-invalid')).toBe('true')
    expect(w.find('[data-testid="privacy-remove-confirm"]').exists()).toBe(false)
    expect(rpcCalls('bridge_privacy_remove_remote_user')).toEqual([])
  })

  it('removes a Discord user after a confirmation, repeating until nothing is left', async () => {
    // The first batch removes; the later ones continue only while the removal stands.
    const answers = [{ erased: 200, more: true }, { erased: 200, more: true }, { erased: 12, more: false }]
    installBackend({ bridge_remote_optouts: [] }, (name) =>
      (name === 'bridge_privacy_remove_remote_user' || name === 'bridge_privacy_erase_continue' ? answers.shift() : null))
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-id"]').setValue(DANA)
    await w.get('form').trigger('submit')

    expect(rpcCalls('bridge_privacy_remove_remote_user')).toEqual([])
    const dialog = w.get('[data-testid="privacy-remove-confirm"]')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(dialog.text()).toContain(DANA)
    expect(dialog.text()).toContain('cannot be undone')

    await w.get('[data-testid="privacy-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_remove_remote_user')).toEqual([{ ...scope, p_remote_user_id: DANA }])
    expect(rpcCalls('bridge_privacy_erase_continue')).toEqual(Array(2).fill({ ...scope, p_remote_user_id: DANA }))
    expect(toast.success).toHaveBeenCalledWith('Removed 412 messages')
    expect((w.get('[data-testid="privacy-id"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('[data-testid="privacy-progress"]').exists()).toBe(false)
  })

  it('Cancel in the confirmation removes nothing', async () => {
    installBackend({ bridge_remote_optouts: [] })
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-id"]').setValue(DANA)
    await w.get('form').trigger('submit')
    await w.get('[data-testid="privacy-confirm-no"]').trigger('click')

    expect(w.find('[data-testid="privacy-remove-confirm"]').exists()).toBe(false)
    expect(rpcCalls('bridge_privacy_remove_remote_user')).toEqual([])
  })

  it('removes every bridged message of the server after a confirmation', async () => {
    const answers = [{ erased: 200, more: true }, { erased: 1, more: false }]
    installBackend({ bridge_remote_optouts: [] }, (name) => (name === 'bridge_privacy_purge_server' ? answers.shift() : null))
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-purge"]').trigger('click')
    expect(w.get('[data-testid="privacy-purge-confirm"]').text()).toContain('Delete every message, file and reaction brought from Discord')
    await w.get('[data-testid="privacy-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_purge_server')).toEqual([scope, scope])
    expect(toast.success).toHaveBeenCalledWith('Removed 201 bridged messages')
  })

  it('goes on through batches that remove reactions and AutoMod rows, not messages', async () => {
    const answers = [
      ...Array(4).fill({ erased: 0, more: true, removed: 200 }),
      { erased: 0, more: false, removed: 5 },
    ]
    installBackend({ bridge_remote_optouts: [] }, (name) => (name === 'bridge_privacy_purge_server' ? answers.shift() : null))
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-purge"]').trigger('click')
    await w.get('[data-testid="privacy-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_purge_server')).toHaveLength(5)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Removed 0 bridged messages')
  })

  it('says so when rows remain after batches that remove nothing', async () => {
    installBackend({ bridge_remote_optouts: [] }, (name) => (name === 'bridge_privacy_purge_server' ? { erased: 0, more: true } : null))
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-purge"]').trigger('click')
    await w.get('[data-testid="privacy-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('bridge_privacy_purge_server')).toHaveLength(3)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('Removed 0 bridged messages; some remain. Run it again.')
  })

  it('says so when the server refuses', async () => {
    installBackend({ bridge_remote_optouts: [] }, (name) => {
      if (name === 'bridge_privacy_purge_server') throw Object.assign(new Error('Only a manager of the server can remove its bridged messages'), { code: '42501' })
      return null
    })
    const w = mountPanel()
    await flushPromises()
    await w.get('[data-testid="privacy-purge"]').trigger('click')
    await w.get('[data-testid="privacy-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
