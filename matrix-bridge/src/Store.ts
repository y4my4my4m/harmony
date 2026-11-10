import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type Job = {
  id: number;
  direction: "to_harmony" | "to_matrix";
  sourceId: string;
  channelId: string;
  roomId: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type NewJob = Omit<Job, "id" | "attempts">;
export class StorageError extends Error {}
const MAX_PENDING = 10_000;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_ERROR_LENGTH = 2_048;

function nonempty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Time must be a nonnegative safe integer");
  }
  return value;
}

function errorText(value: string): string {
  if (typeof value !== "string") throw new TypeError("Error must be a string");
  return value.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Durable inbox/outbox for a single synchronous worker. nextJob does not claim a
 * job: callers must finish/retry/fail it before asking for another one. Delivery
 * is at-least-once; a process crash after a remote POST can cause redelivery.
 *
 * At most 10,000 pending jobs and 1 MiB per serialized payload are accepted.
 * Quota errors roll back the entire transaction (including its receipt).
 * Receipts, terminal jobs and mappings are retained indefinitely for dedupe;
 * deployments must provision/monitor disk space. Parent directories must exist.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    nonempty(path, "path");
    // Create privately before SQLite opens it; sidecars inherit the DB mode.
    // Tighten an existing database too. Never apply filesystem operations to
    // SQLite's special in-memory database name.
    if (path !== ":memory:") {
      const fd = openSync(path, "a", 0o600);
      closeSync(fd);
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS transactions (
          transaction_id TEXT PRIMARY KEY NOT NULL
        );
        CREATE TABLE IF NOT EXISTS encrypted_rooms (
          room_id TEXT PRIMARY KEY NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL CHECK(direction IN ('to_harmony', 'to_matrix')),
          source_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'done', 'failed')),
          ready_at INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          destination_id TEXT,
          UNIQUE(direction, source_id, channel_id, room_id)
        );
        CREATE TABLE IF NOT EXISTS job_destinations (
          job_id INTEGER NOT NULL REFERENCES jobs(id),
          destination_id TEXT NOT NULL,
          PRIMARY KEY(job_id, destination_id)
        );
        CREATE INDEX IF NOT EXISTS job_destinations_destination ON job_destinations(destination_id, job_id);
        CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(id) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS jobs_destination ON jobs(direction, destination_id, channel_id, room_id) WHERE status = 'done';
        CREATE TABLE IF NOT EXISTS ghost_users (
          matrix_id TEXT PRIMARY KEY NOT NULL,
          harmony_id TEXT UNIQUE NOT NULL,
          registered INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ghost_rooms (
          room_id TEXT NOT NULL,
          matrix_id TEXT NOT NULL REFERENCES ghost_users(matrix_id),
          PRIMARY KEY(room_id, matrix_id)
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acceptTransaction(transactionId: string, jobs: NewJob[], encryptedRoomIds: string[] = []): boolean {
    nonempty(transactionId, "transactionId");
    return this.transaction(() => {
      const receipt = this.db.prepare(
        "INSERT INTO transactions(transaction_id) VALUES (?) ON CONFLICT DO NOTHING",
      ).run(transactionId);
      // Homeservers can reuse transaction IDs; deduplicate jobs by event, not by receipt.
      let changed = receipt.changes !== 0;
      for (const roomId of encryptedRoomIds) {
        nonempty(roomId, "roomId");
        if (this.db.prepare("INSERT INTO encrypted_rooms(room_id) VALUES (?) ON CONFLICT DO NOTHING").run(roomId).changes !== 0) changed = true;
      }
      for (const job of jobs) if (this.insert(job)) changed = true;
      return changed;
    });
  }

  isRoomBlocked(roomId: string): boolean {
    return this.ghostState(() => !!this.db.prepare("SELECT 1 FROM encrypted_rooms WHERE room_id = ?").get(roomId));
  }

  enqueue(job: NewJob): boolean {
    return this.transaction(() => this.insert(job));
  }

  private insert(job: NewJob): boolean {
    if (job.direction !== "to_harmony" && job.direction !== "to_matrix") {
      throw new TypeError("Invalid job direction");
    }
    nonempty(job.sourceId, "sourceId");
    nonempty(job.channelId, "channelId");
    nonempty(job.roomId, "roomId");
    if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
      throw new TypeError("Payload must be a JSON object");
    }
    const payload = JSON.stringify(job.payload);
    if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      throw new RangeError("Payload is not serializable or exceeds 1 MiB");
    }
    const decoded: unknown = JSON.parse(payload);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new TypeError("Serialized payload must be a JSON object");
    }
    const result = this.db.prepare(`
      INSERT INTO jobs(direction, source_id, channel_id, room_id, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(direction, source_id, channel_id, room_id) DO NOTHING
    `).run(job.direction, job.sourceId, job.channelId, job.roomId, payload);
    if (result.changes === 0) return false;
    const pending = this.db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'",
    ).get()!.count as number;
    if (pending > MAX_PENDING) throw new Error("Pending job quota exceeded");
    return true;
  }

  nextJob(now = Date.now()): Job | null {
    timestamp(now);
    for (;;) {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE status = 'pending' AND ready_at <= ? ORDER BY id LIMIT 1
      `).get(now);
      if (!row) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload as string);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Not an object");
        }
      } catch {
        // Quarantine corrupt persisted data rather than poisoning the worker.
        this.fail(row.id as number, "Invalid stored JSON payload");
        continue;
      }
      return {
        id: row.id as number,
        direction: row.direction as Job["direction"],
        sourceId: row.source_id as string,
        channelId: row.channel_id as string,
        roomId: row.room_id as string,
        payload: payload as Record<string, unknown>,
        attempts: row.attempts as number,
      };
    }
  }

  private ghostState<T>(operation: () => T): T {
    try { return operation(); }
    catch { throw new StorageError('Bridge state could not be persisted'); }
  }

  freezeSender(job: Job, sender: string): string {
    return this.ghostState(() => this.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM jobs WHERE id = ? AND status = 'pending'").get(job.id);
      if (!row) throw new Error('Pending job not found');
      const payload = JSON.parse(row.payload as string);
      if (typeof payload.matrix_sender === 'string') return payload.matrix_sender;
      payload.matrix_sender = sender;
      this.db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify(payload), job.id);
      return sender;
    }));
  }

  reserveGhost(matrixId: string, harmonyId: string): boolean {
    return this.ghostState(() => {
      this.db.prepare('INSERT INTO ghost_users(matrix_id, harmony_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(matrixId, harmonyId);
      const row = this.db.prepare('SELECT * FROM ghost_users WHERE matrix_id = ?').get(matrixId);
      if (!row || row.harmony_id !== harmonyId) throw new Error('Ghost ownership collision');
      return row.registered === 1;
    });
  }

  ownsGhost(matrixId: string): boolean {
    return this.ghostState(() => !!this.db.prepare('SELECT 1 FROM ghost_users WHERE matrix_id = ? AND registered = 1').get(matrixId));
  }

  registerGhost(matrixId: string): void {
    this.ghostState(() => this.db.prepare('UPDATE ghost_users SET registered = 1 WHERE matrix_id = ?').run(matrixId));
  }

  trackGhostRoom(roomId: string, matrixId: string): void {
    this.ghostState(() => this.db.prepare('INSERT INTO ghost_rooms(room_id, matrix_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(roomId, matrixId));
  }

  ghostRooms(): string[] {
    return this.ghostState(() => this.db.prepare('SELECT DISTINCT room_id FROM ghost_rooms ORDER BY room_id').all().map(row => row.room_id as string));
  }

  roomGhosts(roomId: string): string[] {
    return this.ghostState(() => this.db.prepare('SELECT matrix_id FROM ghost_rooms WHERE room_id = ? ORDER BY matrix_id').all(roomId).map(row => row.matrix_id as string));
  }

  forgetGhostRoom(roomId: string, matrixId: string): void {
    this.ghostState(() => this.db.prepare('DELETE FROM ghost_rooms WHERE room_id = ? AND matrix_id = ?').run(roomId, matrixId));
  }

  recordDestination(job: Job, destinationId: string): void {
    this.ghostState(() => {
      nonempty(destinationId, 'destinationId');
      this.db.prepare('INSERT INTO job_destinations(job_id, destination_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(job.id, destinationId);
    });
  }

  complete(id: number, destinationId: string): void {
    nonempty(destinationId, "destinationId");
    // The first destination stays atomic with completion; acknowledged pieces have separate reverse mappings.
    // Terminal jobs cannot be overwritten by stale calls.
    this.db.prepare(`
      UPDATE jobs SET status = 'done', destination_id = ?, error = NULL, payload = '{}'
      WHERE id = ? AND status = 'pending'
    `).run(destinationId, id);
  }

  retry(id: number, error: string, delayMs: number, now = Date.now()): void {
    timestamp(now);
    timestamp(delayMs);
    const readyAt = timestamp(now + delayMs);
    this.db.prepare(`
      UPDATE jobs SET attempts = MIN(attempts + 1, 2147483647), error = ?, ready_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(errorText(error), readyAt, id);
  }

  fail(id: number, reason: string): void {
    this.db.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, payload = '{}' WHERE id = ? AND status = 'pending'
    `).run(errorText(reason), id);
  }

  counts(): { pending: number; failed: number } {
    const row = this.db.prepare(`
      SELECT COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
             COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed FROM jobs
    `).get()!;
    return { pending: row.pending as number, failed: row.failed as number };
  }

  findSource(direction: Job["direction"], destinationId: string, channelId: string, roomId: string): string | null {
    // Each acknowledged Matrix piece remains replyable even if a later piece failed.
    const piece = this.db.prepare(`
      SELECT j.source_id FROM job_destinations d JOIN jobs j ON j.id = d.job_id
      WHERE d.destination_id = ? AND j.direction = ? AND j.channel_id = ? AND j.room_id = ?
    `).get(destinationId, direction, channelId, roomId);
    if (piece) return piece.source_id as string;
    const row = this.db.prepare(`
      SELECT source_id FROM jobs WHERE direction = ? AND destination_id = ?
      AND channel_id = ? AND room_id = ? AND status = 'done'
    `).get(direction, destinationId, channelId, roomId);
    return row ? row.source_id as string : null;
  }

  findMapping(
    direction: Job["direction"], sourceId: string, channelId: string, roomId: string,
  ): string | null {
    const row = this.db.prepare(`
      SELECT destination_id FROM jobs WHERE direction = ? AND source_id = ?
      AND channel_id = ? AND room_id = ? AND status = 'done'
    `).get(direction, sourceId, channelId, roomId);
    return row ? row.destination_id as string : null;
  }
}
