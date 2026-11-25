/** MatrixManagedPairs.vue: the room list and typed rooms, what is greyed and why, pair states, options and removal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { HARMONY_CHANNELS, NOW, STALE, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import MatrixManagedPairs from '../MatrixManagedPairs.vue'
import { ACCOUNT, BRIDGE_ID, READY_STATUS, ROOMS, parsed, rawPair, rawReady } from './matrixTestKit'

let w: VueWrapper
let fail: { name: string; error: Error } | null
let answer: Record<string, unknown>

function open(raw = rawReady(), props: Record<string, unknown> = {}) {
  w = mount(MatrixManagedPairs, {
    props: { bridge: parsed(raw), harmonyChannels: HARMONY_CHANNELS, encryptedChannelIds: [], now: NOW, ...props },
    attachTo: document.body,
    global: { plugins: [makeI18n()], stubs: { Icon: iconStub } },
  })
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const options = (id: string) => byTest(id).findAll('option').map((o) => ({ text: o.text(), disabled: o.attributes('disabled') !== undefined }))
const submit = async () => { await byTest('pair-form').trigger('submit'); await flushPromises() }
const card = () => byTest('matrix-managed-pair')

beforeEach(() => {
  missingKeys.length = 0
  fail = null
  answer = rawReady({ pairs: [rawPair()] })
  installBackend({}, (name) => {
    if (fail?.name === name) throw fail.error
    return answer
  })
})
afterEach(() => {
  w?.unmount()
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('the form', () => {
  it('greys encrypted channels and rooms, and rooms the bridge cannot post in, with the reason', async () => {
    open(rawReady(), { encryptedChannelIds: ['h-news'] })
    expect(options('select-harmony')).toEqual([
      { text: 'Choose…', disabled: false },
      { text: '#general', disabled: false },
      { text: '#news (end-to-end encrypted)', disabled: true },
      { text: '#memes', disabled: false },
    ])
    expect(options('select-room')).toEqual([
      { text: 'Choose…', disabled: false },
      { text: 'General (#general:example.org)', disabled: false },
      { text: "News (the bridge can't post there)", disabled: true },
      { text: 'Secret (end-to-end encrypted)', disabled: true },
      { text: 'Lobby', disabled: false },
      { text: 'Another room…', disabled: false },
    ])
    expect(byTest('select-room').find('optgroup').attributes('label')).toBe('Invitations (accepted when you pair the room)')
    expect(byTest('select-room').attributes('aria-describedby')).toBe(byTest('matrix-encrypted-note').attributes('id'))
    expect(byTest('select-harmony').attributes('aria-describedby')).toBe(byTest('matrix-encrypted-note').attributes('id'))

    await byTest('select-direction').setValue('to_harmony')
    expect(options('select-room').find((o) => o.text === 'News')).toEqual({ text: 'News', disabled: false })
    expect(options('select-room').find((o) => o.text.startsWith('Secret'))!.disabled).toBe(true)
  })

  it('pairs a listed room by its id, as ghosts by default, and hands the new state up', async () => {
    open()
    await byTest('select-harmony').setValue('h-general')
    await byTest('select-room').setValue('!general:example.org')
    expect(byTest('room-address').exists()).toBe(false)
    await submit()
    expect(rpcCalls('matrix_bridge_pair')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general', p_room: '!general:example.org', p_direction: 'both', p_sender_mode: 'ghost' },
    ])
    expect((w.emitted('state')![0][0] as { pairs: unknown[] }).pairs).toHaveLength(1)
    expect((byTest('select-harmony').element as HTMLSelectElement).value).toBe('')
  })

  it('pairs a typed alias or link, and says what is wrong with anything else', async () => {
    open()
    await byTest('select-harmony').setValue('h-general')
    await byTest('select-room').setValue('other')
    const input = byTest('room-address')
    expect(w.find(`label[for="${input.attributes('id')}"]`).text()).toBe('Room address or ID')
    await submit()
    expect(byTest('room-address-help').text()).toBe("Enter the room's address or ID.")
    await input.setValue('general')
    await submit()
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(byTest('room-address-help').text()).toContain("That isn't a room address.")
    expect(rpcCalls('matrix_bridge_pair')).toEqual([])
    await input.setValue('https://matrix.to/#/%23town:example.org')
    expect(input.attributes('aria-invalid')).toBeUndefined()
    await byTest('select-direction').setValue('to_matrix')
    await byTest('select-mode').setValue('relay')
    await submit()
    expect(rpcCalls('matrix_bridge_pair')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general', p_room: '#town:example.org', p_direction: 'to_matrix', p_sender_mode: 'relay' },
    ])
  })

  it('refuses a typed room the bridge lists as encrypted', async () => {
    open()
    await byTest('select-harmony').setValue('h-general')
    await byTest('select-room').setValue('other')
    await byTest('room-address').setValue('!secret:example.org')
    await submit()
    expect(byTest('room-address-help').text()).toContain("Secret is end-to-end encrypted, so the bridge can't read it.")
    expect(rpcCalls('matrix_bridge_pair')).toEqual([])
  })

  it('asks for the address alone when the bridge lists no room', () => {
    open(rawReady({ snapshot: {} }))
    expect(byTest('select-room').exists()).toBe(false)
    expect(byTest('room-address').exists()).toBe(true)
  })

  it('asks for both sides', async () => {
    open()
    await submit()
    expect(byTest('pair-error').text()).toBe('Choose a Harmony channel and a Matrix room.')
    await byTest('select-harmony').setValue('h-general')
    expect(byTest('pair-error').exists()).toBe(false)
    await submit()
    expect(byTest('pair-error').attributes('role')).toBe('alert')
  })

  it('names a room that is paired elsewhere, and never prints the server\'s words', async () => {
    fail = { name: 'matrix_bridge_pair', error: Object.assign(new Error('secret duplicate'), { code: '23505' }) }
    open()
    await byTest('select-harmony').setValue('h-general')
    await byTest('select-room').setValue('!general:example.org')
    await submit()
    expect(byTest('pair-error').text()).toBe('That room is already paired with another channel.')
    expect(w.text()).not.toContain('secret')
    expect(w.emitted('state')).toBeUndefined()
  })

  it('offers how members appear to an application service only', async () => {
    open(rawReady({ connection: 'account', pairs: [rawPair({ channel_id: 'h-news' })] }))
    expect(byTest('select-mode').exists()).toBe(false)
    expect(byTest('matrix-pair-mode').exists()).toBe(false)
    expect(byTest('matrix-modes').exists()).toBe(false)
    await byTest('select-harmony').setValue('h-general')
    await byTest('select-room').setValue('!lobby:example.org')
    await submit()
    expect(rpcCalls('matrix_bridge_pair')[0].p_sender_mode).toBe('relay')
  })

  it('says whom to invite to a closed room, and that a silent bridge\'s list is old', async () => {
    open()
    expect(byTest('matrix-invite-hint').text()).toContain(`Invite ${ACCOUNT} first`)
    expect(byTest('matrix-rooms-stale').exists()).toBe(false)
    await w.setProps({ bridge: parsed(rawReady({ last_seen_at: STALE, status: { ...READY_STATUS, user_id: null } })) })
    expect(byTest('matrix-invite-hint').text()).toContain('Invite its Matrix account first')
    expect(byTest('matrix-rooms-stale').exists()).toBe(true)
  })

  it('drops a chosen room that becomes encrypted', async () => {
    open()
    await byTest('select-room').setValue('!general:example.org')
    await w.setProps({ bridge: parsed(rawReady({ snapshot: { rooms: ROOMS.map((r) => ({ ...r, encrypted: true })) } })) })
    expect((byTest('select-room').element as HTMLSelectElement).value).toBe('')
  })
})

describe('the pairs', () => {
  it.each([
    [null, 'new', 'Waiting for the bridge'],
    ['joining', 'joining', 'Joining the room'],
    ['ready', 'ready', 'Working'],
  ])('shows state %s', (state, data, label) => {
    open(rawReady({ pairs: [rawPair({ state })] }))
    expect(card().attributes('data-state')).toBe(data)
    expect(byTest('matrix-pair-badge').text()).toBe(label)
    expect(byTest('matrix-pair-error').exists()).toBe(false)
    expect(byTest('matrix-pair-room').text()).toBe('General')
    expect(card().text()).toContain('#general:example.org')
  })

  it.each([
    ['room_not_found', 'The bridge found no room at #gone:example.org.'],
    ['not_invited', `Invite ${ACCOUNT} to it on Matrix.`],
    ['room_encrypted', 'is end-to-end encrypted'],
    ['channel_encrypted', '#general is end-to-end encrypted'],
    ['cannot_send', `${ACCOUNT} may not post in #gone:example.org.`],
    ['room_in_use', 'already bridged to another Harmony channel'],
    ['ghosts_unavailable', "can't add Matrix users"],
    ['harmony_not_bound', "hasn't linked"],
    ['M_WEIRD: the homeserver said no', 'M_WEIRD: the homeserver said no'],
    [null, 'The bridge gave no reason.'],
  ])('explains the error %s', (error, text) => {
    open(rawReady({ pairs: [rawPair({ room_id: null, room_alias: '#gone:example.org', state: 'error', state_error: error })] }))
    expect(byTest('matrix-pair-badge').text()).toBe('Not working')
    expect(byTest('matrix-pair-error').text()).toContain(text)
  })

  it('renders a hostile room name as text', () => {
    open(rawReady({ snapshot: { rooms: [{ ...ROOMS[0], name: '<img src=x onerror=alert(1)>' }] }, pairs: [rawPair()] }))
    expect(w.find('img').exists()).toBe(false)
    expect(byTest('matrix-pair-room').text()).toBe('<img src=x onerror=alert(1)>')
  })

  it('changes the direction and how members appear through the pair, under the alias it was named by', async () => {
    open(rawReady({ pairs: [rawPair()] }))
    const select = byTest('matrix-pair-direction').element as HTMLSelectElement
    select.value = 'to_harmony'
    select.dispatchEvent(new Event('change'))
    // The saved value stands until the server confirms another.
    expect(select.value).toBe('both')
    await flushPromises()
    await byTest('matrix-pair-mode').setValue('relay')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_pair')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general', p_room: '#general:example.org', p_direction: 'to_harmony', p_sender_mode: 'ghost' },
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general', p_room: '#general:example.org', p_direction: 'both', p_sender_mode: 'relay' },
    ])
    expect(rpcCalls('set_matrix_bridge_sender_mode')).toEqual([])
    expect(w.emitted('state')).toHaveLength(2)
  })

  it('reports a change that was not saved', async () => {
    fail = { name: 'matrix_bridge_pair', error: new Error('secret') }
    open(rawReady({ pairs: [rawPair()] }))
    await byTest('matrix-pair-direction').setValue('to_harmony')
    await flushPromises()
    expect(byTest('matrix-pairs-error').text()).toBe("Couldn't save the change. Try again.")
    expect(w.text()).not.toContain('secret')
    expect(byTest('matrix-pair-direction').attributes('disabled')).toBeUndefined()
  })

  it('removes a pair, naming both sides', async () => {
    answer = rawReady()
    open(rawReady({ pairs: [rawPair()] }))
    expect(byTest('pair-remove').attributes('aria-label')).toBe('Remove the pair #general and General')
    await byTest('pair-remove').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_unpair')).toEqual([{ p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general' }])
    expect((w.emitted('state')![0][0] as { pairs: unknown[] }).pairs).toEqual([])
  })

  it('lets a pair of a channel the manager cannot see be removed only', () => {
    open(rawReady({ pairs: [rawPair({ channel_id: 'hidden' })] }))
    expect(card().text()).toContain("A channel you can't see")
    expect(byTest('matrix-pair-direction').exists()).toBe(false)
    expect(byTest('pair-remove').exists()).toBe(true)
  })

  it('no longer offers a paired channel or room', () => {
    open(rawReady({ pairs: [rawPair()] }))
    expect(options('select-harmony').map((o) => o.text)).not.toContain('#general')
    expect(options('select-room').map((o) => o.text)).not.toContain('General (#general:example.org)')
  })
})
