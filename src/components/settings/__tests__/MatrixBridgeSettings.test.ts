import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import en from '@/locales/en.json'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/stores/useProfile', async () => {
  const { reactive } = await import('vue')
  const profile = reactive({ profileId: 'member' })
  return { useProfileStore: () => profile }
})
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], en) || key }) }))
import MatrixBridgeSettings from '../MatrixBridgeSettings.vue'
import { useProfileStore } from '@/stores/useProfile'
const pair = { bot_id: 'bot', channel_id: 'channel', channel_name: 'general', room_id: '!room:hs', sender_mode: 'relay' }
let wrapper: VueWrapper
beforeEach(() => { rpc.mockReset(); useProfileStore().profileId = 'member' })
afterEach(() => wrapper?.unmount())
async function open(rows: unknown = [pair]) {
  rpc.mockResolvedValueOnce({ data: rows, error: null })
  wrapper = mount(MatrixBridgeSettings, { props: { serverId: 'server' } })
  await flushPromises()
}
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

describe('configured Matrix bridge sender settings', () => {
  it('loads fresh pairs, labels the select, and explains prerequisites without claiming delivery', async () => {
    await open()
    expect(rpc).toHaveBeenCalledWith('get_server_matrix_bridges', { p_server_id: 'server' })
    expect(wrapper.text()).toContain('#general')
    expect(wrapper.text()).toContain('!room:hs')
    expect(wrapper.text()).toContain('user namespace')
    expect(wrapper.text()).toContain('permission to invite')
    expect(wrapper.text()).toContain('Existing history is preserved')
    expect(wrapper.text()).toContain('does not confirm registration or delivery')
    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('select').attributes('id'))
    expect(wrapper.get('select').attributes('aria-describedby')).toBeTruthy()
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(['Individual bridged users (recommended)', 'Shared bridge account'])
    rpc.mockResolvedValueOnce({ data: [], error: null })
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.text()).toContain('No configured Matrix bridges')
  })
  it('targets bot+channel, waits for canonical state, and leaves a second pair unchanged', async () => {
    await open([pair, { ...pair, bot_id: 'second-bot' }])
    const pending = deferred()
    rpc.mockReturnValueOnce(pending.promise)
    await wrapper.findAll('select')[0].setValue('ghost')
    expect(rpc).toHaveBeenLastCalledWith('set_matrix_bridge_sender_mode', { p_bot_id: 'bot', p_channel_id: 'channel', p_sender_mode: 'ghost' })
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    expect((wrapper.findAll('select')[0].element as HTMLSelectElement).value).toBe('relay')
    pending.resolve({ data: [{ ...pair, sender_mode: 'ghost' }], error: null }); await flushPromises()
    expect(wrapper.findAll('select').map(select => (select.element as HTMLSelectElement).value)).toEqual(['ghost', 'relay'])
  })
  it('accepts not-yet-bound room pairs and allows a mode choice before connection', async () => {
    await open([{ ...pair, room_id: null }])
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Waiting for the bridge to connect a Matrix room')
    rpc.mockResolvedValueOnce({ data: { ...pair, room_id: null, sender_mode: 'ghost' }, error: null })
    await wrapper.get('select').setValue('ghost'); await flushPromises()
    expect(rpc).toHaveBeenLastCalledWith('set_matrix_bridge_sender_mode', { p_bot_id: 'bot', p_channel_id: 'channel', p_sender_mode: 'ghost' })
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('ghost')
  })
  it.each([null, {}, [{ ...pair, sender_mode: 'pretend' }]])('does not invent loaded state from invalid response %j', async data => {
    await open(data)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load')
  })
  it('locks uncertain saves until reload and never prints server exception text', async () => {
    await open()
    rpc.mockRejectedValueOnce(new Error('secret credentials'))
    await wrapper.get('select').setValue('ghost'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not confirm the mode change')
    expect(wrapper.text()).not.toContain('secret credentials')
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('relay')
    rpc.mockResolvedValueOnce({ data: [{ ...pair, sender_mode: 'ghost' }], error: null })
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('ghost')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('ignores late load responses after a server switch', async () => {
    const pending = deferred(); rpc.mockReturnValueOnce(pending.promise)
    wrapper = mount(MatrixBridgeSettings, { props: { serverId: 'server' } })
    rpc.mockResolvedValueOnce({ data: [{ ...pair, room_id: '!new:hs' }], error: null })
    await wrapper.setProps({ serverId: 'new-server' }); await flushPromises()
    pending.resolve({ data: [pair], error: null }); await flushPromises()
    expect(wrapper.text()).toContain('!new:hs')
    expect(wrapper.text()).not.toContain('!room:hs')
  })
  it('discards a pending save and error after an account switch', async () => {
    await open()
    const pending = deferred(); rpc.mockReturnValueOnce(pending.promise)
    await wrapper.get('select').setValue('ghost')
    rpc.mockResolvedValueOnce({ data: [], error: null })
    useProfileStore().profileId = 'new-member'; await flushPromises()
    pending.resolve({ data: null, error: { message: 'private' } }); await flushPromises()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No configured Matrix bridges')
  })
})
