import { getSupabaseClient } from '../config/supabase.js';
import { SignatureService } from './SignatureService.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import { performanceMonitor } from '../services/PerformanceMonitor.js';
import { logger } from '../utils/logger.js';
import { validateExternalUrl, safeFetch } from '../utils/ssrfProtection.js';

const MAX_CONCURRENT_DOMAINS = 10;

function parseInboxDomain(inboxUrl: string): string | null {
  try {
    return new URL(inboxUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) {
    return [];
  }

  const results: PromiseSettledResult<T>[] = [];
  let idx = 0;

  async function next(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason: any) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: workerCount }, () => next());
  await Promise.all(workers);
  return results;
}

interface QueueItem {
  id: string;
  activity_data: any;
  target_inbox_url: string;  // Database uses target_inbox_url (not target_inbox)
  sender_id: string | null;  // May be NULL for legacy items
  actor_username: string | null;  // Fallback for resolving sender
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;  // Database column name (not next_retry_at)
}

export class DeliveryQueue {
  /**
   * Add an activity to the delivery queue and try to deliver immediately
   * For realtime federation - tries immediate delivery first, queues only if it fails
   */
  static async enqueue(
    activityData: any,
    targetInbox: string,
    senderId: string,
    priority: number = 5
  ): Promise<void> {
    logger.info(`📤 Attempting immediate delivery to ${targetInbox}`);

    try {
      const success = await this.deliverActivityDirect(
        activityData,
        targetInbox,
        senderId
      );
      
      if (success) {
        logger.info(`✅ Immediate delivery succeeded to ${targetInbox}`);
        return;
      }
    } catch (error) {
      logger.warn(`⚠️ Immediate delivery failed, queuing for retry:`, error);
    }

    const supabase = getSupabaseClient();

    const targetDomain = parseInboxDomain(targetInbox);
    if (!targetDomain) {
      logger.warn(`Invalid inbox URL, cannot queue for retry: ${targetInbox}`);
      return;
    }

    const { error } = await supabase.from('federation_delivery_queue').insert({
      activity_data: activityData,
      target_inbox_url: targetInbox,  // Database uses target_inbox_url
      target_domain: targetDomain,
      sender_id: senderId,
      priority,
      status: 'pending',
      attempts: 1, // Already tried once
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // Retry in 5 minutes
      last_attempt_at: new Date().toISOString(),
    });

    if (error) {
      logger.error('Failed to queue delivery for retry:', error);
      throw error;
    }

    logger.info(`📋 Queued for retry: ${targetInbox} (will retry in 5 minutes)`);
  }

  /**
   * Process pending deliveries from the queue.
   * Groups items by target domain and processes domains concurrently
   * (up to MAX_CONCURRENT_DOMAINS) while delivering sequentially within
   * each domain to avoid flooding a single remote server.
   */
  static async processQueue(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { data: items, error } = await supabase
      .from('federation_delivery_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', now)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(50);

    if (error || !items || items.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const byDomain = new Map<string, QueueItem[]>();
    for (const item of items) {
      try {
        const domain = new URL(item.target_inbox_url).hostname;
        const list = byDomain.get(domain) || [];
        list.push(item);
        byDomain.set(domain, list);
      } catch {
        // Invalid URL -- process individually
        const list = byDomain.get('__invalid__') || [];
        list.push(item);
        byDomain.set('__invalid__', list);
      }
    }

    let succeeded = 0;
    let failed = 0;

    const domainEntries = Array.from(byDomain.entries());
    const domainTasks = domainEntries.map(
      ([_domain, domainItems]) => async () => {
        let s = 0;
        let f = 0;
        for (const item of domainItems) {
          const success = await this.deliverActivity(item);
          if (success) s++;
          else f++;
        }
        return { s, f };
      }
    );

    const results = await runWithConcurrencyLimit(domainTasks, MAX_CONCURRENT_DOMAINS);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const itemCount = domainEntries[i][1].length;
      if (r.status === 'fulfilled') {
        succeeded += r.value.s;
        failed += r.value.f;
      } else {
        failed += itemCount;
        logger.error(`Domain delivery batch failed (${domainEntries[i][0]}):`, r.reason);
      }
    }

    logger.info(
      `Processed ${items.length} deliveries across ${byDomain.size} domains: ` +
      `${succeeded} succeeded, ${failed} failed`
    );

    return { processed: items.length, succeeded, failed };
  }

