// Journey: editing a message on a phone. Enter adds a line, as it does in the phone composer;
// the edit saves and cancels by its Save and Cancel buttons (Discord's phone edit). Enter
// saved the edit, so an edited message could not gain a line, and the hint named keys a phone
// keyboard lacks. On a desktop the hint stays, translated, its cancel and save are buttons,
// and Enter saves.

import { test, expect, devices, type Page } from '@playwright/test'
import {
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
// The profile's locale wins over the browser's: the French desktop case has a user of its own.
let frUser: SpecUser
let server: SeededServer
let frServer: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'edph')
  server = await seedServer(admin, user, `Edit phone ${user.username.slice(-6)}`)
  frUser = await createUser(admin, 'edfr')
  frServer = await seedServer(admin, frUser, `Edit fr ${frUser.username.slice(-6)}`)
  const { error } = await admin.from('profiles').update({ locale: 'fr' }).eq('id', frUser.id)
  if (error) throw new Error(`locale: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, frUser)
})

async function seed(text: string, author = user, into = server): Promise<string> {
  const { data, error } = await admin
    .from('messages')
    .insert({ channel_id: into.generalChannelId, user_id: author.id, content: [{ type: 'text', text }] })
    .select('id')
    .single()
  if (error) throw new Error(`message: ${error.message}`)
  return data.id as string
}

async function storedText(id: string): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('id', id).single()
  return (data!.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join('')
}

const row = (page: Page, text: string) =>
  page.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
const editorOf = (page: Page, text: string) => row(page, text).getByRole('textbox', { name: 'Edit message' })

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  async function openEditor(page: Page, text: string) {
    const words = row(page, text).getByText(text)
    await expect(words).toBeVisible({ timeout: 30000 })
    const b = (await words.boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.synthesizeTapGesture', { x: b.x + 30, y: b.y + b.height / 2, duration: 900, tapCount: 1, gestureSourceType: 'touch' })
    const bar = page.getByRole('toolbar', { name: 'Message actions' })
    await expect(bar).toBeVisible({ timeout: 5000 })
    await bar.getByTestId('msg-action-edit').tap()
    const editor = editorOf(page, text)
    await expect(editor).toBeFocused({ timeout: 5000 })
    return editor
  }

  test('Enter adds a line and Save saves; Cancel leaves the message as it was', async ({ page }) => {
    test.setTimeout(120_000)
    const first = `first line ${user.username}`
    const kept = `kept as is ${user.username}`
    const id = await seed(first)
    const keptId = await seed(kept)
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)

    const editor = await openEditor(page, first)
    await test.step('Enter adds a line; the edit stays open', async () => {
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.keyboard.type('second line')
      await expect(editor).toBeVisible()
      await expect(editor).toBeFocused()
      expect(await storedText(id)).toBe(first)
    })

    await test.step('the edit shows Save and Cancel buttons, not the key hint', async () => {
      await expect(row(page, first).getByRole('button', { name: 'Save', exact: true })).toBeVisible()
      await expect(row(page, first).getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
      await expect(row(page, first).getByText('enter to', { exact: false })).toHaveCount(0)
    })

    await test.step('Save stores both lines and closes the edit', async () => {
      await row(page, first).getByRole('button', { name: 'Save', exact: true }).tap()
      await expect(editor).toHaveCount(0, { timeout: 10000 })
      await expect.poll(() => storedText(id), { timeout: 10000 }).toBe(`${first}\nsecond line`)
    })

    await test.step('Cancel closes the edit and keeps the text', async () => {
      const keptEditor = await openEditor(page, kept)
      await page.keyboard.press('End')
      await page.keyboard.type(' changed')
      await row(page, kept).getByRole('button', { name: 'Cancel', exact: true }).tap()
      await expect(keptEditor).toHaveCount(0, { timeout: 10000 })
      expect(await storedText(keptId)).toBe(kept)
    })
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the hint is translated, its actions are buttons, and Enter saves', async ({ page }) => {
    test.setTimeout(120_000)
    const text = `desktop edit ${frUser.username}`
    const id = await seed(text, frUser, frServer)
    await signIn(page, frUser)
    await openChannel(page, frServer.id, frServer.generalChannelId)
    await dismissAnnouncements(page)

    const r = row(page, text)
    await expect(r).toBeVisible({ timeout: 30000 })
    await r.hover()
    await r.getByTestId('msg-action-edit').click()
    const editor = r.locator('.edit-container [role="textbox"]')
    await expect(editor).toBeFocused({ timeout: 5000 })

    await test.step('the hint reads in French, with cancel and save as buttons', async () => {
      await expect(r.locator('.edit-hint')).toHaveText('échap pour annuler • entrée pour enregistrer')
      await expect(r.locator('.edit-hint').getByRole('button', { name: 'annuler' })).toBeVisible()
      await expect(r.locator('.edit-hint').getByRole('button', { name: 'enregistrer' })).toBeVisible()
      await expect(r.getByTestId('edit-save')).toHaveCount(1)
    })

    await test.step('Shift+Enter adds a line, Enter saves', async () => {
      await page.keyboard.press('End')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('more')
      await page.keyboard.press('Enter')
      await expect(editor).toHaveCount(0, { timeout: 10000 })
      await expect.poll(() => storedText(id), { timeout: 10000 }).toBe(`${text}\nmore`)
    })
  })
})
