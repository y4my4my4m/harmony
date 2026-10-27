/**
 * Entering a copy of a server hosted elsewhere reads it again from its host, at most once per ten
 * minutes a server; a successful read ends with the role-change event the role views reload on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { syncServer } = vi.hoisted(() => ({ syncServer: vi.fn() }))
vi.mock('@/services/federation/FederationServerService', () => ({ federationServerService: { syncServer } }))

import { resetRemoteServerSync, syncRemoteServerCopy } from '../remoteServerSync'

const copy = { id: 'ref', is_local_server: false }

beforeEach(() => {
  resetRemoteServerSync()
  syncServer.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('remote server sync', () => {
  it('reads a copy from its host and announces the role change', async () => {
    syncServer.mockResolvedValue({ success: true })
    const events: string[] = []
    const listener = (e: Event) => events.push((e as CustomEvent).detail?.new?.server_id)
    window.addEventListener('server-structure:role-change', listener)
    await syncRemoteServerCopy(copy)
    window.removeEventListener('server-structure:role-change', listener)
    expect(syncServer).toHaveBeenCalledWith('ref')
    expect(events).toEqual(['ref'])
  })

  it('reads no local server', async () => {
    await syncRemoteServerCopy({ id: 'local', is_local_server: true })
    await syncRemoteServerCopy({ id: 'unknown' })
    await syncRemoteServerCopy(null)
    expect(syncServer).not.toHaveBeenCalled()
  })

  it('reads a copy again only after ten minutes', async () => {
    syncServer.mockResolvedValue({ success: true })
    await syncRemoteServerCopy(copy)
    await syncRemoteServerCopy(copy)
    expect(syncServer).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(10 * 60_000)
    await syncRemoteServerCopy(copy)
    expect(syncServer).toHaveBeenCalledTimes(2)
  })

  it('announces nothing when the read fails', async () => {
    syncServer.mockResolvedValue({ success: false, error: 'down' })
    const listener = vi.fn()
    window.addEventListener('server-structure:role-change', listener)
    await syncRemoteServerCopy(copy)
    window.removeEventListener('server-structure:role-change', listener)
    expect(listener).not.toHaveBeenCalled()
  })
})
