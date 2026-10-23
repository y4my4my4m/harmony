// Journey: instance staff as Trust & Safety for servers hosted here (20261027250001). From
// Admin > Servers a moderator opens a server, removes a member's message and the member; each
// confirmation says it acts as staff of this instance and is recorded in the server's audit
// log. The owner reads both in the audit log as "<name> (<instance> staff)", and the channel's
// notice names staff. An admin suspends the server: members see the banner in place of the
// composer, a post and a join are refused, and lifting the suspension gives the composer back.
//
// The stack has no realtime: a member's page reloads to see a suspension.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  instanceDomain,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let staffAdmin: SpecUser
let staffMod: SpecUser
let owner: SpecUser
let member: SpecUser
let offender: SpecUser
let outsider: SpecUser
let server: SeededServer
let domain: string
let offendingMessageId: string

test.beforeAll(async () => {
  staffAdmin = await createUser(admin, 'hsa')
  staffMod = await createUser(admin, 'hsm')
  owner = await createUser(admin, 'hso')
  member = await createUser(admin, 'hsb')
  offender = await createUser(admin, 'hsx')
  outsider = await createUser(admin, 'hsy')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staffAdmin.id)
  await admin.from('profiles').update({ is_moderator: true }).eq('id', staffMod.id)
  domain = await instanceDomain(admin)

  server = await seedServer(admin, owner, `Hosted ${owner.username}`)
  await admin.from('servers').update({ public: true }).eq('id', server.id)
  await addMember(admin, member, server.id)
  await addMember(admin, offender, server.id)

  const client = await userClient(offender)
  const { data, error } = await client.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: offender.id,
    content: [{ type: 'text', text: `buy followers ${offender.username}` }],
  }).select('id').single()
  if (error || !data) throw new Error(`message: ${error?.message}`)
  offendingMessageId = data.id
})

test.afterAll(async () => {
  for (const user of [outsider, offender, member, owner, staffMod, staffAdmin]) await deleteUser(admin, user)
})

async function openHostedServer(page: Page) {
  await page.goto('/admin?tab=servers')
  await dismissAnnouncements(page)
  const panel = page.getByTestId('hosted-servers')
  await expect(panel).toBeVisible({ timeout: 30000 })
  await expect(panel).toContainText(`${domain} staff`)
  await panel.getByTestId('hosted-servers-search').fill(server.name)
  const row = panel.getByTestId('hosted-server-row').filter({ hasText: server.name })
  await expect(row).toHaveCount(1, { timeout: 30000 })
  return { panel, row }
}

const staffDialog = (page: Page) => page.getByTestId('staff-action-dialog')

test('a moderator removes a message and a member as staff; the owner reads it as staff', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await signIn(page, staffMod)

  await test.step('Admin > Servers lists the server; its members open with the owner first', async () => {
    const { panel, row } = await openHostedServer(page)
    await expect(row).toContainText('3 members')
    await row.getByTestId('hosted-server-open').click()
    const members = panel.getByTestId('hosted-member-row')
    await expect(members.first()).toContainText(owner.displayName, { timeout: 30000 })
    await expect(members.first().getByTestId('hosted-member-remove')).toHaveCount(0)
  })

  await test.step('the offender\'s message is removed after a confirmation naming staff and the audit log', async () => {
    const panel = page.getByTestId('hosted-servers')
    await panel.getByTestId('hosted-member-row').filter({ hasText: offender.displayName })
      .getByRole('button', { name: 'Messages' }).click()
    const message = panel.getByTestId('hosted-message-row').filter({ hasText: `buy followers ${offender.username}` })
    await expect(message).toBeVisible({ timeout: 30000 })
    await message.getByTestId('hosted-message-remove').click()

    const dialog = staffDialog(page)
    await expect(page.getByRole('heading', { name: `Remove this message from ${server.name} as ${domain} staff?` })).toBeVisible()
    await expect(dialog).toContainText(`You act as ${domain} staff, not as a moderator of ${server.name}.`)
    await expect(dialog).toContainText(`It is removed for everyone, on ${domain} and on other instances.`)
    await expect(dialog).toContainText(`Recorded in ${server.name}'s audit log as an action of ${domain} staff.`)
    await dialog.getByTestId('staff-action-reason').fill('spam link')
    await page.getByTestId('staff-action-confirm').click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await expect(message).toHaveCount(0, { timeout: 30000 })
    await expect.poll(async () => (await admin.from('messages').select('is_deleted').eq('id', offendingMessageId).single()).data?.is_deleted)
      .toBe(true)
  })

  await test.step('the offender is removed from the server', async () => {
    const panel = page.getByTestId('hosted-servers')
    await panel.getByRole('tab', { name: 'Members' }).click()
    const row = panel.getByTestId('hosted-member-row').filter({ hasText: offender.displayName })
    await row.getByTestId('hosted-member-remove').click()
    const dialog = staffDialog(page)
    await expect(page.getByRole('heading', { name: `Remove ${offender.displayName} from ${server.name} as ${domain} staff?` })).toBeVisible()
    await expect(dialog).toContainText(`${offender.displayName} leaves ${server.name}. They can join again.`)
    await dialog.getByTestId('staff-action-reason').fill('spam account')
    await page.getByTestId('staff-action-confirm').click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await expect(row).toHaveCount(0, { timeout: 30000 })
    await expect.poll(async () => (await admin.from('user_servers').select('id')
      .eq('server_id', server.id).eq('user_id', offender.id)).data?.length).toBe(0)
  })

  await test.step('the owner reads both actions as staff, in the audit log and in the channel', async () => {
    const context = await browser.newContext()
    const ownerPage = await context.newPage()
    await signIn(ownerPage, owner)
    await ownerPage.goto(`/server/${server.id}?section=audit-log`)
    const entries = ownerPage.locator('[data-test="audit-entry"]')
    await expect(entries.first()).toBeVisible({ timeout: 30000 })
    const actor = `${staffMod.displayName} (${domain} staff)`
    const kick = entries.filter({ has: ownerPage.locator('.audit-line', { hasText: `${actor} kicked ${offender.displayName}` }) })
    await expect(kick).toHaveCount(1)
    await expect(kick).toContainText('Reason: spam account')
    const removal = entries.filter({ has: ownerPage.locator('.audit-line', { hasText: `${actor} deleted a message by ${offender.displayName}` }) })
    await expect(removal).toHaveCount(1)
    await expect(removal).toContainText('Reason: spam link')

    await openChannel(ownerPage, server.id, server.generalChannelId)
    const notice = messageList(ownerPage).locator('[data-system-type="member_kick"]').last()
    await expect(notice).toContainText(`(${domain} staff) kicked`, { timeout: 30000 })
    await context.close()
  })
})

