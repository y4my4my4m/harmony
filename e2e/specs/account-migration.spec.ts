// Journey: account migration between two accounts on this instance. The new
// account lists the old one as an alias (handles are checked: malformed, unknown
// and its own are refused), the old account checks the target and moves with its
// password, and a follower of the old account ends up following the new one and
// is pointed to it on the old profile. The redirect can be cancelled.
//
// On the new account: the accounts on a following list, from Mastodon's CSV or Harmony's export,
// are followed in a queued job with a result per account; the profile of an account that moved here
// is copied on request, after a confirmation. Remote handles are in the federation round trip
// (e2e/federation/cases/accountMoveImport.ts).
//
// The /account routes run on the federation backend (e2e/specs/backend.ts). Follower
// migration is the worker's 'account-moved' job, absent here: the spec runs its
// migrate_account_followers batch as the worker would. Following imports run on
// e2e/following-import-worker.ts.

import JSZip from 'jszip'
import { test, expect, type Locator, type Page } from '@playwright/test'
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
import { startFollowingImportWorker, type ImportWorker } from './followingImportWorker'

test.describe.configure({ mode: 'serial' })
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let oldAccount: SpecUser
let newAccount: SpecUser
let fan: SpecUser
let backend: Backend

const actorUri = (user: SpecUser) => `https://${INSTANCE_DOMAIN}/users/${user.username}`

test.beforeAll(async () => {
  // Starts the federation backend under tsx: past 30 s on a loaded CI runner.
  test.setTimeout(120_000)
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

const follows = async (from: SpecUser, to: SpecUser): Promise<string | null> => {
  const { data } = await admin
    .from('follows')
    .select('status')
    .eq('follower_id', from.id)
    .eq('following_id', to.id)
    .maybeSingle()
  return (data?.status as string | undefined) ?? null
}

const csvFile = (name: string, rows: string[]) => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(['Account address,Show boosts,Notify on new posts,Languages', ...rows].join('\n')),
})

