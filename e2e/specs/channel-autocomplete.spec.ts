// Journey: a channel picked from the '#' suggestions replaces the typed '#query' and nothing
// else, wherever the '#' sits: at the start, after a word, after a mention, on a new line, in
// the middle of a line, and a second time in one message; by Tab, Enter and a click. A '#'
// after a space or line break was replaced from that space with an empty range: "see #zet"
// became "see#zeta  #zet". The sent message links each channel.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  composer,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const channelIds: Record<string, string> = {}

test.beforeAll(async () => {
  owner = await createUser(admin, 'chac')
  server = await seedServer(admin, owner, `Hash ${owner.username.slice(-6)}`)
  for (const name of ['zeta', 'dev-ops', 'dev_tools', 'café']) channelIds[name] = await addChannel(admin, server, name)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const list = (page: Page) => page.locator('#auto-suggest-listbox')

async function editorText(page: Page): Promise<string> {
  return (await composer(page).evaluate((el) => (el as HTMLElement).innerText)).replace(/\u00a0/g, ' ')
}

async function clear(page: Page): Promise<void> {
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect.poll(() => editorText(page)).toMatch(/^\s*$/)
}

/** Types `text` (a '\n' is Shift+Enter), then picks the first channel suggestion by `how`. */
async function pick(page: Page, text: string, how: 'Tab' | 'Enter' | 'click', option = '#zeta'): Promise<void> {
  for (const [i, line] of text.split('\n').entries()) {
    if (i > 0) await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(line, { delay: 30 })
  }
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(new RegExp(option))
  if (how === 'click') await list(page).getByRole('option').first().click()
  else await page.keyboard.press(how)
  await expect(list(page)).toHaveCount(0)
}

test('a picked channel replaces only its #query', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const cases: Array<{ typed: string; how: 'Tab' | 'Enter' | 'click'; option?: string; expected: string }> = [
    { typed: '#zet', how: 'Tab', expected: '#zeta ' },
    { typed: 'see #zet', how: 'Tab', expected: 'see #zeta ' },
    { typed: 'see #zet', how: 'Enter', expected: 'see #zeta ' },
    { typed: 'see #zet', how: 'click', expected: 'see #zeta ' },
    { typed: `@${owner.username} #zet`, how: 'Tab', expected: `@${owner.username} #zeta ` },
    { typed: 'line\n#zet', how: 'Tab', expected: 'line\n#zeta ' },
    { typed: 'ask in #dev-o', how: 'Tab', option: '#dev-ops', expected: 'ask in #dev-ops ' },
    { typed: 'ask in #dev_t', how: 'Tab', option: '#dev_tools', expected: 'ask in #dev_tools ' },
    { typed: 'ask in #caf', how: 'Tab', option: '#café', expected: 'ask in #café ' },
  ]
  for (const c of cases) {
    await test.step(`${JSON.stringify(c.typed)} then ${c.how}`, async () => {
      await clear(page)
      await pick(page, c.typed, c.how, c.option)
      await expect.poll(() => editorText(page)).toBe(c.expected)
    })
  }

  await test.step('typed in the middle of a line: the space already after it stays one space', async () => {
    await clear(page)
    await page.keyboard.type('ask  then', { delay: 30 })
    for (let i = 0; i < ' then'.length; i++) await page.keyboard.press('ArrowLeft')
    await pick(page, '#zet', 'Tab')
    await expect.poll(() => editorText(page)).toBe('ask #zeta then')
    await page.keyboard.type('x')
    await expect.poll(() => editorText(page)).toBe('ask #zeta xthen')
  })

  await test.step('two channels in one message, sent: both are channel links', async () => {
    await clear(page)
    await pick(page, 'see #zet', 'Tab')
    await pick(page, 'and #dev-o', 'Tab', '#dev-ops')
    await expect.poll(() => editorText(page)).toBe('see #zeta and #dev-ops ')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('messages')
          .select('content')
          .eq('channel_id', server.generalChannelId)
          .eq('user_id', owner.id)
          .order('created_at', { ascending: false })
          .limit(1)
        return (data?.[0]?.content as Array<Record<string, unknown>> | undefined)
          ?.filter((p) => p.type === 'channel_mention')
          .map((p) => p.channelId)
      }, { timeout: 15000 })
      .toEqual([channelIds.zeta, channelIds['dev-ops']])
  })
})
