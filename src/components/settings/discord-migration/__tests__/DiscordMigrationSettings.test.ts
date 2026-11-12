/** DiscordMigrationSettings.vue: Server Settings → Migrate from Discord. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

const api = vi.hoisted(() => ({
  getMigration: vi.fn(),
  saveMigration: vi.fn(),
  setOwnCredentials: vi.fn(),
  refreshFromDiscord: vi.fn(),
  autoMatch: vi.fn(),
  saveRoleMap: vi.fn(),
  adminImpact: vi.fn(),
  applyPermissions: vi.fn(),
  setState: vi.fn(),
  requestSync: vi.fn(),
  regenerateToken: vi.fn(),
  allowBack: vi.fn(),
  listMembers: vi.fn(),
}))
const confirmMock = vi.hoisted(() => vi.fn())
const rolesMock = vi.hoisted(() => vi.fn())

vi.mock('../migrationApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../migrationApi')>()),
  ...api,
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/services/RoleService', () => ({ roleService: { getServerRoles: rolesMock } }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

import DiscordMigrationSettings from '../DiscordMigrationSettings.vue'
import { MigrationError, type MigrationConfig } from '../migrationApi'

const SERVER = 'srv-1'
const missingKeys: string[] = []

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
    missing: (_locale: string, key: string) => {
      missingKeys.push(key)
    },
    missingWarn: false,
    fallbackWarn: false,
  })
}

const BaseModalStub = defineComponent({
  props: { show: Boolean, title: String },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { 'data-testid': 'modal' }, [slots.default?.(), slots.footer?.()]) : null)
  },
})
const IconStub = defineComponent({ props: { name: String }, setup: () => () => h('i') })

const HARMONY_ROLES = [
  { id: 'H0', name: '@everyone', position: 0, is_default: true, permissions: {} },
  { id: 'H1', name: 'Moderator', position: 2, permissions: {} },
  { id: 'H2', name: 'Member', position: 1, permissions: {} },
  { id: 'H3', name: 'Boss', position: 3, is_admin: true, permissions: { ADMINISTRATOR: true } },
]

function config(overrides: Partial<MigrationConfig> = {}): MigrationConfig {
  return {
    server_id: SERVER,
    state: 'draft',
    discord_guild_id: '900',
    credential_source: 'instance_bot',
    link_token: 'a'.repeat(48),
    last_sync_at: null,
    last_sync_result: null,
    sync_paused_reason: null,
    bot_can_ban: true,
    readiness_warnings: null,
    has_own_credentials: false,
    bridge_available: false,
    instance_bot_available: true,
    caller_is_owner: true,
    discord_roles: [
      { discord_role_id: 'D1', name: 'Mods', color: 0xff0000, position: 5, harmony_permissions: '0', fetched_at: '2026-11-10T00:00:00Z' },
      { discord_role_id: 'D2', name: 'Members', color: 0, position: 3, harmony_permissions: '0', fetched_at: '2026-11-10T00:00:00Z' },
      { discord_role_id: 'D3', name: 'Fans', color: 0, position: 2, harmony_permissions: '0', fetched_at: '2026-11-10T00:00:00Z' },
    ],
    role_map: [{ discord_role_id: 'D1', harmony_role_id: 'H1' }],
    link_counts: { active: 0, left: 0, banned: 0, kicked_on_harmony: 0 },
    readiness: {
      ready: false,
      unmapped_roles: [
        { discord_role_id: 'D2', name: 'Members' },
        { discord_role_id: 'D3', name: 'Fans' },
      ],
      has_credentials: true,
      has_guild: true,
      roles_fetched: true,
    },
    permission_gaps: [],
    ...overrides,
  }
}

async function mountPanel(cfg: MigrationConfig) {
  api.getMigration.mockResolvedValue(cfg)
  const w = mount(DiscordMigrationSettings, {
    props: { serverId: SERVER },
    global: { plugins: [makeI18n()], stubs: { BaseModal: BaseModalStub, Icon: IconStub } },
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  missingKeys.length = 0
  rolesMock.mockResolvedValue(HARMONY_ROLES)
  api.autoMatch.mockResolvedValue([])
  api.listMembers.mockResolvedValue([])
  api.saveRoleMap.mockResolvedValue({})
  api.adminImpact.mockResolvedValue({ holders: [] })
  api.applyPermissions.mockResolvedValue({ updated: [] })
  api.setState.mockResolvedValue({})
  confirmMock.mockResolvedValue(true)
})

describe('role map', () => {
  it('keeps Open migration disabled while roles are unmapped and counts them', async () => {
    const w = await mountPanel(config())
    expect(w.find('[data-testid="open-migration"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="unmapped-counter"]').text()).toBe('2 roles still need a match')
    expect(missingKeys).toEqual([])
  })

  it('enables Open migration once the server says the migration is ready and the redirect is ticked', async () => {
    const w = await mountPanel(config({ readiness: { ready: true, unmapped_roles: [], has_credentials: true, has_guild: true, roles_fetched: true } }))
    expect(w.find('[data-testid="open-migration"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="redirect-added"]').setValue(true)
    expect(w.find('[data-testid="open-migration"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="open-migration"]').trigger('click')
    await flushPromises()
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'open')
  })

  it('saves a chosen Harmony role and offers no ignore option', async () => {
    const w = await mountPanel(config())
    const select = w.find('[data-testid="map-D2"]')
    expect(select.findAll('option').map((o) => o.text().toLowerCase()).some((text) => text.includes('ignore'))).toBe(false)
    expect(select.findAll('option').map((o) => o.text())).not.toContain('@everyone')

    await select.setValue('H2')
    await flushPromises()
    expect(api.saveRoleMap).toHaveBeenCalledTimes(1)
    const [serverId, map, confirm] = api.saveRoleMap.mock.calls[0]
    expect(serverId).toBe(SERVER)
    expect(map).toEqual(expect.arrayContaining([
      { discord_role_id: 'D1', harmony_role_id: 'H1' },
      { discord_role_id: 'D2', harmony_role_id: 'H2' },
    ]))
    expect(confirm).toBe(false)
  })

  it('prefills a name match and saves the matches on request', async () => {
    api.autoMatch.mockResolvedValue([
      { discord_role_id: 'D2', harmony_role_id: 'H2' },
      { discord_role_id: 'D3', harmony_role_id: null },
    ])
    const w = await mountPanel(config())
    expect((w.find('[data-testid="map-D2"]').element as HTMLSelectElement).value).toBe('H2')
    expect(w.find('[data-role="D2"] [data-testid="matched-hint"]').text()).toBe('Matched by name')
    expect(w.find('[data-role="D3"] [data-testid="matched-hint"]').exists()).toBe(false)
    expect(api.saveRoleMap).not.toHaveBeenCalled()

    await w.find('[data-testid="accept-matches"]').trigger('click')
    await flushPromises()
    expect(api.saveRoleMap.mock.calls[0][1]).toEqual(expect.arrayContaining([
      { discord_role_id: 'D2', harmony_role_id: 'H2' },
    ]))
  })

  it('says the members will hold the role when only the Discord side is Administrator', async () => {
    api.saveRoleMap.mockRejectedValueOnce(new MigrationError('ADMIN_ROLE_NEEDS_CONFIRM', 'ADMIN_ROLE_NEEDS_CONFIRM'))
    api.adminImpact.mockResolvedValue({ holders: [{ user_id: 'u1', username: 'carol', display_name: 'Carol' }] })
    const cfg = config()
    cfg.discord_roles[1].harmony_permissions = '1'
    const w = await mountPanel(cfg)
    await w.find('[data-testid="map-D2"]').setValue('H2')
    await flushPromises()
    const text = w.find('[data-testid="admin-confirm"]').text()
    expect(text).toContain('These members will hold this role. They become admins if Administrator is applied to it')
    expect(text).toContain('becomes an admin if Administrator is applied to it')
    expect(text).not.toContain('will become admins of this server')
    expect(missingKeys).toEqual([])
  })

  it('asks for confirmation when the server wants it, lists the holders, and retries confirmed', async () => {
    api.saveRoleMap.mockRejectedValueOnce(new MigrationError('ADMIN_ROLE_NEEDS_CONFIRM', 'ADMIN_ROLE_NEEDS_CONFIRM'))
    api.adminImpact.mockResolvedValue({ holders: [{ user_id: 'u1', username: 'carol', display_name: 'Carol' }] })
    const w = await mountPanel(config())

    await w.find('[data-testid="map-D2"]').setValue('H3')
    await flushPromises()
    expect(api.saveRoleMap).toHaveBeenCalledTimes(1)
    expect(api.adminImpact).toHaveBeenCalledWith(SERVER, 'D2')
    const dialog = w.find('[data-testid="admin-confirm"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('These members will become admins of this server')
    expect(dialog.text()).toContain('Carol')
    expect(dialog.text()).toContain('Anyone given this role on Discord while the migration is open becomes an admin here too')

    await w.find('[data-testid="admin-confirm-ok"]').trigger('click')
    await flushPromises()
    expect(api.saveRoleMap).toHaveBeenCalledTimes(2)
    expect(api.saveRoleMap.mock.calls[1][2]).toBe(true)
    expect(w.find('[data-testid="admin-confirm"]').exists()).toBe(false)
  })

  it('refuses to confirm when the holders cannot be loaded, and retries', async () => {
    api.saveRoleMap.mockRejectedValueOnce(new MigrationError('ADMIN_ROLE_NEEDS_CONFIRM', 'ADMIN_ROLE_NEEDS_CONFIRM'))
    api.adminImpact.mockRejectedValueOnce(new Error('boom'))
    const w = await mountPanel(config())

    await w.find('[data-testid="map-D2"]').setValue('H3')
    await flushPromises()
    const dialog = w.find('[data-testid="admin-confirm"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain("Couldn't load the members who hold this role. Try again.")
    expect(dialog.text()).not.toContain('No one holds this role')
    expect(w.find('[data-testid="admin-confirm-ok"]').attributes('disabled')).toBeDefined()

    api.adminImpact.mockResolvedValue({ holders: [{ user_id: 'u1', username: 'carol', display_name: 'Carol' }] })
    await w.find('[data-testid="admin-confirm-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="admin-confirm-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-confirm"]').text()).toContain('Carol')
    expect(w.find('[data-testid="admin-confirm-ok"]').attributes('disabled')).toBeUndefined()
  })

  it('reloads the config when the admin confirmation is cancelled, so no unsaved pick stays', async () => {
    api.saveRoleMap.mockRejectedValueOnce(new MigrationError('ADMIN_ROLE_NEEDS_CONFIRM', 'ADMIN_ROLE_NEEDS_CONFIRM'))
    const w = await mountPanel(config())
    // the name-match prefill is off: D2 starts empty
    expect((w.find('[data-testid="map-D2"]').element as HTMLSelectElement).value).toBe('')
    const loadsBefore = api.getMigration.mock.calls.length

    await w.find('[data-testid="map-D2"]').setValue('H3')
    await flushPromises()
    await w.find('[data-testid="admin-confirm-cancel"]').trigger('click')
    await flushPromises()
    expect(api.getMigration.mock.calls.length).toBeGreaterThan(loadsBefore)
    expect(w.find('[data-testid="admin-confirm"]').exists()).toBe(false)
    expect((w.find('[data-testid="map-D2"]').element as HTMLSelectElement).value).toBe('')
  })

  it('locks an Administrator row for a caller who is not the owner', async () => {
    const cfg = config({ caller_is_owner: false })
    cfg.discord_roles[1].harmony_permissions = '1'
    const w = await mountPanel(cfg)
    const row = w.find('[data-role="D2"]')
    expect(row.find('select').attributes('disabled')).toBeDefined()
    expect(row.find('[data-testid="owner-only"]').text()).toBe('Only the server owner can map roles with Administrator')
    expect(row.find('[data-testid="admin-badge"]').exists()).toBe(true)
    expect(w.find('[data-role="D3"] select').attributes('disabled')).toBeUndefined()
  })

  it('shows a rule violation on the row in plain words', async () => {
    api.saveRoleMap.mockRejectedValueOnce(new MigrationError('Cannot grant X', 'OTHER'))
    const w = await mountPanel(config())
    await w.find('[data-testid="map-D2"]').setValue('H2')
    await flushPromises()
    expect(w.find('[data-testid="row-error-D2"]').text()).toBe('Cannot grant X')
  })
})

describe('permission gaps', () => {
  const gapConfig = () => config({ permission_gaps: [{ discord_role_id: 'D1', harmony_role_id: 'H1', missing: ['KICK_MEMBERS', 'BAN_MEMBERS'] }] })

  it('names the missing permissions and applies them for that row', async () => {
    const w = await mountPanel(gapConfig())
    expect(w.find('[data-gap="D1"] [data-testid="gap-missing"]').text()).toBe('Kick Members, Ban Members')
    await w.find('[data-testid="apply-D1"]').trigger('click')
    await flushPromises()
    expect(api.applyPermissions).toHaveBeenCalledWith(SERVER, ['D1'], false)
  })

  it('applies every gap with Apply all', async () => {
    const w = await mountPanel(gapConfig())
    await w.find('[data-testid="apply-all"]').trigger('click')
    await flushPromises()
    expect(api.applyPermissions).toHaveBeenCalledWith(SERVER, ['D1'], false)
  })

  it('words a missing Manage Roles permission and an ungrantable permission for people', async () => {
    api.applyPermissions.mockRejectedValueOnce(new MigrationError('Missing permission: MANAGE_ROLES', 'MISSING_MANAGE_ROLES'))
    const w = await mountPanel(gapConfig())
    await w.find('[data-testid="apply-D1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="gap-error-D1"]').text()).toBe('You need the Manage Roles permission to apply permissions')

    api.applyPermissions.mockRejectedValueOnce(new MigrationError('Cannot grant BAN_MEMBERS without holding it', 'CANNOT_GRANT', undefined, 'BAN_MEMBERS'))
    await w.find('[data-testid="apply-D1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="gap-error-D1"]').text()).toBe("You can't grant Ban Members because you don't have it")
  })

  it('confirms an Administrator gap before applying it', async () => {
    api.applyPermissions.mockRejectedValueOnce(new MigrationError('ADMIN_ROLE_NEEDS_CONFIRM', 'ADMIN_ROLE_NEEDS_CONFIRM'))
    const w = await mountPanel(config({ permission_gaps: [{ discord_role_id: 'D1', harmony_role_id: 'H1', missing: ['ADMINISTRATOR'] }] }))
    await w.find('[data-testid="apply-D1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="admin-confirm"]').exists()).toBe(true)
    await w.find('[data-testid="admin-confirm-ok"]').trigger('click')
    await flushPromises()
    expect(api.applyPermissions).toHaveBeenLastCalledWith(SERVER, ['D1'], true)
  })
})

describe('fetch from Discord', () => {
  it('reports the failure inline and a missing ban permission as a notice', async () => {
    api.refreshFromDiscord.mockResolvedValue({ ok: false, error: 'bot_not_in_guild' })
    const w = await mountPanel(config({ bot_can_ban: false }))
    expect(w.find('[data-testid="cannot-ban"]').exists()).toBe(true)
    await w.find('[data-testid="refresh"]').trigger('click')
    await flushPromises()
    expect(api.refreshFromDiscord).toHaveBeenCalledWith(SERVER)
    expect(w.find('[data-testid="refresh-error"]').text()).toContain("isn't in that Discord server")
  })

  it('shows the redirect address and write-only fields for own credentials', async () => {
    const w = await mountPanel(config({ credential_source: 'own', instance_bot_available: false }))
    expect(w.find('[data-testid="source-instance_bot"]').exists()).toBe(false)
    expect(w.find('[data-testid="source-own"]').exists()).toBe(true)
    expect(w.find('[data-testid="dm-own"]').text()).toContain('/bot-gateway/bridge/v2/migrate/callback')
    expect(w.find('#dm-client-secret').attributes('type')).toBe('password')
    expect(w.find('#dm-bot-token').attributes('type')).toBe('password')
  })
})

describe('open and finished', () => {
  const OPEN = () => config({
    state: 'open',
    last_sync_at: new Date().toISOString(),
    last_sync_result: { checked: 4, rolesChanged: 1, removed: 0, errors: 0 },
    readiness: { ready: true, unmapped_roles: [], has_credentials: true, has_guild: true, roles_fetched: true },
  })

  it('shows the invitation link and finishes behind a confirmation', async () => {
    const w = await mountPanel(OPEN())
    expect(w.find('[data-testid="dm-open"]').text()).toContain('a'.repeat(48))
    expect(w.find('[data-testid="open-migration"]').exists()).toBe(false)

    await w.find('[data-testid="finish"]').trigger('click')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'finished')
  })

  it('does not finish when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false)
    const w = await mountPanel(OPEN())
    await w.find('[data-testid="finish"]').trigger('click')
    await flushPromises()
    expect(api.setState).not.toHaveBeenCalled()
  })

  it('syncs now and resumes a paused sync', async () => {
    const w = await mountPanel({ ...OPEN(), sync_paused_reason: 'removal_brake' })
    expect(w.find('[data-testid="paused"]').text()).toContain('Syncing is paused.')
    await w.find('[data-testid="sync-now"]').trigger('click')
    await flushPromises()
    expect(api.requestSync).toHaveBeenCalledWith(SERVER)
    await w.find('[data-testid="resume"]').trigger('click')
    await flushPromises()
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'open')
  })

  it('asks before resuming a removal brake pause, naming the removals it approves', async () => {
    const w = await mountPanel({ ...OPEN(), sync_paused_reason: 'removal_brake' })
    await w.find('[data-testid="resume"]').trigger('click')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const args = confirmMock.mock.calls[0][0]
    expect(args.message).toContain('left or were banned on Discord')
    expect(args.message).toContain('will be removed')
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'open')
  })

  it('does not resume a removal brake pause when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false)
    const w = await mountPanel({ ...OPEN(), sync_paused_reason: 'removal_brake' })
    await w.find('[data-testid="resume"]').trigger('click')
    await flushPromises()
    expect(api.setState).not.toHaveBeenCalled()
  })

  it('resumes any other pause without a confirmation', async () => {
    const w = await mountPanel({ ...OPEN(), sync_paused_reason: 'token_invalid' })
    await w.find('[data-testid="resume"]').trigger('click')
    await flushPromises()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'open')
  })

  it('labels a cleared link Not linked with a hint, not Left Discord', async () => {
    api.listMembers.mockResolvedValue([
      { user_id: 'u3', username: 'erin', display_name: 'Erin', discord_user_id: '557', status: 'left', last_synced_at: null },
    ])
    const w = await mountPanel(OPEN())
    const cell = w.find('[data-testid="status-u3"]')
    expect(cell.text()).toBe('Not linked')
    expect(cell.attributes('title')).toBe('Left Discord or was allowed back. Can link again.')
  })

  it('lists members and allows a member kicked on Harmony back', async () => {
    api.listMembers.mockResolvedValue([
      { user_id: 'u1', username: 'carol', display_name: 'Carol', discord_user_id: '555', status: 'active', last_synced_at: null },
      { user_id: 'u2', username: 'dave', display_name: null, discord_user_id: '556', status: 'kicked_on_harmony', last_synced_at: null },
    ])
    const w = await mountPanel(OPEN())
    expect(w.find('[data-member="u1"]').text()).toContain('555')
    expect(w.find('[data-testid="allow-back-u1"]').exists()).toBe(false)
    await w.find('[data-testid="allow-back-u2"]').trigger('click')
    await flushPromises()
    expect(api.allowBack).toHaveBeenCalledWith(SERVER, 'u2')
  })

  it('words the locked Discord server for open and finished alike', async () => {
    for (const state of ['open', 'finished'] as const) {
      const w = await mountPanel(config({ state }))
      expect(w.text()).toContain("The Discord server can't change after the migration has been opened.")
    }
  })

  it('shows Re-open with its warning once finished', async () => {
    const w = await mountPanel(config({ state: 'finished', finished_at: new Date().toISOString() }))
    expect(w.find('[data-testid="reopen-warning"]').text()).toContain('follow Discord again')
    await w.find('[data-testid="reopen"]').trigger('click')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.setState).toHaveBeenCalledWith(SERVER, 'open')
  })
})

describe('Discord server ID prefill', () => {
  it('fills the field from the bridge and says so when nothing is saved yet', async () => {
    const w = await mountPanel(config({ discord_guild_id: null, bridge_discord_guild_id: '777' }))
    expect((w.find('[data-testid="guild-input"]').element as HTMLInputElement).value).toBe('777')
    expect(w.find('[data-testid="guild-from-bridge"]').text()).toBe("Filled in from this server's Discord bridge.")
    expect(missingKeys).toEqual([])
  })

  it('leaves the field empty without a bridge guild', async () => {
    const w = await mountPanel(config({ discord_guild_id: null, bridge_discord_guild_id: null }))
    expect((w.find('[data-testid="guild-input"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('[data-testid="guild-from-bridge"]').exists()).toBe(false)
  })

  it('prefers the saved guild id over the bridge', async () => {
    const w = await mountPanel(config({ discord_guild_id: '900', bridge_discord_guild_id: '777' }))
    expect((w.find('[data-testid="guild-input"]').element as HTMLInputElement).value).toBe('900')
    expect(w.find('[data-testid="guild-from-bridge"]').exists()).toBe(false)
  })

  it('drops the hint once the owner edits the field', async () => {
    const w = await mountPanel(config({ discord_guild_id: null, bridge_discord_guild_id: '777' }))
    await w.find('[data-testid="guild-input"]').setValue('555')
    expect(w.find('[data-testid="guild-from-bridge"]').exists()).toBe(false)
  })
})
describe('member channel overrides', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    discord_channel_id: '801',
    channel_name: 'general',
    discord_user_id: '601',
    allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
    deny: ['ATTACH_FILES'],
    status: 'linked',
    username: 'bob',
    ...over,
  })

  it('lists each override with its permissions and who it reaches', async () => {
    const w = await mountPanel(
      config({
        member_overrides: [
          row(),
          row({ discord_channel_id: '802', channel_name: 'staff', discord_user_id: '602', allow: [], deny: ['VIEW_CHANNEL'], status: 'not_linked', username: null }),
          row({ discord_channel_id: '803', channel_name: 'lounge', status: 'unpaired', username: null }),
        ],
      } as never),
    )
    const rows = w.findAll('[data-testid="override-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('#general')
    expect(rows[0].text()).toContain('Discord member 601')
    expect(rows[0].text()).toContain('Allows: View Channel, Send Messages')
    expect(rows[0].text()).toContain('Denies: Attach Files')
    expect(rows[0].text()).toContain('Linked to @bob')
    expect(rows[1].text()).toContain('Allows: nothing')
    expect(rows[1].text()).toContain('Not linked yet')
    expect(rows[2].text()).toContain('Channel not paired')
    expect(w.find('[data-testid="overrides-toggle"]').exists()).toBe(false)
    expect(missingKeys).toEqual([])
  })

  it('collapses a long list until asked to show all', async () => {
    const many = Array.from({ length: 8 }, (_, i) => row({ discord_user_id: String(700 + i) }))
    const w = await mountPanel(config({ member_overrides: many } as never))
    expect(w.findAll('[data-testid="override-row"]')).toHaveLength(5)
    await w.find('[data-testid="overrides-toggle"]').trigger('click')
    expect(w.findAll('[data-testid="override-row"]')).toHaveLength(8)
  })

  it('shows nothing without overrides and keeps the unpaired channel warning', async () => {
    const w = await mountPanel(
      config({ readiness_warnings: { unpaired_channels: ['random'], member_overrides: 2 }, member_overrides: [] } as never),
    )
    expect(w.find('[data-testid="dm-overrides"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="warning"]')).toHaveLength(1)
  })
})
describe('redirect address checklist', () => {
  const READY = { ready: true, unmapped_roles: [], has_credentials: true, has_guild: true, roles_fetched: true }

  it.each(['instance_bot', 'bridge', 'own'] as const)('shows the redirect address and blocks Open for the %s source', async (credential_source) => {
    const w = await mountPanel(config({ credential_source, readiness: READY }))
    const block = w.find('[data-testid="dm-redirect"]')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('/bot-gateway/bridge/v2/migrate/callback')
    expect(w.find('[data-testid="open-migration"]').attributes('disabled')).toBeDefined()
    expect(missingKeys).toEqual([])
  })

  it('remembers the tick for this server in this browser', async () => {
    const first = await mountPanel(config({ readiness: READY }))
    await first.find('[data-testid="redirect-added"]').setValue(true)
    expect(localStorage.getItem(`harmony:discord-migration-redirect:${SERVER}`)).toBe('1')
    const second = await mountPanel(config({ readiness: READY }))
    expect((second.find('[data-testid="redirect-added"]').element as HTMLInputElement).checked).toBe(true)
    await second.find('[data-testid="redirect-added"]').setValue(false)
    expect(localStorage.getItem(`harmony:discord-migration-redirect:${SERVER}`)).toBeNull()
  })
})
