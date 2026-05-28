/**
 * Render-time URL tracker stripping.
 *
 * `useContentRenderer.formattedHTML` must apply `stripTrackingParameters`
 * to every `type: 'url'` part it renders. The composer path also strips at
 * parse time (`parseTextForUrls`), but federated posts (parsed server-side)
 * and historical posts (saved before the strip feature existed) only have
 * the render-time pass to clean them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { MessagePart } from '@/types';
import { useContentRenderer } from '../useContentRenderer';

function render(parts: MessagePart[]): string {
  const contentRef = ref<MessagePart[]>(parts);
  const renderer = useContentRenderer(
    contentRef,
    { mode: 'display', enableMarkdown: true, enableClickHandlers: true },
  );
  return renderer.formattedHTML.value;
}

function getFirstAnchor(html: string): HTMLAnchorElement | null {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.querySelector('a');
}

describe('useContentRenderer URL tracker stripping', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue('true'),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips utm_* on arbitrary news domains (Ars Technica case)', () => {
    const html = render([
      {
        type: 'url',
        url: 'https://arstechnica.com/science/article/?utm_brand=arstechnica&utm_social-type=owned&utm_source=mastodon&utm_medium=social',
      } as MessagePart,
    ]);

    const anchor = getFirstAnchor(html);
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe('https://arstechnica.com/science/article/');
    expect(anchor!.textContent).toBe('https://arstechnica.com/science/article/');
  });

  it('strips si= from youtu.be share links', () => {
    const html = render([
      { type: 'url', url: 'https://youtu.be/dKeGsbsvW7w?si=L99TzkSlO2QBdfXT' } as MessagePart,
    ]);

    const container = document.createElement('div');
    container.innerHTML = html;
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).not.toContain('si=');
      expect(a.textContent).not.toContain('si=');
    }
  });

  it('strips fbclid / gclid on any domain', () => {
    const html = render([
      { type: 'url', url: 'https://news.example.org/article?fbclid=abc&gclid=xyz' } as MessagePart,
    ]);
    const a = getFirstAnchor(html);
    expect(a!.getAttribute('href')).toBe('https://news.example.org/article');
    expect(a!.textContent).toBe('https://news.example.org/article');
  });

  it('preserves non-tracking query params', () => {
    const html = render([
      { type: 'url', url: 'https://example.com/search?q=harmony&page=2' } as MessagePart,
    ]);
    const a = getFirstAnchor(html);
    expect(a!.getAttribute('href')).toBe('https://example.com/search?q=harmony&page=2');
  });

  it('preserves the URL when the privacy setting is off', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue('false'),
      setItem: vi.fn(),
    });
    const html = render([
      { type: 'url', url: 'https://news.example.org/x?utm_source=foo' } as MessagePart,
    ]);
    const a = getFirstAnchor(html);
    expect(a!.getAttribute('href')).toBe('https://news.example.org/x?utm_source=foo');
  });

  it('keeps YouTube embed iframe working after stripping (uses cleaned URL for video id parse)', () => {
    const html = render([
      { type: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&utm_source=share' } as MessagePart,
    ]);

    const container = document.createElement('div');
    container.innerHTML = html;
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute('src') || '';
    // The iframe should embed the v=dQw4w9WgXcQ video, with tracking params gone
    expect(src).toContain('dQw4w9WgXcQ');
    expect(src).not.toContain('si=');
    expect(src).not.toContain('utm_source');

    // The anchor displayed above the iframe should also show the cleaned URL
    const anchor = container.querySelector('a');
    expect(anchor!.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
