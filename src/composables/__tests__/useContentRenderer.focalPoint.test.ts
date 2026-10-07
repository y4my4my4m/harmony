/**
 * Inline media grids (MonyContent, renderMode="html") position `object-fit:
 * cover` cells on the attachment focal point; a single item stays centred.
 */

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { MessagePart } from '@/types';
import { useContentRenderer } from '../useContentRenderer';

function images(html: string): HTMLImageElement[] {
  const container = document.createElement('div');
  container.innerHTML = html;
  return Array.from(container.querySelectorAll('img'));
}

function render(parts: unknown[]): string {
  return useContentRenderer(ref(parts as MessagePart[]), { mode: 'display' }).formattedHTML.value;
}

const file = (url: string, extra: Record<string, unknown> = {}) => ({ type: 'file', fileType: 'image', url, ...extra });

describe('useContentRenderer: focal points', () => {
  it('sets object-position from focalPoint on grid cells', () => {
    const [first, second] = images(render([
      file('https://r.example/1.png', { focalPoint: [0.5, 0.5] }),
      file('https://r.example/2.png', { focalPoint: [-1, -1] }),
    ]));
    expect(first.style.objectPosition).toBe('75% 25%');
    expect(second.style.objectPosition).toBe('0% 100%');
  });

  it('leaves a centred or missing focal point unstyled', () => {
    for (const img of images(render([file('https://r.example/1.png', { focalPoint: [0, 0] }), file('https://r.example/2.png')]))) {
      expect(img.getAttribute('style')).toBeNull();
    }
  });

  it('does not position a single item, which is contain', () => {
    const [only] = images(render([file('https://r.example/1.png', { focalPoint: [0.5, 0.5] })]));
    expect(only.getAttribute('style')).toBeNull();
  });

  it('writes only numbers from a remote focalPoint', () => {
    const [first] = images(render([
      file('https://r.example/1.png', { focalPoint: ['0); background: url(https://evil.example/x)', 0] }),
      file('https://r.example/2.png', { focalPoint: { x: 1, y: 1 } }),
    ]));
    expect(first.getAttribute('style')).toBeNull();
  });
});
