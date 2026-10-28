// Journeys, Android app with Gboard: the chat composer of this checkout, typed into through the
// on-screen keyboard:
// - words typed beside markdown keep their letters; Gboard's Enter key adds a line; the send
//   button sends what was typed;
// - the composer asks Gboard for autocorrection, and sends what the composer shows;
// - with the keyboard down, a tap on a word the spellchecker underlines raises the keyboard and
//   opens no spelling menu, after the reaction picker's search and with the composer focused.
//
// Runs on an emulator or device with the app installed and Gboard as its keyboard, not in CI:
// HARMONY_ANDROID=1, an adb device, the e2e stack up (npm run e2e:up) and a dev server of this
// checkout on BASE_URL's port. adb reverse carries the dev server's and the stack gateway's
// ports to the device; the app's WebView loads the dev server, so the composer under test is
// this checkout's, whatever version the installed app is. Keys are tapped where Gboard's own
// accessibility nodes (uiautomator dump) put them.
//
//   HARMONY_ANDROID=1 BASE_URL=http://localhost:5317 npx playwright test --project=android composer-gboard
//
// The emulator used: AVD harmony35 (Pixel 7, API 35, Google Play image with Gboard).

import { execFileSync } from 'node:child_process'
import { test, expect, _android as android, type AndroidDevice, type Page } from '@playwright/test'
import { addChannel, adminClient, createUser, deleteUser, seedServer, type SeededServer, type SpecUser } from '../specs/harness'

const PKG = 'online.knowmad.harmony'
const GBOARD = 'com.google.android.inputmethod.latin'
const DEV = new URL(process.env.BASE_URL || 'http://localhost:5173')
const GATEWAY_PORT = Number(new URL(process.env.E2E_SUPABASE_URL || 'http://localhost:54480').port)

test.skip(!process.env.HARMONY_ANDROID, 'set HARMONY_ANDROID=1 with an emulator or device attached')
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let device: AndroidDevice
let user: SpecUser
let server: SeededServer
// Each test types in a channel of its own: a draft is kept per channel.
let channel = ''

const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  user = await createUser(admin, 'gbd')
  server = await seedServer(admin, user, `Gboard ${user.username}`)
  ;[device] = await android.devices()
  if (!device) throw new Error('no adb device')
  adb('reverse', `tcp:${DEV.port}`, `tcp:${DEV.port}`)
  adb('reverse', `tcp:${GATEWAY_PORT}`, `tcp:${GATEWAY_PORT}`)
  if (!adb('shell', 'settings', 'get', 'secure', 'default_input_method').includes(GBOARD)) {
    throw new Error('Gboard is not the default keyboard')
  }
})

// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, info) => {
  channel = await addChannel(admin, server, `g${info.testId.slice(0, 6)}${info.retry}`)
})

test.afterAll(async () => {
  await device?.shell(`am force-stop ${PKG}`).catch(() => {})
  await device?.close().catch(() => {})
  await deleteUser(admin, user)
})

async function count(): Promise<number> {
  const { count: n } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('channel_id', channel)
  return n ?? 0
}

async function lastText(): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', channel)
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).single()
  return (data!.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? `[${p.type}]`).join('')
}

/** The app's WebView on the dev server, signed in, in the seeded channel. */
async function openApp(): Promise<Page> {
  await device.shell(`am force-stop ${PKG}`)
  await device.shell(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {})
  await device.shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
  const page = await (await device.webView({ pkg: PKG }, { timeout: 60_000 })).page()
  // The app's instance picker is skipped: the dev server's stack is the instance.
  await page.goto(`${DEV.origin}/robots.txt`)
  await page.evaluate((instance) => localStorage.setItem('harmony.instance', JSON.stringify(instance)), {
    origin: DEV.origin,
    name: 'e2e',
    supabaseUrl: process.env.E2E_SUPABASE_URL,
    supabaseAnonKey: process.env.E2E_SUPABASE_ANON_KEY,
    domain: 'localhost',
    capabilities: ['encrypted-history', 'outgoing-webhooks'],
  })
  // The session of an earlier test survives the restart.
  await page.goto(`${DEV.origin}/chat/${server.id}/${channel}`)
  const email = page.locator('[data-testid="auth-email"]')
  const list = page.locator('[data-testid="message-list"]')
  await expect(email.or(list)).toBeVisible({ timeout: 60_000 })
  if (await email.isVisible()) {
    await email.fill(user.email)
    await page.locator('[data-testid="auth-password"]').fill(user.password)
    await page.locator('[data-testid="auth-submit"]').click()
    await page.waitForURL(/\/chat/, { timeout: 60_000 })
    await page.goto(`${DEV.origin}/chat/${server.id}/${channel}`)
  }
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 60_000 })
  return page
}

