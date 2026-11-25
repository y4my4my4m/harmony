// Journey: the scripts an activity can add to its frame. The frame document is the federation
// backend's (backend.ts) and the activity is this spec's, served in its folder. A document nested in
// the frame runs no script, the loader's own text included, and so has no WebRTC of its own; the
// frame and its workers load none from another host.

import { test, expect } from '@playwright/test'
import { startBackend, type Backend } from './backend'

test.use({ serviceWorkers: 'block' })

const APP = 'nestprobe'
const OUTSIDE = 'https://scripts.outside.test'

/** The activity. In a document nested in the frame it reports that it ran, and whether WebRTC is there. */
const ACTIVITY = `(async function () {
  if (window.parent !== window.top) {
    window.parent.postMessage({ nested: 'activity', rtc: typeof window.RTCPeerConnection }, '*')
    return
  }
  const heard = []
  window.addEventListener('message', (event) => { if (event.data && event.data.nested) heard.push(event.data) })
  const loader = document.querySelector('script[nonce]')
  const own = document.querySelector('script[src]').src
  const tag = (attributes, text) => '<script' + attributes + '>' + text + '</' + 'script>'
  const nonce = ' nonce="' + loader.nonce + '"'
  const documents = [
    tag(nonce, loader.textContent),
    tag(' src="' + own + '"', ''),
    tag(nonce + ' src="' + own + '"', ''),
    tag(nonce, 'parent.postMessage({ nested: "inline", rtc: typeof window.RTCPeerConnection }, "*")'),
  ]
  for (const srcdoc of documents) {
    const child = document.createElement('iframe')
    child.srcdoc = srcdoc
    const loaded = new Promise((resolve) => child.addEventListener('load', resolve))
    document.body.appendChild(child)
    await loaded
  }

  const add = (properties) => new Promise((resolve) => {
    const script = Object.assign(document.createElement('script'), properties)
    script.onload = () => resolve('ran')
    script.onerror = () => resolve('refused')
    document.head.appendChild(script)
  })
  const preload = (properties) => new Promise((resolve) => {
    const link = Object.assign(document.createElement('link'), properties)
    link.onload = () => resolve('loaded')
    link.onerror = () => resolve('refused')
    document.head.appendChild(link)
  })
  const inWorker = () => new Promise((resolve) => {
    const text = 'try { importScripts("${OUTSIDE}/worker.js"); postMessage("ran") } catch (e) { postMessage("refused") }'
    new Worker(URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))).onmessage = (event) => resolve(event.data)
  })
  const scripts = {
    nonce: await add({ src: '${OUTSIDE}/nonce.js', nonce: loader.nonce }),
    module: await add({ src: '${OUTSIDE}/module.js', type: 'module' }),
    import: await import('${OUTSIDE}/import.js').then(() => 'ran', () => 'refused'),
    worker: await inWorker(),
    preload: await preload({ rel: 'preload', as: 'script', href: '${OUTSIDE}/preload.js', nonce: loader.nonce }),
  }
  document.head.appendChild(Object.assign(document.createElement('script'), { nonce: loader.nonce, textContent: 'window.inlineRan = true' }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  window.top.postMessage({ result: { rtc: typeof window.RTCPeerConnection, inline: window.inlineRan === true, heard, scripts } }, '*')
})()`

let backend: Backend

test.beforeAll(async () => {
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
})

test('an activity adds no script to its frame, and a document nested there runs none', async ({ page }) => {
  await backend.route(page)
  await page.route(`**/activities/${APP}/app.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: ACTIVITY }))
  const outside: string[] = []
  await page.route(`${OUTSIDE}/**`, (route) => {
    outside.push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: '' })
  })
  // A page off the network, as backend.ts says of the frame's document.
  await page.goto('/offline.html')

  const result = await page.evaluate((src) => new Promise((resolve) => {
    window.addEventListener('message', (event) => { if (event.data?.result) resolve(event.data.result) })
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock')
    frame.src = src
    document.body.appendChild(frame)
  }), `/api/federation/activities/frame/${APP}?entry=app.js`)
  expect(result).toEqual({
    rtc: 'undefined',
    inline: false,
    heard: [],
    scripts: { nonce: 'refused', module: 'refused', import: 'refused', worker: 'refused', preload: 'refused' },
  })
  expect(outside).toEqual([])
})
