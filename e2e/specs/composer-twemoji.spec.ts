// Journeys: under the Twemoji emoji style the composer draws unicode emoji as Twemoji, as sent
// messages draw them; it drew them in the system's emoji font. Every way in is covered: the
// emoji picker, `:name` suggestions taken with Tab or Enter, paste, text typed by an emoji
// keyboard or an input method, a draft opened for editing, the phone composer and a direct
// message. The text sent is the same characters that went in, skin tones, ZWJ sequences, flags,
// keycaps and tag sequences included. The caret steps over a whole emoji and Backspace removes
// it whole; a copy holds the characters; undo brings an emoji back drawn. A drawn emoji takes
// no more height than its characters did.
//
// Under the System style the composer keeps the characters as text, and messages do too: the
// style chosen in Appearance did not reach message rendering.

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
let user: SpecUser
let friend: SpecUser
let server: SeededServer
let channel = ''
let dm = ''

const SKIN = '👍🏽'
const FAMILY = '👨‍👩‍👧'
const FLAG = '🇯🇵'
const KEYCAP = '1️⃣'
const ENGLAND = '🏴󠁧󠁢󠁥󠁮󠁧󠁿'

test.beforeAll(async () => {
  user = await createUser(admin, 'twe')
  friend = await createUser(admin, 'twef')
  server = await seedServer(admin, user, `Twemoji ${user.username.slice(-6)}`)
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: user.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  dm = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: dm, user_id: user.id },
    { conversation_id: dm, user_id: friend.id },
  ])
})

// Each test writes to a channel of its own: tests of this file run side by side.
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, friend)
})

const COMPOSER = '[data-testid="message-input"] .rich-text-editor'
const editor = (page: Page) => page.locator(COMPOSER)

/** The editor's text as it sends it: a drawn emoji reads as its characters (utils/editorText). */
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
      if (el.tagName === 'BR') {
        out += '\n'
        return
      }
      el.childNodes.forEach(walk)
    }
    root.childNodes.forEach(walk)
    return out.replace(/\u00a0/g, ' ')
  })

/**
 * Drawn emoji in order: the characters, the text they keep (transparent, for the field's value
 * and screen readers), the Twemoji file drawn, whether it loaded, whether the caret can enter.
 */
const drawn = (box: Locator) =>
  box.evaluate((root) =>
    Promise.all(
      Array.from(root.querySelectorAll<HTMLElement>('.editor-emoji[data-unicode]')).map(async (atom) => {
        const style = getComputedStyle(atom)
        const url = /url\("?([^")]+)"?\)/.exec(style.backgroundImage)?.[1] ?? ''
        const loaded = await new Promise<boolean>((resolve) => {
          const img = new Image()
          img.onload = () => resolve(img.naturalWidth > 0)
          img.onerror = () => resolve(false)
          img.src = url
        })
        return {
          unicode: atom.dataset.unicode,
          text: atom.textContent,
          file: url.replace(/^.*\/twemoji\//, ''),
          loaded,
          transparent: style.color === 'rgba(0, 0, 0, 0)',
          editable: atom.isContentEditable,
        }
      }),
    ),
  )

/** Emoji left as characters drawn by the system's font: text outside the drawn emoji. */
const undrawn = (box: Locator) =>
  box.evaluate((root) => {
    const found: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('.editor-emoji[data-unicode]')) continue
      found.push(...((node as Text).data.match(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu) ?? []))
    }
    return found
  })

/** The value Chromium's accessibility tree gives the composer's textbox. */
async function accessibleValue(page: Page): Promise<string | undefined> {
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: Array<{ role?: { value: string }; name?: { value: string }; value?: { value: string } }>
  }
  await cdp.detach()
  const box = nodes.find((n) => n.role?.value === 'textbox' && n.name?.value?.startsWith('Message #'))
  return box?.value?.value?.replace(/\u00a0/g, ' ')
}

/** `atom` of `drawn` for a sequence drawn from `file`. */
const atom = (unicode: string, file: string) => ({ unicode, text: unicode, file, loaded: true, transparent: true, editable: false })

const paste = (box: Locator, text: string) =>
  box.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)

