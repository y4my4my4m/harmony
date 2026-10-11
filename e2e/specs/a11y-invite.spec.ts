// Journey: accepting an invite to a server that has rules, keyboard only.
//
// The invite page names the server in its h1 and speaks the preview; the rules
// open as a labelled modal dialog that takes focus; Escape backs out to the
// Accept button; "Agree and join" from the keyboard joins and lands in the
// server.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { animationsSettled, focusWithin, politeRegion, tabTo } from './a11y-keyboard'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const joiners: SpecUser[] = []
const CODE = `A11Y${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const RULES = ['Be kind to each other', 'No spam or advertising']

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11yinvo')
  server = await seedServer(admin, owner, `Rules ${owner.username.slice(-6)}`)
  const { error: rulesError } = await admin.from('servers').update({ rules: RULES }).eq('id', server.id)
  if (rulesError) throw new Error(`rules: ${rulesError.message}`)
  const { error } = await admin.from('invites').insert({ code: CODE, server_id: server.id, created_by: owner.id, max_uses: 0 })
  if (error) throw new Error(`invite: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  for (const joiner of joiners) await deleteUser(admin, joiner)
})

test('accept an invite with server rules using only the keyboard', async ({ page }) => {
  test.setTimeout(180_000)
  // A fresh stranger per run: a repeat must not find the previous one already a member.
  const joiner = await createUser(admin, 'a11yinvj')
  joiners.push(joiner)
  await signIn(page, joiner)
  // Instance rules are shown once per device; this journey is about the server's.
  await page.evaluate(() => localStorage.setItem('harmony-instance-rules-ack', 'true'))
  await page.goto(`/invite/${CODE}`)

  const card = page.getByTestId('invite-accept')
  const accept = page.getByRole('button', { name: 'Accept invite' })
  const rules = page.getByRole('dialog', { name: 'Before you join' })

  await test.step('the preview names the server in its h1 and is spoken', async () => {
    await expect(card).toHaveAttribute('data-state', 'preview', { timeout: 30000 })
    await expect(page.getByRole('heading', { level: 1, name: server.name })).toBeVisible()
    await expect(politeRegion(page)).toContainText(`Invite to ${server.name}`, { timeout: 5000 })
    await animationsSettled(page)
    await expectNoAxeViolations(page, { label: 'invite preview' })
  })

  await test.step('Accept opens the rules as a modal dialog that takes focus', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await tabTo(page, accept)
    await page.keyboard.press('Enter')
    await expect(rules).toBeVisible()
    await expect(rules).toHaveAttribute('aria-modal', 'true')
    await expect.poll(() => focusWithin(page, '[role="dialog"]')).toBe(true)
    for (const rule of RULES) await expect(rules).toContainText(rule)
    await animationsSettled(page)
    await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'server rules dialog' })
  })

  await test.step('Tab stays in the dialog; Escape backs out to Accept', async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      expect(await focusWithin(page, '[role="dialog"]')).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(rules).toBeHidden()
    await expect(accept).toBeFocused()
    const { data } = await admin.from('user_servers').select('user_id').eq('server_id', server.id).eq('user_id', joiner.id)
    expect(data ?? []).toHaveLength(0)
  })

  await test.step('"Agree and join" from the keyboard joins the server', async () => {
    await page.keyboard.press('Enter')
    await expect(rules).toBeVisible()
    const agree = rules.getByRole('button', { name: 'Agree and join' })
    await expect(agree).toHaveAccessibleDescription('By joining, you agree to these rules.')
    await tabTo(page, agree, { max: 6 })
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/chat/${server.id}`), { timeout: 30000 })
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('user_servers')
          .select('status')
          .eq('server_id', server.id)
          .eq('user_id', joiner.id)
          .maybeSingle()
        return data?.status ?? null
      }, { timeout: 15000 })
      .toBe('accepted')
  })
})
