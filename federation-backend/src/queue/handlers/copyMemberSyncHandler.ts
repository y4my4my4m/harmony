/**
 * copy-member-sync: one read of the members of a server hosted elsewhere, and of their roles, into
 * its copy (ServerDiscoveryService.runMemberSync). Deduplicated by `copy-member-sync:<server_id>`:
 * at most one job per server waits or runs.
 *
 *   { server_id, sign_as }   the copy, and the local member whose key signs the reads
 */

import type { FederationJobData } from '../BullMQManager.js';

export async function handleCopyMemberSyncJob(data: FederationJobData): Promise<void> {
  const { server_id: serverId, sign_as: signAs } = data;
  if (typeof serverId !== 'string' || typeof signAs !== 'string') return;
  const { ServerDiscoveryService } = await import('../../services/ServerDiscoveryService.js');
  await ServerDiscoveryService.runMemberSync(serverId, signAs);
}
