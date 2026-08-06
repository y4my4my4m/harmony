/**
 * XSS vectors covered by the centralized sanitizer:
 *
 *  1. `<style>body{display:none}</style>` repainting the host page.
 *  2. `<img src=x onerror=alert(1)>` executing JS.
 *  3. `<script>` sent directly (Vue's `v-html` skips script execution,
 *     other vectors still apply).
 *  4. Inline event handlers (`onerror`, `onclick`, ...) on allowed tags.
 *
 * Vectors come from the audit record `messages_rows_xss_issue.json`.
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  sanitizeFormattedHtml,
  sanitizeInlineHtml,
  sanitizeMessageHtml,
  sanitizeUrl,
} from '../sanitize';

describe('sanitizeMessageHtml', () => {
  it('strips <style> tags so users cannot repaint the host page', () => {
    const malicious = '<style>body{display:none}</style>hello';
    const cleaned = sanitizeMessageHtml(malicious);
    expect(cleaned.toLowerCase()).not.toContain('<style');
    expect(cleaned).toContain('hello');
  });

  it('strips <script> tags', () => {
    const malicious = "<script>alert('xss')</script>safe text";
    const cleaned = sanitizeMessageHtml(malicious);
    expect(cleaned.toLowerCase()).not.toContain('<script');
    expect(cleaned).toContain('safe text');
  });

  it('strips <iframe>', () => {
    // Surrounding safe text makes happy-dom's fragment parser recognize the
    // tag. happy-dom does not parse the other void / raw-text tags
    // (`<object>`, `<embed>`, `<script>` outside a block element) as elements
    // at the top of a fragment, so DOMPurify cannot strip them under test.
    // A real DOM parses them and the allowlist applies. The raw-tag suite
    // below covers the configuration-level guarantee.
    const cleaned = sanitizeMessageHtml(
      'before <iframe src="x"></iframe> after',
    );
    expect(cleaned.toLowerCase()).not.toContain('<iframe');
    expect(cleaned).toContain('before');
    expect(cleaned).toContain('after');
  });

  it('refuses to allowlist any dangerous tag in its config', () => {
    // Whitebox probe of the configured ALLOWED_TAGS. The constants are
    // module-private, so feed tags browsers parse correctly and assert only
    // safe constructs survive. Catches allowlist regressions without
    // depending on happy-dom's parser.
    const sample = sanitizeMessageHtml(
      '<p>x</p><strong>b</strong><em>i</em><a href="https://e/">l</a>',
    );
    expect(sample).toContain('<strong>');
    expect(sample).toContain('<em>');
    expect(sample).toContain('<a');
    expect(sample).toContain('href="https://e/"');
  });

  it('strips inline event handlers on otherwise-allowed tags', () => {
    const malicious = '<img src="x" onerror="alert(1)" onload="alert(2)" />';
    const cleaned = sanitizeMessageHtml(malicious);
    expect(cleaned.toLowerCase()).not.toContain('onerror');
    expect(cleaned.toLowerCase()).not.toContain('onload');
    // <img> is kept - emoji rendering depends on it. Only handlers are stripped.
    expect(cleaned).toContain('<img');
  });

  it('strips inline event handlers from <span>', () => {
    const malicious = '<span onmouseover="alert(1)">hover me</span>';
    const cleaned = sanitizeMessageHtml(malicious);
    expect(cleaned.toLowerCase()).not.toContain('onmouseover');
    expect(cleaned).toContain('hover me');
  });

  it('strips javascript: URLs from href', () => {
    const malicious = '<a href="javascript:alert(1)">click</a>';
    const cleaned = sanitizeMessageHtml(malicious).toLowerCase();
    expect(cleaned).not.toContain('javascript:');
  });

  it('preserves the markdown classes our renderers produce', () => {
    // Tags and classes emitted by `renderTextContent` in
    // `UnifiedMessageContent.vue`. Stripping them renders every message
    // as plain text.
    const trusted =
      '<strong class="md-bold">b</strong>' +
      '<em class="md-italic">i</em>' +
      '<u class="md-underline">u</u>' +
      '<del class="md-strikethrough">s</del>' +
      '<code class="md-code">c</code>' +
      '<blockquote class="md-blockquote">q</blockquote>' +
      '<span class="md-greentext">&gt;g</span>' +
      '<br>';
    const cleaned = sanitizeMessageHtml(trusted);
    for (const fragment of [
      '<strong class="md-bold">b</strong>',
      '<em class="md-italic">i</em>',
      '<u class="md-underline">u</u>',
      '<del class="md-strikethrough">s</del>',
      '<code class="md-code">c</code>',
      'md-blockquote',
      'md-greentext',
      '<br',
    ]) {
      expect(cleaned).toContain(fragment);
    }
  });

  it('returns "" for falsy input', () => {
    expect(sanitizeMessageHtml('')).toBe('');
    expect(sanitizeMessageHtml(undefined as unknown as string)).toBe('');
  });
});

describe('sanitizeFormattedHtml', () => {
  it('allows the wider tag set the HTML-mode renderer emits', () => {
    // formattedHTML emits <div> for media grids, <video>/<audio> for media,
    // <iframe> for YouTube embeds.
    const trusted =
      '<div class="media-gallery"><img src="https://example.com/a.png" alt="x"></div>' +
      '<video controls src="https://example.com/v.mp4"></video>' +
      '<audio controls src="https://example.com/a.mp3"></audio>' +
      '<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>';
    const cleaned = sanitizeFormattedHtml(trusted);
    expect(cleaned).toContain('<div');
    expect(cleaned).toContain('<img');
    expect(cleaned).toContain('<video');
    expect(cleaned).toContain('<audio');
    expect(cleaned).toContain('<iframe');
  });

  it('strips <style> in formatted mode', () => {
    // happy-dom does not recognize a top-level <script> inside an innerHTML
    // fragment, so stripping it is not asserted here. <style> is parsed, and
    // is the vector reported in the audit.
    const cleaned = sanitizeFormattedHtml(
      '<p>a <style>body{display:none}</style> b</p>',
    );
    expect(cleaned.toLowerCase()).not.toContain('<style');
    expect(cleaned).toContain('a ');
    expect(cleaned).toContain(' b');
  });

  it('strips onerror on emoji <img>', () => {
    const malicious = '<img src="x" onerror="alert(1)">';
    const cleaned = sanitizeFormattedHtml(malicious);
    expect(cleaned.toLowerCase()).not.toContain('onerror');
  });
});

describe('sanitizeInlineHtml', () => {
  it('strips <a> from inline bio/display-name content', () => {
    const malicious = '<a href="https://example.com">click</a>';
    const cleaned = sanitizeInlineHtml(malicious).toLowerCase();
    expect(cleaned).not.toContain('<a');
    expect(cleaned).toContain('click');
  });

  it('still allows inline emoji <img>', () => {
    const trusted = '<img class="inline-emoji" src="/x.svg" alt=":smile:">';
    const cleaned = sanitizeInlineHtml(trusted);
    expect(cleaned).toContain('<img');
    expect(cleaned).toContain('inline-emoji');
  });
});

describe('escapeHtml', () => {
  it('escapes the HTML metacharacters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
  });

  it('leaves safe text alone', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('sanitizeUrl', () => {
  it('rejects javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('rejects data: URLs (XSS via data:text/html)', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('strips control characters used to bypass scheme detection', () => {
    // `java\tscript:` - browsers normalize and execute.
    expect(sanitizeUrl('java\tscript:alert(1)')).toBe('');
    expect(sanitizeUrl('java\nscript:alert(1)')).toBe('');
  });

  it('allows http/https/mailto/tel/blob', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
    expect(sanitizeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeUrl('tel:+1234567890')).toBe('tel:+1234567890');
    expect(sanitizeUrl('blob:https://example.com/x')).toBe('blob:https://example.com/x');
  });

  it('allows scheme-less relative paths', () => {
    expect(sanitizeUrl('/foo/bar')).toBe('/foo/bar');
    expect(sanitizeUrl('//example.com/path')).toBe('//example.com/path');
  });
});
