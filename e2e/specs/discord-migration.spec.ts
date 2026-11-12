// Journey: "Migrate from Discord", against a stub Discord (e2e/discord-stub-server.ts).
//
// The server owner opens Server Settings > Migrate from Discord, picks "My own Discord
// application", saves the credentials and the Discord server, fetches the roles, accepts the
// role that matches by name, maps the other by hand, applies its missing Kick Members
// permission, confirms the redirect address was added and opens the migration. A new visitor follows the link: the stub's Discord consent
// -> the account form -> NewProfile -> the server, holding both mapped roles. The stub then drops
// one role from that member; the owner presses "Sync now" and the role is gone.
//
// The bot gateway runs as a child process (botGateway.ts) with DISCORD_API_BASE and
// DISCORD_OAUTH_BASE at the stub. The dev server has no /bot-gateway proxy (the real instance's
// reverse proxy has), so the pages forward those requests to the gateway; redirects pass
// through untouched.

import { test, expect, type BrowserContext } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  PASSWORD,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'
import {
  startDiscordStub,
  STUB_BOT_TOKEN,
  STUB_CLIENT_ID,
  STUB_CLIENT_SECRET,
  type DiscordStub,
} from '../discord-stub-server'

const admin = adminClient()
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'

const GUILD_ID = '900000000000000777'
const ROLE_REGULARS = '1500000000000000010'
const ROLE_HELPER = '1500000000000000011'
const ROLE_BOT = '1500000000000000012'
const BOT_USER_ID = STUB_CLIENT_ID
const DISCORD_USER_ID = '1500000000000000099'
const KICK_MEMBERS = '2'
const ADMINISTRATOR = '8'
// A Discord username Harmony accepts and no earlier run used.
const DISCORD_NAME = `dj${Date.now().toString(36)}`

let owner: SpecUser
let server: SeededServer
let stub: DiscordStub
let gateway: BotGateway
let newcomerId = ''
let crewRoleId = ''

test.beforeAll(async () => {
  owner = await createUser(admin, 'dmo')
  server = await seedServer(admin, owner, `Migrate ${owner.username}`)

  // The cloned Harmony roles: "Regulars" shares its name with a Discord role, "Crew" does not.
  const { data: roles, error } = await admin
    .from('server_roles')
    .insert([
      { server_id: server.id, name: 'Regulars', position: 3, permissions: 0 },
      { server_id: server.id, name: 'Crew', position: 2, permissions: 0 },
    ])
    .select('id, name')
  if (error || !roles) throw new Error(`roles: ${error?.message}`)

  crewRoleId = roles.find((r) => r.name === 'Crew')!.id

  stub = await startDiscordStub({
    guildId: GUILD_ID,
    consentUserId: DISCORD_USER_ID,
    bans: [],
    roles: [
      { id: ROLE_REGULARS, name: 'Regulars', color: 0x3498db, position: 3, permissions: '0' },
      { id: ROLE_HELPER, name: 'Helper', color: 0xe67e22, position: 2, permissions: KICK_MEMBERS },
      // Managed by Discord (the bot's own role): never shown or mapped.
      { id: ROLE_BOT, name: 'Migration Bot', position: 1, permissions: ADMINISTRATOR, managed: true },
    ],
    members: [
      { user: { id: BOT_USER_ID, username: 'migration-bot' }, roles: [ROLE_BOT], joined_at: '2020-01-01T00:00:00.000Z' },
      {
        user: { id: DISCORD_USER_ID, username: DISCORD_NAME, global_name: 'Discord Joe' },
        roles: [ROLE_REGULARS, ROLE_HELPER],
        joined_at: '2021-03-04T05:06:07.000Z',
      },
    ],
  })

  gateway = await startBotGateway({
    // The origin the browser uses: the gateway builds the OAuth redirect URI and the return
    // address from it.
    INSTANCE_DOMAIN: BASE_URL,
    DISCORD_API_BASE: stub.apiUrl,
    DISCORD_OAUTH_BASE: stub.url,
  })
})

