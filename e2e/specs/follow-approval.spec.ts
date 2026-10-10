// Journey: locked accounts. An account turns on "Require follow approval" in Privacy
// settings; a follow of it is a request, shown as Requested on the profile and as Cancel
// request on the profile card however often the card is reopened. The owner accepts it from
// the notification panel and the follower reads followers-only posts; removing the follower
// hides them again. Turning approval off accepts a request still waiting, and an account the
// owner blocks cannot follow at all.
//
// Followers-only posts are seeded through the service role; every follow and answer goes
// through the UI.

import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SpecUser,
} from './harness'

const admin = adminClient()

async function signedInPage(browser: Browser, user: SpecUser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, user)
  return page
}

async function followRow(followerId: string, followingId: string) {
  const { data } = await admin
    .from('follows')
    .select('status')
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .maybeSingle()
  return data?.status ?? null
}

async function seedPost(author: SpecUser, visibility: 'public' | 'followers', text: string) {
  const { error } = await admin.from('posts').insert({
    author_id: author.id,
    visibility,
    is_local: true,
    content: [{ type: 'text', text }],
  })
  if (error) throw new Error(`post by ${author.username}: ${error.message}`)
}

const followLabel = (page: Page) => page.locator('[data-testid="profile-follow-btn"] .follow-label')

async function openProfile(page: Page, user: SpecUser) {
  await page.goto(`/social/profile/${user.username}`)
  await dismissAnnouncements(page)
  await expect(page.locator('.name-handle-section .user-handle')).toContainText(user.username, { timeout: 30000 })
}

