/**
 * XSS regression tests for `parseDisplayNameOrBioForDisplay`, the helper
 * that turns a (possibly federated) bio / display-name payload into HTML
 * for v-html consumers like `UserCard.vue`.
 *
 * The same audit payloads that hit chat messages also reach bio/display-
 * name fields via the federation backend: a remote instance can ship a
 * bio that contains `<style>` or `<img onerror>`. These tests assert
 * those payloads are inert here too.
 */

import { describe, expect, it } from 'vitest';
import { parseDisplayNameOrBioForDisplay } from '../mentionUtils';

function assertNoExecutableHtml(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;

  const dangerous = container.querySelectorAll(
    'style, script, iframe, object, embed, link, meta, base, form, input, a',
  );
  expect(
    dangerous.length,
    `expected no dangerous/interactive elements, got: ${Array.from(dangerous)
      .map((el) => el.outerHTML)
      .join(', ')}`,
  ).toBe(0);

  for (const el of Array.from(container.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      expect(
        attr.name.toLowerCase().startsWith('on'),
        `expected no on* handlers, found ${attr.name}="${attr.value}"`,
      ).toBe(false);
    }
  }
}

describe('parseDisplayNameOrBioForDisplay - XSS regression', () => {
  it('neutralizes <style> in a plain-string bio', () => {
    const html = parseDisplayNameOrBioForDisplay('<style>body{display:none}</style>');
    assertNoExecutableHtml(html);
  });

  it('neutralizes <script> in a plain-string bio', () => {
    const html = parseDisplayNameOrBioForDisplay('<script>alert(1)</script>');
    assertNoExecutableHtml(html);
  });

  it('neutralizes <img onerror> in a plain-string bio', () => {
    const html = parseDisplayNameOrBioForDisplay('<img src=x onerror=alert(1)>');
    assertNoExecutableHtml(html);
  });

  it('neutralizes <a href=javascript:> in a plain-string bio', () => {
    const html = parseDisplayNameOrBioForDisplay('<a href="javascript:alert(1)">click</a>');
    assertNoExecutableHtml(html);
  });

  it('neutralizes federated MFM payload with hostile text part', () => {
    const html = parseDisplayNameOrBioForDisplay([
      { type: 'text', text: '<style>body{display:none}</style>' },
    ]);
    assertNoExecutableHtml(html);
  });

  it('neutralizes federated MFM payload with hostile emoji name', () => {
    // Malicious instance ships an emoji whose name contains an injection
    // payload. The renderer escapes the name when splicing into the
    // <img> alt/title attributes, and the final sanitizer strips any
    // dangerous attribute that survives.
    const html = parseDisplayNameOrBioForDisplay([
      {
        type: 'emoji',
        emoji: {
          name: 'a";alert(1);//',
          url: 'https://example.com/emoji.png',
        },
      },
    ]);
    assertNoExecutableHtml(html);
    expect(html).not.toMatch(/onerror\s*=/i);
  });

  it('escapes literal `<style>` so the browser shows it as text', () => {
    const html = parseDisplayNameOrBioForDisplay('<style>x</style>');
    expect(html).toContain('&lt;style&gt;');
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.textContent).toContain('<style>');
  });

  it('falls back to the escaped fallback string when input is empty', () => {
    const html = parseDisplayNameOrBioForDisplay('', '<style>x</style>');
    assertNoExecutableHtml(html);
    // Fallback content is shown as literal text after escaping.
    expect(html).toContain('&lt;style&gt;');
  });

  it('preserves emoji <img> for legitimate emoji parts', () => {
    const html = parseDisplayNameOrBioForDisplay([
      { type: 'text', text: 'hi ' },
      {
        type: 'emoji',
        emoji: {
          name: 'smile',
          url: 'https://example.com/smile.png',
        },
      },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe(':smile:');
  });
});
