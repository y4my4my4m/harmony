// Journey: an owner hands out an invite link and a stranger accepts it.
//
// The link is read out of the invite modal, so the code under test is the one
// the UI generates, not one written straight into the invites table.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let joiner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'inva')
  joiner = await createUser(admin, 'invb')
  server = await seedServer(admin, owner, `Invite Server ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, joiner)
})

test('accept an invite and land in the server', async ({ browser }) => {
  test.setTimeout(180_000)

  let code = ''

  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()

  await test.step('the owner generates an invite link', async () => {
    await signIn(ownerPage, owner)
    await ownerPage.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(ownerPage)
    await expect(ownerPage.locator('.channel-sidebar .server-name')).toHaveText(server.name, {
      timeout: 30000,
    })

    await ownerPage.locator('.channel-sidebar .server-name').click()
    await ownerPage
      .locator('.server-dropdown li')
      .filter({ hasText: 'Get Invite Link' })
      .click()

    const linkField = ownerPage.locator('input.invite-url-input')
    await expect(linkField).toHaveValue(/\/invite\/[A-Z0-9]{8}$/, { timeout: 30000 })
    code = (await linkField.inputValue()).split('/invite/')[1]
  })

  const joinerContext = await browser.newContext()
  const joinerPage = await joinerContext.newPage()

  await test.step('a stranger opens the link', async () => {
    await signIn(joinerPage, joiner)
    await joinerPage.goto(`/invite/${code}`)

    await expect(joinerPage.locator('.invite-card__title')).toHaveText(server.name, {
      timeout: 30000,
    })
    await expect(joinerPage.locator('.invite-card__muted').first()).toContainText(
      "You've been invited to join",
    )
    await expect(joinerPage.locator('.invite-btn.primary')).toHaveText(/Accept Invite/)
  })

  await test.step('accepting drops them into the server', async () => {
    await joinerPage.locator('.invite-btn.primary').click()

    await joinerPage.waitForURL(new RegExp(`/chat/${server.id}/`), { timeout: 60000 })
    await dismissAnnouncements(joinerPage)
    await expect(joinerPage.locator('.channel-sidebar .server-name')).toHaveText(server.name, {
      timeout: 30000,
    })
  })

  await test.step('the same link now says they are already a member', async () => {
    await joinerPage.goto(`/invite/${code}`)
    await expect(joinerPage.locator('.invite-card__muted').first()).toContainText(
      "You're already a member of",
      { timeout: 30000 },
    )
    await expect(joinerPage.locator('.invite-btn.primary')).toHaveText(/Open Server/)
  })

  await test.step('the owner sees the new member in the member list', async () => {
    await ownerPage.reload()
    await dismissAnnouncements(ownerPage)
    await expect(
      ownerPage.locator('.user-sidebar, [class*="member"]').getByText(joiner.displayName).first(),
    ).toBeVisible({ timeout: 30000 })
  })

  await joinerContext.close()
  await ownerContext.close()
})