async function setFollowApproval(page: Page, on: boolean) {
  await page.goto('/settings/privacy')
  await dismissAnnouncements(page)
  const toggle = page.locator('[data-testid="follow-approval-toggle"]')
  await expect(toggle).toBeVisible({ timeout: 30000 })
  // The switch is disabled until the stored value has been read.
  await expect(toggle).not.toHaveClass(/disabled/, { timeout: 15000 })
  await expect(toggle).toHaveAttribute('aria-checked', String(!on), { timeout: 15000 })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

async function lockedFlag(user: SpecUser): Promise<boolean> {
  const { data } = await admin.from('profiles').select('manually_approves_followers').eq('id', user.id).single()
  return data?.manually_approves_followers === true
}

async function openProfileCard(page: Page, user: SpecUser) {
  await page.locator('.user-sidebar .user-item').filter({ hasText: user.displayName }).first().click()
  const card = page.locator('.profile-modal-content')
  await expect(card).toBeVisible({ timeout: 15000 })
  return card
}

test('a locked account holds follows as requests until it accepts them', async ({ browser }) => {
  test.setTimeout(300_000)

  const owner = await createUser(admin, 'lkown')
  const fan = await createUser(admin, 'lkfan')
  const publicText = `public by ${owner.username}`
  const followersText = `for followers of ${owner.username}`
  try {
    const server = await seedServer(admin, owner, `Locked ${owner.username}`)
    await addMember(admin, fan, server.id)
    await seedPost(owner, 'public', publicText)
    await seedPost(owner, 'followers', followersText)

    const ownerPage = await signedInPage(browser, owner)
    const fanPage = await signedInPage(browser, fan)

    await test.step('the owner requires follow approval', async () => {
      await setFollowApproval(ownerPage, true)
      await expect.poll(() => lockedFlag(owner), { timeout: 15000 }).toBe(true)
    })

    await test.step('a follow is a request: Requested, followers-only posts still hidden', async () => {
      await openProfile(fanPage, owner)
      await expect(fanPage.locator('[data-testid="profile-locked-badge"]')).toBeVisible({ timeout: 15000 })
      await expect(fanPage.getByText(publicText)).toBeVisible({ timeout: 30000 })
      await expect(fanPage.getByText(followersText)).toHaveCount(0)
      await expect(followLabel(fanPage)).toHaveText('Follow', { timeout: 15000 })

      await fanPage.locator('[data-testid="profile-follow-btn"]').click()
      await expect(followLabel(fanPage)).toHaveText('Requested', { timeout: 15000 })
      await expect.poll(() => followRow(fan.id, owner.id), { timeout: 15000 }).toBe('pending')

      await fanPage.reload()
      await expect(followLabel(fanPage)).toHaveText('Requested', { timeout: 30000 })
    })

    await test.step('the profile card shows the request on every open', async () => {
      await openChannel(fanPage, server.id, server.generalChannelId)
      const followButton = (await openProfileCard(fanPage, owner)).locator('[data-testid="profile-modal-follow-btn"]')
      await expect(followButton).toHaveText('Cancel request', { timeout: 15000 })
      await expect(fanPage.locator('[data-testid="profile-modal-locked-badge"]')).toBeVisible()

      await fanPage.keyboard.press('Escape')
      await expect(fanPage.locator('.profile-modal-content')).toBeHidden()
      const reopened = (await openProfileCard(fanPage, owner)).locator('[data-testid="profile-modal-follow-btn"]')
      await expect(reopened).toHaveText('Cancel request', { timeout: 15000 })

      await fanPage.keyboard.press('Escape')
      await fanPage.reload()
      await dismissAnnouncements(fanPage)
      const afterReload = (await openProfileCard(fanPage, owner)).locator('[data-testid="profile-modal-follow-btn"]')
      await expect(afterReload).toHaveText('Cancel request', { timeout: 15000 })
      await fanPage.keyboard.press('Escape')
      expect(await followRow(fan.id, owner.id)).toBe('pending')
    })

    await test.step('the owner accepts the request from the notification panel', async () => {
      await openChannel(ownerPage, server.id, server.generalChannelId)
      await ownerPage.locator('[data-testid="notification-bell"]').click()
      const panel = ownerPage.locator('[data-testid="notification-panel"]')
      await expect(panel).toBeVisible({ timeout: 15000 })
      const request = panel.locator('[data-testid="notification-item"][data-type="activitypub_follow_request"]')
      await expect(request).toBeVisible({ timeout: 30000 })
      await request.locator('.quick-btn.primary').click()
      await expect.poll(() => followRow(fan.id, owner.id), { timeout: 15000 }).toBe('accepted')
      await expect(request).toHaveCount(0, { timeout: 15000 })
    })

    await test.step('the follower reads followers-only posts', async () => {
      await openProfile(fanPage, owner)
      await expect(followLabel(fanPage)).toHaveText('Following', { timeout: 30000 })
      await expect(fanPage.getByText(followersText)).toBeVisible({ timeout: 30000 })
    })

    await test.step('removing the follower hides them again', async () => {
      await ownerPage.goto('/social/followers')
      await dismissAnnouncements(ownerPage)
      const row = ownerPage.locator('.user-item').filter({ hasText: fan.displayName })
      await expect(row).toBeVisible({ timeout: 30000 })
      await row.locator('[data-testid="remove-follower-btn"]').click()
      const dialog = ownerPage.locator('.modal-container').filter({ hasText: 'stop following you' })
      await expect(dialog).toBeVisible({ timeout: 10000 })
      await dialog.getByRole('button', { name: 'Remove follower', exact: true }).click()
      await expect(row).toHaveCount(0, { timeout: 15000 })
      await expect.poll(() => followRow(fan.id, owner.id), { timeout: 15000 }).toBe(null)

      await openProfile(fanPage, owner)
      await expect(fanPage.getByText(publicText)).toBeVisible({ timeout: 30000 })
      await expect(fanPage.getByText(followersText)).toHaveCount(0)
      await expect(followLabel(fanPage)).toHaveText('Follow', { timeout: 15000 })
    })
  } finally {
    await deleteUser(admin, fan)
    await deleteUser(admin, owner)
  }
})

test('turning approval off accepts a request still waiting', async ({ browser }) => {
  test.setTimeout(240_000)

  const owner = await createUser(admin, 'lkopen')
  const waiting = await createUser(admin, 'lkwait')
  try {
    await admin.from('profiles').update({ manually_approves_followers: true }).eq('id', owner.id)
    const waitingPage = await signedInPage(browser, waiting)
    const ownerPage = await signedInPage(browser, owner)

    await test.step('a follow of the locked account waits', async () => {
      await openProfile(waitingPage, owner)
      await waitingPage.locator('[data-testid="profile-follow-btn"]').click()
      await expect(followLabel(waitingPage)).toHaveText('Requested', { timeout: 15000 })
      await expect.poll(() => followRow(waiting.id, owner.id), { timeout: 15000 }).toBe('pending')
    })

    await test.step('the owner turns approval off and the request is accepted', async () => {
      await setFollowApproval(ownerPage, false)
      await expect.poll(() => lockedFlag(owner), { timeout: 15000 }).toBe(false)
      await expect.poll(() => followRow(waiting.id, owner.id), { timeout: 15000 }).toBe('accepted')

      await openProfile(waitingPage, owner)
      await expect(followLabel(waitingPage)).toHaveText('Following', { timeout: 30000 })
      await expect(waitingPage.locator('[data-testid="profile-locked-badge"]')).toHaveCount(0)
    })
  } finally {
    await deleteUser(admin, waiting)
    await deleteUser(admin, owner)
  }
})

test('an account the owner blocks cannot follow it', async ({ browser }) => {
  test.setTimeout(180_000)

  const owner = await createUser(admin, 'lkblk')
  const blocked = await createUser(admin, 'lkbld')
  try {
    const { error } = await admin.from('user_blocks').insert({ blocker_id: owner.id, blocked_user_id: blocked.id })
    if (error) throw new Error(`block: ${error.message}`)
    const page = await signedInPage(browser, blocked)

    await openProfile(page, owner)
    await expect(followLabel(page)).toHaveText('Follow', { timeout: 15000 })
    const write = page.waitForResponse((r) => r.url().includes('/rest/v1/follows') && r.request().method() === 'POST')
    await page.locator('[data-testid="profile-follow-btn"]').click()
    expect((await write).status()).toBe(403)
    await expect(followLabel(page)).toHaveText('Follow')
    expect(await followRow(blocked.id, owner.id)).toBe(null)
  } finally {
    await deleteUser(admin, blocked)
    await deleteUser(admin, owner)
  }
})
