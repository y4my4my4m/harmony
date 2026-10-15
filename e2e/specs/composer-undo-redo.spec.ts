// Journey: undo and redo in the channel composer. Shift upper-cases KeyboardEvent.key:
// Ctrl+Shift+Z arrives as "Z". The editor owns undo, so a chord it does not match falls
// through to the browser's own history, which is empty.
//
// Each case sends and reads the stored message back: the composer's model, not only its DOM,
// follows the redo.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, composer, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'undo')
  server = await seedServer(admin, user, `Undo ${user.username}`)
})
test.afterAll(async () => { await deleteUser(admin, user) })

async function lastMessageText(): Promise<string | null> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return null
  return (data.content as Array<{ type: string; text?: string }>).map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('')
}

const type = (page: Page, text: string) => page.keyboard.type(text, { delay: 25 })

async function sendAndRead(page: Page, expected: string) {
  await page.keyboard.press('Enter')
  await expect(composer(page)).toHaveText('')
  await expect.poll(lastMessageText, { timeout: 15000 }).toBe(expected)
}

test('redo restores undone text in the composer', async ({ page }) => {
  test.setTimeout(120_000)

  await test.step('open the channel', async () => {
    await signIn(page, user)
    await openChannel(page, server.id, server.generalChannelId)
    await composer(page).click()
  })

  for (const [label, redoChord] of [
    ['Ctrl+Shift+Z', 'Control+Shift+Z'],
    ['Cmd+Shift+Z', 'Meta+Shift+Z'],
    ['Ctrl+Y', 'Control+y'],
  ] as const) {
    await test.step(`${label} redoes after Ctrl+Z`, async () => {
      await type(page, 'hello')
      await type(page, ' world')
      await expect(composer(page)).toHaveText('hello world')

      await page.keyboard.press('Control+z')
      await expect(composer(page)).toHaveText('hello')

      await page.keyboard.press(redoChord)
      await expect(composer(page)).toHaveText('hello world')

      await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+z')
      await expect(composer(page)).toHaveText('')
      await page.keyboard.press(redoChord)
      await page.keyboard.press(redoChord)
      await expect(composer(page)).toHaveText('hello world')

      await type(page, '!')
      await sendAndRead(page, 'hello world!')
    })
  }
})