async function chooseFile(panel: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  await panel.locator('[data-testid="am-import-file"]').setInputFiles(file)
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
    await expect(fanPage).toHaveURL(new RegExp(`/@${newAccount.username}$`), {
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

test('the panel lists everything that stays behind', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const panel = await openMigration(page, oldAccount)

  const staying = panel.locator('[data-testid="am-move"] .am-columns > div').nth(1)
  await expect(staying).toContainText('What stays behind')
  for (const item of [
    'Posts, messages and direct messages',
    'Likes, boosts and bookmarks',
    'Your display name, bio, avatar, banner and profile fields',
    'The accounts you follow',
    'Accounts you blocked or muted',
    'End-to-end encryption keys',
    'Bots you own',
    'Servers you own',
  ]) {
    await expect(staying).toContainText(item)
  }
  await context.close()
})

test.describe('following import', () => {
  let importer: SpecUser
  let open: SpecUser
  let locked: SpecUser
  let blocker: SpecUser
  let blocked: SpecUser
  let already: SpecUser
  let worker: ImportWorker | undefined

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    importer = await createUser(admin, 'imper')
    open = await createUser(admin, 'impopen')
    locked = await createUser(admin, 'implocked')
    blocker = await createUser(admin, 'impblocker')
    blocked = await createUser(admin, 'impblocked')
    already = await createUser(admin, 'impalready')
    await admin.from('profiles').update({ manually_approves_followers: true }).eq('id', locked.id)
    for (const row of [
      { blocker_id: blocker.id, blocked_user_id: importer.id },
      { blocker_id: importer.id, blocked_user_id: blocked.id },
    ]) {
      const { error } = await admin.from('user_blocks').insert(row)
      if (error) throw new Error(`block: ${error.message}`)
    }
    const client = await userClient(importer)
    const { error } = await client.from('follows').insert({ follower_id: importer.id, following_id: already.id })
    if (error) throw new Error(`follow: ${error.message}`)
  })

  test.afterAll(async () => {
    await worker?.stop()
    for (const user of [importer, open, locked, blocker, blocked, already]) await deleteUser(admin, user)
  })

  test('a file that is not a following list is refused', async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, importer)
    const error = panel.locator('[data-testid="am-import-error"]')

    await chooseFile(panel, { name: 'blocked_accounts.csv', mimeType: 'text/csv', buffer: Buffer.from(`${open.username}@${INSTANCE_DOMAIN}\n`) })
    await expect(error).toContainText('looks like a different list')

    await chooseFile(panel, { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from('{"followers":[]}') })
    await expect(error).toContainText('not a following list')

    await chooseFile(panel, { name: 'other.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') })
    await expect(error).toContainText('not a following list')

    await chooseFile(panel, csvFile('following_accounts.csv', []))
    await expect(error).toContainText('lists no accounts')

    await expect(panel.locator('[data-testid="am-import-preview"]')).toHaveCount(0)
    await context.close()
  })

  test('a running import stops, and what it did not reach stays unfollowed', async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, importer)

    await chooseFile(panel, csvFile('following_accounts.csv', [`${open.username}@${INSTANCE_DOMAIN},true,false,`]))
    await panel.locator('[data-testid="am-import-start"]').click()
    const status = panel.locator('[data-testid="am-import-status"]')
    await expect(status).toHaveText('Importing: 0 of 1 done', { timeout: 15000 })

    await panel.locator('[data-testid="am-import-cancel"]').click()
    await expect(status).toHaveText('Import stopped. Follows already made stay.', { timeout: 15000 })
    await expect(panel.locator('[data-testid="am-import-count-cancelled"]')).toHaveText('1')
    expect(await follows(importer, open)).toBeNull()
    await context.close()
  })

  test('Mastodon\'s CSV is followed as the follow button would, with a result per account', async ({ browser }) => {
    test.setTimeout(180_000)
    worker ??= await startFollowingImportWorker()
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, importer)
    const missing = `nobody${importer.username}`

    await test.step('nothing happens before the import is started', async () => {
      await chooseFile(panel, csvFile('following_accounts.csv', [
        `${open.username}@${INSTANCE_DOMAIN},true,false,`,
        `${locked.username}@${INSTANCE_DOMAIN},true,false,"en, de"`,
        `${blocker.username}@${INSTANCE_DOMAIN},false,false,`,
        `${blocked.username}@${INSTANCE_DOMAIN},false,false,`,
        `${already.username}@${INSTANCE_DOMAIN},true,true,`,
        `${missing}@${INSTANCE_DOMAIN},true,false,`,
        `${importer.username}@${INSTANCE_DOMAIN},true,false,`,
        'not a handle,true,false,',
      ]))
      await expect(panel.locator('[data-testid="am-import-preview"]')).toContainText('8 accounts found in this file.')
      expect(await follows(importer, open)).toBeNull()
    })

    await test.step('the job follows each account and the panel shows the result', async () => {
      await panel.locator('[data-testid="am-import-start"]').click()
      await expect(panel.locator('[data-testid="am-import-status"]')).toHaveText('Import finished', { timeout: 60000 })
      await expect(panel.locator('[data-testid="am-import-count-followed"]')).toHaveText('1')
      await expect(panel.locator('[data-testid="am-import-count-requested"]')).toHaveText('1')
      await expect(panel.locator('[data-testid="am-import-count-already"]')).toHaveText('1')
      await expect(panel.locator('[data-testid="am-import-count-failed"]')).toHaveText('5')
      await expect(panel.locator('[data-testid="am-import-cancel"]')).toHaveCount(0)
    })

    await test.step('every failure is named with its reason', async () => {
      const failures = panel.locator('[data-testid="am-import-failures"]')
      await failures.locator('summary').click()
      const row = (handle: string) => failures.locator('li').filter({ has: page.getByText(handle, { exact: true }) })
      await expect(row(`${blocker.username}@${INSTANCE_DOMAIN}`)).toContainText('A block stands between you')
      await expect(row(`${blocked.username}@${INSTANCE_DOMAIN}`)).toContainText('A block stands between you')
      await expect(row(`${missing}@${INSTANCE_DOMAIN}`)).toContainText('Account not found')
      await expect(row(`${importer.username}@${INSTANCE_DOMAIN}`)).toContainText('your own account')
      await expect(row('not a handle')).toContainText('Not an account address')
    })

    await test.step('the follows match the follow path', async () => {
      expect(await follows(importer, open)).toBe('accepted')
      expect(await follows(importer, locked)).toBe('pending')
      expect(await follows(importer, blocker)).toBeNull()
      expect(await follows(importer, blocked)).toBeNull()
      expect(await follows(importer, already)).toBe('accepted')
      const { count } = await admin
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', locked.id)
        .eq('type', 'activitypub_follow_request')
      expect(count).toBe(1)
    })

    await test.step('the result is there after a reload', async () => {
      await page.reload()
      await expect(panel.locator('[data-testid="am-import-status"]')).toHaveText('Import finished', { timeout: 30000 })
      await expect(panel.locator('[data-testid="am-import-count-failed"]')).toHaveText('5')
    })
    await context.close()
  })

  test('Harmony\'s export ZIP imports too, and accounts already followed count as such', async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, importer)

    const entry = (user: SpecUser, extra: Record<string, unknown> = {}) => ({
      id: user.id, username: user.username, domain: INSTANCE_DOMAIN, status: 'accepted', deleted: false, ...extra,
    })
    const zip = new JSZip()
    zip.file('README.txt', 'Harmony account export')
    zip.file('social.json', JSON.stringify({
      following: [
        entry(open),
        entry(locked, { status: 'pending' }),
        entry(blocker, { status: 'rejected' }),
        entry(blocked, { deleted: true }),
      ],
      followers: [entry(already)],
      blocks: [],
      mutes: [],
    }))
    await chooseFile(panel, {
      name: 'harmony-export-old-2026-11-09.zip',
      mimeType: 'application/zip',
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    })
    await expect(panel.locator('[data-testid="am-import-preview"]')).toContainText('2 accounts found in this file.')
    await panel.locator('[data-testid="am-import-start"]').click()
    await expect(panel.locator('[data-testid="am-import-status"]')).toHaveText('Import finished', { timeout: 60000 })
    await expect(panel.locator('[data-testid="am-import-count-followed"]')).toHaveText('0')
    await expect(panel.locator('[data-testid="am-import-count-already"]')).toHaveText('2')
    await expect(panel.locator('[data-testid="am-import-failures"]')).toHaveCount(0)
    await context.close()
  })
})

