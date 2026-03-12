/**
 * NotificationListener - PostgreSQL LISTEN/NOTIFY for instant federation job pickup
 *
 * Maintains a dedicated pg connection that LISTENs on the 'federation_jobs' channel.
 * When queue_federation_job() inserts a job and calls pg_notify(), this listener
 * receives the notification and fetches the job via pg-boss immediately, bypassing
 * the polling interval entirely.
 *
 * The pg-boss polling workers (at 10s intervals) serve as a safety net for any
 * notifications missed during reconnects or restarts.
 */

import pg from 'pg';
import PgBoss from 'pg-boss';
import { logger } from '../utils/logger.js';

const CHANNEL = 'federation_jobs';
const BATCH_WINDOW_MS = 50;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

interface JobNotification {
  name: string;
  id: string;
}

type JobHandler = (jobType: string, job: PgBoss.Job<any>) => Promise<void>;

export class NotificationListener {
  private client: pg.Client | null = null;
  private connectionString: string;
  private boss: PgBoss;
  private onJob: JobHandler;
  private isRunning = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotifications: JobNotification[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(connectionString: string, boss: PgBoss, onJob: JobHandler) {
    this.connectionString = connectionString;
    this.boss = boss;
    this.onJob = onJob;
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

      this.reconnectAttempt = 0;
      logger.info(`NotificationListener connected and listening on "${CHANNEL}"`);
    } catch (err: any) {
      logger.error('NotificationListener failed to connect:', err.message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;

    // Clean up old client
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end().catch(() => {});
      this.client = null;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
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
      if (!notification.name || !notification.id) return;

      this.pendingNotifications.push(notification);

      // Batch notifications within a short window to avoid
      // hammering pg-boss with individual fetches under high throughput
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

    // Group by queue name to fetch one batch per queue
    const byQueue = new Map<string, JobNotification[]>();
    for (const n of batch) {
      const list = byQueue.get(n.name) || [];
      list.push(n);
      byQueue.set(n.name, list);
    }

    const fetchPromises: Promise<void>[] = [];
    for (const [queueName, notifications] of byQueue) {
      // Delivery-queue-fallback notifications don't go through pg-boss
      if (queueName === 'delivery-queue-fallback') continue;

      fetchPromises.push(this.fetchAndProcess(queueName, notifications.length));
    }

    await Promise.allSettled(fetchPromises);
  }

  private async fetchAndProcess(queueName: string, count: number): Promise<void> {
    try {
      // Fetch up to `count` jobs from this queue. If boss.work() already
      // claimed them, fetch returns an empty array -- no double processing.
      const jobs = await this.boss.fetch(queueName, { batchSize: Math.min(count, 20) });

      if (!jobs || (Array.isArray(jobs) && jobs.length === 0)) return;

      const jobArray = Array.isArray(jobs) ? jobs : [jobs];
      logger.debug(`NotificationListener fetched ${jobArray.length} ${queueName} job(s) instantly`);

      for (const job of jobArray) {
        try {
          await this.onJob(queueName, job);
          await this.boss.complete(queueName, job.id);
        } catch (err) {
          logger.error(`NotificationListener job ${queueName}:${job.id} failed:`, err);
          try {
            await this.boss.fail(queueName, job.id);
          } catch {
            // pg-boss will handle the failed state via expiry
          }
        }
      }
    } catch (err) {
      logger.error(`NotificationListener fetch error for ${queueName}:`, err);
    }
  }
}
