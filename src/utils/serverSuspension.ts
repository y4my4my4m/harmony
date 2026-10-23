import type { Server } from '@/types'

/**
 * Banner of a server suspended by instance staff of its host (servers.suspended_at,
 * 20261027250001): the instance whose staff suspended it, and their reason.
 */
export function serverSuspension(
  server: Pick<Server, 'suspended_at' | 'suspended_reason' | 'is_local_server' | 'federation_domain'> | null | undefined,
  localDomain: string,
): { instance: string; reason: string | null } | null {
  if (!server?.suspended_at) return null
  return {
    instance: server.is_local_server === false && server.federation_domain ? server.federation_domain : localDomain,
    reason: server.suspended_reason?.trim() || null,
  }
}
