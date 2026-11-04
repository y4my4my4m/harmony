// Journey: Settings › Notifications › Master volume starts at 100 % and paints in the theme's
// accent.
//
// The slider shows the stored level, not a fixed 70: a level set and reloaded is the level shown.
// Builds before 1.9.3 stored 0.7 with every sound theme change, without the user moving the
// slider; such a record (no settingsVersion) reads as 100 %. A level the user set in those builds
// (anything but 0.7) is kept.
//
// A native range input takes the platform accent (teal, green, the OS highlight) unless
// accent-color is set; its fill and thumb follow --harmony-primary, live. Skins keep their own
// accent (Paper: brand blue; Skyglass: its primary); High contrast keeps the theme's.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'mastervol')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const slider = (page: Page) => page.getByTestId('notification-volume')

async function openNotifications(page: Page) {
  await page.goto('/settings/notifications')
  await dismissAnnouncements(page)
  await expect(slider(page)).toBeVisible({ timeout: 30000 })
}

/** The user-scoped localStorage key of the audio theme settings (utils/userScopedStorage.ts). */
async function settingsKey(page: Page): Promise<string> {
  return page.evaluate((id) => {
    const prefix = Object.keys(localStorage)
      .map((key) => new RegExp(`^(harmony_i_.+?_user_${id}_)`).exec(key)?.[1])
      .find(Boolean)
    if (!prefix) throw new Error('no user-scoped key')
    return `${prefix}audio_theme_settings`
  }, user.id)
}

const stored = (page: Page, key: string) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as { volume: number; settingsVersion?: number } | null, key)

/** accent-color of the slider and the colour --harmony-primary resolves to, as rgb(). */
async function accentAndPrimary(page: Page) {
  return slider(page).evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--harmony-primary)'
    el.parentElement!.appendChild(probe)
    const primary = getComputedStyle(probe).color
    probe.remove()
    return { accent: getComputedStyle(el).accentColor, primary }
  })
}

test('master volume starts at 100 %, shows the stored level and wears the accent', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openNotifications(page)

  await test.step('a new account starts at 100 %', async () => {
    await expect(slider(page)).toHaveValue('100')
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '100%')
  })

  await test.step('fill and thumb are the theme accent, and follow it', async () => {
    const { accent, primary } = await accentAndPrimary(page)
    expect(accent).toBe(primary)
    await page.evaluate(() => document.documentElement.style.setProperty('--harmony-primary', '#c026d3'))
    await expect.poll(async () => (await accentAndPrimary(page)).accent).toBe('rgb(192, 38, 211)')
    await page.evaluate(() => document.documentElement.style.removeProperty('--harmony-primary'))
  })

  const key = await settingsKey(page)

  await test.step('a level set holds across a reload', async () => {
    await slider(page).fill('40')
    await expect.poll(async () => (await stored(page, key))?.volume).toBe(0.4)
    await page.reload()
    await expect(slider(page)).toHaveValue('40', { timeout: 30000 })
  })

  await test.step('0.7 stored by an older build without a slider move reads as 100 %', async () => {
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ selectedTheme: 'default', volume: 0.7, lastUpdated: '2026-10-01T00:00:00.000Z' }))
    }, key)
    await page.reload()
    await expect(slider(page)).toHaveValue('100', { timeout: 30000 })
    expect(await stored(page, key)).toMatchObject({ volume: 1, settingsVersion: 2 })
  })

  for (const look of [
    { name: 'Paper', settings: { theme: 'light', activeSkinId: 'paper' }, token: '--pp-blue' },
    { name: 'Skyglass', settings: { theme: 'dark', activeSkinId: 'skyglass' }, token: '--sg-primary' },
    { name: 'High contrast', settings: { theme: 'dark', activeSkinId: null, highContrast: true }, token: '--harmony-primary' },
  ]) {
    await test.step(`${look.name}: the accent of the look`, async () => {
      const { error } = await admin.from('profiles').update({ appearance_settings: look.settings }).eq('id', user.id)
      if (error) throw new Error(`appearance: ${error.message}`)
      await page.reload()
      await expect(slider(page)).toBeVisible({ timeout: 30000 })
      if (look.settings.activeSkinId) await expect(page.locator('html')).toHaveAttribute('data-skin', look.settings.activeSkinId, { timeout: 15000 })
      else await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true', { timeout: 15000 })
      await expect.poll(() => slider(page).evaluate((el, token) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${token})`
        el.parentElement!.appendChild(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        const accent = getComputedStyle(el).accentColor
        return accent !== 'auto' && accent === expected
      }, look.token)).toBe(true)
    })
  }
  await admin.from('profiles').update({ appearance_settings: {} }).eq('id', user.id)

  await test.step('a level the user set in an older build is kept', async () => {
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ selectedTheme: 'default', volume: 0.55, lastUpdated: '2026-10-01T00:00:00.000Z' }))
    }, key)
    await page.reload()
    await expect(slider(page)).toHaveValue('55', { timeout: 30000 })
  })
})
