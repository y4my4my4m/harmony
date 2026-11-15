import { ref } from 'vue';
import { supabase } from '@/supabase';

/**
 * Whether a local account holds a username, for the composer's drawing of a
 * typed @handle. Same match as resolveMentionsUserData: exact username,
 * is_local. Answers last the session; a failed lookup is retried after
 * RETRY_MS.
 */

const BATCH_MS = 150;
const RETRY_MS = 30_000;
const MAX_BATCH = 50;

const known = new Map<string, boolean>();
const pending = new Set<string>();
const waiting: string[] = [];
const retryAt = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Bumps when a lookup finds a username no local account holds. */
export const absentLocalHandleCount = ref(0);

/** true: an account holds it; false: none does; undefined: not looked up yet. */
export function localHandleExists(username: string): boolean | undefined {
  return known.get(username);
}

/** Queues a lookup unless one is answered, in flight, or failed within RETRY_MS. */
export function requestLocalHandle(username: string): void {
  if (!username || known.has(username) || pending.has(username)) return;
  if ((retryAt.get(username) ?? 0) > Date.now()) return;
  pending.add(username);
  waiting.push(username);
  timer ??= setTimeout(flush, BATCH_MS);
}

async function flush(): Promise<void> {
  timer = null;
  const names = waiting.splice(0, MAX_BATCH);
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .in('username', names)
      .eq('is_local', true);
    if (error || !Array.isArray(data)) throw error ?? new Error('profiles lookup returned no rows');
    const found = new Set(data.map((row: { username: string }) => row.username));
    let absent = 0;
    for (const name of names) {
      known.set(name, found.has(name));
      if (!found.has(name)) absent++;
    }
    if (absent > 0) absentLocalHandleCount.value++;
  } catch {
    const at = Date.now() + RETRY_MS;
    for (const name of names) retryAt.set(name, at);
  } finally {
    for (const name of names) pending.delete(name);
    if (waiting.length > 0) timer ??= setTimeout(flush, BATCH_MS);
  }
}
