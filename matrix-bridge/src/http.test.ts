import { describe, expect, it, vi } from 'vitest';
import { endpoint, HttpError, isTransientError, requestJson, requestImage, requestFile } from './http.js';

describe('HTTP', () => {
  it('preserves base paths and removes query credentials', () => {
    expect(endpoint('https://example.org/proxy/?access_token=SECRET#secret', '/path').href)
      .toBe('https://example.org/proxy/path');
    expect(() => endpoint('https://user:SECRET@example.org', 'path')).toThrow('Invalid service URL');
  });

  it.each([408, 429, 500, 503])('classifies %s as transient without leaking the response', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'SECRET' }), { status }));
    const error = await requestJson(new URL('https://example.org?token=SECRET'), {}, fetchImpl).catch(e => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(isTransientError(error)).toBe(true);
    expect((error as Error).message).not.toContain('SECRET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sanitizes network exceptions and never retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('SECRET https://host?token=SECRET'));
    await expect(requestJson(new URL('https://host'), { method: 'POST' }, fetchImpl))
      .rejects.toThrow('HTTP transport failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds even a fetch implementation that ignores abort', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(requestJson(new URL('https://host'), {}, fetchImpl, 10)).rejects.toThrow('timed out');
    expect((fetchImpl.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('bounds response body consumption too', async () => {
    const response = new Response(new ReadableStream({ start() {} }));
    await expect(requestJson(new URL('https://host'), {}, vi.fn<typeof fetch>().mockResolvedValue(response), 10))
      .rejects.toThrow('timed out');
  });

  it('caps JSON responses and carries bounded Retry-After delays', async () => {
    const large = new Response(JSON.stringify({ data: 'x'.repeat(1024 * 1024) }));
    await expect(requestJson(new URL('https://host'), {}, vi.fn<typeof fetch>().mockResolvedValue(large)))
      .rejects.toThrow('exceeds limit');
    const limited = new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
    const error = await requestJson(new URL('https://host'), {}, vi.fn<typeof fetch>().mockResolvedValue(limited)).catch(error => error);
    expect((error as HttpError).retryAfterMs).toBe(120_000);
  });

  it.each(['fetch', 'body'])('bounds avatar %s stalls and aborts without exposing credentials', async stalled => {
    vi.useFakeTimers();
    try {
      const fetchImpl = stalled === 'fetch'
        ? vi.fn<typeof fetch>(() => new Promise(() => {}))
        : vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'image/png' } }));
      const pending = expect(requestImage(new URL('https://matrix.test/media'), { headers: { Authorization: 'Bearer SECRET' } }, fetchImpl))
        .rejects.toThrow('HTTP request timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('reads binary media and encoded filenames without consuming text or JSON', async () => {
    const bytes = Buffer.from([0, 255, 1, 2]);
    const response = new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('写真.png'), 'X-File-Type': 'image/png' } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(requestFile(new URL('https://host/file'), { headers: { Authorization: 'Bot SECRET' } }, fetchImpl))
      .resolves.toEqual({ bytes, name: '写真.png', contentType: 'image/png' });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bot SECRET' } });
  });

  it('allows empty ordinary files and uses safe default metadata', async () => {
    await expect(requestFile(new URL('https://host/file'), {}, vi.fn<typeof fetch>().mockResolvedValue(new Response(null))))
      .resolves.toEqual({ bytes: Buffer.alloc(0), name: 'attachment', contentType: 'application/octet-stream' });
  });

  it.each(['declared', 'streamed'])('rejects %s oversized media and cancels the body', async size => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel });
    const response = new Response(body, { headers: size === 'declared' ? { 'Content-Length': '52428801' } : {} });
    await expect(requestFile(new URL('https://host/file'), {}, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow('exceeds limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'body'])('bounds media %s stalls without exposing credentials', async stalled => {
    vi.useFakeTimers();
    try {
      const fetchImpl = stalled === 'fetch' ? vi.fn<typeof fetch>(() => new Promise(() => {}))
        : vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
      const pending = expect(requestFile(new URL('https://host/file?token=SECRET'), {}, fetchImpl)).rejects.toThrow('HTTP request timed out');
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('rejects malformed encoded media filenames without echoing headers', async () => {
    const response = new Response('bytes', { headers: { 'X-File-Name': '%SECRET' } });
    await expect(requestFile(new URL('https://host/file'), {}, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow('Invalid media filename');
  });

  it('does not consider invalid JSON or a forbidden response transient', async () => {
    for (const response of [new Response('not json'), new Response('SECRET', { status: 403 })]) {
      const error = await requestJson(new URL('https://host'), {}, vi.fn<typeof fetch>().mockResolvedValue(response)).catch(e => e);
      expect(isTransientError(error)).toBe(false);
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});
