/**
 * Shared optimistic-message helpers for useChat and useDM.
 * client_nonce matching survives encryption (optimistic row is plaintext).
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

/** `temp-` prefix is load-bearing: dedup/reconcile detect optimistic rows by it. */
export function createTempMessageId(): string {
  return `temp-${Date.now()}-${getRandomId()}`;
}

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
 * Match an incoming persisted row to an optimistic temp message.
 * Prefers client_nonce (survives encryption); falls back to user_id + content.
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
