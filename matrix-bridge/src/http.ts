import { MAX_MEDIA_BYTES, mediaContentType, mediaName, type MediaFile } from './Media.js';

export type FetchImpl = typeof fetch;

/** Deliberately excludes URLs, response text, headers and underlying causes. */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly status?: number,
    public readonly errcode?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isTransientError(error: unknown): boolean {
  return error instanceof HttpError && error.transient;
}

export function endpoint(base: string, path: string): URL {
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    throw new HttpError('Invalid service URL', false);
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

async function boundedBytes(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new HttpError('HTTP response exceeds limit', false);
  }
  if (!response.body) throw new HttpError('Invalid JSON response', false);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError('HTTP response exceeds limit', false);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function boundedJson(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (response.status === 204) return undefined;
  const bytes = await boundedBytes(response, signal, maxBytes);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpError('Invalid JSON response', false); }
}

export interface AvatarImage { data: string; content_type: string }

export function requestImage(url: URL, init: RequestInit, fetchImpl: FetchImpl = fetch): Promise<AvatarImage> {
  return request(url, init, fetchImpl, 15_000, async (response, signal) => {
    const content_type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!content_type || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(content_type)) {
      await response.body?.cancel();
      throw new HttpError('Unsupported avatar image type', false);
    }
    const bytes = await boundedBytes(response, signal);
    if (!bytes.length) throw new HttpError('Empty avatar image', false);
    return { data: bytes.toString('base64'), content_type };
  });
}

/** Authenticated media is read with both a declared-length and streamed-byte bound. */
export function requestFile(url: URL, init: RequestInit, fetchImpl: FetchImpl = fetch, name = 'attachment'): Promise<MediaFile> {
  return request(url, init, fetchImpl, 60_000, async (response, signal) => {
    let fileName = name;
    const encoded = response.headers.get('x-file-name');
    if (encoded !== null) {
      try { fileName = decodeURIComponent(encoded); }
      catch { await response.body?.cancel(); throw new HttpError('Invalid media filename', false); }
    }
    if (!response.body && Number(response.headers.get('content-length')) > 0) throw new HttpError('Invalid media body', false);
    const bytes = response.body ? await boundedBytes(response, signal, MAX_MEDIA_BYTES) : Buffer.alloc(0);
    return { bytes, name: mediaName(fileName), contentType: mediaContentType(response.headers.get('x-file-type') ?? response.headers.get('content-type')) };
  });
}

/** One attempt only: callers decide whether their operation is safe to retry. */
export function requestJson<T = unknown>(
  url: URL, init: RequestInit, fetchImpl: FetchImpl = fetch, timeoutMs = 15_000, maxBytes = MAX_RESPONSE_BYTES,
): Promise<T> {
  return request(url, init, fetchImpl, timeoutMs, (response, signal) => boundedJson(response, signal, maxBytes)) as Promise<T>;
}

async function request<T>(
  url: URL,
  init: RequestInit,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  decode: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpError('HTTP request timed out', true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        let errcode: string | undefined;
        // Only expose known protocol codes; a hostile server can echo credentials anywhere.
        try {
          const body = await boundedJson(response, controller.signal) as { errcode?: unknown };
          if (['M_NOT_FOUND', 'M_FORBIDDEN', 'M_UNAUTHORIZED', 'M_LIMIT_EXCEEDED', 'M_USER_IN_USE'].includes(String(body?.errcode))) {
            errcode = String(body.errcode);
          }
        } catch { /* A status is sufficient for non-JSON errors. */ }
        const retryHeader = response.headers.get('retry-after');
        const seconds = retryHeader === null ? NaN : Number(retryHeader);
        const retryDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader ?? '') - Date.now();
        const retryAfterMs = Number.isFinite(retryDelay) && retryDelay >= 0 ? Math.min(86_400_000, retryDelay) : undefined;
        throw new HttpError(`HTTP request failed (${response.status})`,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status, errcode, retryAfterMs);
      }
      return await decode(response, controller.signal);
    })()]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError('HTTP transport failed', true);
  } finally {
    clearTimeout(timer);
  }
}