  /**
   * Check if an endpoint is marked as dead
   * Returns false if no record exists (endpoint not yet tracked)
   */
  private static async isEndpointDead(endpointUrl: string): Promise<boolean> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('federation_endpoint_health')
        .select('is_dead')
        .eq('endpoint_url', endpointUrl)
        .maybeSingle();
      
      if (error || !data) {
        return false;
      }
      
      return data.is_dead === true;
    } catch (error) {
      logger.warn(`Error checking endpoint health for ${endpointUrl}:`, error);
      return false;
    }
  }

  /**
   * Batch-check which endpoints are marked as dead.
   * Returns a Set of dead endpoint URLs.
   */
  private static async getDeadEndpoints(endpointUrls: string[]): Promise<Set<string>> {
    if (endpointUrls.length === 0) return new Set();
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('federation_endpoint_health')
        .select('endpoint_url')
        .in('endpoint_url', endpointUrls)
        .eq('is_dead', true);

      if (error || !data) return new Set();
      return new Set(data.map((d: any) => d.endpoint_url));
    } catch (error) {
      logger.warn('Error batch-checking endpoint health:', error);
      return new Set();
    }
  }

  /**
   * Update endpoint health tracking
   */
  private static async updateEndpointHealth(
    endpointUrl: string,
    domain: string,
    success: boolean,
    httpStatus?: number,
    errorMessage?: string
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('update_endpoint_health', {
      p_endpoint_url: endpointUrl,
      p_domain: domain,
      p_success: success,
      p_http_status: httpStatus || null,
      p_error_message: errorMessage || null,
    });

    if (error) {
      logger.warn(`Failed to update endpoint health for ${endpointUrl}:`, error);
    }
  }

  /**
   * Update federation_health (and last_seen via SQL) for instance-level tracking.
   */
  private static async updateFederationHealth(
    domain: string,
    success: boolean,
    latencyMs?: number,
    error?: string
  ): Promise<void> {
    const normalized = domain.toLowerCase();
    const supabase = getSupabaseClient();
    const { error: rpcError } = await supabase.rpc('update_federation_health', {
      p_instance_domain: normalized,
      p_success: success,
      p_latency_ms: latencyMs ?? null,
      p_error: error ?? null,
    });

    if (rpcError) {
      logger.warn(`Failed to update federation health for ${normalized}:`, rpcError);
    }
  }

  /**
   * Record delivery metrics and update federation_health (includes last_seen on success).
   */
  private static recordDeliveryOutcome(
    targetDomain: string,
    success: boolean,
    durationMs: number,
    activityData?: any,
    error?: string
  ): void {
    const activityType = typeof activityData?.type === 'string' ? activityData.type : undefined;
    performanceMonitor.recordMetric('federation_delivery', targetDomain, durationMs, 'ms', {
      labels: {
        target_domain: targetDomain,
        success,
        activity_type: activityType,
      },
    });
    void this.updateFederationHealth(targetDomain, success, durationMs, error);
  }

  /**
   * Deliver directly without queue management (for immediate delivery)
   */
  private static async deliverActivityDirect(
    activityData: any,
    targetInbox: string,
    senderId: string
  ): Promise<boolean> {
    const targetDomain = parseInboxDomain(targetInbox);
    if (!targetDomain) {
      logger.warn(`Invalid inbox URL, skipping delivery: ${targetInbox}`);
      return false;
    }

    if (BlockedInstancesCache.isBlocked(targetDomain)) {
      logger.info(`🚫 Skipping delivery to blocked instance: ${targetDomain}`);
      return false;
    }

    const isDead = await this.isEndpointDead(targetInbox);
    if (isDead) {
      logger.info(`⏭️ Skipping delivery to dead endpoint: ${targetInbox}`);
      return false;
    }

    // SSRF protection: validate inbox URL before fetching
    try {
      validateExternalUrl(targetInbox);
    } catch (err: any) {
      logger.warn(`🚫 SSRF: Blocked delivery to unsafe inbox URL: ${targetInbox} - ${err.message}`);
      return false;
    }

    const startedAt = process.hrtime.bigint();

    try {
      const { headers } = await SignatureService.signRequest(
        targetInbox,
        'POST',
        activityData,
        senderId
      );

      headers['Content-Type'] = 'application/activity+json';

      // safeFetch re-validates URL+DNS per redirect hop and applies a timeout;
      // the validateExternalUrl() check above is defense-in-depth.
      const response = await safeFetch(targetInbox, {
        method: 'POST',
        headers,
        body: JSON.stringify(activityData),
      });

      if (response.ok || response.status === 202) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        await this.updateEndpointHealth(targetInbox, targetDomain, true, response.status);
        this.recordDeliveryOutcome(targetDomain, true, durationMs, activityData);
        logger.info(`✅ Delivered to ${targetInbox} (${response.status})`);
        return true;
      } else {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        await this.updateEndpointHealth(
          targetInbox,
          targetDomain,
          false,
          response.status,
          `HTTP ${response.status}`
        );
        this.recordDeliveryOutcome(
          targetDomain,
          false,
          durationMs,
          activityData,
          `HTTP ${response.status}`
        );
        logger.warn(`❌ Failed to deliver to ${targetInbox}: ${response.status}`);
        return false;
      }
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateEndpointHealth(targetInbox, targetDomain, false, undefined, errorMessage);
      this.recordDeliveryOutcome(targetDomain, false, durationMs, activityData, errorMessage);
      logger.error(`❌ Delivery error to ${targetInbox}:`, error);
      return false;
    }
  }

  /**
   * Deliver a single activity to a remote inbox (from queue)
   */
  private static async deliverActivity(item: QueueItem): Promise<boolean> {
    const supabase = getSupabaseClient();

    const targetDomain = parseInboxDomain(item.target_inbox_url);
    if (!targetDomain) {
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          error_message: 'Invalid target inbox URL',
        })
        .eq('id', item.id);
      return false;
    }

    if (BlockedInstancesCache.isBlocked(targetDomain)) {
      logger.info(`🚫 Skipping delivery to blocked instance: ${targetDomain}`);
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          error_message: 'Instance is blocked',
        })
        .eq('id', item.id);
      return false;
    }

    // Check if endpoint is dead before attempting delivery
    const isDead = await this.isEndpointDead(item.target_inbox_url);
    if (isDead) {
      logger.info(`⏭️ Skipping delivery to dead endpoint: ${item.target_inbox_url}`);
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          error_message: 'Endpoint marked as dead',
        })
        .eq('id', item.id);
      return false;
    }

    try {
      // Resolve sender_id if missing (legacy items don't have it)
      let senderId = item.sender_id;
      if (!senderId && item.actor_username) {
        logger.info(`🔍 Resolving sender_id from actor_username: ${item.actor_username}`);
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', item.actor_username)
          .eq('is_local', true)
          .single();
        
        if (profile) {
          senderId = profile.id;
          await supabase
            .from('federation_delivery_queue')
            .update({ sender_id: senderId })
            .eq('id', item.id);
          logger.info(`✅ Resolved sender_id: ${senderId}`);
        }
      }

      if (!senderId) {
        throw new Error(`Cannot resolve sender for delivery - no sender_id or actor_username`);
      }

      // SSRF protection: validate inbox URL before fetching
      try {
        validateExternalUrl(item.target_inbox_url);
      } catch (ssrfErr: any) {
        logger.warn(`🚫 SSRF: Blocked queue delivery to unsafe inbox URL: ${item.target_inbox_url} - ${ssrfErr.message}`);
        await supabase
          .from('federation_delivery_queue')
          .update({ status: 'failed', error_message: `SSRF blocked: ${ssrfErr.message}`, last_attempt_at: new Date().toISOString() })
          .eq('id', item.id);
        return false;
      }

      // Sign the request
      const startedAt = process.hrtime.bigint();
      const { headers } = await SignatureService.signRequest(
        item.target_inbox_url,
        'POST',
        item.activity_data,
        senderId
      );

      headers['Content-Type'] = 'application/activity+json';

      // Send request. See note in `deliver()` - `validateExternalUrl(item.target_inbox_url)`
      // above stays for explicit logging; safeFetch enforces SSRF guarantees.
      const response = await safeFetch(item.target_inbox_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(item.activity_data),
      });

      if (response.ok || response.status === 202) {
        // Success - mark as delivered and update health
        await supabase
          .from('federation_delivery_queue')
          .update({
            status: 'delivered',
            last_attempt_at: new Date().toISOString(),
            http_status_code: response.status,
          })
          .eq('id', item.id);

        await this.updateEndpointHealth(
          item.target_inbox_url,
          targetDomain,
          true,
          response.status
        );

        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.recordDeliveryOutcome(targetDomain, true, durationMs, item.activity_data);

        logger.info(`✅ Delivered to ${item.target_inbox_url} (${response.status})`);
        return true;
      } else {
        // Failed - update health tracking and handle failure
        await this.updateEndpointHealth(
          item.target_inbox_url,
          targetDomain,
          false,
          response.status,
          `HTTP ${response.status}`
        );
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.recordDeliveryOutcome(
          targetDomain,
          false,
          durationMs,
          item.activity_data,
          `HTTP ${response.status}`
        );
        await this.handleDeliveryFailure(item, `HTTP ${response.status}`, response.status);
        logger.warn(`❌ Failed to deliver to ${item.target_inbox_url}: ${response.status}`);
        return false;
      }
    } catch (error) {
      // Network error or other exception
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateEndpointHealth(
        item.target_inbox_url,
        targetDomain,
        false,
        undefined,
        errorMessage
      );
      this.recordDeliveryOutcome(targetDomain, false, 0, item.activity_data, errorMessage);
      await this.handleDeliveryFailure(item, errorMessage);
      logger.error(`❌ Delivery error to ${item.target_inbox_url}:`, error);
      return false;
    }
  }

  /**
   * Handle delivery failure (retry with exponential backoff)
   */
  private static async handleDeliveryFailure(
    item: QueueItem,
    errorMessage: string,
    httpStatus?: number
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const newAttempts = item.attempts + 1;

    if (newAttempts >= item.max_attempts) {
      // Max attempts reached - mark as failed
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          attempts: newAttempts,
          error_message: errorMessage, // FIXED: was 'last_error'
          http_status_code: httpStatus,
        })
        .eq('id', item.id);

      logger.warn(`Max attempts reached for delivery to ${item.target_inbox_url}`);
    } else {
      // Schedule retry with exponential backoff (5, 10, 20, 40, 80 minutes after first queued attempt)
      const backoffMinutes = Math.pow(2, newAttempts - 1) * 5;
      const nextRetry = new Date();
      nextRetry.setMinutes(nextRetry.getMinutes() + backoffMinutes);

      await supabase
        .from('federation_delivery_queue')
        .update({
          attempts: newAttempts,
          last_attempt_at: new Date().toISOString(),
          next_attempt_at: nextRetry.toISOString(),
          error_message: errorMessage, // FIXED: was 'last_error'
          http_status_code: httpStatus,
        })
        .eq('id', item.id);

      logger.info(`Scheduled retry for ${item.target_inbox_url} in ${backoffMinutes} minutes`);
    }
  }

  /**
   * Broadcast activity to all followers of a user
   * Uses shared inbox when available to optimize delivery (one request per server)
   */
  static async broadcastToFollowers(
    userId: string,
    activityData: any
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // Get all followers' inbox URLs (both individual and shared)
    // Use inner join syntax instead of foreign key hint to avoid ambiguity
    const { data: follows, error: followsError } = await supabase
      .from('follows')
      .select(`
        follower_id,
        follower:profiles!follower_id (
          inbox_url,
          shared_inbox_url,
          is_local,
          domain
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'accepted');

    if (followsError) {
      logger.error('Error fetching followers:', followsError);
      return;
    }

    if (!follows || follows.length === 0) {
      logger.info('No followers to broadcast to');
      return;
    }

    // Group followers by their preferred inbox (shared inbox preferred)
    const inboxMap = new Map<string, { inbox: string; type: 'shared' | 'individual' }>();
    
    for (const follow of follows) {
      const follower = (follow as any).follower;
      
      if (!follower) {
        logger.warn(`Follower profile is null for follower_id: ${(follow as any).follower_id}`);
        continue;
      }
      
      if (follower.is_local) {
        continue; // Skip local followers
      }
      
      // Prefer shared inbox, fall back to individual inbox
      const preferredInbox = follower.shared_inbox_url || follower.inbox_url;
      
      if (preferredInbox) {
        const inboxType = follower.shared_inbox_url ? 'shared' : 'individual';
        
        if (!inboxMap.has(preferredInbox)) {
          inboxMap.set(preferredInbox, {
            inbox: preferredInbox,
            type: inboxType,
          });
        }
      } else {
        logger.warn(`Follower from ${follower.domain} has no inbox URL configured`);
      }
    }

    const allInboxUrls = [...inboxMap.keys()];
    const deadEndpoints = await this.getDeadEndpoints(allInboxUrls);

    const liveInboxes: { inbox: string; type: 'shared' | 'individual' }[] = [];
    let skipped = 0;

    for (const [inbox, entry] of inboxMap) {
      if (deadEndpoints.has(inbox)) {
        skipped++;
        continue;
      }
      liveInboxes.push(entry);
    }

    let enqueued = 0;
    let sharedInboxCount = 0;
    let individualInboxCount = 0;

    const deliveryTasks = liveInboxes.map((entry) => async () => {
      await this.enqueue(activityData, entry.inbox, userId);
      return entry.type;
    });

    const results = await runWithConcurrencyLimit(deliveryTasks, MAX_CONCURRENT_DOMAINS);

    for (const r of results) {
      if (r.status === 'fulfilled') {
        enqueued++;
        if (r.value === 'shared') sharedInboxCount++;
        else individualInboxCount++;
      }
    }

    logger.info(
      `Broadcast to ${enqueued} inboxes ` +
      `(${sharedInboxCount} shared, ${individualInboxCount} individual) ` +
      `for ${follows.length} remote followers` +
      (skipped > 0 ? ` (${skipped} dead endpoints skipped)` : '')
    );
  }

  /**
   * Send activity to a specific inbox
   */
  static async sendToInbox(
    inboxUrl: string,
    activityData: any,
    senderId: string
  ): Promise<void> {
    await this.enqueue(activityData, inboxUrl, senderId, 1); // High priority
  }

  /**
   * Get queue statistics
   */
  static async getStats(): Promise<{
    pending: number;
    delivered: number;
    failed: number;
  }> {
    const supabase = getSupabaseClient();

    const { count: pending } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: delivered } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'delivered');

    const { count: failed } = await supabase
      .from('federation_delivery_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed');

    return {
      pending: pending || 0,
      delivered: delivered || 0,
      failed: failed || 0,
    };
  }
}

