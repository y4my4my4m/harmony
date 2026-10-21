/**
 * A remote server whose Group refuses members from other instances is shown as closed; only
 * remote servers are asked about, at most once per ten minutes, and an unanswered check changes
 * nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { serverStatus } = vi.hoisted(() => ({ serverStatus: vi.fn() }))
vi.mock('@/services/federation/FederationServerService', () => ({ federationServerService: { serverStatus } }))

import { checkRemoteServer, isRemoteServerClosed, resetRemoteServerStatus } from '../remoteServerStatus'

const remote = { id: 'ref', is_local_server: false }

beforeEach(() => {
  resetRemoteServerStatus()
  serverStatus.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('remote server status', () => {
  it('marks a remote server whose Group is closed', async () => {
    serverStatus.mockResolvedValue({ federationClosed: true })
    await checkRemoteServer(remote)
    expect(serverStatus).toHaveBeenCalledWith('ref')
    expect(isRemoteServerClosed('ref')).toBe(true)
  })

  it('asks nothing about a local server', async () => {
    await checkRemoteServer({ id: 'local', is_local_server: true })
    await checkRemoteServer({ id: 'unknown' })
    expect(serverStatus).not.toHaveBeenCalled()
  })

  it('asks again only after ten minutes, and clears a server that opened again', async () => {
    serverStatus.mockResolvedValue({ federationClosed: true })
    await checkRemoteServer(remote)
    await checkRemoteServer(remote)
    expect(serverStatus).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(10 * 60_000)
    serverStatus.mockResolvedValue({ federationClosed: false })
    await checkRemoteServer(remote)
    expect(serverStatus).toHaveBeenCalledTimes(2)
    expect(isRemoteServerClosed('ref')).toBe(false)
  })

  it('keeps what it knew when the check gets no answer', async () => {
    serverStatus.mockResolvedValueOnce({ federationClosed: true })
    await checkRemoteServer(remote)
    vi.advanceTimersByTime(10 * 60_000)
    serverStatus.mockResolvedValueOnce(null)
    await checkRemoteServer(remote)
    expect(isRemoteServerClosed('ref')).toBe(true)
  })
})
