/**
 * Post and bio rendering (MonyContent, renderMode="html") with author-supplied
 * `system` parts and URI payloads from the security audit. The DOM the browser
 * would build is inspected rather than the string.
 */

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { MessagePart } from '@/types';
import { useContentRenderer } from '../useContentRenderer';

function render(content: MessagePart[] | string): string {
  const renderer = useContentRenderer(ref(content), {
    mode: 'display',
    enableMarkdown: true,
    enableClickHandlers: true,
  });
  return renderer.formattedHTML.value;
}

function dom(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

function unsafeUris(container: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of Array.from(container.querySelectorAll('*'))) {
    for (const attr of ['href', 'src', 'srcdoc', 'style']) {
      const value = el.getAttribute(attr);
      if (value == null) continue;
      if (attr === 'srcdoc' || attr === 'style' || /^\s*(javascript|data:text\/html|vbscript)/i.test(value)) {
        found.push(`<${el.tagName.toLowerCase()} ${attr}="${value}">`);
      }
    }
  }
  return found;
}

const SYSTEM_PAYLOADS = [
  '<iframe src="javascript:parent.__pwned=document.domain"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<div style="position:fixed;inset:0;z-index:99999;background:url(https://evil.example/x.png)">x</div>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
];

describe('useContentRenderer: author-supplied system parts', () => {
  for (const payload of SYSTEM_PAYLOADS) {
    it(`drops a system part carrying ${payload.slice(0, 40)}`, () => {
      const html = render([
        { type: 'text', text: 'hi ' } as MessagePart,
        { type: 'system', event_type: payload } as unknown as MessagePart,
      ]);
      const container = dom(html);
      expect(container.querySelector('iframe, a, img, svg, div[style], .system-message')).toBeNull();
      expect(unsafeUris(container)).toEqual([]);
      expect(container.textContent).toBe('hi ');
    });
  }

  it('drops a system part in a bio stored as JSON text', () => {
    const bio = JSON.stringify([
      { type: 'text', text: 'about me' },
      { type: 'system', event_type: SYSTEM_PAYLOADS[0] },
    ]);
    const container = dom(render(bio));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toBe('about me');
  });

  it('drops a system part whatever the case of its type', () => {
    const container = dom(render([
      { type: 'System', event_type: SYSTEM_PAYLOADS[1] } as unknown as MessagePart,
    ]));
    expect(container.querySelector('a')).toBeNull();
  });

  it('exposes no system part to the component renderer', () => {
    const renderer = useContentRenderer(ref([
      { type: 'system', event_type: 'join' } as unknown as MessagePart,
      { type: 'text', text: 'x' } as MessagePart,
    ]));
    expect(renderer.renderableContent.value.map((p) => p.type)).toEqual(['text']);
  });
});

describe('useContentRenderer: URI payloads', () => {
  it('renders a javascript: url part as inert text', () => {
    const container = dom(render([{ type: 'url', url: 'javascript:alert(1)' } as MessagePart]));
    expect(container.querySelector('a')).toBeNull();
    expect(unsafeUris(container)).toEqual([]);
  });

  it('keeps a YouTube embed and its link', () => {
    const container = dom(render([
      { type: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as MessagePart,
    ]));
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toMatch(/^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?/);
    expect(container.querySelector('a.url-link')?.getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('does not render a custom emoji with a javascript: url as a link or script', () => {
    const container = dom(render([
      {
        type: 'emoji',
        emoji: { id: 'e', name: 'x" onerror="alert(1)', url: 'javascript:alert(1)//storage/v1/x' },
      } as unknown as MessagePart,
    ]));
    expect(unsafeUris(container)).toEqual([]);
    for (const el of Array.from(container.querySelectorAll('*'))) {
      expect(Array.from(el.attributes).some((a) => a.name.startsWith('on'))).toBe(false);
    }
  });

  it('escapes a file size that is not a number', () => {
    const container = dom(render([
      {
        type: 'file',
        url: 'https://example.com/a.bin',
        fileName: 'a.bin',
        fileType: 'other',
        fileSize: '<img src=x onerror=alert(1)>',
      } as unknown as MessagePart,
    ]));
    expect(container.querySelector('img')).toBeNull();
  });
});
