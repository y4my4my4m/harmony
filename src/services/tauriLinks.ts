import { isTauriRuntime } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';

const isAndroid = /Android/i.test(navigator.userAgent);
let installed = false;

// Shared by the global handler below and any component that already intercepts
// its own anchor clicks (e.g. UnifiedContentRenderer). Android: tauri-plugin-shell's
// open() execs the URL as a local program (broken), so use a native ACTION_VIEW
// intent. Desktop: the shell plugin's open works.
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    if (isAndroid) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('android_open_url', { url });
    } else {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    }
  } catch (err) {
    debug.warn('⚠️ [tauriLinks] failed to open external URL:', err);
  }
}

// The Tauri webview ignores <a target="_blank"> / window.open, so external links
// do nothing. One delegated handler opens any unhandled http(s) anchor click in
// the OS browser — covers every link without per-link wiring. Bubble phase +
// defaultPrevented guard so component handlers that already open the link win.
export function installTauriExternalLinks(): void {
  if (installed || !isTauriRuntime()) return;
  installed = true;

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const anchor = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return; // in-app/relative routes handled by the router

    e.preventDefault();
    openExternalUrl(href);
  });
}