test.describe('copy the old profile', () => {
  // A 1x1 PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const NEW_NAME = 'Name Of The New Account'
  const OLD_BIO = 'Line one of the old bio.\nLine two.'
  let origin: SpecUser
  let target: SpecUser
  let aliasOnly: SpecUser
  let unlisted: SpecUser

  const profileOf = async (user: SpecUser) =>
    (await admin
      .from('profiles')
      .select('display_name, bio, avatar_url, banner_url, profile_fields')
      .eq('id', user.id)
      .single()).data!

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    origin = await createUser(admin, 'cpold')
    target = await createUser(admin, 'cpnew')
    aliasOnly = await createUser(admin, 'cpalias')
    unlisted = await createUser(admin, 'cpunlisted')

    const avatar = `${origin.id}/avatar-1.png`
    const banner = `${origin.id}/banner-1.png`
    for (const [bucket, path] of [['avatars', avatar], ['banners', banner]]) {
      const { error } = await admin.storage.from(bucket).upload(path, PNG, { contentType: 'image/png', upsert: true })
      if (error) throw new Error(`upload ${bucket}: ${error.message}`)
    }
    const { error } = await admin.from('profiles').update({
      display_name: 'Name Of The Old Account',
      bio: OLD_BIO,
      avatar_url: avatar,
      banner_url: banner,
      moved_to_id: target.id,
      moved_to_uri: actorUri(target),
      moved_at: new Date().toISOString(),
      profile_fields: [
        {
          name: 'Blog',
          value: '<a href="https://blog.example/me" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span><span class="">blog.example/me</span><span class="invisible"></span></a>',
        },
        { name: 'Pronouns', value: 'they &amp; them' },
      ],
    }).eq('id', origin.id)
    if (error) throw new Error(`origin: ${error.message}`)
    await admin.from('profiles').update({ display_name: NEW_NAME, also_known_as: [actorUri(origin)] }).eq('id', target.id)

    // Lists the old account, which never moved here.
    await admin.from('profiles').update({ also_known_as: [actorUri(oldAccount)] }).eq('id', aliasOnly.id)
    // The old account points here; this account does not list it.
    await admin.from('profiles').update({
      moved_to_id: unlisted.id,
      moved_to_uri: actorUri(unlisted),
      moved_at: new Date().toISOString(),
    }).eq('id', fan.id)
  })

  test.afterAll(async () => {
    await admin.from('profiles').update({ moved_to_id: null, moved_to_uri: null, moved_at: null }).eq('id', fan.id)
    for (const user of [origin, target, aliasOnly, unlisted]) await deleteUser(admin, user)
  })

  test('it is offered only after a move both accounts confirm', async ({ browser }) => {
    test.setTimeout(150_000)
    for (const user of [aliasOnly, unlisted]) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const panel = await openMigration(page, user)
      await expect(panel.locator('[data-testid="am-aliases"], .am-block').first()).toBeVisible()
      await expect(panel.locator('[data-testid="am-copy"]')).toHaveCount(0)
      await context.close()
    }

    await test.step('the route refuses an account not named by a confirmed move', async () => {
      const client = await userClient(unlisted)
      const { data } = await client.auth.getSession()
      const res = await fetch(`${backend.url}/account/profile/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session!.access_token}` },
        body: JSON.stringify({ origin_id: fan.id, fields: ['display_name'] }),
      })
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('not_verified')
    })
  })

  test('nothing changes before the confirmation, then only what was picked', async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, target)
    const copy = panel.locator('[data-testid="am-copy"]')
    await expect(copy).toContainText(`@${origin.username}`, { timeout: 15000 })

    const open = copy.locator('[data-testid="am-copy-open"]')
    const dialog = page.locator('[data-testid="am-copy-confirm"]')

    await test.step('every row starts unticked', async () => {
      for (const field of ['display_name', 'bio', 'avatar', 'banner', 'profile_fields']) {
        await expect(copy.locator(`[data-testid="am-copy-${field}"]`)).not.toBeChecked()
      }
      await expect(open).toBeDisabled()
      await expect(copy.locator('[data-testid="am-copy-row-display_name"]')).toContainText('Replaces what this profile has')
      await expect(copy.locator('[data-testid="am-copy-row-bio"]')).toContainText('Adds to this profile')
      await expect(copy.locator('[data-testid="am-copy-row-profile_fields"]')).toContainText('Blog: https://blog.example/me')
      await expect(copy.locator('[data-testid="am-copy-row-profile_fields"]')).toContainText('Pronouns: they & them')
    })

    await test.step('cancelling the confirmation changes nothing', async () => {
      await copy.locator('[data-testid="am-copy-display_name"]').check()
      await open.click()
      await expect(dialog).toContainText('Display name: replaces what this profile has now.')
      await expect(dialog).toContainText('cannot be restored')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      expect((await profileOf(target)).display_name).toBe(NEW_NAME)
    })

    await test.step('a confirmed copy changes what was picked and nothing else', async () => {
      await copy.locator('[data-testid="am-copy-display_name"]').uncheck()
      await copy.locator('[data-testid="am-copy-bio"]').check()
      await copy.locator('[data-testid="am-copy-avatar"]').check()
      await copy.locator('[data-testid="am-copy-profile_fields"]').check()
      await open.click()
      await expect(dialog).toContainText('Bio: added to this profile.')
      await expect(dialog).toContainText('Avatar: added to this profile.')
      await expect(dialog).not.toContainText('cannot be restored')
      await page.locator('[data-testid="am-copy-confirm-button"]').click()
      await expect(dialog).toBeHidden({ timeout: 30000 })

      const after = await profileOf(target)
      expect(after.display_name).toBe(NEW_NAME)
      expect(after.bio).toBe(OLD_BIO)
      expect(after.banner_url).toBeNull()
      expect(after.profile_fields).toEqual([
        {
          name: 'Blog',
          value: '<a href="https://blog.example/me" target="_blank" rel="me nofollow noopener noreferrer">https://blog.example/me</a>',
        },
        { name: 'Pronouns', value: 'they &amp; them' },
      ])
    })

    await test.step('the avatar is the new account\'s own object', async () => {
      const { avatar_url: avatar } = await profileOf(target)
      expect(avatar).toMatch(new RegExp(`^${target.id}/avatar-\\d+-[0-9a-f]{8}\\.png$`))
      const { data, error } = await admin.storage.from('avatars').download(avatar as string)
      expect(error).toBeNull()
      expect((await data!.arrayBuffer()).byteLength).toBe(PNG.byteLength)
    })

    await test.step('a field now the same cannot be picked', async () => {
      await expect(copy.locator('[data-testid="am-copy-bio"]')).toBeDisabled({ timeout: 15000 })
      await expect(copy.locator('[data-testid="am-copy-row-bio"]')).toContainText('Already the same')
      await expect(copy.locator('[data-testid="am-copy-row-profile_fields"]')).toContainText('Already the same')
    })

    await context.close()
  })

  test('cancelling the redirect ends the offer', async ({ browser }) => {
    test.setTimeout(120_000)
    await admin.from('profiles').update({ moved_to_id: null, moved_to_uri: null, moved_at: null }).eq('id', origin.id)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const panel = await openMigration(page, target)
    await expect(panel.locator('[data-testid="am-copy"]')).toHaveCount(0)
    await context.close()
  })
})
