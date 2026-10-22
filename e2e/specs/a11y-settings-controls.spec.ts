// Journey: settings controls driven by the keyboard.
//
// Theme cards are a radio group (one Tab stop, arrows select); the colour
// picker's field and hue track are sliders with spoken values and its swatches a
// radio group; saving appearance is announced and keeps focus. Upload controls
// (server banner, emoji, profile banner) are reachable by Tab and open the file
// chooser on Enter. Channel permission overrides are Allow/Inherit/Deny radio
// groups changed with arrows and saved. Roles reorder with Alt+Arrow keys and
// Move buttons, announcing the new position. Escape in a settings dialog closes
// the dialog only, and focus returns to its opener.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  PERMISSION_BITS,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { animationsSettled, politeRegion, tabTo } from './a11y-keyboard'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let roomId: string
const roleIds: Record<string, string> = {}

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11yctl')
  server = await seedServer(admin, owner, `Ctl ${owner.username.slice(-8)}`)
  roomId = await addChannel(admin, server, 'overrides')
  const { data, error } = await admin
    .from('server_roles')
    .insert([
      { server_id: server.id, name: 'Alpha', position: 30, permissions: 2 ** PERMISSION_BITS.VIEW_CHANNEL },
      { server_id: server.id, name: 'Beta', position: 20, permissions: 2 ** PERMISSION_BITS.VIEW_CHANNEL },
      { server_id: server.id, name: 'Gamma', position: 10, permissions: 2 ** PERMISSION_BITS.VIEW_CHANNEL },
    ])
    .select('id, name')
  if (error || !data) throw new Error(`roles: ${error?.message}`)
  for (const row of data) roleIds[row.name] = row.id
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

async function rolePositions(): Promise<Record<string, number>> {
  const { data } = await admin.from('server_roles').select('name, position').eq('server_id', server.id)
  return Object.fromEntries((data ?? []).map((r) => [r.name, r.position]))
}

/**
 * Counts file choosers opened on `page`. One listener for the page's lifetime keeps
 * Playwright's chooser interception on; enabling it per step races the keypress.
 */
function watchFileChoosers(page: Page): () => number {
  let opened = 0
  page.on('filechooser', () => { opened++ })
  return () => opened
}

async function expectFileChooserOnEnter(page: Page, opened: () => number) {
  const before = opened()
  await page.keyboard.press('Enter')
  await expect.poll(opened, { timeout: 10000 }).toBe(before + 1)
}

test('theme cards and the colour picker by keyboard; saving is announced and keeps focus', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto('/settings/appearance')
  const themes = page.getByRole('radiogroup', { name: 'Theme' })
  await expect(themes).toBeVisible({ timeout: 30000 })
  await animationsSettled(page)
  await expectNoAxeViolations(page, { label: 'appearance' })

  await test.step('the theme set is one Tab stop; arrow keys move and select', async () => {
    const checked = themes.getByRole('radio', { checked: true })
    await tabTo(page, checked, { max: 30 })
    const before = await checked.getAttribute('value')
    await page.keyboard.press('ArrowRight')
    const after = themes.getByRole('radio', { checked: true })
    await expect(after).toBeFocused()
    expect(await after.getAttribute('value')).not.toBe(before)
    const custom = themes.getByRole('radio', { name: 'Custom', exact: true })
    for (let i = 0; i < 6 && !(await custom.isChecked()); i++) await page.keyboard.press('ArrowRight')
    await expect(custom).toBeChecked()
    await expect(custom).toBeFocused()
  })

  // The Background editor starts collapsed.
  const backgroundHeader = page.locator('.theme-collapse-header').first()
  await expect(backgroundHeader).toHaveAttribute('aria-expanded', 'false')
  await backgroundHeader.click()
  await expect(backgroundHeader).toHaveAttribute('aria-expanded', 'true')
  const picker = page.getByRole('group', { name: 'Background color' })

  await test.step('the saturation and brightness field is a slider with a spoken value', async () => {
    const field = picker.getByRole('slider', { name: 'Saturation and brightness' })
    await tabTo(page, field)
    await page.keyboard.press('Home')
    await expect(field).toHaveAttribute('aria-valuetext', /^Saturation 0%, brightness \d+%$/)
    await page.keyboard.press('Shift+ArrowRight')
    await expect(field).toHaveAttribute('aria-valuetext', /^Saturation 10%, /)
    const brightness = Number((await field.getAttribute('aria-valuetext'))!.match(/brightness (\d+)%/)![1])
    await page.keyboard.press('ArrowDown')
    await expect(field).toHaveAttribute('aria-valuetext', `Saturation 10%, brightness ${brightness - 1}%`)
  })

  await test.step('the hue track is a slider in degrees', async () => {
    const hue = picker.getByRole('slider', { name: 'Hue' })
    await tabTo(page, hue, { max: 4 })
    await page.keyboard.press('Home')
    await expect(hue).toHaveAttribute('aria-valuetext', '0 degrees')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(hue).toHaveAttribute('aria-valuetext', '10 degrees')
    await expect(hue).toHaveAttribute('aria-valuenow', '10')
  })

  await test.step('the hex field is labelled; preset swatches are a radio group', async () => {
    const hex = picker.getByRole('textbox', { name: 'Hex color' })
    await expect(hex).toBeVisible()
    const swatches = picker.getByRole('radiogroup', { name: 'Preset colors' })
    const first = swatches.getByRole('radio').first()
    await tabTo(page, swatches.locator('[role="radio"][tabindex="0"]'), { max: 6 })
    await first.focus()
    await page.keyboard.press('ArrowRight')
    const second = swatches.getByRole('radio').nth(1)
    await expect(second).toBeFocused()
    await expect(second).toHaveAttribute('aria-checked', 'true')
    const name = (await second.getAttribute('aria-label')) ?? (await second.textContent()) ?? ''
    const swatchHex = name.match(/#[0-9A-F]{6}/i)![0]
    await expect(hex).toHaveValue(new RegExp(swatchHex.replace('#', '#?'), 'i'))
  })

  await test.step('unsaved changes are announced; Save announces and focuses the page heading', async () => {
    const bar = page.getByRole('region', { name: 'You have unsaved appearance changes' })
    await expect(bar).toBeVisible()
    await expect(politeRegion(page)).toContainText('unsaved appearance changes', { timeout: 5000 })
    await tabTo(page, bar.getByRole('button', { name: 'Save changes' }), { max: 120 })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeFocused()
    await expect(politeRegion(page)).toContainText('Appearance saved', { timeout: 5000 })
    await expect(bar).toBeHidden()
  })

  // The swatch picked above recolours the page; contrast of a user-chosen palette is the user's.
  await animationsSettled(page)
  await expectNoAxeViolations(page, { label: 'appearance with the custom theme open', disable: ['color-contrast'] })
})

