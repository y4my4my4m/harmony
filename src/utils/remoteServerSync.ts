/**
 * The copy of a server hosted elsewhere, read again from its host on entering it (federation-backend
 * GET /servers/:id/sync, as the signed-in member): channels and their order, roles, members' roles
 * and pins. A copy joined before its host published roles and pins gets them here. At most once per
 * RESYNC_MS a server; the views showing roles reload on the role-change event it ends with.
 */
import { federationServerService } from '@/services/federation/FederationServerService'

const RESYNC_MS = 10 * 60_000

const syncedAt = new Map<string, number>()

export async function syncRemoteServerCopy(server: { id: string; is_local_server?: boolean } | null | undefined): Promise<void> {
  if (!server?.id || server.is_local_server !== false) return
  const last = syncedAt.get(server.id)
  if (last !== undefined && Date.now() - last < RESYNC_MS) return
  syncedAt.set(server.id, Date.now())

  const result = await federationServerService.syncServer(server.id)
  if (!result.success || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('server-structure:role-change', { detail: { new: { server_id: server.id } } }))
}

export function resetRemoteServerSync(): void {
  syncedAt.clear()
}
