// Journey, Android app: embedded frames cannot run native commands.
//
// wry injects Tauri's IPC script, invoke key included, into every frame and exposes the `ipc`
// bridge to every frame as the main page. MainFrameIpc.kt (src-tauri/gen/android) answers the main
// frame only. A sandboxed frame (as an activity runs in) and a plain third-party frame (as an embed)
// each emit an app event through Tauri's own invoke; the main page listens. Only the main page's
// event may arrive.
//
// Runs on an emulator or device with the debug APK, not in CI: HARMONY_ANDROID=1 and an adb device.
// No e2e stack: the frames are routed responses.
//
//   HARMONY_ANDROID=1 HARMONY_APK=<path to app-universal-debug.apk> npx playwright test --project=android frame-ipc

import { test, expect, _android as android, type AndroidDevice } from '@playwright/test'

const PKG = 'online.knowmad.harmony'

test.skip(!process.env.HARMONY_ANDROID, 'set HARMONY_ANDROID=1 with an emulator or device attached')

const FRAMES = {
  sandboxed: {
    sandbox: 'allow-scripts allow-pointer-lock',
    csp: "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'",
  },
  plain: { sandbox: null, csp: null },
} as const

function frameDocument(kind: string): string {
  return `<!doctype html><script>
    const post = (r) => parent.postMessage({ probe: Object.assign({ kind: ${JSON.stringify(kind)} }, r) }, '*');
    post({ loaded: true, internals: typeof window.__TAURI_INTERNALS__ });
    if (window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'harmony-frame-probe', payload: ${JSON.stringify(kind)} });
      post({ invoked: true });
    }
  </script>`
}

let device: AndroidDevice

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ;[device] = await android.devices()
  if (!device) throw new Error('no adb device')
  if (process.env.HARMONY_APK) await device.installApk(process.env.HARMONY_APK)
})

test.afterAll(async () => {
  await device?.shell(`am force-stop ${PKG}`).catch(() => {})
  await device?.close()
})

test('a sandboxed frame and a third-party frame cannot run native commands', async () => {
  test.setTimeout(180_000)
  await device.shell(`am force-stop ${PKG}`)
  await device.shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
  const webview = await device.webView({ pkg: PKG }, { timeout: 60_000 })
  const page = await webview.page()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.evaluate(() => typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)).toBe('object')

  await page.context().route('https://frame-probe.test/**', (route) => {
    const kind = new URL(route.request().url()).pathname.slice(1) as keyof typeof FRAMES
    const frame = FRAMES[kind]
    if (!frame) return route.fulfill({ status: 404, body: '' })
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
    if (frame.csp) headers['content-security-policy'] = frame.csp
    return route.fulfill({ status: 200, headers, body: frameDocument(kind) })
  })

  await page.evaluate(async (frames) => {
    type Internals = {
      transformCallback: (cb: (event: { payload: string }) => void) => number
      invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
    }
    const w = window as unknown as { __probe: unknown[]; __TAURI_INTERNALS__: Internals }
    w.__probe = []
    window.addEventListener('message', (e) => { if (e.data?.probe) w.__probe.push(e.data.probe) })
    const internals = w.__TAURI_INTERNALS__
    const handler = internals.transformCallback((event) => w.__probe.push({ event: event.payload }))
    await internals.invoke('plugin:event|listen', { event: 'harmony-frame-probe', target: { kind: 'Any' }, handler })
    await internals.invoke('plugin:event|emit', { event: 'harmony-frame-probe', payload: 'main' })
    for (const [kind, frame] of Object.entries(frames)) {
      const el = document.createElement('iframe')
      if (frame.sandbox !== null) el.setAttribute('sandbox', frame.sandbox)
      el.src = `https://frame-probe.test/${kind}`
      document.body.appendChild(el)
    }
  }, FRAMES)

  const probe = () => page.evaluate(() => (window as unknown as { __probe: Array<Record<string, unknown>> }).__probe)
  // Both frames loaded and invoked; the window below leaves their events time to arrive.
  await expect.poll(async () => (await probe()).filter((r) => r.invoked).map((r) => r.kind).sort(), { timeout: 30_000 })
    .toEqual(['plain', 'sandboxed'])
  await page.waitForTimeout(3_000)
  const events = (await probe()).filter((r) => 'event' in r).map((r) => r.event)
  expect(events).toEqual(['main'])
})
