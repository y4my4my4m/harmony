/**
 * deliver-outgoing-webhook: one attempt of one outgoing webhook delivery
 * (services/OutgoingWebhookSender.ts). A failed attempt is rescheduled by the database, and the
 * sweep queues it again when due; only a database error fails the job.
 */

import { deliverOutgoingWebhook } from '../../services/OutgoingWebhookSender.js';
import type { FederationJobData } from '../BullMQManager.js';

export async function handleOutgoingWebhookJob(data: FederationJobData): Promise<void> {
  const deliveryId = (data as { delivery_id?: unknown }).delivery_id;
  if (typeof deliveryId !== 'string') return;
  await deliverOutgoingWebhook(deliveryId);
}