async function lastText(where: { channel_id?: string; conversation_id?: string }): Promise<string> {
  let query = admin.from('messages').select('content').eq('user_id', user.id)
  query = where.channel_id ? query.eq('channel_id', where.channel_id) : query.eq('conversation_id', where.conversation_id!)
  const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return ''
  return (data.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? `[${p.type}]`).join('')
}

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

/** The newest message's text is `text`, byte for byte. */
async function expectSent(where: { channel_id?: string; conversation_id?: string }, text: string) {
  await expect.poll(async () => hex(await lastText(where)), { timeout: 15000 }).toBe(hex(text))
}

async function clearEditor(page: Page, box: Locator) {
  await box.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await expect.poll(() => valueOf(box)).toBe('')
}

async function chooseStyle(page: Page, name: 'Twemoji' | 'System') {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  await expect(page.getByTestId('theme-options')).toBeVisible({ timeout: 30000 })
  await page.locator('.emoji-pack-btn').filter({ hasText: name }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeHidden()
}

test('picker, suggestions, paste and an emoji keyboard draw Twemoji; the message holds the same characters', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  const box = editor(page)
  await box.click()
  await page.keyboard.type('hello', { delay: 10 })
  const textHeight = await box.evaluate((el) => el.getBoundingClientRect().height)

  await test.step('emoji picker', async () => {
    await page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' }).click()
    const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
    await picker.getByRole('textbox', { name: 'Search emoji' }).fill('grinning face')
    await picker.locator('.emoji-item').first().click()
    await expect.poll(() => drawn(box)).toEqual([atom('😀', '1f600.svg')])
  })

  await test.step('`:name` suggestion taken with Tab, then with Enter', async () => {
    await box.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' :thumbsu', { delay: 20 })
    const options = page.locator('#auto-suggest-listbox [role="option"]')
    await expect(options.first()).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Tab')
    await page.keyboard.type(':red_hear', { delay: 20 })
    await expect(options.first()).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual(['😀', '👍', '❤️'])
  })

  await test.step('paste: skin tone, ZWJ sequence, flag, keycap, tag sequence', async () => {
    await paste(box, `${SKIN}${FAMILY}${FLAG}${KEYCAP}${ENGLAND}`)
    await expect.poll(async () => (await drawn(box)).slice(3)).toEqual([
      atom(SKIN, '1f44d-1f3fd.svg'),
      atom(FAMILY, '1f468-200d-1f469-200d-1f467.svg'),
      atom(FLAG, '1f1ef-1f1f5.svg'),
      atom(KEYCAP, '31-20e3.svg'),
      atom(ENGLAND, '1f3f4-e0067-e0062-e0065-e006e-e0067-e007f.svg'),
    ])
  })

  await test.step('an emoji keyboard types its emoji as text', async () => {
    await page.keyboard.insertText(' 🫠')
    await expect.poll(async () => (await drawn(box)).map((d) => d.unicode).at(-1)).toBe('🫠')
  })

  const expected = `hello😀 👍 ❤️ ${SKIN}${FAMILY}${FLAG}${KEYCAP}${ENGLAND} 🫠`
  expect(await undrawn(box)).toEqual([])
  expect(await valueOf(box)).toBe(expected)
  // The characters stay the field's text: screen readers and input methods read them.
  await expect(box).toHaveText(expected, { useInnerText: true })
  if (browserName === 'chromium') expect(await accessibleValue(page)).toBe(expected)
  // One line of drawn emoji is as tall as one line of text.
  expect(await box.evaluate((el) => el.getBoundingClientRect().height)).toBe(textHeight)

  await page.keyboard.press('Enter')
  await expectSent({ channel_id: channel }, expected)
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'hello' }).last()
  await expect(row.locator(`img.inline-emoji[alt="${SKIN}"]`)).toHaveCount(1)
})

