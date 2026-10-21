/**
 * Remote servers whose Group refuses members from other instances: harmony:federationEnabled
 * false (federation-backend GET /servers/:id/status). Their Remove never reached this instance (an
 * older host, a lost delivery, a server closed before its host upgraded), so the membership is
 * still here and the server has gone silent. The server view says why, with a Leave button.
 * Checked on entering the server, at most once per RECHECK_MS.
 */
import { reactive } from 'vue'
import { federationServerService } from '@/services/federation/FederationServerService'

const RECHECK_MS = 10 * 60_000

const closed = reactive(new Set<string>())
const checkedAt = new Map<string, number>()

export function isRemoteServerClosed(serverId: string | null | undefined): boolean {
  return !!serverId && closed.has(serverId)
}

export async function checkRemoteServer(server: { id: string; is_local_server?: boolean } | null | undefined): Promise<void> {
  if (!server?.id || server.is_local_server !== false) return
  const last = checkedAt.get(server.id)
  if (last !== undefined && Date.now() - last < RECHECK_MS) return
  checkedAt.set(server.id, Date.now())

  const status = await federationServerService.serverStatus(server.id)
  if (!status) return
  if (status.federationClosed) closed.add(server.id)
  else closed.delete(server.id)
}

export function resetRemoteServerStatus(): void {
  closed.clear()
  checkedAt.clear()
}
