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
 * Jobs that read their server's current state when they run: one per server per COLLAPSE_MS, queued
 * at its end. A statement changing many emojis or roles notifies once per row, and a bridge syncing
 * a server's emojis commits once per emoji. A notification after the job is queued opens the next
 * window, so no change goes unsent. A process that stops mid-window queues its jobs as it stops.
 */
const COLLAPSED_JOBS = new Set(['federate-server-update']);
const COLLAPSE_MS = 5_000;

function collapseKey(notification: JobNotification): string | null {
  const serverId = notification.data?.server_id;
  return COLLAPSED_JOBS.has(notification.name) && typeof serverId === 'string' ? `${notification.name}:${serverId}` : null;
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
  private collapsed = new Map<string, { timer: ReturnType<typeof setTimeout>; notification: JobNotification }>();

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
    const waiting = [...this.collapsed.values()];
    this.collapsed.clear();
    for (const { timer } of waiting) clearTimeout(timer);
    await Promise.allSettled(waiting.map(({ notification }) => this.enqueue(notification)));

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
    for (const notification of batch) {
      if (notification.name === 'delivery-queue-fallback') continue;
      const key = collapseKey(notification);
      if (key) {
        if (!this.collapsed.has(key)) {
          const timer = setTimeout(() => {
            this.collapsed.delete(key);
            void this.enqueue(notification);
          }, COLLAPSE_MS);
          timer.unref?.();
          this.collapsed.set(key, { timer, notification });
        }
        continue;
      }
      addPromises.push(this.enqueue(notification));
    }

    await Promise.allSettled(addPromises);
  }

  private async enqueue(notification: JobNotification): Promise<void> {
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
      });
      logger.debug(`NotificationListener: enqueued ${notification.name} job`);
    } catch (err) {
      logger.error(`NotificationListener: failed to enqueue ${notification.name}:`, err);
    }
  }
}
