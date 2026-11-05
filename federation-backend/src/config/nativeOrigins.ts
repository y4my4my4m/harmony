/**
 * Page origins of the native apps (src-tauri). They load the frontend from the app bundle, so
 * every request they make to an instance is cross-origin. Tauri 3 (tauri-runtime-wry and
 * tauri-runtime-cef custom_scheme_url):
 *
 *   tauri://localhost       macOS and iOS (WKWebView); Linux builds before the CEF runtime
 *   http://tauri.localhost  Windows (WebView2), Android, Linux on CEF
 *
 * https://tauri.localhost is served only to a webview built with useHttpsScheme, which no
 * Harmony build sets, so it is absent.
 */
export const NATIVE_CLIENT_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;

/** CORS origins: CORS_ORIGIN's comma-separated entries, then the native apps'. */
export function corsOrigins(configured: string): string[] {
  const listed = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  return [...new Set([...listed, ...NATIVE_CLIENT_ORIGINS])];
}