async function uiDump(): Promise<string> {
  await device.shell('uiautomator dump --windows /sdcard/ui.xml')
  return (await device.shell('cat /sdcard/ui.xml')).toString()
}

/** Screen pixels of a point in the WebView's viewport (CSS px). */
async function screenPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  const view = /class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]/.exec(await uiDump())
  const [left, top] = view ? [Number(view[1]), Number(view[2])] : [0, 0]
  return [Math.round(left + x * dpr), Math.round(top + y * dpr)]
}

/** Taps an element as a finger does: the soft keyboard opens only for a real touch. */
async function touch(page: Page, selector: string, holdMs = 0) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} is not on screen`)
  const [x, y] = await screenPoint(page, box.x + box.width / 2, box.y + box.height / 2)
  await device.shell(holdMs ? `input swipe ${x} ${y} ${x} ${y} ${holdMs}` : `input tap ${x} ${y}`)
}

interface Key { label: string; x: number; y: number; top: number }

/**
 * Gboard's keys on screen, by lower-cased label, from its accessibility nodes. Letter keys are
 * labelled in the case Shift gives them. The suggestion strip above the keys holds words
 * ("a", "in") that would shadow letter keys: only nodes from the top row of keys down count.
 */
async function keyboardKeys(): Promise<Map<string, Key>> {
  const xml = await uiDump()
  const nodes: Key[] = []
  const node = /<node [^>]*>/g
  let m: RegExpExecArray | null
  while ((m = node.exec(xml)) !== null) {
    const tag = m[0]
    if (!tag.includes(`package="${GBOARD}"`)) continue
    const label = /content-desc="([^"]*)"/.exec(tag)?.[1] || /text="([^"]*)"/.exec(tag)?.[1] || ''
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag)
    if (!label || !bounds) continue
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number)
    nodes.push({ label, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), top: y1 })
  }
  const q = nodes.find((k) => k.label.toLowerCase() === 'q')
  const keys = new Map<string, Key>()
  for (const k of nodes) {
    if (q && k.top < q.top) continue
    if (!keys.has(k.label.toLowerCase())) keys.set(k.label.toLowerCase(), k)
  }
  return keys
}

async function tapKey(keys: Map<string, Key>, label: string) {
  const key = keys.get(label.toLowerCase())
  if (!key) throw new Error(`no Gboard key "${label}"; keys: ${[...keys.keys()].join(', ')}`)
  await device.shell(`input tap ${key.x} ${key.y}`)
}

/** Types letters and spaces on Gboard's letter layout. */
async function gboardType(text: string) {
  const keys = await keyboardKeys()
  for (const ch of text) {
    await tapKey(keys, ch === ' ' ? 'space' : ch)
    await new Promise((r) => setTimeout(r, 120))
  }
}

async function composerText(page: Page): Promise<string> {
  return page.locator('[data-testid="message-input"] .rich-text-editor').evaluate((el) => (el.textContent ?? '').replace(/\u00a0/g, ' '))
}

test('words typed on Gboard beside markdown keep their letters; Enter adds a line; send sends', async () => {
  test.setTimeout(300_000)
  const page = await openApp()
  const editor = page.locator('[data-testid="message-input"] .rich-text-editor')
  await touch(page, '[data-testid="message-input"] .rich-text-editor')
  await expect.poll(async () => (await keyboardKeys()).size, { timeout: 30_000 }).toBeGreaterThan(20)
  // The markdown goes in through the page; Gboard types the words after it.
  await page.keyboard.insertText('**a** ')
  await gboardType('hello world')
  await expect.poll(() => composerText(page), { timeout: 15_000 }).toMatch(/^\*\*a\*\* hello world ?$/i)
  await expect(editor.locator('.editor-bold-content')).toHaveText('a')

  const keys = await keyboardKeys()
  const enter = [...keys.keys()].find((k) => /^(Enter|Return|New line)$/i.test(k))
  if (!enter) throw new Error(`no Enter key; keys: ${[...keys.keys()].join(', ')}`)
  await tapKey(keys, enter)
  await gboardType('again')
  await expect.poll(() => composerText(page), { timeout: 15_000 }).toMatch(/hello world ?again$/i)
  expect(await editor.locator('br').count()).toBeGreaterThan(0)

  const before = await count()
  await touch(page, '[data-testid="message-send-btn"]')
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(before)
  expect(await lastText()).toMatch(/^\*\*a\*\* hello world ?\nagain$/i)
})

test('the composer asks the keyboard for autocorrection and sends what it shows', async () => {
  test.setTimeout(300_000)
  const page = await openApp()
  await touch(page, '[data-testid="message-input"] .rich-text-editor')
  await expect.poll(async () => (await keyboardKeys()).size, { timeout: 30_000 }).toBeGreaterThan(20)
  // EditorInfo.inputType of the focused editor; TYPE_TEXT_FLAG_AUTO_CORRECT is 0x8000, which
  // Chromium withholds from an editor with autocorrect="off".
  const editorInfo = (await device.shell('dumpsys input_method')).toString()
    .split('\n').filter((line) => /inputType=0x[1-9a-f]/.test(line)).pop() ?? ''
  const inputType = Number(/inputType=(0x[0-9a-f]+)/.exec(editorInfo)?.[1])
  expect(inputType & 0x8000).toBe(0x8000)
  await page.keyboard.insertText('*x* ')
  await gboardType('teh cat ')
  await expect.poll(() => composerText(page), { timeout: 15_000 }).toMatch(/^\*x\* (teh|the) cat $/i)
  const shown = (await composerText(page)).trim()
  const before = await count()
  await touch(page, '[data-testid="message-send-btn"]')
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(before)
  expect(await lastText()).toBe(shown)
})

/** Whether the soft keyboard is up, as the input method service has it. */
async function keyboardShown(): Promise<boolean> {
  return /mInputShown=true/.test((await device.shell('dumpsys input_method')).toString())
}

test('with the keyboard down, a tap on an underlined word raises the keyboard and opens no spelling menu', async () => {
  test.setTimeout(300_000)
  const { error } = await admin.from('messages').insert({
    channel_id: channel, user_id: user.id, content: [{ type: 'text', text: 'react to this one' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
  const page = await openApp()
  const selector = '[data-testid="message-input"] .rich-text-editor'
  const editor = page.locator(selector)
  await touch(page, selector)
  await expect.poll(keyboardShown, { timeout: 30_000 }).toBe(true)
  await page.keyboard.insertText('this is a misspeled word ')

  // The reaction picker: long press, React, a search typed on Gboard, the first result.
  await touch(page, '.message-item:has-text("react to this one")', 800)
  await touch(page, '[data-testid="msg-action-react"]:visible')
  await expect(page.locator('.emoji-popup .search-input')).toBeFocused({ timeout: 15_000 })
  await expect.poll(async () => (await keyboardKeys()).size, { timeout: 30_000 }).toBeGreaterThan(20)
  await gboardType('smile')
  await touch(page, '.emoji-popup .emoji-item')
  await expect(page.locator('.emoji-popup')).toHaveCount(0)
  // Focus went back to the picker's opener; the search's keyboard went down with the picker.
  await expect.poll(keyboardShown, { timeout: 15_000 }).toBe(false)
  await expect(editor).not.toBeFocused()

  const word = () => editor.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode()) && !node.textContent!.includes('misspeled'));
    const at = node!.textContent!.indexOf('misspeled')
    const range = document.createRange()
    range.setStart(node!, at + 3)
    range.setEnd(node!, at + 4)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  const tapWord = async () => {
    const { x, y } = await word()
    const [sx, sy] = await screenPoint(page, x, y)
    await device.shell(`input tap ${sx} ${sy}`)
  }
  const caret = () => page.evaluate(() => getSelection()!.anchorOffset)
  // Read once the tap has settled: without the fix the keyboard can show for a moment before the
  // menu opens. The menu (TextSuggestionHost) lists these under its suggestions.
  const settled = async () => {
    await page.waitForTimeout(1500)
    return { keyboard: await keyboardShown(), menu: /text="(Add to dictionary|Delete)"/.test(await uiDump()) }
  }

  await tapWord()
  expect(await settled()).toEqual({ keyboard: true, menu: false })
  await expect(editor).toBeFocused()
  expect(await caret()).toBeGreaterThanOrEqual(10)
  expect(await caret()).toBeLessThanOrEqual(19)

  // Back takes the keyboard down and leaves the composer focused.
  await device.shell('input keyevent 4')
  await expect.poll(keyboardShown, { timeout: 15_000 }).toBe(false)
  await expect(editor).toBeFocused()
  await page.waitForTimeout(500)
  await tapWord()
  expect(await settled()).toEqual({ keyboard: true, menu: false })
})