test.afterAll(async () => {
  await gateway?.stop()
  await stub?.stop()
  if (server) await admin.from('servers').delete().eq('id', server.id)
  if (newcomerId) await admin.auth.admin.deleteUser(newcomerId).catch(() => {})
  await deleteUser(admin, owner)
})

/** The instance's reverse proxy, for a page: /bot-gateway/<path> goes to the gateway. */
async function proxyGateway(context: BrowserContext) {
  await context.route('**/bot-gateway/**', async (route) => {
    const url = new URL(route.request().url())
    const target = `${gateway.url}${url.pathname.replace(/^\/bot-gateway/, '')}${url.search}`
    const response = await route.fetch({ url: target, maxRedirects: 0 })
    await route.fulfill({ response })
  })
}

async function memberRoleNames(userId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('user_roles')
    .select('server_roles(name)')
    .eq('user_id', userId)
    .eq('server_id', server.id)
  if (error) throw new Error(`user_roles: ${error.message}`)
  return (data ?? []).map((row) => (row as unknown as { server_roles: { name: string } }).server_roles.name).filter((name) => name !== 'everyone').sort()
}

test('an owner opens the migration, a Discord member joins with their roles, and a sync follows Discord', async ({ page, browser }) => {
  test.setTimeout(300_000)
  await proxyGateway(page.context())

  // ---------------------------------------------------------------- the owner configures
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=discord-migration`)
  const panel = page.locator('[data-testid="discord-migration"]')
  await expect(panel.locator('[data-testid="dm-source"]')).toBeVisible({ timeout: 45000 })

  await panel.locator('[data-testid="source-own"]').check()
  await panel.getByLabel('Client ID').fill(STUB_CLIENT_ID)
  await panel.getByLabel('Client secret').fill(STUB_CLIENT_SECRET)
  await panel.getByLabel('Bot token').fill(STUB_BOT_TOKEN)
  await panel.locator('[data-testid="guild-input"]').fill(GUILD_ID)
  await panel.locator('[data-testid="save-source"]').click()
  await expect(panel.locator('[data-testid="dm-secrets-hint"]')).toContainText('stored', { timeout: 15000 })
  await expect(panel.locator('[data-testid="save-error"]')).toHaveCount(0)

  await panel.locator('[data-testid="refresh"]').click()
  await expect(panel.locator('[data-testid="refresh-ok"]')).toContainText('2', { timeout: 30000 })
  // The managed bot role is not offered.
  await expect(panel.locator(`[data-role="${ROLE_BOT}"]`)).toHaveCount(0)
  await expect(panel.locator(`[data-role="${ROLE_REGULARS}"]`)).toBeVisible()
  await expect(panel.locator('[data-testid="unmapped-counter"]')).toContainText('2')

  // "Regulars" matches by name; "Helper" does not and is mapped by hand.
  await expect(panel.locator(`[data-role="${ROLE_REGULARS}"] [data-testid="matched-hint"]`)).toBeVisible()
  await panel.locator('[data-testid="accept-matches"]').click()
  await expect(panel.locator('[data-testid="unmapped-counter"]')).toContainText('1', { timeout: 15000 })
  await panel.locator(`[data-testid="map-${ROLE_HELPER}"]`).selectOption(crewRoleId)
  await expect(panel.locator('[data-testid="unmapped-counter"]')).toContainText('Every Discord role has a match', { timeout: 15000 })

  // Crew lacks Kick Members, which Helper has on Discord.
  const gap = panel.locator(`[data-gap="${ROLE_HELPER}"]`)
  await expect(gap).toBeVisible({ timeout: 15000 })
  await expect(gap.locator('[data-testid="gap-missing"]')).toContainText('Kick Members')
  await panel.locator(`[data-testid="apply-${ROLE_HELPER}"]`).click()
  await expect(panel.locator('[data-testid="dm-gaps"]')).toHaveCount(0, { timeout: 15000 })

  // Every Discord application has to accept the return address; Open waits for the owner to say it does.
  const redirect = panel.locator('[data-testid="dm-redirect"]')
  await expect(redirect).toBeVisible()
  await expect(redirect).toContainText('/bot-gateway/bridge/v2/migrate/callback')
  await expect(panel.locator('[data-testid="open-migration"]')).toBeDisabled()
  await panel.locator('[data-testid="redirect-added"]').check()
  await expect(panel.locator('[data-testid="open-migration"]')).toBeEnabled({ timeout: 15000 })
  await panel.locator('[data-testid="open-migration"]').click()
  await expect(panel.locator('[data-testid="dm-open"]')).toBeVisible({ timeout: 15000 })

  const { data: migration, error: migrationError } = await admin
    .from('discord_migrations')
    .select('link_token, state')
    .eq('server_id', server.id)
    .single()
  if (migrationError || !migration) throw new Error(`discord_migrations: ${migrationError?.message}`)
  expect(migration.state).toBe('open')

  // ---------------------------------------------------------------- the newcomer joins
  const visitorContext = await browser.newContext({ baseURL: BASE_URL })
  try {
    await proxyGateway(visitorContext)
    const visitor = await visitorContext.newPage()
    await visitor.goto(`/migrate/${migration.link_token}`)
    await expect(visitor.getByRole('heading', { name: server.name })).toBeVisible({ timeout: 45000 })
    await visitor.locator('[data-testid="migrate-new-account"]').click()

    // The stub's consent screen asks for the identify scope only.
    await expect(visitor.getByText('Scope: identify')).toBeVisible({ timeout: 45000 })
    await visitor.locator('#stub-authorize').click()

    // Back from the consent, with a ticket and the Discord username filled in.
    const form = visitor.locator('[data-testid="migrate-form"]')
    await expect(form).toBeVisible({ timeout: 45000 })
    await expect(visitor.locator('[data-testid="migrate-username"]')).toHaveValue(DISCORD_NAME)
    const email = `${DISCORD_NAME}@e2e.test`
    await visitor.locator('[data-testid="migrate-email"]').fill(email)
    await visitor.locator('[data-testid="migrate-password"]').fill(PASSWORD)
    await visitor.locator('[data-testid="migrate-submit"]').click()

    await expect(visitor).toHaveURL(/new-profile/, { timeout: 45000 })
    await expect(visitor.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 15000 })
    await visitor.locator('[data-testid="profile-display-name"]').fill('Discord Joe')
    await expect(visitor.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
    await visitor.locator('[data-testid="profile-submit"]').click()
    await visitor.waitForURL(/\/chat/, { timeout: 45000 })
    await dismissAnnouncements(visitor)

    // The newcomer is in the server and holds both mapped roles.
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id')
      .eq('username', DISCORD_NAME)
      .eq('is_local', true)
      .single()
    if (profileError || !profile) throw new Error(`profile: ${profileError?.message}`)
    newcomerId = profile.id
    await expect.poll(() => memberRoleNames(newcomerId), { timeout: 30000 }).toEqual(['Crew', 'Regulars'])
    await expect(visitor.getByText(server.name).first()).toBeVisible({ timeout: 30000 })
  } finally {
    await visitorContext.close()
  }

  // ---------------------------------------------------------------- the sync follows Discord
  stub.state.members.find((m) => m.user.id === DISCORD_USER_ID)!.roles = [ROLE_REGULARS]
  await page.reload()
  await expect(panel.locator('[data-testid="dm-open"]')).toBeVisible({ timeout: 45000 })
  await expect(panel.locator(`[data-member="${newcomerId}"]`)).toBeVisible({ timeout: 15000 })
  await panel.locator('[data-testid="sync-now"]').click()
  // The gateway looks for due servers every 30 seconds.
  await expect.poll(() => memberRoleNames(newcomerId), { timeout: 120_000, intervals: [2000] }).toEqual(['Regulars'])
})
