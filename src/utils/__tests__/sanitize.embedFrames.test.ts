import { describe, expect, it } from 'vitest';
import {
  isAllowedEmbedFrameSrc,
  safeHref,
  sanitizeFormattedHtml,
  sanitizeHighlightedCode,
  sanitizeMessageHtml,
} from '../sanitize';

function dom(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('sanitizeFormattedHtml: URI check and embed frames', () => {
  it('removes an iframe with a javascript: src', () => {
    expect(dom(sanitizeFormattedHtml('<iframe src="javascript:alert(1)"></iframe>')).querySelector('iframe')).toBeNull();
  });

  it('removes an iframe from an origin that is not an embed provider', () => {
    for (const src of [
      'https://evil.example/phish',
      'https://www.youtube.com.evil.example/embed/x',
      'https://evil.example/https://www.youtube.com/embed/x',
      'http://www.youtube.com/embed/x',
      'https://www.youtube.com/watch?v=x',
      'https://user:pass@www.youtube.com/embed/x',
      '//www.youtube.com/embed/x',
    ]) {
      const html = sanitizeFormattedHtml(`<p>a</p><iframe src="${src}"></iframe>`);
      expect(dom(html).querySelector('iframe'), src).toBeNull();
      expect(html).toContain('<p>a</p>');
    }
  });

  it('removes an iframe without a src or with srcdoc', () => {
    expect(dom(sanitizeFormattedHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).querySelector('iframe')).toBeNull();
    expect(dom(sanitizeFormattedHtml('<iframe></iframe>')).querySelector('iframe')).toBeNull();
  });

  it('keeps YouTube and Spotify embed frames', () => {
    for (const src of [
      'https://www.youtube.com/embed/abc?enablejsapi=1&origin=https%3A%2F%2Fapp.test',
      'https://www.youtube-nocookie.com/embed/abc',
      'https://open.spotify.com/embed/track/123',
    ]) {
      const frame = dom(sanitizeFormattedHtml(`<iframe src="${src.replace(/&/g, '&amp;')}" allowfullscreen></iframe>`)).querySelector('iframe');
      expect(frame?.getAttribute('src'), src).toBe(src);
    }
  });

  it('strips javascript: from href and src', () => {
    const container = dom(sanitizeFormattedHtml('<a href="javascript:alert(1)">x</a><img src="javascript:alert(2)">'));
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBeNull();
  });

  it('keeps http(s), relative and blob URLs', () => {
    const container = dom(sanitizeFormattedHtml(
      '<a href="https://example.com/x">a</a><img src="/assets/emojis/1f600.svg"><video src="blob:https://app.test/1"></video>',
    ));
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/x');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/emojis/1f600.svg');
    expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:https://app.test/1');
  });

  it('does not change the message sanitizer, which drops every iframe', () => {
    expect(sanitizeMessageHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>')).not.toContain('<iframe');
  });
});

describe('isAllowedEmbedFrameSrc', () => {
  it('accepts provider embed paths only', () => {
    expect(isAllowedEmbedFrameSrc('https://www.youtube.com/embed/x')).toBe(true);
    expect(isAllowedEmbedFrameSrc('https://open.spotify.com/track/x')).toBe(false);
    expect(isAllowedEmbedFrameSrc(' https://www.youtube.com/embed/x')).toBe(false);
    expect(isAllowedEmbedFrameSrc(null)).toBe(false);
  });
});

describe('sanitizeHighlightedCode', () => {
  // One payload per call: happy-dom's NodeIterator skips the node after a removed one.
  it('keeps span/class and drops everything else', () => {
    const tag = dom(sanitizeHighlightedCode('<span class="hl-tag">&lt;</span>'));
    expect(tag.querySelectorAll('span.hl-tag').length).toBe(1);
    expect(tag.textContent).toBe('<');
    const attrs = dom(sanitizeHighlightedCode('<span class="a" onclick="x()" style="color:red">b</span>'));
    expect(attrs.querySelector('[onclick], [style]')).toBeNull();
    expect(attrs.querySelector('span.a')?.textContent).toBe('b');
    for (const payload of ['<img src=x onerror=alert(1)>', '<a href="javascript:1">c</a>', '<svg onload=alert(1)></svg>']) {
      expect(dom(sanitizeHighlightedCode(payload)).querySelector('img, a, svg'), payload).toBeNull();
    }
  });
});

describe('safeHref', () => {
  it('returns undefined for unsafe schemes and the URL otherwise', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('/settings')).toBe('/settings');
  });
});