test('the caret steps over a whole emoji and Backspace removes it whole', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  const box = editor(page)
  await box.click()
  await paste(box, `a${FAMILY}${SKIN}${FLAG}b`)
  await expect.poll(async () => (await drawn(box)).length).toBe(3)

  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('X')
  await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}X${SKIN}${FLAG}b`)

  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Backspace')
  await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}X${SKIN}b`)
  await page.keyboard.press('Backspace')
  await expect.poll(() => valueOf(box)).toBe(`a${FAMILY}Xb`)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Backspace')
  await expect.poll(() => valueOf(box)).toBe('aXb')

  await page.keyboard.press('End')
  await page.keyboard.insertText(FLAG)
  await page.keyboard.type('c')
  await expect.poll(() => valueOf(box)).toBe(`aXb${FLAG}c`)

  // A double click selects the emoji, as one on a word selects the word.
  await box.locator(`.editor-emoji[data-unicode="${FLAG}"]`).dblclick()
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(FLAG)
  await page.keyboard.type('d')
  await expect.poll(() => valueOf(box)).toBe('aXbdc')

  await page.keyboard.press('Enter')
  await expectSent({ channel_id: channel }, 'aXbdc')
})

test('a draft restored by a reload draws its emoji once the emoji data loads', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  const box = editor(page)
  await box.click()
  await paste(box, `kept ${SKIN} ${FAMILY}`)
  await expect.poll(async () => (await drawn(box)).length).toBe(2)
  // Drafts are written after a pause in typing.
  await page.waitForTimeout(1500)
  await page.reload()
  await expect(editor(page)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => valueOf(editor(page)), { timeout: 15000 }).toBe(`kept ${SKIN} ${FAMILY}`)
  await expect.poll(async () => (await drawn(editor(page))).map((d) => d.unicode), { timeout: 15000 }).toEqual([SKIN, FAMILY])
  expect(await undrawn(editor(page))).toEqual([])
})

test('a selection copies and cuts the characters; undo and redo bring the emoji back drawn', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  const box = editor(page)
  await box.click()
  await paste(box, `x${SKIN}${FAMILY}y`)
  await expect.poll(async () => (await drawn(box)).length).toBe(2)
  await page.evaluate(() => {
    const w = window as unknown as { copied: string[] }
    w.copied = []
    document.addEventListener('copy', (e) => w.copied.push(e.clipboardData?.getData('text/plain') ?? ''))
    document.addEventListener('cut', (e) => w.copied.push(e.clipboardData?.getData('text/plain') ?? ''))
  })
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied)

  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  // The selection shows the emoji selected, the image under the highlight and not the
  // system's glyph over it.
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(`${SKIN}${FAMILY}`)
  expect(await box.locator('.editor-twemoji').first().evaluate((el) => getComputedStyle(el, '::selection').color)).toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('Control+C')
  await expect.poll(copied).toEqual([`${SKIN}${FAMILY}`])

  await page.keyboard.press('Control+X')
  await expect.poll(copied).toEqual([`${SKIN}${FAMILY}`, `${SKIN}${FAMILY}`])
  await expect.poll(() => valueOf(box)).toBe('xy')

  await page.keyboard.press('Control+Z')
  await expect.poll(() => valueOf(box)).toBe(`x${SKIN}${FAMILY}y`)
  expect((await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FAMILY])
  await page.keyboard.press('Control+Shift+Z')
  await expect.poll(() => valueOf(box)).toBe('xy')
  await page.keyboard.press('Control+Z')
  await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FAMILY])

  await page.keyboard.press('Enter')
  await expectSent({ channel_id: channel }, `x${SKIN}${FAMILY}y`)
})

/** Composes `steps` one update at a time, then commits `committed`, as an input method does. */
async function compose(page: Page, steps: string[], committed: string) {
  const cdp = await page.context().newCDPSession(page)
  for (const step of steps) {
    await cdp.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length })
    await page.waitForTimeout(40)
  }
  await cdp.send('Input.insertText', { text: committed })
  await cdp.detach()
}

test('a Japanese composition beside an emoji keeps its text; an emoji it commits is drawn', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'compositions are driven through the Chrome DevTools Protocol')
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  const box = editor(page)
  await box.click()
  await page.keyboard.insertText('😀')
  await expect.poll(async () => (await drawn(box)).length).toBe(1)
  await compose(page, ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん'], '日本')
  await expect.poll(() => valueOf(box)).toBe('😀日本')
  await compose(page, ['は', 'はー', 'はーと'], '❤️')
  await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual(['😀', '❤️'])
  await expect.poll(() => valueOf(box)).toBe('😀日本❤️')
  await page.keyboard.press('Enter')
  await expectSent({ channel_id: channel }, '😀日本❤️')
})

