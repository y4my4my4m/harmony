// Journey: the section list of Server settings. Sections run Overview, Welcome & rules, Privacy
// settings, Roles; then Expression, Integrations and Moderation, each under its heading; then
// Advanced settings. A heading names its list and takes no focus; a heading shows only when a
// section under it does, and a section a member lacks the permission for stays hidden. ?section=
// still opens a section. At phone width the drawer holds the same list.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, addMember, createUser, deleteUser, grantRole, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let auditor: SpecUser
let member: SpecUser
let server: SeededServer

const OWNER_SECTIONS = [
  'Overview', 'Welcome & rules', 'Privacy settings', 'Roles',
  'Emoji', 'Stickers', 'Soundboard',
  'Outgoing webhooks', 'Discord Bridge', 'Migrate from Discord',
  'AutoMod', 'Reports', 'Bans', 'Audit log',
  'Advanced settings',
]

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'ssn')
  auditor = await createUser(admin, 'ssa')
  member = await createUser(admin, 'ssm')
  server = await seedServer(admin, owner, `Nav ${owner.username}`)
  await addMember(admin, auditor, server.id)
  await addMember(admin, member, server.id)
  await grantRole(admin, server.id, auditor, { name: 'Auditor', position: 1, permissions: ['VIEW_AUDIT_LOG'] })
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const user of [owner, auditor, member]) await deleteUser(admin, user)
})

const nav = (page: Page) => page.getByTestId('server-settings-nav')

async function groupsOf(page: Page): Promise<Array<{ heading: string | null; sections: string[] }>> {
  return nav(page).locator('.nav-section').evaluateAll((groups) => groups.map((g) => ({
    heading: g.querySelector('h2')?.textContent?.trim() ?? null,
    sections: [...g.querySelectorAll('li button')].map((b) => b.textContent!.trim()),
  })))
}

test('the owner gets every section, grouped under headings, in order', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}`)
  await expect(nav(page).getByRole('button', { name: 'Advanced settings' })).toBeVisible({ timeout: 30000 })

  await test.step('sections and headings in order', async () => {
    await expect(nav(page).getByRole('button')).toHaveText(OWNER_SECTIONS, { timeout: 15000 })
    await expect(nav(page).getByRole('heading', { level: 2 })).toHaveText(['Expression', 'Integrations', 'Moderation'])
    await expect.poll(() => groupsOf(page)).toEqual([
      { heading: null, sections: ['Overview', 'Welcome & rules', 'Privacy settings', 'Roles'] },
      { heading: 'Expression', sections: ['Emoji', 'Stickers', 'Soundboard'] },
      { heading: 'Integrations', sections: ['Outgoing webhooks', 'Discord Bridge', 'Migrate from Discord'] },
      { heading: 'Moderation', sections: ['AutoMod', 'Reports', 'Bans', 'Audit log'] },
      { heading: null, sections: ['Advanced settings'] },
    ])
  })

  await test.step('each heading names its list', async () => {
    await expect(nav(page).getByRole('list', { name: 'Moderation' }).getByRole('listitem')).toHaveCount(4)
    await expect(nav(page).getByRole('list', { name: 'Expression' }).getByRole('button')).toHaveText(['Emoji', 'Stickers', 'Soundboard'])
    await expect(nav(page).getByRole('list', { name: 'Integrations' }).getByRole('button')).toHaveText(['Outgoing webhooks', 'Discord Bridge', 'Migrate from Discord'])
  })

  await test.step('Tab moves from section to section; no heading takes focus', async () => {
    await nav(page).getByRole('button', { name: 'Overview' }).focus()
    const focused: string[] = []
    for (let i = 1; i < OWNER_SECTIONS.length; i++) {
      await page.keyboard.press('Tab')
      focused.push(await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`))
    }
    expect(focused).toEqual(OWNER_SECTIONS.slice(1).map((label) => `BUTTON:${label}`))
  })

  await test.step('a section opens from the list and by ?section=', async () => {
    await nav(page).getByRole('button', { name: 'Audit log' }).click()
    await expect(nav(page).getByRole('button', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page')
    await page.goto(`/server/${server.id}?section=bans`)
    await expect(nav(page).getByRole('button', { name: 'Bans' })).toHaveAttribute('aria-current', 'page', { timeout: 30000 })
    await page.goto(`/server/${server.id}?section=welcome`)
    await expect(nav(page).getByRole('button', { name: 'Welcome & rules' })).toHaveAttribute('aria-current', 'page', { timeout: 30000 })
  })
})

test('View Audit Log alone: Moderation holds Audit log only, and Bans stays out of reach', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, auditor)
  await page.goto(`/server/${server.id}`)
  await expect(nav(page).getByRole('button', { name: 'Advanced settings' })).toBeVisible({ timeout: 30000 })
  await expect.poll(() => groupsOf(page)).toEqual([
    { heading: null, sections: ['Overview', 'Privacy settings', 'Roles'] },
    { heading: 'Expression', sections: ['Emoji', 'Stickers', 'Soundboard'] },
    { heading: 'Moderation', sections: ['Audit log'] },
    { heading: null, sections: ['Advanced settings'] },
  ])
  await page.goto(`/server/${server.id}?section=bans`)
  await expect(nav(page).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page', { timeout: 30000 })
  await expect(nav(page).getByRole('button', { name: 'Bans' })).toHaveCount(0)
})

test('a member without permissions gets no Integrations or Moderation heading', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await page.goto(`/server/${server.id}`)
  await expect(nav(page).getByRole('button', { name: 'Advanced settings' })).toBeVisible({ timeout: 30000 })
  await expect.poll(() => groupsOf(page)).toEqual([
    { heading: null, sections: ['Overview', 'Privacy settings', 'Roles'] },
    { heading: 'Expression', sections: ['Emoji', 'Stickers', 'Soundboard'] },
    { heading: null, sections: ['Advanced settings'] },
  ])
  await expect(nav(page).getByRole('heading')).toHaveText(['Expression'])
})

test('at phone width the drawer holds the same grouped list', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await signIn(page, owner)
  // The drawer opens with the view at phone width.
  await page.goto(`/server/${server.id}`)
  await expect(nav(page).getByRole('button', { name: 'Advanced settings' })).toBeAttached({ timeout: 30000 })
  await expect(nav(page).getByRole('button')).toHaveText(OWNER_SECTIONS)
  await expect(nav(page).getByRole('heading', { level: 2 })).toHaveText(['Expression', 'Integrations', 'Moderation'])
  await nav(page).getByRole('button', { name: 'Audit log' }).scrollIntoViewIfNeeded()
  await expect(nav(page).getByRole('button', { name: 'Audit log' })).toBeInViewport()
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await nav(page).getByRole('button', { name: 'Bans' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bans')
})
