import { isTauriRuntime } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';

let installed = false;

// Shared by the global click handler below and any component that already
// intercepts its own anchor clicks (e.g. UnifiedContentRenderer) and would
// otherwise swallow the click without ever reaching the OS browser.
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    debug.warn('⚠️ [tauriLinks] failed to open external URL:', err);
  }
}

// The Tauri webview ignores <a target="_blank"> / window.open, so external links
// do nothing. One delegated handler routes any unhandled http(s) anchor click to
// the OS browser via the shell plugin — covers every link without per-link wiring.
export function installTauriExternalLinks(): void {
  if (installed || !isTauriRuntime()) return;
  installed = true;

  console.warn('🔗 [tauriLinks] global handler installed');
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const anchor = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    console.warn('🔗 [tauriLinks] global click, href:', href);
    if (!/^https?:\/\//i.test(href)) return; // in-app/relative routes handled by the router

    e.preventDefault();
    openExternalUrl(href);
  }, true);
}
