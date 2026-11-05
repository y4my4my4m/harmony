// Journeys: the chat composer draws Twemoji in WebKit, the engine of the iOS app, the macOS app
// and every iOS browser (the WebKit subset of composer-twemoji.spec.ts).
// - Pasted and typed emoji are drawn; the caret steps over a whole emoji and Backspace removes
//   it whole; the message holds the same characters.
// - On an iPhone the send button sends the same characters.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer
let channel = ''

const SKIN = '👍🏽'
const FAMILY = '👨‍👩‍👧'
const FLAG = '🇯🇵'

test.beforeAll(async () => {
  me = await createUser(admin, 'iostw')
  server = await seedServer(admin, me, `iOS Twemoji ${me.username.slice(-6)}`)
})
test.afterAll(async () => {
  await deleteUser(admin, me)
})
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')

/** The editor's text as it sends it: a drawn emoji reads as its characters. */
const valueOf = (box: Locator) =>
  box.evaluate((root) => {
    let out = ''
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += (node as Text).data
        return
      }
      const el = node as HTMLElement
      if (el.dataset?.unicode) {
        out += el.dataset.unicode
        return
      }
      el.childNodes.forEach(walk)
    }
    root.childNodes.forEach(walk)
    return out.replace(/\u00a0/g, ' ')
  })

const drawn = (box: Locator) =>
  box.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('.editor-emoji[data-unicode]')).map((el) => ({
      unicode: el.dataset.unicode,
      image: /twemoji\/[0-9a-f-]+\.svg/.test(getComputedStyle(el).backgroundImage),
      transparent: getComputedStyle(el).color === 'rgba(0, 0, 0, 0)',
    })),
  )

const paste = (box: Locator, text: string) =>
  box.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)

async function lastText(): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', channel).eq('user_id', me.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return ''
  return (data.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? `[${p.type}]`).join('')
}

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('pasted and typed emoji are drawn; caret and Backspace take a whole emoji', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, me)
    await openChannel(page, server.id, channel)
    const box = editor(page)
    await box.click()
    await paste(box, `a${FAMILY}${SKIN}b`)
    await page.keyboard.insertText(FLAG)
    await expect.poll(() => drawn(box)).toEqual([FAMILY, SKIN, FLAG].map((unicode) => ({ unicode, image: true, transparent: true })))

    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}X${SKIN}b${FLAG}`)
    await page.keyboard.press('End')
    await page.keyboard.press('Backspace')
    await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}X${SKIN}b`)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Backspace')
    await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}Xb`)

    await page.keyboard.press('Enter')
    await expect.poll(async () => hex(await lastText()), { timeout: 15000 }).toBe(hex(`a${FAMILY}Xb`))
  })
})

test.describe('iPhone', () => {
  const { userAgent } = devices['iPhone 15 Pro']
  test.use({ viewport: { width: 393, height: 852 }, userAgent, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('the send button sends the drawn emoji as the same characters', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, me)
    await page.goto(`/chat/${server.id}/${channel}`)
    await dismissAnnouncements(page)
    const box = editor(page)
    await box.tap()
    await page.keyboard.type('hey ', { delay: 10 })
    await page.keyboard.insertText(SKIN)
    await paste(box, ` ${FAMILY}`)
    await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FAMILY])
    await page.locator('[data-testid="message-send-btn"]').tap()
    await expect.poll(async () => hex(await lastText()), { timeout: 15000 }).toBe(hex(`hey ${SKIN} ${FAMILY}`))
  })
})
