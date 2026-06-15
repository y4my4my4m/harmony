/**
 * Shared optimistic-message helpers for the channel (`useChat`) and DM
 * (`useDM`) stores.
 *
 * Both stores implement the exact same optimistic-send lifecycle:
 *   1. Insert a temp message immediately (so the UI feels instant).
 *   2. Tag it with a `client_nonce` so the realtime INSERT can be matched back
 *      to the optimistic row and de-duplicated.
 *   3. Reconcile when the persisted row arrives (via the send response or a
 *      realtime event), whichever wins the race.
 *
 * This logic used to be copy-pasted into both stores. It lives here so there is
 * a single, tested source of truth.
 */

/**
 * Collision-resistant random id. Prefers `crypto.randomUUID`, falling back to a
 * Math.random-based id when the Web Crypto API is unavailable.
 */
export function getRandomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* crypto unavailable - fall through */
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Temp id for an optimistic message. The `temp-` prefix is load-bearing: the
 * dedup + reconcile paths detect optimistic rows by `id.startsWith('temp-')`. */
export function createTempMessageId(): string {
  return `temp-${Date.now()}-${getRandomId()}`;
}

/** Whether a message id belongs to an as-yet-unconfirmed optimistic message. */
export function isOptimisticId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('temp-');
}

interface NonceCarrier {
  id: string;
  user_id?: string | null;
  content?: unknown;
  metadata?: { client_nonce?: string } | null;
}

interface IncomingRow {
  user_id?: string | null;
  content?: unknown;
  metadata?: { client_nonce?: string } | null;
}

/**
 * Find the optimistic (temp) message in `messages` that corresponds to an
 * incoming persisted row, or -1 if none.
 *
 * Matching strategy, in order of reliability:
 *   1. `client_nonce` - survives encryption (the optimistic row holds plaintext
 *      while the persisted/realtime row holds ciphertext), so it dedupes
 *      encrypted sends that a content comparison never could.
 *   2. `user_id` + structural content equality - fallback for older/bridged
 *      rows that predate the nonce.
 */
export function findOptimisticMatchIndex(
  messages: readonly NonceCarrier[],
  incoming: IncomingRow,
): number {
  const incomingNonce = incoming.metadata?.client_nonce;
  if (incomingNonce) {
    const byNonce = messages.findIndex(
      (m) => isOptimisticId(m.id) && m.metadata?.client_nonce === incomingNonce,
    );
    if (byNonce !== -1) return byNonce;
  }

  const incomingContent = JSON.stringify(incoming.content);
  return messages.findIndex(
    (m) =>
      isOptimisticId(m.id) &&
      m.user_id === incoming.user_id &&
      JSON.stringify(m.content) === incomingContent,
  );
}
