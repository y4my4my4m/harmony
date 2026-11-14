/**
 * NotificationListener - PostgreSQL LISTEN/NOTIFY bridge into BullMQ
 *
 * Maintains a dedicated pg connection that LISTENs on the 'federation_jobs'
 * channel.  When queue_federation_job() fires pg_notify(), this listener
 * adds the job to the appropriate BullMQ queue, giving near-zero latency
 * pickup without any polling. 'federation_switches' drops the cached
 * federation switches (FederationSwitches).
 *
 * BullMQ handles retries, backoff, and persistence automatically.
 */

import pg from 'pg';
import { type Queue } from 'bullmq';
import { logger } from '../utils/logger.js';
import { invalidateFederationSwitches } from '../services/FederationSwitches.js';

const CHANNEL = 'federation_jobs';
// Migration 20261028500001: a change of the instance's federation switches.
const SWITCHES_CHANNEL = 'federation_switches';
const BATCH_WINDOW_MS = 50;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Jobs that read their server's current state when they run: one per server per COLLAPSE_MS window
 * of the clock, a delayed job due at the window's end. A statement changing many emojis or roles
 * notifies once per row, and a bridge syncing a server's emojis commits once per emoji. The job id
 * names server and window, so BullMQ keeps the first and ignores the rest; the window lives in
 * Redis and survives a restart. A notification after the window ends lands in the next one.
 */
const COLLAPSED_JOBS = new Set(['federate-server-update']);
const COLLAPSE_MS = 5_000;

/** BullMQ job id and delay for a collapsed job; null for any other. Job ids take no ':'. */
export function collapsedJob(notification: JobNotification, now: number): { jobId: string; delay: number } | null {
  const serverId = notification.data?.server_id;
  if (!COLLAPSED_JOBS.has(notification.name) || typeof serverId !== 'string') return null;
  const window = Math.floor(now / COLLAPSE_MS);
  return {
    jobId: `${notification.name}-${serverId}-${window}`,
    delay: (window + 1) * COLLAPSE_MS - now,
  };
}

interface JobNotification {
  name: string;
  id?: string;
  data?: Record<string, any>;
}

type QueueResolver = (jobName: string) => Queue | undefined;

export class NotificationListener {
  private client: pg.Client | null = null;
  private connectionString: string;
  private getQueue: QueueResolver;
  private isRunning = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotifications: JobNotification[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(connectionString: string, getQueue: QueueResolver) {
    this.connectionString = connectionString;
    this.getQueue = getQueue;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // Ignore errors during shutdown
      }
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.client = new pg.Client({
        connectionString: this.connectionString,
        application_name: 'harmony-federation-notify-listener',
      });

      this.client.on('notification', (msg) => {
        if (msg.channel === SWITCHES_CHANNEL) {
          invalidateFederationSwitches();
          return;
        }
        if (msg.channel === CHANNEL && msg.payload) {
          this.handleNotification(msg.payload);
        }
      });

      this.client.on('error', (err) => {
        logger.error('NotificationListener connection error:', err.message);
        this.scheduleReconnect();
      });

      this.client.on('end', () => {
        if (this.isRunning) {
          logger.warn('NotificationListener connection closed unexpectedly');
          this.scheduleReconnect();
        }
      });

      await this.client.connect();
      await this.client.query(`LISTEN ${CHANNEL}`);
      await this.client.query(`LISTEN ${SWITCHES_CHANNEL}`);

      this.reconnectAttempt = 0;
      logger.info(`NotificationListener connected and listening on "${CHANNEL}"`);
    } catch (err: any) {
      logger.error('NotificationListener failed to connect:', err.message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;

    if (this.client) {
      this.client.removeAllListeners();
      this.client.end().catch(() => {});
      this.client = null;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt++;

    logger.info(`NotificationListener reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  private handleNotification(payload: string): void {
    try {
      const notification = JSON.parse(payload) as JobNotification;
      if (!notification.name) return;

      this.pendingNotifications.push(notification);

      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          this.processBatch();
        }, BATCH_WINDOW_MS);
      }
    } catch {
      logger.warn('NotificationListener received invalid payload:', payload);
    }
  }

  private async processBatch(): Promise<void> {
    const batch = this.pendingNotifications.splice(0);
    if (batch.length === 0) return;

    const addPromises: Promise<void>[] = [];
    const collapsedIds = new Set<string>();
    for (const notification of batch) {
      if (notification.name === 'delivery-queue-fallback') continue;
      const collapsed = collapsedJob(notification, Date.now());
      if (collapsed) {
        if (collapsedIds.has(collapsed.jobId)) continue;
        collapsedIds.add(collapsed.jobId);
      }
      addPromises.push(this.enqueue(notification, collapsed));
    }

    await Promise.allSettled(addPromises);
  }

  private async enqueue(notification: JobNotification, collapsed: { jobId: string; delay: number } | null): Promise<void> {
    const queue = this.getQueue(notification.name);
    if (!queue) {
      logger.warn(`NotificationListener: no queue for "${notification.name}"`);
      return;
    }

    try {
      const jobData = notification.data ?? { type: 'create', _bridged_id: notification.id };
      await queue.add(notification.name, jobData, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        ...(collapsed ?? {}),
      });
      logger.debug(`NotificationListener: enqueued ${notification.name} job`);
    } catch (err) {
      logger.error(`NotificationListener: failed to enqueue ${notification.name}:`, err);
    }
  }
}
