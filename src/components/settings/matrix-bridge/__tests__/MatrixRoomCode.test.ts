/** MatrixRoomCode.vue and the instance's pairs: the code, whom to invite, what to post, and a room that moved away. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { HARMONY_CHANNELS, NOW, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import MatrixManagedPairs from '../MatrixManagedPairs.vue'
import { ACCOUNT, BRIDGE_ID, READY_STATUS, parsed, rawPair, rawReady } from './matrixTestKit'

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const INVITE = '@harmony:instance.example'
let w: VueWrapper
let codes: string[]
let fail: Error | null
let user: string | null

const instance = (overrides: Record<string, unknown> = {}) => rawReady({ mode: 'instance', ...overrides })
const linked = (overrides: Record<string, unknown> = {}) => rawPair({ room_alias: null, ...overrides })
const lost = rawPair({ room_id: null, room_alias: null, state: 'error', state_error: 'room_in_use' })

function open(raw = instance(), props: Record<string, unknown> = {}) {
  w = mount(MatrixManagedPairs, {
    props: { bridge: parsed(raw), harmonyChannels: HARMONY_CHANNELS, encryptedChannelIds: [], now: NOW, ...props },
    attachTo: document.body,
    global: { plugins: [makeI18n()], stubs: { Icon: iconStub } },
  })
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const copied = (id: string) => w.find(`[data-testid="${id}"] pre`).text()
const submit = async () => { await byTest('pair-form').trigger('submit'); await flushPromises() }
async function getCode(channel = 'h-news') {
  await byTest('select-harmony').setValue(channel)
  await submit()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  missingKeys.length = 0
  fail = null
  user = INVITE
  codes = ['ML-AAAA-BBBB-CCCC', 'ML-DDDD-EEEE-FFFF']
  installBackend({}, (name) => {
    if (fail) throw fail
    if (name === 'matrix_bridge_room_code') return { code: codes.shift(), expires_at: '2026-11-25T12:30:00Z', user_id: user }
    return instance({ pairs: [linked()] })
  })
})
afterEach(() => {
  w?.unmount()
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('the code', () => {
  it('replaces the room list: a channel, a direction and how members appear', () => {
    open(instance(), { encryptedChannelIds: ['h-memes'] })
    expect(byTest('select-room').exists()).toBe(false)
    expect(byTest('room-address').exists()).toBe(false)
    expect(byTest('matrix-invite-hint').exists()).toBe(false)
    expect(byTest('select-harmony').findAll('option').find((o) => o.text() === '#memes (end-to-end encrypted)')!.attributes('disabled')).toBeDefined()
    expect(byTest('matrix-encrypted-note').text()).toContain("an encrypted room can't be linked")
    expect(byTest('select-mode').exists()).toBe(true)
  })

  it('shows the account to invite, the message to post, who may post it and that the room moves', async () => {
    open()
    await byTest('select-direction').setValue('to_harmony')
    await byTest('select-mode').setValue('relay')
    await getCode()
    expect(rpcCalls('matrix_bridge_room_code')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-news', p_direction: 'to_harmony', p_sender_mode: 'relay' },
    ])
    expect(copied('matrix-code-account')).toBe(INVITE)
    expect(copied('matrix-code-command')).toBe('!harmony link ML-AAAA-BBBB-CCCC')
    expect(byTest('matrix-code-expiry').text()).toBe('expires in 30 minutes')
    expect(byTest('matrix-code-panel').text()).toContain("someone who may change the room's settings")
    expect(byTest('matrix-code-panel').text()).toContain('moves here from whatever it was linked with before')
    expect(document.activeElement?.tagName).toBe('H4')
    expect(document.activeElement?.textContent).toBe('Link #news with a Matrix room')
    expect(byTest('get-room-code').exists()).toBe(false)
  })

  it('expires, and a new one takes its place', async () => {
    open(instance(), { now: NOW - 4000 })
    await getCode()
    expect(byTest('matrix-code-expiry').text()).toBe('expires in 30 minutes')
    await w.setProps({ now: NOW + 30 * 60_000 })
    expect(byTest('matrix-code-expired').attributes('role')).toBe('alert')
    vi.setSystemTime(NOW + 30 * 60_000)
    await byTest('new-room-code').trigger('click')
    await flushPromises()
    expect(copied('matrix-code-command')).toBe('!harmony link ML-DDDD-EEEE-FFFF')
    expect(byTest('matrix-code-expired').exists()).toBe(false)
    expect(rpcCalls('matrix_bridge_room_code').map((c) => c.p_channel_id)).toEqual(['h-news', 'h-news'])
  })

  it('is closed by the pair that appears, and says so', async () => {
    open()
    await getCode('h-general')
    await w.setProps({ bridge: parsed(instance({ pairs: [linked()] })) })
    await flushPromises()
    expect(byTest('matrix-code-panel').exists()).toBe(false)
    expect(byTest('matrix-linked').attributes('role')).toBe('status')
    expect(byTest('matrix-linked').text()).toBe('#general is linked with General.')
    expect(byTest('get-room-code').exists()).toBe(true)
  })

  it('belongs to its channel: choosing another drops it', async () => {
    open()
    await getCode('h-news')
    await byTest('select-harmony').setValue('h-memes')
    await flushPromises()
    expect(byTest('matrix-code-panel').exists()).toBe(false)
    expect(byTest('get-room-code').exists()).toBe(true)
  })

  it.each([
    ['select-direction', 'to_matrix'],
    ['select-mode', 'relay'],
  ])('carries what it was made with: another %s drops it', async (select, value) => {
    open()
    await getCode('h-news')
    await byTest(select).setValue(value)
    await flushPromises()
    expect(byTest('matrix-code-panel').exists()).toBe(false)
    expect(byTest('get-room-code').exists()).toBe(true)
  })

  it('falls back to the account the bridge reports, and says when none is known', async () => {
    user = null
    open()
    await getCode()
    expect(copied('matrix-code-account')).toBe(ACCOUNT)
    await w.setProps({ bridge: parsed(instance({ status: { ...READY_STATUS, user_id: null } })) })
    expect(byTest('matrix-code-no-account').text()).toContain("isn't known yet")
  })

  it('sends relay for an account, whose messages have one sender', async () => {
    open(instance({ connection: 'account' }))
    expect(byTest('select-mode').exists()).toBe(false)
    await getCode()
    expect(rpcCalls('matrix_bridge_room_code')[0].p_sender_mode).toBe('relay')
  })

  it.each([
    [Object.assign(new Error('off'), { code: '0A000' }), "doesn't offer that at the moment"],
    [Object.assign(new Error('secret'), { code: '22023' }), "Couldn't get a code. Try again."],
  ])('says why there is none', async (error, text) => {
    fail = error
    open()
    await getCode()
    expect(byTest('pair-error').text()).toContain(text)
    expect(w.text()).not.toContain('secret')
    fail = null
    await byTest('select-harmony').setValue('')
    await submit()
    expect(byTest('pair-error').text()).toBe('Choose a Harmony channel.')
    expect(rpcCalls('matrix_bridge_room_code')).toHaveLength(1)
  })
})

describe('the pairs', () => {
  it('change direction and sender mode with their own room', async () => {
    open(instance({ pairs: [linked()] }))
    await byTest('matrix-pair-direction').setValue('to_matrix')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_pair')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general', p_room: '!general:example.org', p_direction: 'to_matrix', p_sender_mode: 'ghost' },
    ])
  })

  it.each([
    ['as the database reports it', lost],
    ['whatever the bridge reports since', rawPair({ room_id: null, room_alias: null, state: 'joining', state_error: null })],
  ])('say that their room moved away, %s, and take a new code', async (_how, pair) => {
    open(instance({ pairs: [pair] }))
    const card = byTest('matrix-managed-pair')
    expect(card.attributes('data-state')).toBe('error')
    expect(byTest('matrix-pair-badge').text()).toBe('Not working')
    expect(byTest('matrix-pair-error').text()).toBe('The room was linked with another channel by a newer code. Link #general again with a code of its own.')
    expect(byTest('matrix-pair-room').text()).toBe('No room')
    expect(byTest('matrix-pair-direction').exists()).toBe(false)
    await byTest('pair-relink').trigger('click')
    await flushPromises()
    expect((byTest('select-harmony').element as HTMLSelectElement).value).toBe('h-general')
    expect(document.activeElement).toBe(byTest('select-harmony').element)
    await submit()
    expect(rpcCalls('matrix_bridge_room_code')[0].p_channel_id).toBe('h-general')
    expect(byTest('matrix-code-panel').exists()).toBe(true)
    await w.setProps({ bridge: parsed(instance({ pairs: [linked()] })) })
    await flushPromises()
    expect(byTest('matrix-linked').exists()).toBe(true)
  })

  it('that lost their room keep their direction and sender mode in the new code', async () => {
    open(instance({ pairs: [{ ...lost, direction: 'to_harmony', sender_mode: 'relay' }] }))
    await byTest('pair-relink').trigger('click')
    await flushPromises()
    await submit()
    expect(rpcCalls('matrix_bridge_room_code')[0]).toMatchObject({ p_channel_id: 'h-general', p_direction: 'to_harmony', p_sender_mode: 'relay' })
  })

  it('are removed as others are', async () => {
    open(instance({ pairs: [linked()] }))
    await byTest('pair-remove').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_unpair')).toEqual([{ p_bridge_id: BRIDGE_ID, p_channel_id: 'h-general' }])
  })
})
