/**
 * A remote channel's cached rows are checked against the host once per session: the
 * federation backend inserts the rows the cache lacks and completes rows cached without their
 * files, and reports how many changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSession = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { auth: { getSession } } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: {} }))
vi.mock('@/services/userDataService', () => ({ userDataService: {} }))

import { CoreMessageService } from '@/services/core/CoreMessageService'

const fetchMock = vi.fn()
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const service = () => CoreMessageService.getInstance()

describe('CoreMessageService.refreshRemoteChannel', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports rows the host page added or completed, as the member', async () => {
    fetchMock.mockResolvedValueOnce(answer({ source: 'remote', changed: 3, messages: [] }))
    expect(await service().refreshRemoteChannel('r1')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/federation/channels/r1/messages?limit=50')
    expect(init.headers.Authorization).toBe('Bearer token')
  })

  it('asks once per channel per session', async () => {
    fetchMock.mockResolvedValue(answer({ source: 'remote', changed: 1, messages: [] }))
    expect(await service().refreshRemoteChannel('r2')).toBe(true)
    expect(await service().refreshRemoteChannel('r2')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports nothing for an unchanged page, the backend\'s cache, or a failure', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ source: 'remote', changed: 0, messages: [] }))
      .mockResolvedValueOnce(answer({ source: 'cache', messages: [] }))
      .mockResolvedValueOnce(answer({ error: 'Channel not found' }, 404))
      .mockRejectedValueOnce(new TypeError('network'))
    expect(await service().refreshRemoteChannel('r3')).toBe(false)
    expect(await service().refreshRemoteChannel('r4')).toBe(false)
    expect(await service().refreshRemoteChannel('r5')).toBe(false)
    expect(await service().refreshRemoteChannel('r6')).toBe(false)
  })

  it('asks again on the next open when the host did not answer', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ error: 'Bad gateway' }, 502))
      .mockResolvedValueOnce(answer({ source: 'cache', messages: [] }))
      .mockResolvedValueOnce(answer({ source: 'remote', changed: 2, messages: [] }))
    expect(await service().refreshRemoteChannel('r8')).toBe(false)
    expect(await service().refreshRemoteChannel('r8')).toBe(false)
    expect(await service().refreshRemoteChannel('r8')).toBe(true)
    expect(await service().refreshRemoteChannel('r8')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('asks nothing without a session', async () => {
    getSession.mockResolvedValueOnce({ data: { session: null } })
    expect(await service().refreshRemoteChannel('r7')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