test('a message opened for editing draws its emoji; the edit saves the same characters', async ({ page }) => {
  test.setTimeout(120_000)
  const original = `edit ${SKIN} ${FLAG}`
  await admin.from('messages').insert({ channel_id: channel, user_id: user.id, content: [{ type: 'text', text: original }] })
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await expect(page.locator('.message-item').filter({ hasText: 'edit' })).toBeVisible({ timeout: 30000 })
  await editor(page).click()
  await page.keyboard.press('ArrowUp')
  const box = page.locator('.edit-container .rich-text-editor')
  await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FLAG])
  await page.keyboard.press('End')
  await page.keyboard.insertText(' 🎉')
  await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FLAG, '🎉'])
  await page.keyboard.press('Enter')
  await expect(box).toBeHidden()
  await expectSent({ channel_id: channel }, `${original} 🎉`)
})

test('a direct message composer draws Twemoji', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto(`/dm/${dm}`)
  await dismissAnnouncements(page)
  const box = editor(page)
  await expect(box).toBeVisible({ timeout: 30000 })
  await box.click()
  await paste(box, `dm ${SKIN}`)
  await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN])
  await page.keyboard.press('Enter')
  await expectSent({ conversation_id: dm }, `dm ${SKIN}`)
})

test('System: the composer and messages keep emoji as characters', async ({ page }) => {
  test.setTimeout(150_000)
  await admin.from('messages').insert({ channel_id: channel, user_id: user.id, content: [{ type: 'text', text: `before ${SKIN}` }] })
  await signIn(page, user)
  await chooseStyle(page, 'System')
  await openChannel(page, server.id, channel)
  const before = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'before' })
  await expect(before).toBeVisible({ timeout: 30000 })
  await expect(before.locator('img.inline-emoji')).toHaveCount(0)
  await expect(before).toContainText(SKIN)

  const box = editor(page)
  await box.click()
  await page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' }).click()
  const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
  await picker.getByRole('textbox', { name: 'Search emoji' }).fill('grinning face')
  await picker.locator('.emoji-item').first().click()
  await expect.poll(() => valueOf(box)).toBe('😀')
  await paste(box, ` ${FAMILY}`)
  await expect.poll(() => valueOf(box)).toBe(`😀 ${FAMILY}`)
  expect(await drawn(box)).toEqual([])
  expect(await undrawn(box)).toEqual(['😀', '👨', '👩', '👧'])
  await page.keyboard.press('Enter')
  await expectSent({ channel_id: channel }, `😀 ${FAMILY}`)

  await test.step('Twemoji again draws the draft at once', async () => {
    await chooseStyle(page, 'Twemoji')
    await openChannel(page, server.id, channel)
    await expect(before.locator(`img.inline-emoji[alt="${SKIN}"]`)).toHaveCount(1)
    await clearEditor(page, editor(page))
    await paste(editor(page), SKIN)
    await expect.poll(async () => (await drawn(editor(page))).map((d) => d.unicode)).toEqual([SKIN])
  })
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport: { width: 375, height: viewport.height }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the phone composer draws Twemoji and the send button sends the same characters', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${channel}`)
    await dismissAnnouncements(page)
    const box = editor(page)
    await expect(box).toBeVisible({ timeout: 30000 })
    await box.tap()
    await page.keyboard.type('hey ', { delay: 10 })
    await page.keyboard.insertText(SKIN)
    await paste(box, ` ${FAMILY}`)
    await expect.poll(async () => (await drawn(box)).map((d) => d.unicode)).toEqual([SKIN, FAMILY])
    expect(await undrawn(box)).toEqual([])
    await page.getByTestId('message-send-btn').tap()
    await expectSent({ channel_id: channel }, `hey ${SKIN} ${FAMILY}`)
  })
})
