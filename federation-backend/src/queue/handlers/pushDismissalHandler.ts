/**
 * Cancels notifications on the user's Android installations once they are read or deleted
 * elsewhere. Jobs are queued by queue_push_dismissal (migration 20261004100001).
 */

import { PushNotificationService } from '../../services/PushNotificationService.js';
import { logger } from '../../utils/logger.js';

export interface PushDismissalJobData {
  user_id: string;
  /** null together with all = true: every notification of the user. */
  ids: string[] | null;
  all: boolean;
}

export async function handlePushDismissalJob(data: PushDismissalJobData): Promise<void> {
  if (!data?.user_id) {
    logger.warn('Push dismissal job without user_id, dropped');
    return;
  }
  const ids = data.all || !Array.isArray(data.ids) ? null : data.ids.filter((id) => typeof id === 'string');
  if (ids !== null && ids.length === 0) return;
  await PushNotificationService.sendDismissal(data.user_id, ids);
}
