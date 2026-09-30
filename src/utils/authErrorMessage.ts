/**
 * User-facing text for a GoTrue / supabase-js auth error.
 *
 * AuthRetryableFetchError carries the raw response body as `message`; an empty
 * 5xx body stringifies to "{}". Such messages are replaced by status-based text.
 */
export function authErrorMessage(error: unknown, fallback = 'Authentication failed'): string {
  const err = (error ?? {}) as { message?: unknown; status?: unknown };
  const status = typeof err.status === 'number' ? err.status : undefined;
  const raw = typeof err.message === 'string' ? err.message.trim() : '';

  const readable = raw.length > 0 && !/^[[{]/.test(raw);
  if (readable) return raw;

  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status !== undefined && status >= 500) {
    return 'The server is unavailable right now. Try again in a moment.';
  }
  if (status === 0 || (error instanceof TypeError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return fallback;
}