test('an admin suspends the server: members see the banner, posts and joins are refused', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const context = await browser.newContext()
  const memberPage = await context.newPage()
  await signIn(memberPage, member)
  await openChannel(memberPage, server.id, server.generalChannelId)
  await expect(memberPage.getByTestId('server-suspended-banner')).toHaveCount(0)

  await signIn(page, staffAdmin)

  await test.step('the suspension lists what members will see', async () => {
    const { row } = await openHostedServer(page)
    await row.getByTestId('hosted-server-suspend').click()
    const dialog = staffDialog(page)
    await expect(page.getByRole('heading', { name: `Suspend ${server.name} as ${domain} staff?` })).toBeVisible()
    await expect(dialog).toContainText('Nobody can post new messages in it or join it until the suspension is lifted.')
    await expect(dialog).toContainText(`${domain} staff suspended this server.`)
    await dialog.getByTestId('staff-action-reason').fill('coordinated raids')
    await page.getByTestId('staff-action-confirm').click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await expect(row).toContainText('Suspended')
    await expect(row).toContainText('Reason: coordinated raids')
  })

  await test.step('a member sees the banner in place of the composer', async () => {
    await openChannel(memberPage, server.id, server.generalChannelId)
    const banner = memberPage.getByTestId('server-suspended-banner')
    await expect(banner).toContainText(`${domain} staff suspended this server.`, { timeout: 30000 })
    await expect(banner).toContainText('Reason: coordinated raids')
    await expect(memberPage.locator('[data-testid="message-input"] .rich-text-editor')).toHaveCount(0)
  })

  await test.step('a post and a join are refused', async () => {
    const client = await userClient(member)
    const { error: postError } = await client.from('messages').insert({
      channel_id: server.generalChannelId, user_id: member.id, content: [{ type: 'text', text: 'still here?' }],
    })
    expect(postError?.message).toContain('SERVER_SUSPENDED')
    const joining = await userClient(outsider)
    const { error: joinError } = await joining.rpc('join_public_server', { p_server_id: server.id })
    expect(joinError?.message).toContain('SERVER_SUSPENDED')
  })

  await test.step('lifting the suspension gives the composer back', async () => {
    const { row } = await openHostedServer(page)
    await row.getByRole('button', { name: 'Lift suspension' }).click()
    await expect(staffDialog(page)).toContainText('Members can post and join again.')
    await page.getByTestId('staff-action-confirm').click()
    await expect(row).not.toContainText('Suspended', { timeout: 30000 })

    await openChannel(memberPage, server.id, server.generalChannelId)
    await expect(memberPage.getByTestId('server-suspended-banner')).toHaveCount(0)
    await expect(memberPage.locator('[data-testid="message-input"] .rich-text-editor')).toBeVisible({ timeout: 30000 })
  })
  await context.close()
})