test('upload controls are in the tab order and open the file chooser', async ({ page }) => {
  test.setTimeout(180_000)
  const opened = watchFileChoosers(page)
  await signIn(page, owner)

  await test.step('server banner', async () => {
    await page.goto(`/server/${server.id}`)
    const banner = page.getByRole('group', { name: 'Server banner' }).getByRole('button', { name: 'Upload server banner' })
    await expect(banner).toBeAttached({ timeout: 30000 })
    await tabTo(page, banner, { max: 60 })
    await expectFileChooserOnEnter(page, opened)
  })

  await test.step('custom emoji', async () => {
    await page.goto(`/server/${server.id}?section=emoji`)
    const emoji = page.getByRole('button', { name: 'Upload emoji' })
    await expect(emoji).toBeAttached({ timeout: 30000 })
    await tabTo(page, emoji, { max: 60 })
    await expectFileChooserOnEnter(page, opened)
  })

  await test.step('profile banner', async () => {
    await page.goto('/settings/account')
    const banner = page.getByRole('button', { name: /profile banner/i })
    await expect(banner).toBeAttached({ timeout: 30000 })
    await tabTo(page, banner, { max: 60 })
    await expectFileChooserOnEnter(page, opened)
  })
})

test('channel permission overrides are Allow/Inherit/Deny radio groups changed with arrows', async ({ page }) => {
  test.setTimeout(180_000)
  await admin.from('channel_permission_overrides').delete().eq('channel_id', roomId)
  // The Appearance test saves a custom palette for this user; the dialog is checked on the default theme.
  await admin.from('profiles').update({ appearance_settings: null }).eq('id', owner.id)
  await signIn(page, owner)
  await openChannel(page, server.id, roomId)

  // The channel menu items are pointer-only (ChannelContextMenu, chat area); the dialog is driven by keyboard.
  await channelRow(page, 'overrides').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()

  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(dialog.getByRole('textbox', { name: /channel name/i })).toBeFocused()

  await test.step('the editor tabs are a tablist moved with arrows', async () => {
    const general = dialog.getByRole('tab', { name: 'General' })
    await tabTo(page, general, { backwards: true, max: 10 })
    await expect(general).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight')
    const permissions = dialog.getByRole('tab', { name: 'Permissions' })
    await expect(permissions).toBeFocused()
    await expect(permissions).toHaveAttribute('aria-selected', 'true')
  })

  const sendMessages = dialog.getByRole('radiogroup', { name: 'Send Messages' })

  await test.step('a permission is one Tab stop; arrows change Inherit to Allow and Deny', async () => {
    await expect(sendMessages).toBeVisible({ timeout: 15000 })
    const inherit = sendMessages.getByRole('radio', { name: 'Inherit' })
    await expect(inherit).toHaveAttribute('aria-checked', 'true')
    await tabTo(page, inherit, { max: 80 })
    await page.keyboard.press('ArrowRight')
    const allow = sendMessages.getByRole('radio', { name: 'Allow' })
    await expect(allow).toBeFocused()
    await expect(allow).toHaveAttribute('aria-checked', 'true')
    await expect(inherit).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(sendMessages.getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(allow).toHaveAttribute('aria-checked', 'true')
  })

  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'channel edit dialog' })

  await test.step('Escape with an unsaved override asks first; the dialog stays', async () => {
    await page.keyboard.press('Escape')
    const prompt = page.getByRole('alertdialog', { name: /Discard changes/ })
    await expect(prompt).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(prompt).toBeHidden()
    await expect(dialog).toBeVisible()
  })

  await test.step('Save permissions stores an allow override for @everyone', async () => {
    await tabTo(page, dialog.getByRole('button', { name: 'Save permissions' }), { max: 120 })
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('channel_permission_overrides')
          .select('allow_permissions, deny_permissions')
          .eq('channel_id', roomId)
          .maybeSingle()
        return data ? BigInt(data.allow_permissions) & (1n << BigInt(PERMISSION_BITS.SEND_MESSAGES)) : null
      }, { timeout: 15000 })
      .toBe(1n << BigInt(PERMISSION_BITS.SEND_MESSAGES))
  })
})

