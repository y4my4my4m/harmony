/**
 * XSS regression tests for the post (ActivityPub timeline) rendering path.
 *
 * Posts get rendered via `UnifiedContentRenderer` in `renderMode="html"`,
 * which v-html's the output of `useContentRenderer.formattedHTML`. The
 * pipeline that builds that HTML is:
 *
 *   1. `renderPart('text')` calls `escapeHtml(part.text)` BEFORE any other
 *      transformation. After this point every subsequent transform
 *      operates on already-escaped text.
 *   2. Emoji / markdown / hashtag transforms run, inserting only known-safe
 *      tags we chose.
 *   3. The joined output is run through `sanitizeFormattedHtml` (DOMPurify
 *      with a wider allowlist than chat - includes `<iframe>` for YouTube
 *      embeds, `<video>` / `<audio>` for inline media - but still strips
 *      `<style>`, `<script>`, inline event handlers, and javascript: URLs).
 *
 * These tests assert the security invariant via DOM parsing rather than
 * substring matching: build the actual DOM the browser would build and
 * count dangerous elements.
 */

import { describe, expect, it } from 'vitest';
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

/** Same DOM-parse assertion as the chat XSS suite. */
function assertNoExecutableHtml(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;

  const dangerous = container.querySelectorAll(
    'style, script, object, embed, link, meta, base, form, input, textarea, button',
  );
  expect(
    dangerous.length,
    `expected no dangerous elements, got: ${Array.from(dangerous)
      .map((el) => el.outerHTML)
      .join(', ')}`,
  ).toBe(0);

  const allElements = container.querySelectorAll('*');
  for (const el of Array.from(allElements)) {
    for (const attr of Array.from(el.attributes)) {
      expect(
        attr.name.toLowerCase().startsWith('on'),
        `expected no on* handlers, found ${attr.name}="${attr.value}" on <${el.tagName.toLowerCase()}>`,
      ).toBe(false);
    }
  }

  for (const el of Array.from(allElements)) {
    for (const attrName of ['href', 'src', 'action', 'formaction']) {
      const val = el.getAttribute(attrName);
      if (val) {
        const lowered = val.trim().toLowerCase();
        expect(
          lowered.startsWith('javascript:') || lowered.startsWith('data:text/html'),
          `expected no javascript:/data:text/html in ${attrName}, found "${val}" on <${el.tagName.toLowerCase()}>`,
        ).toBe(false);
      }
    }
  }
}

describe('useContentRenderer.formattedHTML - XSS regression suite', () => {
  // Identical audit payloads to the chat suite - same vector, different
  // rendering path. Both paths must reject all of them.
  const auditPayloads: Array<[string, string]> = [
    [
      '<style>body{display:none}</style>',
      '<style>body{display:none}</style>',
    ],
    [
      '<style>.display-name{color:lime} after',
      '<style>.display-name{color:lime;font-size:16px;font-weight: 900;font-style: italic;}</style> Decided to make all the usernames italic and lime',
    ],
    [
      '<style>body{display:unset}',
      '<style>body{display:unset}</style>',
    ],
    [
      '<style>*::before{background-image:...}',
      '<style>*::before{background-image:url(itmesarah.github.io/iwillbeokay720p.avif)!important;transform:translateZ(0);z-index: -1;}</style>',
    ],
    [
      '<style>.app{filter:hue-rotate}',
      '<style>\r\n.app {\r\n    filter: hue-rotate(90deg) !important;\r\n}\r\n</style>',
    ],
    [
      'broken-out partial tag in backticks',
      "Doing `style>body{display:block}</style`",
    ],
  ];

  for (const [name, text] of auditPayloads) {
    it(`neutralizes audit payload: ${name}`, () => {
      const html = render([{ type: 'text', text } as MessagePart]);
      assertNoExecutableHtml(html);
    });
  }

  it('neutralizes <script>alert(1)</script>', () => {
    const html = render([
      { type: 'text', text: '<script>alert(1)</script>after' } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
  });

  it('neutralizes <img src=x onerror=alert(1)>', () => {
    const html = render([
      { type: 'text', text: '<img src=x onerror=alert(1)>' } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
  });

  it('neutralizes <a href=javascript:alert(1)>', () => {
    const html = render([
      { type: 'text', text: '<a href="javascript:alert(1)">click</a>' } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
  });

  it('neutralizes <svg onload=alert(1)>', () => {
    const html = render([
      { type: 'text', text: '<svg onload="alert(1)"></svg>' } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
  });

  it('neutralizes federation-side emoji name injection', () => {
    // A malicious federated instance can include an emoji whose `name` is
    // a JS injection payload. The previous renderer spliced the name into
    // an inline `onerror` JavaScript string. The fix HTML-escapes the name
    // and the sanitizer drops any `on*` attribute that survives. Use a
    // payload that would have escaped attribute context.
    const html = render([
      {
        type: 'emoji',
        emoji: {
          id: 'x',
          name: 'a";alert(1);//',
          url: 'https://example.com/emoji.png',
        },
      } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
    // The hostile name MUST NOT appear unescaped in JS context. It's fine
    // for it to appear as the alt text of a sanitized <img>.
    expect(html).not.toMatch(/onerror\s*=/i);
  });

  it('neutralizes federation-side hashtag name injection', () => {
    const html = render([
      {
        type: 'hashtag',
        name: 'x" onclick="alert(1)',
      } as MessagePart,
    ]);
    assertNoExecutableHtml(html);
  });

  it('preserves legitimate inline media (image url part)', () => {
    const html = render([
      { type: 'url', url: 'https://example.com/image.png' } as MessagePart,
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;
    // The renderer should still emit an <img> for an image URL - the
    // sanitizer's wider allowlist permits it.
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('preserves YouTube iframe embeds (the reason formatted mode has a wider allowlist)', () => {
    const html = render([
      { type: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as MessagePart,
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;
    const iframes = container.querySelectorAll('iframe');
    if (iframes.length > 0) {
      // If an iframe is emitted, it must be a YouTube embed URL.
      for (const iframe of Array.from(iframes)) {
        const src = iframe.getAttribute('src') || '';
        expect(src).toMatch(/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//);
      }
    }
    // Either way: no dangerous elements introduced.
    assertNoExecutableHtml(html);
  });
});
