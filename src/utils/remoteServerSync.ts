/**
 * The copy of a server hosted elsewhere, read again from its host on entering it (federation-backend
 * GET /servers/:id/sync, as the signed-in member): channels and their order, roles, members' roles
 * and pins. A copy joined before its host published roles and pins gets them here. At most once per
 * RESYNC_MS a server after a sync that succeeded; a failed one is retried on the next entry. The
 * views showing roles reload on the role-change event it ends with.
 */
import { federationServerService } from '@/services/federation/FederationServerService'

const RESYNC_MS = 10 * 60_000

const syncedAt = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
// Sign-out generation: a read started in an earlier one is dropped.
let epoch = 0

export function syncRemoteServerCopy(server: { id: string; is_local_server?: boolean } | null | undefined): Promise<void> {
  if (!server?.id || server.is_local_server !== false) return Promise.resolve()
  const id = server.id
  const last = syncedAt.get(id)
  if (last !== undefined && Date.now() - last < RESYNC_MS) return Promise.resolve()
  const running = inFlight.get(id)
  if (running) return running

  const started = epoch
  const run = federationServerService.syncServer(id).then((result) => {
    if (started !== epoch || !result.success) return
    syncedAt.set(id, Date.now())
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('server-structure:role-change', { detail: { new: { server_id: id } } }))
  }).finally(() => {
    if (started === epoch) inFlight.delete(id)
  })
  inFlight.set(id, run)
  return run
}

/** Forgets every sync time and drops answers still in flight: they belong to the account signed out. */
export function resetRemoteServerSync(): void {
  epoch++
  syncedAt.clear()
  inFlight.clear()
}