test('roles reorder with Alt+Arrow keys and Move buttons, announcing the position', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=roles`)
  const list = page.locator('.role-rail ul')
  await expect(list).toBeVisible({ timeout: 30000 })
  const pill = (name: string) => page.locator('.role-rail .role-pill').filter({ has: page.locator('.role-pill-name', { hasText: new RegExp(`^${name}$`) }) })

  await test.step('Alt+ArrowUp on a focused role moves it above its neighbour; focus stays on it', async () => {
    await tabTo(page, pill('Gamma'), { max: 60 })
    await page.keyboard.press('Enter')
    await expect(pill('Gamma')).toHaveAttribute('aria-current', 'true')
    await pill('Gamma').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect(politeRegion(page)).toContainText(/Gamma moved to position \d+ of \d+/, { timeout: 15000 })
    await expect(pill('Gamma')).toBeFocused()
    await expect.poll(async () => {
      const p = await rolePositions()
      return p.Gamma > p.Beta && p.Beta < p.Alpha
    }, { timeout: 15000 }).toBe(true)
  })

  await test.step('the Move down button moves the selected role back and keeps focus', async () => {
    const down = page.getByRole('button', { name: 'Move Gamma down' })
    await tabTo(page, down, { max: 60 })
    await page.keyboard.press('Enter')
    await expect(politeRegion(page)).toContainText(/Gamma moved to position \d+ of \d+/, { timeout: 15000 })
    await expect(down).toBeFocused()
    await expect.poll(async () => {
      const p = await rolePositions()
      return p.Alpha > p.Beta && p.Beta > p.Gamma
    }, { timeout: 15000 }).toBe(true)
  })

  await test.step('the top role cannot move up; @everyone has no move controls', async () => {
    const top = page.locator('.role-rail .role-pill').first()
    const topName = (await top.locator('.role-pill-name').textContent())!.trim()
    await top.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: `Move ${topName} up` })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('button', { name: `Move ${topName} down` })).not.toHaveAttribute('aria-disabled', 'true')
    await page.locator('.role-rail .role-pill').last().focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="role-move-up"]')).toHaveCount(0)
  })

  await animationsSettled(page)

  await expectNoAxeViolations(page, { label: 'server settings › roles' })
})

test('Escape in a settings dialog closes the dialog only', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=advanced`)
  const opener = page.getByTestId('delete-server-open')
  await expect(opener).toBeVisible({ timeout: 30000 })
  await tabTo(page, opener, { max: 60 })
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('alertdialog', { name: 'Delete server' })
  await expect(dialog).toBeVisible()
  const confirmField = dialog.getByRole('textbox', { name: /Type the server name to confirm/ })
  await expect(confirmField).toBeFocused()
  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[role="alertdialog"]', label: 'delete-server dialog' })

  await test.step('a wrong name is tied to the field when Delete is pressed', async () => {
    await page.keyboard.type('not the name')
    await tabTo(page, dialog.getByRole('button', { name: 'Delete server' }), { max: 6 })
    await page.keyboard.press('Enter')
    await expect(confirmField).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('alert')).not.toHaveText('')
  })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/server/${server.id}`))
  await expect(opener).toBeFocused()
  const { data } = await admin.from('servers').select('id').eq('id', server.id).maybeSingle()
  expect(data?.id).toBe(server.id)
})
