import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Store, StorageError, type Job } from "./Store.js";

type NewJob = Omit<Job, "id" | "attempts">;
const job = (sourceId = "source", overrides: Partial<NewJob> = {}): NewJob => ({
  direction: "to_harmony", sourceId, channelId: "channel", roomId: "!room:example.org",
  payload: { body: "hello", nested: { ok: true } }, ...overrides,
});
const stores: Store[] = [];
const directories: string[] = [];
function memory(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), "matrix-store-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}
function open(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}
function close(store: Store): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Store", () => {
  it("starts empty, round trips payloads, and deduplicates the full job key", () => {
    const store = memory();
    expect(store.counts()).toEqual({ pending: 0, failed: 0 });
    expect(store.nextJob()).toBeNull();
    expect(store.enqueue(job())).toBe(true);
    expect(store.enqueue(job("source", { payload: { body: "replacement" } }))).toBe(false);
    expect(store.enqueue(job("source", { direction: "to_matrix" }))).toBe(true);
    expect(store.enqueue(job("source", { channelId: "other" }))).toBe(true);
    expect(store.enqueue(job("source", { roomId: "other" }))).toBe(true);
    expect(store.counts().pending).toBe(4);
    expect(store.nextJob(0)).toMatchObject({ ...job(), attempts: 0 });
    // Reads intentionally do not claim work.
    expect(store.nextJob(0)).toEqual(store.nextJob(0));
  });

  it("persists ghost ownership, room tracking and immutable queued sender across restart", () => {
    const path = file();
    let store = open(path);
    store.enqueue(job('outbound', { direction: 'to_matrix' }));
    const queued = store.nextJob()!;
    expect(store.freezeSender(queued, '@ghost:test')).toBe('@ghost:test');
    expect(store.reserveGhost('@ghost:test', 'harmony-user')).toBe(false);
    store.registerGhost('@ghost:test');
    store.trackGhostRoom('!room:test', '@ghost:test');
    close(store);
    store = open(path);
    expect(store.freezeSender(store.nextJob()!, '@relay:test')).toBe('@ghost:test');
    expect(store.nextJob()!.payload.matrix_sender).toBe('@ghost:test');
    expect(store.reserveGhost('@ghost:test', 'harmony-user')).toBe(true);
    expect(store.ownsGhost('@ghost:test')).toBe(true);
    expect(store.ghostRooms()).toEqual(['!room:test']);
    expect(store.roomGhosts('!room:test')).toEqual(['@ghost:test']);
    expect(() => store.reserveGhost('@ghost:test', 'another-owner')).toThrow();
    store.forgetGhostRoom('!room:test', '@ghost:test');
    expect(store.ghostRooms()).toEqual([]);
    expect(store.ownsGhost('@ghost:test')).toBe(true);
  });

  it('looks up reverse mappings after restart without crossing direction, channel or room', () => {
    const path = file();
    let store = open(path);
    store.enqueue(job('native-parent', { direction: 'to_matrix' }));
    store.complete(store.nextJob()!.id, '$matrix-parent');
    close(store);
    store = open(path);
    expect(store.findSource('to_matrix', '$matrix-parent', 'channel', '!room:example.org')).toBe('native-parent');
    expect(store.findSource('to_harmony', '$matrix-parent', 'channel', '!room:example.org')).toBeNull();
    expect(store.findSource('to_matrix', '$matrix-parent', 'other', '!room:example.org')).toBeNull();
    expect(store.findSource('to_matrix', '$matrix-parent', 'channel', '!other:example.org')).toBeNull();
    expect(store.findSource('to_matrix', '$unknown', 'channel', '!room:example.org')).toBeNull();
    store.enqueue(job('failed-parent', { direction: 'to_matrix' }));
    store.fail(store.nextJob()!.id, 'refused');
    expect(store.findSource('to_matrix', '$failed', 'channel', '!room:example.org')).toBeNull();
  });

  it('keeps acknowledged per-piece reverse mappings across restart and later job failure', () => {
    const path = file();
    let store = open(path);
    store.enqueue(job('native-original', { direction: 'to_matrix' }));
    const queued = store.nextJob()!;
    store.recordDestination(queued, '$text');
    store.recordDestination(queued, '$file');
    store.recordDestination(queued, '$file');
    expect(store.findSource('to_matrix', '$file', 'channel', '!room:example.org')).toBe('native-original');
    expect(store.findSource('to_harmony', '$file', 'channel', '!room:example.org')).toBeNull();
    expect(store.findSource('to_matrix', '$file', 'other-channel', '!room:example.org')).toBeNull();
    expect(store.findSource('to_matrix', '$file', 'channel', '!other:example.org')).toBeNull();
    close(store);
    store = open(path);
    expect(store.findSource('to_matrix', '$text', 'channel', '!room:example.org')).toBe('native-original');
    store.recordDestination(store.nextJob()!, '$file');
    store.fail(queued.id, 'Later attachment refused');
    expect(store.findSource('to_matrix', '$file', 'channel', '!room:example.org')).toBe('native-original');
    expect(store.findMapping('to_matrix', 'native-original', 'channel', '!room:example.org')).toBeNull();
    const db = new DatabaseSync(path);
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM job_destinations').get()!.count).toBe(2); }
    finally { db.close(); }
  });

  it('classifies per-piece mapping write failures as StorageError', () => {
    const store = memory();
    store.enqueue(job('native-original', { direction: 'to_matrix' }));
    const queued = store.nextJob()!;
    close(store);
    expect(() => store.recordDestination(queued, '$acknowledged')).toThrow(StorageError);
  });

  it("atomically accepts receipts, including empty and overlapping transactions", () => {
    const store = memory();
    expect(store.acceptTransaction("one", [job("a"), job("a"), job("b")])).toBe(true);
    expect(store.acceptTransaction("one", [job("a"), job("b")])).toBe(false);
    expect(store.acceptTransaction("two", [job("a"), job("c")])).toBe(true);
    expect(store.acceptTransaction("empty", [])).toBe(true);
    expect(store.acceptTransaction("empty", [])).toBe(false);
    expect(store.counts().pending).toBe(3);
  });

  it("rolls back both the receipt and earlier jobs when a later job fails", () => {
    const store = memory();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.acceptTransaction("retryable", [job("a"), job("b", { payload: circular })]))
      .toThrow();
    expect(store.counts().pending).toBe(0);
    expect(store.acceptTransaction("retryable", [job("a"), job("b")])).toBe(true);
    expect(store.counts().pending).toBe(2);
  });

  it("keeps receipts, terminal dedupe, attempts, scheduling and mappings across restart", () => {
    const path = file();
    let store = open(path);
    store.acceptTransaction("txn", [job("a"), job("b"), job("c")]);
    const a = store.nextJob(0)!;
    store.complete(a.id, "destination-a");
    const b = store.nextJob(0)!;
    store.retry(b.id, "temporary", 100, 10);
    store.fail(store.nextJob(0)!.id, "permanent");
    close(store);
    store = open(path);
    expect(store.acceptTransaction("txn", [job("a"), job("b"), job("c")])).toBe(false);
    expect(store.enqueue(job("a"))).toBe(false);
    expect(store.enqueue(job("c"))).toBe(false);
    expect(store.counts()).toEqual({ pending: 1, failed: 1 });
    expect(store.findMapping("to_harmony", "a", "channel", "!room:example.org"))
      .toBe("destination-a");
    expect(store.nextJob(109)).toBeNull();
    expect(store.nextJob(110)).toMatchObject({ sourceId: "b", attempts: 1 });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally { db.close(); }
  });

  it("accepts new events and encryption fences under reused transaction IDs after restart", () => {
    const path = file();
    let store = open(path);
    store.acceptTransaction('1', [job('old')]);
    store.complete(store.nextJob()!.id, 'old-copy');
    close(store);
    store = open(path);
    expect(store.acceptTransaction('1', [job('old'), job('new')])).toBe(true);
    expect(store.acceptTransaction('1', [job('old'), job('new')])).toBe(false);
    expect(store.counts()).toEqual({ pending: 1, failed: 0 });
    expect(store.findMapping('to_harmony', 'old', 'channel', '!room:example.org')).toBe('old-copy');
    const roomId = '!newly-encrypted:example.org';
    expect(() => store.acceptTransaction('1', [job('rolled-back'), job('invalid', { payload: { toJSON: () => null } })], [roomId])).toThrow();
    expect(store.counts().pending).toBe(1);
    expect(store.isRoomBlocked(roomId)).toBe(false);
    expect(store.acceptTransaction('1', [], [roomId])).toBe(true);
    expect(store.acceptTransaction('1', [], [roomId])).toBe(false);
    close(store);
    store = open(path);
    expect(store.isRoomBlocked(roomId)).toBe(true);
    expect(store.acceptTransaction('1', [job('old'), job('new')], [roomId])).toBe(false);
    const db = new DatabaseSync(path);
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()!.count).toBe(1); }
    finally { db.close(); }
  });

  it("returns ready jobs in stable ID order, not retry timestamp order", () => {
    const store = memory();
    for (const source of ["a", "b", "c"]) store.enqueue(job(source));
    const a = store.nextJob(0)!;
    store.retry(a.id, "later", 100, 0);
    const b = store.nextJob(0)!;
    expect(b.sourceId).toBe("b");
    store.retry(b.id, "soon", 10, 0);
    expect(store.nextJob(0)!.sourceId).toBe("c");
    expect(store.nextJob(10)!.sourceId).toBe("b");
    expect(store.nextJob(100)).toMatchObject({ id: a.id, attempts: 1 });
    store.retry(a.id, "again", 0, 100);
    expect(store.nextJob(100)!.attempts).toBe(2);
  });

  it("atomically completes mappings with exact lookup keys and immutable terminal states", () => {
    const store = memory();
    store.enqueue(job());
    const id = store.nextJob()!.id;
    expect(store.findMapping("to_harmony", "source", "channel", "!room:example.org")).toBeNull();
    expect(() => store.complete(id, "")).toThrow();
    expect(store.counts().pending).toBe(1);
    store.complete(id, "remote");
    store.complete(id, "replacement");
    store.retry(id, "stale", 0);
    store.fail(id, "stale");
    expect(store.counts()).toEqual({ pending: 0, failed: 0 });
    expect(store.findMapping("to_harmony", "source", "channel", "!room:example.org")).toBe("remote");
    expect(store.findMapping("to_matrix", "source", "channel", "!room:example.org")).toBeNull();
    expect(store.findMapping("to_harmony", "source", "other", "!room:example.org")).toBeNull();
    expect(store.findMapping("to_harmony", "source", "channel", "other")).toBeNull();
    store.enqueue(job("failed"));
    const failedId = store.nextJob()!.id;
    store.fail(failedId, "failed");
    store.complete(failedId, "not-a-mapping");
    expect(store.findMapping("to_harmony", "failed", "channel", "!room:example.org")).toBeNull();
    expect(store.counts().failed).toBe(1);
  });

  it("bounds stored errors and quarantines invalid JSON without blocking other jobs", () => {
    const path = file();
    const store = open(path);
    store.acceptTransaction("txn", [job("bad"), job("array"), job("good")]);
    const id = store.nextJob()!.id;
    store.retry(id, "x".repeat(100_000), 0, 0);
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT error, attempts FROM jobs WHERE id = ?").get(id)!;
      expect((row.error as string).length).toBeLessThanOrEqual(2048);
      expect(row.attempts).toBe(1);
      db.prepare("UPDATE jobs SET payload = ? WHERE source_id = ?").run("{", "bad");
      db.prepare("UPDATE jobs SET payload = ? WHERE source_id = ?").run("[]", "array");
      expect(store.nextJob()!.sourceId).toBe("good");
      expect(store.counts()).toEqual({ pending: 1, failed: 2 });
      store.fail(store.nextJob()!.id, "z".repeat(100_000));
      const failed = db.prepare("SELECT MAX(length(error)) AS length FROM jobs").get()!;
      expect(failed.length).toBeLessThanOrEqual(2048);
    } finally { db.close(); }
  });

  it("persists encryption fences atomically and removes terminal message payloads", () => {
    const path = file();
    let store = open(path);
    const roomId = "!encrypted:example.org";
    expect(() => store.acceptTransaction("rollback", [job("bad", { payload: { toJSON: () => null } })], [roomId])).toThrow();
    expect(store.isRoomBlocked(roomId)).toBe(false);
    store.acceptTransaction("encryption", [job("done"), job("failed")], [roomId]);
    store.complete(store.nextJob()!.id, "remote");
    store.fail(store.nextJob()!.id, "refused");
    close(store);
    store = open(path);
    expect(store.isRoomBlocked(roomId)).toBe(true);
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare("SELECT payload FROM jobs").all();
      expect(rows.every(row => row.payload === "{}")).toBe(true);
    } finally { db.close(); }
  });

  it("rejects invalid payloads and invalid schedules without altering work", () => {
    const store = memory();
    expect(() => store.enqueue(job("big", { payload: { body: "x".repeat(1_048_576) } }))).toThrow();
    expect(() => store.enqueue(job("array", { payload: [] as unknown as Record<string, unknown> }))).toThrow();
    expect(() => store.enqueue(job("json", { payload: { toJSON: () => null } }))).toThrow();
    expect(() => store.enqueue(job(""))).toThrow();
    store.enqueue(job());
    const id = store.nextJob()!.id;
    for (const delay of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => store.retry(id, "bad", delay, 1)).toThrow();
    }
    expect(() => store.nextJob(-1)).toThrow();
    expect(store.nextJob()!.attempts).toBe(0);
  });

  it("enforces the pending quota atomically and permits duplicates at capacity", () => {
    const store = memory();
    const jobs = Array.from({ length: 10_000 }, (_, i) => job(String(i)));
    expect(store.acceptTransaction("full", jobs)).toBe(true);
    expect(store.enqueue(jobs[0]!)).toBe(false);
    expect(store.acceptTransaction('full', [jobs[0]!])).toBe(false);
    const roomId = '!quota-fence:example.org';
    expect(() => store.acceptTransaction('full', [job('reuse-extra')], [roomId])).toThrow(/quota/);
    expect(store.isRoomBlocked(roomId)).toBe(false);
    expect(() => store.acceptTransaction("overflow", [job("extra")])).toThrow(/quota/);
    expect(store.counts().pending).toBe(10_000);
    store.complete(store.nextJob()!.id, "done");
    expect(store.acceptTransaction('full', [job('reuse-extra')], [roomId])).toBe(true);
    expect(store.isRoomBlocked(roomId)).toBe(true);
    expect(store.counts().pending).toBe(10_000);
    store.complete(store.nextJob()!.id, 'done-again');
    expect(store.acceptTransaction("overflow", [job("extra")])).toBe(true);
    expect(store.counts().pending).toBe(10_000);
  }, 20_000);
});
