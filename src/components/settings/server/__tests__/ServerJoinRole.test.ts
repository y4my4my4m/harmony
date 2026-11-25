/**
 * ServerJoinRole.vue: the role shown is the open server's, whichever server's answer lands last.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  getServerSettings: vi.fn(),
  setServerJoinRole: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => mocks.toast }))
vi.mock('@/services/permissionsService', () => ({ getServerSettings: mocks.getServerSettings }))
vi.mock('@/services/RoleService', () => ({ roleService: { setServerJoinRole: mocks.setServerJoinRole } }))
vi.mock('@/stores/useServerRoles', () => ({
  useServerRolesStore: () => ({
    rolesByServer: new Map([
      ['a', [{ id: 'a-everyone', name: '@everyone', is_default: true }, { id: 'a-new', name: 'Newcomer' }]],
      ['b', [{ id: 'b-everyone', name: '@everyone', is_default: true }, { id: 'b-guest', name: 'Guest' }]],
      ['c', [
        { id: 'c-everyone', name: '@everyone', is_default: true, position: 0, permissions: { VIEW_CHANNEL: true } },
        { id: 'c-news', name: 'News', position: 1, permissions: { VIEW_CHANNEL: true } },
        { id: 'c-mod', name: 'Mods', position: 2, permissions: { VIEW_CHANNEL: true, KICK_MEMBERS: true } },
      ]],
    ]),
    ensureServerLoaded: vi.fn(async () => {}),
  }),
}))

import ServerJoinRole from '../ServerJoinRole.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const render = () => mount(ServerJoinRole, { props: { serverId: 'a' } })
const select = (w: ReturnType<typeof render>) => w.get<HTMLSelectElement>('[data-testid="join-role-select"]')
/** The chosen option's text; undefined when the select holds a value none of its options has. */
const shown = (w: ReturnType<typeof render>) => select(w).element.selectedOptions[0]?.textContent

beforeEach(() => {
  mocks.getServerSettings.mockReset()
  mocks.setServerJoinRole.mockReset().mockResolvedValue({ ok: true })
})

describe('ServerJoinRole', () => {
  it('drops the answer of the server left behind', async () => {
    const a = deferred<{ default_role_id: string }>()
    mocks.getServerSettings.mockImplementation((id: string) =>
      id === 'a' ? a.promise : Promise.resolve({ default_role_id: 'b-guest' }))
    const w = render()
    await w.setProps({ serverId: 'b' })
    await flushPromises()
    expect(shown(w)).toBe('Guest')

    a.resolve({ default_role_id: 'a-new' })
    await flushPromises()
    expect(shown(w)).toBe('Guest')
  })

  it('shows no role and takes no choice until the next server answers', async () => {
    const b = deferred<null>()
    mocks.getServerSettings.mockImplementation((id: string) =>
      id === 'a' ? Promise.resolve({ default_role_id: 'a-new' }) : b.promise)
    const w = render()
    await flushPromises()
    expect(shown(w)).toBe('Newcomer')

    await w.setProps({ serverId: 'b' })
    expect(shown(w)).toBe('joinRole.none')
    expect(select(w).element.disabled).toBe(true)
    b.resolve(null)
    await flushPromises()
    expect(select(w).element.disabled).toBe(false)
  })

  it('keeps a save finished after the switch off the next server', async () => {
    const saved = deferred<{ ok: true }>()
    mocks.setServerJoinRole.mockReturnValue(saved.promise)
    mocks.getServerSettings.mockResolvedValue(null)
    const w = render()
    await flushPromises()
    await select(w).setValue('a-new')
    expect(mocks.setServerJoinRole).toHaveBeenCalledWith('a', 'a-new')

    await w.setProps({ serverId: 'b' })
    await flushPromises()
    saved.resolve({ ok: true })
    await flushPromises()
    expect(shown(w)).toBe('joinRole.none')

    await select(w).setValue('b-guest')
    expect(mocks.setServerJoinRole).toHaveBeenLastCalledWith('b', 'b-guest')
    await flushPromises()
    expect(shown(w)).toBe('Guest')
  })

  it('offers only roles the server gives new members, and keeps a refused current one listed with a note', async () => {
    mocks.getServerSettings.mockResolvedValue({ default_role_id: 'c-mod' })
    const w = mount(ServerJoinRole, { props: { serverId: 'c' } })
    await flushPromises()
    const texts = w.findAll('option').map((o) => o.text())
    expect(texts).toContain('News')
    expect(texts).toContain('Mods')
    expect(w.find('[data-testid="join-role-refused"]').text()).toBe('joinRole.currentNotOpen')

    mocks.getServerSettings.mockResolvedValue({ default_role_id: 'c-news' })
    const other = mount(ServerJoinRole, { props: { serverId: 'c' } })
    await flushPromises()
    expect(other.findAll('option').map((o) => o.text())).not.toContain('Mods')
    expect(other.find('[data-testid="join-role-refused"]').exists()).toBe(false)
  })

  it('tells why the server refused the role', async () => {
    mocks.getServerSettings.mockResolvedValue({ default_role_id: 'c-news' })
    mocks.setServerJoinRole.mockResolvedValue({ ok: false, error: 'ROLE_NOT_OPEN' })
    const w = mount(ServerJoinRole, { props: { serverId: 'c' } })
    await flushPromises()
    await select(w).setValue('c-news')
    await flushPromises()
    expect(mocks.toast.error).toHaveBeenCalledWith('joinRole.notOpen')
  })
})
