// Journey: account migration between two accounts on this instance. The new
// account lists the old one as an alias (handles are checked: malformed, unknown
// and its own are refused), the old account checks the target and moves with its
// password, and a follower of the old account ends up following the new one and
// is pointed to it on the old profile. The redirect can be cancelled.
//
// The /account routes run on the federation backend (e2e/specs/backend.ts). Follower
// migration is the worker's 'account-moved' job, absent here: the spec runs its
// migrate_account_followers batch as the worker would.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  signIn,
  userClient,
  type SpecUser,
} from './harness'
import { INSTANCE_DOMAIN, startBackend, type Backend } from './backend'

test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let oldAccount: SpecUser
let newAccount: SpecUser
let fan: SpecUser
let backend: Backend

const actorUri = (user: SpecUser) => `https://${INSTANCE_DOMAIN}/users/${user.username}`

test.beforeAll(async () => {
  oldAccount = await createUser(admin, 'mvold')
  newAccount = await createUser(admin, 'mvnew')
  fan = await createUser(admin, 'mvfan')
  const client = await userClient(fan)
  const { error } = await client
    .from('follows')
    .insert({ follower_id: fan.id, following_id: oldAccount.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  for (const user of [oldAccount, newAccount, fan]) await deleteUser(admin, user)
})

async function openMigration(page: Page, user: SpecUser) {
  await backend.route(page)
  await signIn(page, user)
  await page.goto('/settings/advanced')
  await dismissAnnouncements(page)
  const panel = page.locator('[data-testid="account-migration"]')
  await expect(panel.locator('.am-block').first()).toBeVisible({ timeout: 30000 })
  return panel
}

async function aliasesOf(user: SpecUser): Promise<string[]> {
  const { data } = await admin.from('profiles').select('also_known_as').eq('id', user.id).single()
  return (data?.also_known_as as string[] | null) ?? []
}

test('the new account lists the old one as an alias', async ({ page }) => {
  test.setTimeout(150_000)

  const panel = await openMigration(page, newAccount)
  const input = panel.locator('[data-testid="am-alias-input"]')
  const add = panel.getByRole('button', { name: 'Add', exact: true })
  const error = panel.locator('.am-block').first().locator('.sec-error')

  await test.step('malformed, unknown and own handles are refused', async () => {
    await expect(panel.getByText('No other accounts are listed.')).toBeVisible()
    for (const [handle, message] of [
      ['not a handle!', 'Enter an account like username@instance.social.'],
      [`nobody${newAccount.username}`, 'That account could not be found.'],
      [newAccount.username, 'This account cannot list itself.'],
    ]) {
      await input.fill(handle)
      await add.click()
      await expect(error).toHaveText(message, { timeout: 15000 })
    }
    expect(await aliasesOf(newAccount)).toEqual([])
  })

  await test.step('add the old account, remove it, add it again', async () => {
    const aliases = panel.locator('[data-testid="am-aliases"]')
    await input.fill(`@${oldAccount.username}@${INSTANCE_DOMAIN}`)
    await add.click()
    await expect(aliases).toContainText(`@${oldAccount.username}`, { timeout: 15000 })
    expect(await aliasesOf(newAccount)).toEqual([actorUri(oldAccount)])

    await aliases.getByRole('button', { name: 'Remove' }).click()
    await expect(aliases).toHaveCount(0, { timeout: 15000 })
    expect(await aliasesOf(newAccount)).toEqual([])

    await input.fill(oldAccount.username)
    await add.click()
    await expect(aliases).toContainText(`@${oldAccount.username}`, { timeout: 15000 })
    expect(await aliasesOf(newAccount)).toEqual([actorUri(oldAccount)])
  })
})

test('the old account moves and its follower follows the new one', async ({ browser }) => {
  test.setTimeout(180_000)

  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const panel = await openMigration(page, oldAccount)

  await test.step('the target check confirms the alias', async () => {
    await panel.locator('[data-testid="am-target-input"]').fill(newAccount.username)
    await panel.locator('[data-testid="am-check"]').click()
    await expect(panel.locator('[data-testid="am-alias-ok"]')).toBeVisible({ timeout: 15000 })
    await expect(panel.locator('[data-testid="am-start"]')).toBeEnabled()
  })

  await test.step('the move asks for the password', async () => {
    await panel.locator('[data-testid="am-start"]').click()
    const confirm = page.locator('[data-testid="am-confirm"]')
    await expect(confirm).toBeVisible()
    const submit = confirm.getByRole('button', { name: 'Move my account' })
    await expect(submit).toBeDisabled()

    await confirm.locator('#am-password').fill('not-the-password')
    await submit.click()
    await expect(confirm.locator('.sec-error')).toHaveText('That password is not correct.', {
      timeout: 15000,
    })

    await confirm.locator('#am-password').fill(oldAccount.password)
    await submit.click()
    await expect(confirm).toBeHidden({ timeout: 15000 })
    await expect(panel.locator('[data-testid="am-moved"]')).toContainText(
      `@${newAccount.username}`,
      {
        timeout: 15000,
      },
    )
  })

  let migrationId = ''
  await test.step('the move is recorded and the follower batch runs', async () => {
    const { data: moved } = await admin
      .from('profiles')
      .select('moved_to_id, moved_to_uri')
      .eq('id', oldAccount.id)
      .single()
    expect(moved).toEqual({ moved_to_id: newAccount.id, moved_to_uri: actorUri(newAccount) })

    const { data: migration } = await admin
      .from('account_migrations')
      .select('id, followers_count')
      .eq('profile_id', oldAccount.id)
      .single()
    expect(migration?.followers_count).toBe(1)
    migrationId = migration!.id
    const { error } = await admin.rpc('migrate_account_followers', {
      p_migration_id: migrationId,
      p_limit: 200,
    })
    if (error) throw new Error(`migrate_account_followers: ${error.message}`)

    const { data: follows } = await admin
      .from('follows')
      .select('following_id, status')
      .eq('follower_id', fan.id)
    expect(follows).toEqual([{ following_id: newAccount.id, status: 'accepted' }])
  })

  await test.step('the follower sees where the old account went', async () => {
    const fanContext = await browser.newContext()
    const fanPage = await fanContext.newPage()
    await signIn(fanPage, fan)
    await fanPage.goto(`/social/profile/${oldAccount.username}`)
    const notice = fanPage.locator('[data-testid="moved-account-notice"]')
    await expect(notice).toContainText(`@${newAccount.username}`, { timeout: 30000 })

    await notice.locator('[data-testid="moved-account-go"]').click()
    await expect(fanPage).toHaveURL(new RegExp(`/social/profile/${newAccount.username}$`), {
      timeout: 30000,
    })
    await expect(fanPage.locator('[data-testid="profile-follow-btn"] .follow-label')).toHaveText(
      'Following',
      {
        timeout: 30000,
      },
    )
    await fanContext.close()

    const { count } = await admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', fan.id)
      .eq('type', 'move')
    expect(count).toBe(1)
  })

  await test.step('the old account cancels the redirect', async () => {
    await panel.locator('[data-testid="am-cancel"]').click()
    await expect(panel.locator('[data-testid="am-moved"]')).toHaveCount(0, { timeout: 15000 })
    const { data } = await admin
      .from('profiles')
      .select('moved_to_id')
      .eq('id', oldAccount.id)
      .single()
    expect(data?.moved_to_id).toBeNull()
  })

  await context.close()
})
