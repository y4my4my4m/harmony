import { onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/services/instanceConfig';

type Rgb = [number, number, number];

function opaqueBackgroundAt(x: number, y: number): Rgb | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
    if (m) {
      const alpha = m[4] === undefined ? 1 : Number(m[4]);
      if (alpha > 0.05) {
        return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
      }
    }
    el = el.parentElement;
  }
  return null;
}

function toHex([r, g, b]: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function isLight([r, g, b]: Rgb): boolean {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4;
}

export function useStatusBarTheme(): void {
  if (!isTauriRuntime()) return;

  let attrObserver: MutationObserver | null = null;
  let bodyObserver: MutationObserver | null = null;
  let last = '';

  const apply = () => {
    const cx = Math.round(window.innerWidth / 2);
    const status = opaqueBackgroundAt(cx, 2);
    const nav = opaqueBackgroundAt(cx, window.innerHeight - 2);
    if (!status || !nav) return;

    const statusHex = toHex(status);
    const navHex = toHex(nav);
    const statusDark = isLight(status);
    const navDark = isLight(nav);
    const key = `${statusHex}:${navHex}:${statusDark}:${navDark}`;
    if (key === last) return;
    last = key;

    invoke('set_system_bar_colors', { statusHex, navHex, statusDark, navDark }).catch(() => {});
  };

  onMounted(() => {
    apply();
    let pending = 0;
    const schedule = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(apply, 200);
    };
    attrObserver = new MutationObserver(schedule);
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
    bodyObserver = new MutationObserver(schedule);
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  });

  onUnmounted(() => {
    attrObserver?.disconnect();
    bodyObserver?.disconnect();
  });
}
