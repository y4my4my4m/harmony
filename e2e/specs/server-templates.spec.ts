// Journey: an owner exports their server as a template file from Server
// Settings > Advanced; another user creates a server from that file in Create
// Server. The new server has the source's categories, channels and roles.
//
// The template is structure only: the exported file carries no messages or
// members, and the new server is owned by whoever created it.

import fs from 'fs'
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addChannel,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  permissionMask,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let importer: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'tpla')
  importer = await createUser(admin, 'tplb')
  server = await seedServer(admin, owner, `Template ${owner.username}`)

  await addChannel(admin, server, 'tpl-notes')
  const { data: category, error: categoryError } = await admin
    .from('channel_categories')
    .insert({ server_id: server.id, name: 'Projects', order: 5 })
    .select('id')
    .single()
  if (categoryError || !category) throw new Error(`category: ${categoryError?.message}`)
  const { error: channelError } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'roadmap', type: 0, category: category.id })
  if (channelError) throw new Error(`roadmap: ${channelError.message}`)
  const { error: roleError } = await admin.from('server_roles').insert({
    server_id: server.id,
    name: 'Moderators',
    color: '#E67E22',
    position: 5,
    permissions: permissionMask(['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS']),
  })
  if (roleError) throw new Error(`role: ${roleError.message}`)
  const { error: messageError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text: 'not part of any template' }],
  })
  if (messageError) throw new Error(`message: ${messageError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, importer)
})

// The 31 named permission bits. Export drops the bits above them, which the server-insert
// trigger sets on Admin.
const NAMED_BITS = (1n << 31n) - 1n

/** Channels as "category/name/type" and roles as "name/permissions/flags/color", sorted. */
async function structure(db: SupabaseClient, serverId: string) {
  const [{ data: channels }, { data: categories }, { data: roles }] = await Promise.all([
    db.from('channels').select('name, type, category').eq('server_id', serverId),
    db.from('channel_categories').select('id, name').eq('server_id', serverId),
    db
      .from('server_roles')
      .select('name, permissions, is_default, is_admin, color')
      .eq('server_id', serverId),
  ])
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]))
  return {
    channels: (channels ?? [])
      .map((c) => `${categoryName.get(c.category) ?? '-'}/${c.name}/${c.type}`)
      .sort(),
    roles: (roles ?? [])
      .map(
        (r) =>
          `${r.name}/${BigInt(r.permissions) & NAMED_BITS}/${r.is_default}/${r.is_admin}/${
            r.color ?? ''
          }`,
      )
      .sort(),
  }
}

test('export a server as a template and create a server from the file', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)

  const fileName = `${server.name}.harmony-template.json`
  const saved = testInfo.outputPath(fileName)

  await test.step('the owner exports the template', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await signIn(page, owner)
    await page.goto(`/server/${server.id}?section=advanced`)
    const exportButton = page.locator('[data-testid="server-template-export-btn"]')
    await expect(exportButton).toBeVisible({ timeout: 30000 })

    const download = page.waitForEvent('download')
    await exportButton.click()
    const file = await download
    expect(file.suggestedFilename()).toBe(fileName)
    await file.saveAs(saved)
    await context.close()

    const template = JSON.parse(fs.readFileSync(saved, 'utf8'))
    expect(template.format).toBe('harmony.server-template')
    expect(template.server.name).toBe(server.name)
    const text = JSON.stringify(template)
    expect(text).not.toContain('not part of any template')
    expect(text).not.toContain(owner.id)
  })

  const context = await browser.newContext()
  const page = await context.newPage()
  const copyName = `Copy ${importer.username}`
  let newServerId = ''

  await test.step('another user picks the file in Create Server', async () => {
    await signIn(page, importer)
    await page.locator('[data-testid="empty-create-server"]').click()
    const nameInput = page.locator('[data-testid="create-server-name-input"]')
    await expect(nameInput).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="create-server-template-input"]').setInputFiles(saved)
    const summary = page.locator('[data-testid="create-server-template-summary"]')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText(server.name)
    // Moderators beside @everyone and Admin; Text Channels, Voice Channels and Projects;
    // general, voice chat, tpl-notes and roadmap.
    await expect(summary).toContainText('1 role · 3 categories · 4 channels')
    await expect(nameInput).toHaveValue(server.name)
  })

  await test.step('create the server and land in it', async () => {
    await page.locator('[data-testid="create-server-name-input"]').fill(copyName)
    await page.locator('[data-testid="create-server-btn"]').click()
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}\/[0-9a-f-]{36}/, { timeout: 30000 })
    newServerId = page.url().split('/chat/')[1].split('/')[0]
    expect(newServerId).not.toBe(server.id)
    await expect(page.locator('.channel-sidebar .server-name')).toHaveText(copyName, {
      timeout: 30000,
    })
    await expect(channelRow(page, 'tpl-notes')).toBeVisible({ timeout: 30000 })
    await expect(channelRow(page, 'roadmap')).toBeVisible()
    await expect(
      page.locator('.channel-sidebar .category-name').filter({ hasText: /^\s*projects\s*$/i }),
    ).toBeVisible()
  })

  await test.step('categories, channels and roles match the source', async () => {
    const source = await structure(admin, server.id)
    const copy = await structure(admin, newServerId)
    expect(copy.channels).toEqual(source.channels)
    expect(copy.roles).toEqual(source.roles)

    const { data: created } = await admin
      .from('servers')
      .select('owner')
      .eq('id', newServerId)
      .single()
    expect(created?.owner).toBe(importer.id)
    const { data: channels } = await admin
      .from('channels')
      .select('id')
      .eq('server_id', newServerId)
    const { data: messages } = await admin
      .from('messages')
      .select('content')
      .in(
        'channel_id',
        (channels ?? []).map((c) => c.id),
      )
    expect(JSON.stringify(messages ?? [])).not.toContain('not part of any template')
  })

  await context.close()
})
