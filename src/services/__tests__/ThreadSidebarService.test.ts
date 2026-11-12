import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'

const { rpc, from, query } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return { rpc: vi.fn(), from: vi.fn(() => query), query }
})
vi.mock('@/supabase', () => ({ supabase: { rpc, from } }))

import {
  getServerThreadSidebar,
  setServerThreadSidebar,
  getInstanceThreadSidebarDefault,
  setInstanceThreadSidebarDefault,
  getThreadSidebarMode,
  useThreadSidebarMode,
  setCached,
  THREAD_SIDEBAR_DEFAULT_KEY,
} from '../ThreadSidebarService'
import { userStorage } from '@/utils/userScopedStorage'

const KEY = (id: string) => `harmony.threadSidebarMode.${id}`
const stored = (id: string) => userStorage.getItem(KEY(id))

beforeEach(() => {
  vi.clearAllMocks()
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  localStorage.clear()
})

describe('ThreadSidebarService', () => {
  it('reads and writes the server setting through the RPCs', async () => {
    const state = { mode: 'all', server_value: null, instance_default: 'all' }
    rpc.mockResolvedValue({ data: state, error: null })
    expect(await getServerThreadSidebar('s1')).toEqual(state)
    expect(rpc).toHaveBeenCalledWith('get_server_thread_sidebar', { p_server_id: 's1' })
    await setServerThreadSidebar('s1', null)
    expect(rpc).toHaveBeenCalledWith('set_server_thread_sidebar', { p_server_id: 's1', p_mode: null })
  })

  it('throws RPC errors from get and set', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('nope') })
    await expect(getServerThreadSidebar('s1')).rejects.toThrow('nope')
  })

  it('reads the instance default', async () => {
    query.maybeSingle.mockResolvedValue({ data: { config_value: 'joined' }, error: null })
    expect(await getInstanceThreadSidebarDefault()).toBe('joined')
    expect(from).toHaveBeenCalledWith('instance_config')
    expect(query.eq).toHaveBeenCalledWith('config_key', THREAD_SIDEBAR_DEFAULT_KEY)
    query.maybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await getInstanceThreadSidebarDefault()).toBe('all')
  })

  it('writes the instance default through set_instance_config', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await setInstanceThreadSidebarDefault('joined')
    expect(rpc).toHaveBeenCalledWith('set_instance_config', {
      p_key: 'thread_sidebar_default',
      p_value: 'joined',
      p_description: 'Which threads the channel sidebar lists for servers whose server_settings.thread_sidebar is NULL',
    })
    rpc.mockResolvedValue({ data: false, error: null })
    await expect(setInstanceThreadSidebarDefault('all')).rejects.toThrow()
  })

  it('looks up the effective mode, null on error', async () => {
    rpc.mockResolvedValue({ data: 'joined', error: null })
    expect(await getThreadSidebarMode('s1')).toBe('joined')
    expect(rpc).toHaveBeenCalledWith('server_thread_sidebar_mode', { p_server_id: 's1' })
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    expect(await getThreadSidebarMode('s1')).toBeNull()
  })
})

describe('useThreadSidebarMode', () => {
  it('a successful lookup sets the mode and remembers it', async () => {
    rpc.mockResolvedValue({ data: 'joined', error: null })
    const { mode } = useThreadSidebarMode(ref('c1'), ref(true))
    await flushPromises()
    expect(mode.value).toBe('joined')
    expect(stored('c1')).toBe('joined')
  })

  it('a failed lookup keeps the remembered mode', async () => {
    userStorage.setItem(KEY('c2'), 'joined')
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    const { mode } = useThreadSidebarMode(ref('c2'), ref(true))
    await flushPromises()
    expect(mode.value).toBe('joined')
  })

  it('falls back to all when nothing is remembered', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    const { mode } = useThreadSidebarMode(ref('c3'), ref(true))
    await flushPromises()
    expect(mode.value).toBe('all')
  })

  it('uses the remembered mode before the lookup resolves', () => {
    userStorage.setItem(KEY('c4'), 'joined')
    rpc.mockReturnValue(new Promise(() => {}))
    const { mode } = useThreadSidebarMode(ref('c4'), ref(true))
    expect(mode.value).toBe('joined')
  })

  it('a lookup returning all overwrites a remembered joined', async () => {
    userStorage.setItem(KEY('c5'), 'joined')
    rpc.mockResolvedValue({ data: 'all', error: null })
    const { mode } = useThreadSidebarMode(ref('c5'), ref(true))
    await flushPromises()
    expect(mode.value).toBe('all')
    expect(stored('c5')).toBe('all')
  })

  it('makes no RPC call for a remote server', async () => {
    userStorage.setItem(KEY('c6'), 'joined')
    const { mode } = useThreadSidebarMode(ref('c6'), ref(false))
    await flushPromises()
    expect(rpc).not.toHaveBeenCalled()
    expect(mode.value).toBe('joined')
  })

  it('a lookup for a server left behind changes nothing for the new one', async () => {
    let resolveA!: (value: unknown) => void
    rpc.mockImplementation((_name: string, args: { p_server_id: string }) =>
      args.p_server_id === 'sa'
        ? new Promise(resolve => { resolveA = resolve })
        : Promise.resolve({ data: 'all', error: null }))
    const serverId = ref<string | null>('sa')
    const { mode } = useThreadSidebarMode(serverId, ref(true))
    serverId.value = 'sb'
    await flushPromises()
    expect(mode.value).toBe('all')
    resolveA({ data: 'joined', error: null })
    await flushPromises()
    expect(mode.value).toBe('all')
    expect(stored('sb')).toBe('all')
    expect(stored('sa')).toBeNull()
  })

  it('setCached applies at once and remembers', async () => {
    rpc.mockResolvedValue({ data: 'all', error: null })
    const { mode } = useThreadSidebarMode(ref('c7'), ref(true))
    await flushPromises()
    setCached('c7', 'joined')
    await nextTick()
    expect(mode.value).toBe('joined')
    expect(stored('c7')).toBe('joined')
  })
})
