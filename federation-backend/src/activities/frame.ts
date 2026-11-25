/**
 * GET /activities/frame/:appId?entry=<file>.js[&source=package] — the document an activity runs in.
 *
 * The page is Harmony's, not the activity's: a loader that adds the activity's script once it finds
 * itself framed and in an opaque origin, and that posts {hp: 1, t: 'gone'} to the client when the
 * document is left. A built-in's script is <APP_URL>/activities/<appId>/<entry> (the web build); an
 * installed package's is <APP_URL>/api/federation/activities/pkg/<appId>/<sha256>.js
 * (packageRoutes.ts). The Content-Security-Policy carries `sandbox allow-scripts
 * allow-pointer-lock`, so the document runs in an opaque origin even when opened directly, never
 * with the instance's storage, and refuses every network connection (connect-src 'none'). Styles,
 * images, media and fonts load from the app's own folder, data: and blob: only; frame-ancestors
 * names the web app and the native apps.
 *
 * An activity is one script. The loader adds it, then a second policy that takes none
 * (AFTER_SCRIPT_CSP). A script is checked against the policies when its load starts: the activity's
 * runs, and none it adds does. The first policy alone would take one from any host under its nonce.
 *
 * connect-src does not cover WebRTC, and Chromium 148, Firefox 150 and WebKit 26.4 recognize no CSP
 * `webrtc` directive: the loader deletes the constructors before the activity runs. A nested
 * document would have its own, and frame-src does not cover srcdoc; it inherits both policies and
 * runs no script. An about:blank child is another opaque origin. In those three browsers no policy
 * covers `preconnect` and `dns-prefetch` links, nor Chromium's `prerender` links (a whole GET).
 */

import { randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import config from '../config/index.js'
import { corsOrigins } from '../config/nativeOrigins.js'

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.js$/
const PACKAGE_ENTRY = /^[0-9a-f]{64}\.js$/

/** Origin the web build (and so /activities/<id>/) is served from. */
export function assetOrigin(): string {
  return new URL(config.APP_URL ?? `https://${config.INSTANCE_DOMAIN}`).origin
}

export function frameAncestors(): string[] {
  return [...new Set([assetOrigin(), ...corsOrigins(config.CORS_ORIGIN)])]
}

/** The folder an activity's files load from. */
export function appFolder(appId: string, packaged: boolean): string {
  return packaged ? `${assetOrigin()}/api/federation/activities/pkg/${appId}/` : `${assetOrigin()}/activities/${appId}/`
}

export function frameCsp(appId: string, nonce: string, packaged = false): string {
  const folder = appFolder(appId, packaged)
  return [
    'sandbox allow-scripts allow-pointer-lock',
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${folder}`,
    `style-src 'unsafe-inline' ${folder}`,
    `img-src data: blob: ${folder}`,
    `media-src data: blob: ${folder}`,
    `font-src data: ${folder}`,
    "connect-src 'none'",
    'worker-src blob:',
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self' ${frameAncestors().join(' ')}`,
  ].join('; ')
}

/**
 * worker-src falls back to script-src; a blob: worker inherits the policies and imports nothing.
 * No policy holds 'strict-dynamic': with it WebKit 26.4 loads modules and worker imports from every
 * host, whatever the other policies say.
 */
const AFTER_SCRIPT_CSP = "script-src 'none'; worker-src blob:"

/** Text of the document's inline script. */
export function frameLoader(scriptSrc: string): string {
  return `
(function () {
  if (window.parent === window || self.origin !== 'null') {
    document.documentElement.textContent = 'This activity runs inside Harmony.';
    return;
  }
  // Captured before the activity runs: leaving this document (the activity navigating its frame)
  // tells the client, which stops talking to the frame.
  var parentWindow = window.parent;
  var post = parentWindow.postMessage.bind(parentWindow);
  window.addEventListener('pagehide', function () { post({ hp: 1, t: 'gone' }, '*'); }, true);
  // A desktop shell may run its bridge scripts in subframes too (wry on WebView2). Their
  // window.ipc and __TAURI_INTERNALS__ are non-configurable; the ports they call at send time,
  // window.chrome.webview and window.webkit.messageHandlers, are removed before the activity runs.
  // The WebRTC constructors go with them: a peer connection tells its other end the player's address.
  ['chrome', 'webkit', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel'].forEach(function (name) {
    try { delete window[name]; } catch (e) {}
  });
  var script = document.createElement('script');
  script.src = ${JSON.stringify(scriptSrc).replace(/</g, '\\u003c')};
  document.head.appendChild(script);
  var policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = ${JSON.stringify(AFTER_SCRIPT_CSP)};
  document.head.appendChild(policy);
})();
`
}

export function frameHtml(loader: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Harmony activity</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
<script nonce="${nonce}">${loader}</script>
</head>
<body></body>
</html>
`
}

const router = Router()

router.get('/frame/:appId', (req: Request, res: Response) => {
  const appId = String(req.params.appId)
  const entry = typeof req.query.entry === 'string' ? req.query.entry : ''
  const packaged = req.query.source === 'package'
  if (!APP_ID.test(appId) || !(packaged ? PACKAGE_ENTRY : ENTRY).test(entry)) {
    res.status(400).type('text/plain').send('Bad activity')
    return
  }
  const nonce = randomBytes(18).toString('base64')
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Cross-Origin-Resource-Policy')
  res.removeHeader('Cross-Origin-Embedder-Policy')
  res.removeHeader('Origin-Agent-Cluster')
  const folder = appFolder(appId, packaged)
  res.setHeader('Content-Security-Policy', frameCsp(appId, nonce, packaged))
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(), clipboard-read=()')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.type('text/html').send(frameHtml(frameLoader(`${folder}${entry}`), nonce))
})

export default router
