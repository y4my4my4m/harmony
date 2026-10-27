/**
 * Entering a copy of a server hosted elsewhere reads it again from its host, at most once per ten
 * minutes a server after a read that succeeded; a successful read ends with the role-change event
 * the role views reload on. A failed read is tried again on the next entry. Sign-out forgets it all.
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

  it('reads a copy again on the next entry after a failed read', async () => {
    syncServer.mockResolvedValueOnce({ success: false, error: 'down' })
    syncServer.mockResolvedValue({ success: true })
    await syncRemoteServerCopy(copy)
    await syncRemoteServerCopy(copy)
    expect(syncServer).toHaveBeenCalledTimes(2)
    await syncRemoteServerCopy(copy)
    expect(syncServer).toHaveBeenCalledTimes(2)
  })

  it('reads a copy once while a read is in flight', async () => {
    let answer: (value: { success: boolean }) => void = () => {}
    syncServer.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const first = syncRemoteServerCopy(copy)
    const second = syncRemoteServerCopy(copy)
    answer({ success: true })
    await Promise.all([first, second])
    expect(syncServer).toHaveBeenCalledOnce()
  })

  it('reads a copy again after sign-out', async () => {
    syncServer.mockResolvedValue({ success: true })
    await syncRemoteServerCopy(copy)
    resetRemoteServerSync()
    await syncRemoteServerCopy(copy)
    expect(syncServer).toHaveBeenCalledTimes(2)
  })

  it('drops an answer that arrives after sign-out', async () => {
    let answer: (value: { success: boolean }) => void = () => {}
    syncServer.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    syncServer.mockResolvedValue({ success: true })
    const listener = vi.fn()
    window.addEventListener('server-structure:role-change', listener)
    const stale = syncRemoteServerCopy(copy)
    resetRemoteServerSync()
    answer({ success: true })
    await stale
    expect(listener).not.toHaveBeenCalled()
    await syncRemoteServerCopy(copy)
    window.removeEventListener('server-structure:role-change', listener)
    expect(syncServer).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledOnce()
  })
})
