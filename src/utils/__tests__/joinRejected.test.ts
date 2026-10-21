/**
 * A late Reject of a federated join: the server leaves the list, and a view on it moves to the
 * chat home; a view elsewhere stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { leave, push, route } = vi.hoisted(() => ({
  leave: vi.fn(),
  push: vi.fn(async () => {}),
  route: { value: { params: {} as Record<string, string> } },
}))

vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ _handleUserServerLeave: leave }) }))
vi.mock('@/router', () => ({ default: { currentRoute: route, push } }))

import { forgetRejectedServer } from '../joinRejected'

beforeEach(() => {
  leave.mockClear()
  push.mockClear()
})

describe('forgetRejectedServer', () => {
  it('removes the server and leaves its view', async () => {
    route.value = { params: { serverId: 'ref', channelId: 'c1' } }
    await forgetRejectedServer('ref')
    expect(leave).toHaveBeenCalledWith({ old: { server_id: 'ref' } })
    expect(push).toHaveBeenCalledWith('/chat')
  })

  it('stays where the user is when another server is open', async () => {
    route.value = { params: { serverId: 'other', channelId: 'c2' } }
    await forgetRejectedServer('ref')
    expect(leave).toHaveBeenCalledOnce()
    expect(push).not.toHaveBeenCalled()
  })

  it('does nothing without a server id', async () => {
    await forgetRejectedServer(undefined)
    expect(leave).not.toHaveBeenCalled()
  })
})
