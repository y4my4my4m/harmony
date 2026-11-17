/**
 * GET /activities/frame/:appId?entry=<file>.js — the document an activity runs in.
 *
 * The page is Harmony's, not the activity's: a loader that adds the activity's script from
 * <APP_URL>/activities/<appId>/<entry> once it finds itself framed and in an opaque origin. Its
 * Content-Security-Policy carries `sandbox allow-scripts allow-pointer-lock`, so the document runs
 * in an opaque origin even when opened directly, never with the instance's storage, and refuses
 * every network connection (connect-src 'none'). Scripts, styles, images, media and fonts load from
 * the app's own folder, data: and blob: only; frame-ancestors names the web app and the native apps.
 */

import { randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import config from '../config/index.js'
import { corsOrigins } from '../config/nativeOrigins.js'

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.js$/

/** Origin the web build (and so /activities/<id>/) is served from. */
export function assetOrigin(): string {
  return new URL(config.APP_URL ?? `https://${config.INSTANCE_DOMAIN}`).origin
}

export function frameAncestors(): string[] {
  return [...new Set([assetOrigin(), ...corsOrigins(config.CORS_ORIGIN)])]
}

export function frameCsp(appId: string, nonce: string): string {
  const folder = `${assetOrigin()}/activities/${appId}/`
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

export function frameHtml(scriptSrc: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Harmony activity</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
<script nonce="${nonce}">
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
  var script = document.createElement('script');
  script.src = ${JSON.stringify(scriptSrc).replace(/</g, '\\u003c')};
  document.head.appendChild(script);
})();
</script>
</head>
<body></body>
</html>
`
}

const router = Router()

router.get('/frame/:appId', (req: Request, res: Response) => {
  const appId = String(req.params.appId)
  const entry = typeof req.query.entry === 'string' ? req.query.entry : ''
  if (!APP_ID.test(appId) || !ENTRY.test(entry)) {
    res.status(400).type('text/plain').send('Bad activity')
    return
  }
  const nonce = randomBytes(18).toString('base64')
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Cross-Origin-Resource-Policy')
  res.removeHeader('Cross-Origin-Embedder-Policy')
  res.removeHeader('Origin-Agent-Cluster')
  res.setHeader('Content-Security-Policy', frameCsp(appId, nonce))
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(), clipboard-read=()')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.type('text/html').send(frameHtml(`${assetOrigin()}/activities/${appId}/${entry}`, nonce))
})

export default router
