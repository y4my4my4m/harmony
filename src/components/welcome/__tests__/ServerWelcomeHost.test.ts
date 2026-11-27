/**
 * The welcome screen host asks for the screen of every server the user opens, a copy of a server
 * hosted elsewhere included: the copy holds the host's screen (federation backend groupWelcome.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const { visit, channelStore } = vi.hoisted(() => ({
  visit: vi.fn(async () => undefined),
  channelStore: { currentServerId: null as string | null, servers: [] as Array<Record<string, unknown>> },
}))

vi.mock('@/stores/useServerWelcome', () => ({
  useServerWelcomeStore: () => ({ current: null, busy: false, error: null, visit, dismiss: vi.fn(), accept: vi.fn() }),
}))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => store }))

const store = reactive(channelStore)

import ServerWelcomeHost from '../ServerWelcomeHost.vue'

enableAutoUnmount(afterEach)

const mountHost = (isDm = false) => mount(ServerWelcomeHost, {
  props: { isDm },
  global: { stubs: { BaseModal: true, ServerWelcomeScreen: true } },
})

beforeEach(() => {
  visit.mockClear()
  store.currentServerId = null
  store.servers = [
    { id: 'local-1', is_local_server: true },
    { id: 'copy-1', is_local_server: false },
  ]
})

describe('ServerWelcomeHost', () => {
  it.each(['local-1', 'copy-1'])('asks for the screen of %s', (id) => {
    store.currentServerId = id
    mountHost()
    expect(visit).toHaveBeenCalledWith(id)
  })

  it('asks for nothing in direct messages, or for a server the user is not in', () => {
    store.currentServerId = 'copy-1'
    mountHost(true)
    store.currentServerId = 'gone-1'
    mountHost()
    expect(visit).not.toHaveBeenCalled()
  })
})
