// Journey: a copy of a server hosted on another instance (migration 20261027200001). Its owner is
// the host's; this instance's admin holds no server authority in it.
//
//   - the server menu and Server settings say where it is hosted and that settings here change
//     only this instance's view; settings offer the overview and emojis, and to instance staff
//     "On {instance}", above which the banner leaves out that line; they name the host owner, and
//     Leave works from there;
//   - the member menu offers no Kick or Ban, and no invite is offered;
//   - instance staff's Delete on another member's message is "Hide on {instance}", with a confirm
//     naming the instance and the host; the author's own message keeps Delete; no Pin.
//
// The copy rows are written here as the federation backend writes them (this stack has no
// federation backend); /servers/leave is answered as the backend answers it.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  addMember, adminClient, createUser, deleteUser, messageList, openChannel, seedServer, signIn,
  type SeededServer, type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const host = 'chat.example'
const hostOwner = { id: crypto.randomUUID(), username: `own${Date.now().toString(36)}` }
const copy = { id: crypto.randomUUID(), name: 'Harbour Hall', channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${copy.id}`
let staff: SpecUser
let author: SpecUser
let home: SeededServer
let authorMessageId: string

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })
const messageMenu = (page: Page) => page.getByRole('menu', { name: 'Message options' })

test.beforeAll(async () => {
  staff = await createUser(admin, 'cpst')
  author = await createUser(admin, 'cpau')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  home = await seedServer(admin, staff, `Home ${staff.username}`)
  await addMember(admin, author, home.id)

  const { error: ownerError } = await admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: 'Host Owner', domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  })
  if (ownerError) throw new Error(`host owner: ${ownerError.message}`)

  const { error } = await admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host, host_domain: host,
    federation_metadata: { attributedTo: `https://${host}/users/${hostOwner.username}` },
  })
  if (error) throw new Error(`copy: ${error.message}`)
  const channel = await admin.from('channels').insert({
    id: copy.channel, server_id: copy.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${copy.channel}`,
  })
  if (channel.error) throw new Error(`copy channel: ${channel.error.message}`)
  for (const user of [staff, author]) {
    const member = await admin.from('user_servers').upsert(
      { server_id: copy.id, user_id: user.id, status: 'accepted', member_instance: 'localhost' },
      { onConflict: 'user_id,server_id' },
    )
    if (member.error) throw new Error(`membership: ${member.error.message}`)
  }

  const { data: posted, error: postError } = await admin.from('messages').insert([
    { channel_id: copy.channel, user_id: author.id, content: [{ type: 'text', text: 'Fair winds from the author' }] },
    { channel_id: copy.channel, user_id: staff.id, content: [{ type: 'text', text: 'Staff says hello' }] },
  ]).select('id, user_id')
  if (postError || !posted) throw new Error(`messages: ${postError?.message}`)
  authorMessageId = posted.find((m) => m.user_id === author.id)!.id
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, author)
  await deleteUser(admin, staff)
})

test('a copy says where it is hosted, names the host owner, offers no server settings but this instance\'s tools, and Leave works', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, staff)
  await openChannel(page, copy.id, copy.channel)

  await test.step('the server menu names the host and offers Leave, not an invite', async () => {
    await page.locator('.channel-sidebar .server-name').click()
    const banner = page.locator('.server-dropdown [data-testid="server-copy-banner"]')
    await expect(banner).toContainText(`Hosted on ${host}`)
    await expect(banner).toContainText('Its owner and moderators manage it there. Settings here only change what you see.')
    const menu = page.locator('.server-dropdown [role="menu"]')
    await expect(menu.getByRole('menuitem', { name: 'Leave server' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Get invite link' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Overview' }).click()
  })

  await test.step('settings: the banner, the overview, emojis and this instance\'s tools, the host owner', async () => {
    const banner = page.getByTestId('server-copy-banner')
    await expect(banner).toContainText(`Hosted on ${host}`, { timeout: 30000 })
    const nav = page.getByTestId('server-settings-nav')
    await expect(nav.getByRole('button')).toHaveText(['Overview', 'Emoji', /^On \S+$/])
    const owner = page.getByTestId('server-copy-owner')
    await expect(owner).toContainText('Owner')
    await expect(owner).toContainText('Host Owner')
    await expect(owner).toContainText(`@${hostOwner.username}@${host}`)
    await expect(page.getByText('Delete server')).toHaveCount(0)
  })

  await test.step('"On {instance}": the banner no longer says settings here only change what you see', async () => {
    const tab = page.getByTestId('server-settings-nav').getByRole('button', { name: /^On \S+$/ })
    const title = (await tab.textContent())!.trim()
    await tab.click()
    await expect(page.getByTestId('instance-server-panel').getByRole('heading', { name: title })).toBeVisible()
    const body = page.getByTestId('server-copy-banner-body')
    await expect(body).toHaveText('Its owner and moderators manage it there.')
    await page.getByTestId('server-settings-nav').getByRole('button', { name: 'Overview' }).click()
    await expect(body).toHaveText('Its owner and moderators manage it there. Settings here only change what you see.')
  })

  await test.step('Leave leaves the copy', async () => {
    await page.route('**/servers/leave', async (route) => {
      await admin.from('user_servers').delete().eq('server_id', copy.id).eq('user_id', staff.id)
      await route.fulfill({ json: { success: true, message: 'Left server successfully' } })
    })
    await page.getByTestId('server-copy-leave').click()
    const confirm = page.getByRole('alertdialog').filter({ hasText: copy.name })
    await confirm.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect.poll(async () => {
      const { data } = await admin.from('user_servers').select('id').eq('server_id', copy.id).eq('user_id', staff.id)
      return data?.length
    }, { timeout: 15000 }).toBe(0)
  })

  const back = await admin.from('user_servers').upsert(
    { server_id: copy.id, user_id: staff.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  )
  expect(back.error).toBeNull()
})

test('a member who is not instance staff gets the overview and emojis of a copy, nothing more', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, author)
  await openChannel(page, copy.id, copy.channel)
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('.server-dropdown [role="menu"]').getByRole('menuitem', { name: 'Overview' }).click()

  await expect(page.getByTestId('server-copy-banner')).toContainText(`Hosted on ${host}`, { timeout: 30000 })
  await expect(page.getByTestId('server-settings-nav').getByRole('button')).toHaveText(['Overview', 'Emoji'])
  await expect(page.getByTestId('instance-server-panel')).toHaveCount(0)
})

test('the member menu offers no Kick or Ban in a copy, and does on a server hosted here', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, staff)

  const memberMenuOf = async (name: string) => {
    await page.locator('.user-sidebar .user-item').filter({ hasText: name }).first().click({ button: 'right' })
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Copy user ID' }) })
    await expect(menu).toBeVisible({ timeout: 15000 })
    return menu
  }

  await test.step('a server hosted here', async () => {
    await openChannel(page, home.id, home.generalChannelId)
    const menu = await memberMenuOf(author.displayName)
    await expect(menu.getByRole('menuitem', { name: `Kick ${author.displayName}` })).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Escape')
  })

  await test.step('a copy', async () => {
    await openChannel(page, copy.id, copy.channel)
    const menu = await memberMenuOf(author.displayName)
    await expect(menu.getByRole('menuitem', { name: 'Mention' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Kick / })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /^Ban / })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Invite to server' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})

test('instance staff hide another member\'s message on this instance; their own keeps Delete; no Pin', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, staff)
  await openChannel(page, copy.id, copy.channel)

  const own = rowOf(page, 'Staff says hello')
  await expect(own).toBeVisible({ timeout: 30000 })
  await own.hover()
  await expect(own.getByTestId('msg-action-delete')).toHaveAttribute('aria-label', 'Delete message')

  const row = rowOf(page, 'Fair winds from the author')
  await row.click({ button: 'right' })
  await expect(messageMenu(page)).toBeVisible({ timeout: 15000 })
  await expect(messageMenu(page).getByRole('menuitem', { name: 'Reply' })).toBeVisible()
  await expect(messageMenu(page).getByRole('menuitem', { name: /Pin message/ })).toHaveCount(0)
  const hide = messageMenu(page).getByRole('menuitem', { name: /^Hide on / })
  await expect(hide).toBeVisible()
  const label = (await hide.textContent())!.trim()
  const instance = label.replace(/^Hide on /, '')
  await expect(messageMenu(page).getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0)
  await hide.click()

  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(`Hide on ${instance}`)
  await expect(confirm).toContainText(
    `Hide this message for everyone on ${instance}? It stays on ${host} and for everyone else.`)
  await confirm.getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(rowOf(page, 'Fair winds from the author')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(async () => {
    const { data } = await admin.from('messages').select('is_deleted').eq('id', authorMessageId).single()
    return data?.is_deleted
  }, { timeout: 15000 }).toBe(true)
})
