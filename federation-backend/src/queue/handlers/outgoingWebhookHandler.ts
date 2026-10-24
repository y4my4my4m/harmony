/**
 * deliver-outgoing-webhook: one attempt of one outgoing webhook delivery
 * (services/OutgoingWebhookSender.ts). A failed attempt is rescheduled by the database, and the
 * sweep queues it again when due; a deferred claim queues the job again after its delay; only a
 * database error fails the job.
 */

import { deliverOutgoingWebhook } from '../../services/OutgoingWebhookSender.js';
import { bullmqManager, type FederationJobData } from '../BullMQManager.js';

export async function handleOutgoingWebhookJob(data: FederationJobData): Promise<void> {
  const deliveryId = (data as { delivery_id?: unknown }).delivery_id;
  if (typeof deliveryId !== 'string') return;
  const deferMs = await deliverOutgoingWebhook(deliveryId);
  if (deferMs != null) await bullmqManager.addJob('deliver-outgoing-webhook', data, deferMs);
}
