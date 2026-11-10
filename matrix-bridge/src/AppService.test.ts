import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppService } from './AppService.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })))
})
async function setup(acceptTransaction = vi.fn().mockReturnValue(true), ownsGhost?: (id: string) => boolean) {
  const server = createAppService({ hsToken: 'private-token', botUserId: '@relay:test', ownsGhost, acceptTransaction, status: () => ({ ready: true, pending: 0, failed: 0 }) })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = (body: string, headers: Record<string, string> = { Authorization: 'Bearer private-token' }, path = '/_matrix/app/v1/transactions/one') => fetch(base + path, { method: 'PUT', body, headers })
  return { base, put, acceptTransaction }
}

describe('application-service HTTP', () => {
  it('authenticates before parsing JSON and does not accept query-string credentials', async () => {
    const { put, acceptTransaction } = await setup()
    expect((await put('not JSON', {})).status).toBe(401)
    expect((await put('{}', {}, '/_matrix/app/v1/transactions/one?access_token=private-token')).status).toBe(401)
    expect(acceptTransaction).not.toHaveBeenCalled()
  })
  it('acknowledges durable acceptance and duplicate transactions identically', async () => {
    const { put, acceptTransaction } = await setup(vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false))
    const event = { type: 'm.room.message', event_id: '$one', content: { body: 'hello', msgtype: 'm.text' } }
    for (let i = 0; i < 2; i++) {
      const response = await put(JSON.stringify({ events: [event] }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({})
    }
    expect(acceptTransaction).toHaveBeenCalledWith('one', [event])
  })
  it('does not acknowledge storage failures or expose exception contents', async () => {
    const { put } = await setup(vi.fn().mockImplementation(() => { throw new Error('secret-token') }))
    const response = await put('{"events":[]}')
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret-token')
  })
  it('bounds request bodies, validates transaction shape and handles malformed IDs', async () => {
    const { put, acceptTransaction } = await setup()
    expect((await put('not JSON')).status).toBe(400)
    expect((await put('{"events":{}}')).status).toBe(400)
    expect((await put('{"events":[]}', undefined, '/_matrix/app/v1/transactions/%zz')).status).toBe(400)
    expect((await put('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
    expect(acceptTransaction).not.toHaveBeenCalled()
  })
  it('answers only durably owned ghosts without provisioning unknown namespace users', async () => {
    const ghost = '@relay_h_11111111111141118111111111111111:test'
    const ownsGhost = vi.fn(id => id === ghost)
    const { base } = await setup(undefined, ownsGhost)
    const path = '/_matrix/app/v1/users/' + encodeURIComponent(ghost)
    expect((await fetch(base + path)).status).toBe(401)
    expect(ownsGhost).not.toHaveBeenCalled()
    const headers = { Authorization: 'Bearer private-token' }
    expect((await fetch(base + path, { headers })).status).toBe(200)
    expect((await fetch(base + '/_matrix/app/v1/users/%40relay_h_22222222222242228222222222222222%3Atest', { headers })).status).toBe(404)
  })
  it('answers only its exact user namespace and exposes no secrets in health', async () => {
    const { base } = await setup()
    const headers = { Authorization: 'Bearer private-token' }
    expect((await fetch(base + '/_matrix/app/v1/users/%40relay%3Atest', { headers })).status).toBe(200)
    expect((await fetch(base + '/_matrix/app/v1/users/%40other%3Atest', { headers })).status).toBe(404)
    const health = await fetch(base + '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ready: true, pending: 0, failed: 0 })
  })
})
