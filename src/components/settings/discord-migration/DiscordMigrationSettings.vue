<template>
  <div class="dm-panel" data-testid="discord-migration">
    <h2 class="section-title dm-title">{{ t('discordMigration.title') }}</h2>
    <p class="db-muted">{{ t('discordMigration.intro') }}</p>

    <p v-if="loading" class="db-muted" role="status" data-testid="dm-loading">{{ t('discordMigration.loading') }}</p>

    <div v-else-if="loadError" class="db-banner db-banner--error" role="alert" data-testid="dm-load-error">
      <p>{{ t('discordMigration.loadError') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('discordMigration.retry') }}</button>
      </div>
    </div>

    <template v-else-if="config">
      <!-- 1. Prerequisites -->
      <section class="db-card" data-testid="dm-prereq">
        <h3 class="db-card-sub">{{ t('discordMigration.prereq.title') }}</h3>
        <ul class="db-steps">
          <li>{{ t('discordMigration.prereq.cloneFirst') }}</li>
          <li>{{ t('discordMigration.prereq.botInServer') }}</li>
        </ul>
      </section>

      <!-- 2-4. Credentials, Discord server, fetch -->
      <section class="db-card" data-testid="dm-source">
        <h3 class="db-card-sub">{{ t('discordMigration.source.title') }}</h3>
        <fieldset class="dm-fieldset" :disabled="busy !== ''">
          <legend class="db-sr-only">{{ t('discordMigration.source.title') }}</legend>
          <label v-for="option in sourceOptions" :key="option" class="dm-radio">
            <input v-model="source" type="radio" name="dm-source" :value="option" :data-testid="`source-${option}`" />
            <span>
              <span class="db-ui">{{ t(`discordMigration.source.${option}.label`) }}</span>
              <span class="db-muted dm-block">{{ t(`discordMigration.source.${option}.hint`) }}</span>
            </span>
          </label>
        </fieldset>

        <div v-if="source === 'own'" class="dm-own" data-testid="dm-own">
          <p class="db-muted">{{ t('discordMigration.source.own.intro') }}</p>
          <p class="db-muted">{{ t('discordMigration.source.own.redirect') }}</p>
          <BridgeCopyBlock :text="redirectUri" :label="t('discordMigration.source.own.redirectLabel')" />
          <div class="db-field">
            <label class="db-label" for="dm-client-id">{{ t('discordMigration.source.own.clientId') }}</label>
            <input id="dm-client-id" v-model="clientId" class="db-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" />
          </div>
          <div class="db-field">
            <label class="db-label" for="dm-client-secret">{{ t('discordMigration.source.own.clientSecret') }}</label>
            <input id="dm-client-secret" v-model="clientSecret" class="db-input" type="password" autocomplete="off" spellcheck="false" />
          </div>
          <div class="db-field">
            <label class="db-label" for="dm-bot-token">{{ t('discordMigration.source.own.botToken') }}</label>
            <input id="dm-bot-token" v-model="botToken" class="db-input" type="password" autocomplete="off" spellcheck="false" />
          </div>
          <p class="db-muted" data-testid="dm-secrets-hint">
            {{ config.has_own_credentials ? t('discordMigration.source.own.stored') : t('discordMigration.source.own.notStored') }}
          </p>
        </div>

        <div class="db-field dm-guild">
          <label class="db-label" for="dm-guild">{{ t('discordMigration.guild.label') }}</label>
          <input
            id="dm-guild"
            v-model="guildId"
            class="db-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :disabled="guildLocked"
            data-testid="guild-input"
            @input="guildFromBridge = false"
          />
          <span class="db-muted">{{ guildLocked ? t('discordMigration.guild.locked') : t('discordMigration.guild.hint') }}</span>
          <span v-if="guildFromBridge && !guildLocked" class="db-muted" data-testid="guild-from-bridge">
            {{ t('discordMigration.guild.fromBridge') }}
          </span>
        </div>

        <p v-if="saveError" class="dm-error" role="alert" data-testid="save-error">{{ saveError }}</p>
        <div class="db-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy !== '' || !source"
            data-testid="save-source"
            @click="saveSource"
          >
            {{ t('discordMigration.source.save') }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy !== '' || !canRefresh"
            data-testid="refresh"
            @click="refresh"
          >
            {{ busy === 'refresh' ? t('discordMigration.refresh.working') : t('discordMigration.refresh.button') }}
          </button>
        </div>
        <p v-if="!canRefresh" class="db-muted dm-top" data-testid="refresh-hint">{{ t('discordMigration.refresh.needSave') }}</p>
        <p v-if="refreshMessage" class="db-muted dm-top" role="status" data-testid="refresh-ok">{{ refreshMessage }}</p>
        <p v-if="refreshError" class="dm-error dm-top" role="alert" data-testid="refresh-error">{{ refreshError }}</p>
        <div v-if="config.bot_can_ban === false" class="db-banner db-banner--warn dm-top" role="status" data-testid="cannot-ban">
          <p>{{ t('discordMigration.refresh.cannotBan') }}</p>
        </div>
      </section>

      <!-- 5. Role map -->
      <section class="db-card" data-testid="dm-roles">
        <h3 class="db-card-sub">{{ t('discordMigration.roles.title') }}</h3>
        <p class="db-muted">{{ t('discordMigration.roles.intro') }}</p>

        <p v-if="!config.discord_roles.length" class="db-muted" data-testid="roles-empty">{{ t('discordMigration.roles.empty') }}</p>
        <template v-else>
          <p
            :class="['dm-counter', unmappedCount ? 'dm-counter--todo' : 'dm-counter--done']"
            role="status"
            data-testid="unmapped-counter"
          >
            {{ unmappedCount ? t('discordMigration.roles.counter', { count: unmappedCount }, unmappedCount) : t('discordMigration.roles.allMatched') }}
          </p>

          <ul class="dm-roles">
            <li v-for="role in config.discord_roles" :key="role.discord_role_id" class="dm-role" :data-role="role.discord_role_id">
              <span class="dm-role-name">
                <span class="dm-dot" :style="{ backgroundColor: roleColor(role) }" aria-hidden="true"></span>
                <span class="dm-role-text">{{ role.name }}</span>
                <span v-if="isAdminRow(role)" class="dm-badge" data-testid="admin-badge" :title="t('discordMigration.roles.adminBadge')">
                  <Icon name="shield" :size="12" aria-hidden="true" />
                  {{ t('discordMigration.roles.adminBadge') }}
                </span>
              </span>
              <span class="dm-arrow" aria-hidden="true">→</span>
              <span class="dm-role-pick">
                <select
                  class="db-select"
                  :aria-label="t('discordMigration.roles.selectLabel', { role: role.name })"
                  :value="selection[role.discord_role_id] ?? ''"
                  :disabled="busy !== '' || adminLocked(role)"
                  :data-testid="`map-${role.discord_role_id}`"
                  @change="onPick(role, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-if="!selection[role.discord_role_id]" value="" disabled>{{ t('discordMigration.roles.choose') }}</option>
                  <option v-for="hr in harmonyRoles" :key="hr.id" :value="hr.id">{{ hr.name }}</option>
                </select>
                <span v-if="adminLocked(role)" class="db-muted dm-hint" data-testid="owner-only">
                  {{ t('discordMigration.roles.ownerOnly') }}
                </span>
                <span v-else-if="isSuggested(role.discord_role_id)" class="db-muted dm-hint" data-testid="matched-hint">
                  {{ t('discordMigration.roles.matchedByName') }}
                </span>
                <span v-if="rowErrors[role.discord_role_id]" class="dm-error dm-hint" role="alert" :data-testid="`row-error-${role.discord_role_id}`">
                  {{ rowErrors[role.discord_role_id] }}
                </span>
              </span>
            </li>
          </ul>

          <div v-if="hasSuggestions" class="db-actions">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="busy !== ''" data-testid="accept-matches" @click="acceptSuggestions">
              {{ t('discordMigration.roles.accept') }}
            </button>
          </div>
        </template>
      </section>

      <!-- 6. Permission gaps -->
      <section v-if="config.permission_gaps.length" class="db-card" data-testid="dm-gaps">
        <h3 class="db-card-sub">{{ t('discordMigration.gaps.title') }}</h3>
        <p class="db-muted">{{ t('discordMigration.gaps.intro') }}</p>
        <div class="db-actions dm-bottom">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="busy !== ''" data-testid="apply-all" @click="applyAll">
            {{ t('discordMigration.gaps.applyAll') }}
          </button>
        </div>
        <p v-if="allGapsError" class="dm-error" role="alert" data-testid="apply-all-error">{{ allGapsError }}</p>
        <ul class="dm-gaps">
          <li v-for="gap in config.permission_gaps" :key="gap.discord_role_id" class="dm-gap" :data-gap="gap.discord_role_id">
            <div class="dm-gap-text">
              <div class="dm-gap-line">
                <span class="db-ui">{{ discordRoleName(gap.discord_role_id) }}</span>
                <span class="dm-arrow" aria-hidden="true">→</span>
                <span class="db-ui">{{ harmonyRoleName(gap.harmony_role_id) }}</span>
              </div>
              <span class="db-muted dm-block" data-testid="gap-missing">{{ missingText(gap) }}</span>
              <span v-if="gapErrors[gap.discord_role_id]" class="dm-error dm-block" role="alert" :data-testid="`gap-error-${gap.discord_role_id}`">
                {{ gapErrors[gap.discord_role_id] }}
              </span>
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="busy !== ''"
              :data-testid="`apply-${gap.discord_role_id}`"
              @click="applyGap(gap)"
            >
              {{ t('discordMigration.gaps.apply') }}
            </button>
          </li>
        </ul>
      </section>

      <!-- 7. Member channel overrides -->
      <section v-if="memberOverrides.length" class="db-card" data-testid="dm-overrides">
        <h3 class="db-card-sub">{{ t('discordMigration.overrides.title') }}</h3>
        <p class="db-muted">{{ t('discordMigration.overrides.intro') }}</p>
        <ul class="dm-gaps">
          <li v-for="o in shownOverrides" :key="`${o.discord_channel_id}:${o.discord_user_id}`" class="dm-override" data-testid="override-row">
            <span class="db-ui">#{{ o.channel_name || o.discord_channel_id }}</span>
            <span class="db-muted">{{ t('discordMigration.overrides.member', { id: o.discord_user_id }) }}</span>
            <span class="db-muted">{{ t('discordMigration.overrides.allows', { list: permissionList(o.allow) }) }}</span>
            <span class="db-muted">{{ t('discordMigration.overrides.denies', { list: permissionList(o.deny) }) }}</span>
            <span class="dm-override-status" :data-status="o.status" data-testid="override-status">{{ overrideStatus(o) }}</span>
          </li>
        </ul>
        <div v-if="memberOverrides.length > OVERRIDES_COLLAPSED" class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-testid="overrides-toggle" @click="showAllOverrides = !showAllOverrides">
            {{ showAllOverrides ? t('discordMigration.overrides.showFewer') : t('discordMigration.overrides.showAll', { count: memberOverrides.length }) }}
          </button>
        </div>
      </section>

      <!-- 8. Readiness and open -->
      <section v-if="config.state !== 'open' && config.state !== 'finished'" class="db-card" data-testid="dm-ready">
        <h3 class="db-card-sub">{{ t('discordMigration.ready.title') }}</h3>
        <ul v-if="blockers.length" class="db-steps" data-testid="blockers">
          <li v-for="blocker in blockers" :key="blocker">{{ blocker }}</li>
        </ul>
        <div v-for="warning in warnings" :key="warning" class="db-banner db-banner--warn" role="status" data-testid="warning">
          <p>{{ warning }}</p>
        </div>
        <p v-if="stateError" class="dm-error" role="alert" data-testid="state-error">{{ stateError }}</p>
        <div class="db-actions">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="busy !== '' || !config.readiness.ready"
            data-testid="open-migration"
            @click="openMigration"
          >
            {{ t('discordMigration.ready.open') }}
          </button>
        </div>
      </section>

      <!-- 9. Open -->
      <section v-if="config.state === 'open'" class="db-card" data-testid="dm-open">
        <h3 class="db-card-sub">{{ t('discordMigration.open.title') }}</h3>
        <p class="db-muted">{{ t('discordMigration.open.lead') }}</p>
        <BridgeCopyBlock :text="inviteUrl" :label="t('discordMigration.open.linkLabel')" />
        <div class="db-actions dm-bottom">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="busy !== ''" data-testid="regenerate" @click="regenerate">
            {{ t('discordMigration.open.regenerate') }}
          </button>
        </div>

        <div v-if="config.sync_paused_reason" class="db-banner db-banner--warn" role="status" data-testid="paused">
          <p>
            <strong>{{ t('discordMigration.open.pausedTitle') }}</strong>
            {{ pausedText }}
          </p>
          <div class="db-actions">
            <button type="button" class="btn btn-primary btn-sm" :disabled="busy !== ''" data-testid="resume" @click="resume">
              {{ t('discordMigration.open.resume') }}
            </button>
          </div>
        </div>

        <p class="db-text" data-testid="last-sync">{{ lastSyncText }}</p>
        <p v-if="syncResultText" class="db-muted" data-testid="sync-result">{{ syncResultText }}</p>
        <p v-if="stateError" class="dm-error" role="alert" data-testid="state-error">{{ stateError }}</p>
        <div class="db-actions dm-bottom">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="busy !== ''" data-testid="sync-now" @click="syncNow">
            {{ t('discordMigration.open.syncNow') }}
          </button>
          <button type="button" class="btn btn-danger btn-sm" :disabled="busy !== ''" data-testid="finish" @click="finish">
            {{ t('discordMigration.open.finish') }}
          </button>
        </div>
      </section>

      <!-- 10. Finished -->
      <section v-if="config.state === 'finished'" class="db-card" data-testid="dm-finished">
        <h3 class="db-card-sub">{{ t('discordMigration.finished.title') }}</h3>
        <p class="db-muted">{{ t('discordMigration.finished.lead') }}</p>
        <p class="db-muted" data-testid="reopen-warning">{{ t('discordMigration.finished.warning') }}</p>
        <p v-if="stateError" class="dm-error" role="alert" data-testid="state-error">{{ stateError }}</p>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary" :disabled="busy !== ''" data-testid="reopen" @click="reopen">
            {{ t('discordMigration.finished.reopen') }}
          </button>
        </div>
      </section>

      <!-- Members -->
      <section v-if="config.state === 'open' || config.state === 'finished'" class="db-card" data-testid="dm-members">
        <h3 class="db-card-sub">{{ t('discordMigration.members.title') }}</h3>
        <p v-if="!members.length" class="db-muted" data-testid="members-empty">{{ t('discordMigration.members.empty') }}</p>
        <div v-else class="dm-table-wrap">
          <table class="dm-table">
            <thead>
              <tr>
                <th scope="col">{{ t('discordMigration.members.user') }}</th>
                <th scope="col">{{ t('discordMigration.members.discordId') }}</th>
                <th scope="col">{{ t('discordMigration.members.status') }}</th>
                <th scope="col">{{ t('discordMigration.members.lastSynced') }}</th>
                <th scope="col"><span class="db-sr-only">{{ t('discordMigration.members.actions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in members" :key="member.user_id" :data-member="member.user_id">
                <td>{{ member.display_name || member.username || member.user_id }}</td>
                <td><code class="db-inline-code">{{ member.discord_user_id }}</code></td>
                <td :title="member.status === 'left' ? t('discordMigration.members.leftHint') : undefined" :data-testid="`status-${member.user_id}`">
                  {{ t(`discordMigration.members.statuses.${member.status}`) }}
                </td>
                <td>{{ member.last_synced_at ? ago(member.last_synced_at) : t('discordMigration.members.never') }}</td>
                <td>
                  <button
                    v-if="member.status === 'kicked_on_harmony'"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="busy !== ''"
                    :data-testid="`allow-back-${member.user_id}`"
                    @click="allowMemberBack(member)"
                  >
                    {{ t('discordMigration.members.allowBack') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="membersError" class="dm-error" role="alert">{{ membersError }}</p>
      </section>
    </template>

    <AdminRoleConfirmDialog
      :show="adminDialog !== null"
      :holders="adminDialog?.holders ?? []"
      :busy="adminBusy"
      :load-failed="adminDialog?.loadFailed ?? false"
      :pending="adminDialog?.pending ?? false"
      @confirm="confirmAdmin"
      @cancel="cancelAdmin"
      @retry="retryHolders"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { roleService, type ServerRole } from '@/services/RoleService'
import BridgeCopyBlock from '../discord-bridge/BridgeCopyBlock.vue'
import { formatAgo } from '../discord-bridge/bridgeTime'
import AdminRoleConfirmDialog from './AdminRoleConfirmDialog.vue'
import {
  adminImpact,
  allowBack,
  applyPermissions,
  autoMatch,
  getMigration,
  listMembers,
  migrationInviteUrl,
  migrationRedirectUri,
  refreshFromDiscord,
  regenerateToken,
  requestSync,
  saveMigration,
  saveRoleMap,
  setOwnCredentials,
  setState,
  type AdminHolder,
  type CredentialSource,
  type DiscordRoleRow,
  type MigrationConfig,
  type MigrationError,
  type MigrationMember,
  type MemberOverride,
  type PermissionGap,
  type RoleMapRow,
} from './migrationApi'

const props = defineProps<{ serverId: string }>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const config = ref<MigrationConfig | null>(null)
const harmonyRoles = ref<ServerRole[]>([])
const members = ref<MigrationMember[]>([])
const loading = ref(true)
const loadError = ref(false)
const busy = ref('')
const now = ref(Date.now())

const source = ref<CredentialSource | ''>('')
const guildId = ref('')
// True while the field holds the bridge's guild the panel filled in, not something saved or typed.
const guildFromBridge = ref(false)
const clientId = ref('')
const clientSecret = ref('')
const botToken = ref('')
const saveError = ref('')
const refreshError = ref('')
const refreshMessage = ref('')
const stateError = ref('')
const membersError = ref('')
const allGapsError = ref('')

/** The Harmony role chosen per Discord role: the saved map plus unsaved name matches. */
const selection = ref<Record<string, string>>({})
/** Discord role ids whose selection is a name match not yet saved. */
const suggested = ref<Set<string>>(new Set())
const rowErrors = ref<Record<string, string>>({})
const gapErrors = ref<Record<string, string>>({})

interface AdminDialog {
  holders: AdminHolder[]
  /** The list of holders could not be loaded: the dialog cannot be confirmed. */
  loadFailed: boolean
  /** The Discord roles the confirmation is about. */
  roleIds: string[]
  /** A role-map save where no mapped Harmony role carries Administrator yet. */
  pending: boolean
  run: () => Promise<void>
}
const adminDialog = ref<AdminDialog | null>(null)
const adminBusy = ref(false)

const redirectUri = computed(() => migrationRedirectUri())
const inviteUrl = computed(() => migrationInviteUrl(config.value?.link_token ?? ''))
const guildLocked = computed(() => !!config.value && config.value.state !== null && config.value.state !== 'draft')

const sourceOptions = computed<CredentialSource[]>(() => {
  const c = config.value
  if (!c) return []
  const options: CredentialSource[] = []
  if (c.instance_bot_available || c.credential_source === 'instance_bot') options.push('instance_bot')
  if (c.bridge_available || c.credential_source === 'bridge') options.push('bridge')
  options.push('own')
  return options
})

const canRefresh = computed(() => !!config.value && config.value.readiness.has_guild && config.value.readiness.has_credentials)

const harmonyRoleMap = computed(() => new Map(harmonyRoles.value.map((r) => [r.id, r])))

const unmappedCount = computed(() => config.value?.readiness.unmapped_roles.length ?? 0)
const hasSuggestions = computed(() => suggested.value.size > 0)

function isSuggested(discordRoleId: string): boolean {
  return suggested.value.has(discordRoleId)
}

function discordAdmin(role: DiscordRoleRow): boolean {
  try {
    return (BigInt(role.harmony_permissions || '0') & 1n) !== 0n
  } catch {
    return false
  }
}

function harmonyAdmin(harmonyRoleId: string | undefined): boolean {
  if (!harmonyRoleId) return false
  const hr = harmonyRoleMap.value.get(harmonyRoleId)
  if (!hr) return false
  return hr.is_admin === true || (hr.permissions as Record<string, boolean> | undefined)?.ADMINISTRATOR === true
}

/** Administrator-bearing: the Discord role, or the Harmony role it is mapped to, carries Administrator. */
function isAdminRow(role: DiscordRoleRow): boolean {
  return discordAdmin(role) || harmonyAdmin(selection.value[role.discord_role_id])
}

function adminLocked(role: DiscordRoleRow): boolean {
  return !!config.value && !config.value.caller_is_owner && isAdminRow(role)
}

function roleColor(role: DiscordRoleRow): string {
  if (!role.color) return 'var(--text-secondary)'
  return `#${role.color.toString(16).padStart(6, '0')}`
}

function discordRoleName(id: string): string {
  return config.value?.discord_roles.find((r) => r.discord_role_id === id)?.name ?? id
}

function harmonyRoleName(id: string): string {
  return harmonyRoleMap.value.get(id)?.name ?? id
}

function permissionLabel(name: string): string {
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function permissionList(names: string[]): string {
  return names.length ? names.map(permissionLabel).join(', ') : t('discordMigration.overrides.nothing')
}

function overrideStatus(o: MemberOverride): string {
  if (o.status === 'unpaired') return t('discordMigration.overrides.unpaired')
  if (o.status === 'linked') return t('discordMigration.overrides.linked', { username: o.username ?? '' })
  return t('discordMigration.overrides.notLinked')
}

function missingText(gap: PermissionGap): string {
  return gap.missing.map(permissionLabel).join(', ')
}

function ago(iso: string): string {
  return formatAgo(t as never, iso, now.value)
}

function errorText(error: unknown): string {
  const e = error as Partial<MigrationError> | undefined
  switch (e?.code) {
    case 'ADMIN_ROLE_OWNER_ONLY':
      return t('discordMigration.roles.ownerOnly')
    case 'MISSING_MANAGE_ROLES':
      return t('discordMigration.errors.needManageRoles')
    case 'CANNOT_GRANT':
      return t('discordMigration.errors.cannotGrant', { permission: permissionLabel(e.permission ?? '') })
    default:
      return e?.message || t('discordMigration.errors.generic')
  }
}

function isNeedsConfirm(error: unknown): boolean {
  return (error as Partial<MigrationError> | undefined)?.code === 'ADMIN_ROLE_NEEDS_CONFIRM'
}

// ------------------------------------------------------------------ loading

async function reloadConfig() {
  config.value = await getMigration(props.serverId)
  const c = config.value
  if (c.credential_source) source.value = c.credential_source
  else if (!source.value) source.value = sourceOptions.value[0] ?? 'own'
  if (c.discord_guild_id) {
    guildId.value = c.discord_guild_id
    guildFromBridge.value = false
  } else if (!guildId.value && c.bridge_discord_guild_id) {
    guildId.value = c.bridge_discord_guild_id
    guildFromBridge.value = true
  }
  selection.value = {
    ...Object.fromEntries(Object.entries(selection.value).filter(([id]) => suggested.value.has(id))),
    ...Object.fromEntries(c.role_map.map((m) => [m.discord_role_id, m.harmony_role_id])),
  }
  suggested.value = new Set([...suggested.value].filter((id) => !c.role_map.some((m) => m.discord_role_id === id)))
  if (c.state === 'open' || c.state === 'finished') await reloadMembers()
}

async function reloadMembers() {
  try {
    members.value = await listMembers(props.serverId)
    membersError.value = ''
  } catch (e) {
    membersError.value = errorText(e)
  }
}

/** Prefills unmapped rows with the Harmony role of the same name. */
async function prefillMatches() {
  const c = config.value
  if (!c || !c.discord_roles.length || !c.readiness.unmapped_roles.length) return
  try {
    const rows = await autoMatch(props.serverId)
    const unmapped = new Set(c.readiness.unmapped_roles.map((r) => r.discord_role_id))
    const next = { ...selection.value }
    const found = new Set(suggested.value)
    for (const row of rows) {
      if (row.harmony_role_id && unmapped.has(row.discord_role_id) && !next[row.discord_role_id]) {
        next[row.discord_role_id] = row.harmony_role_id
        found.add(row.discord_role_id)
      }
    }
    selection.value = next
    suggested.value = found
  } catch {
    // Suggestions are a convenience; the select still works without them.
  }
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const [, roles] = await Promise.all([reloadConfig(), roleService.getServerRoles(props.serverId)])
    harmonyRoles.value = [...roles].filter((r) => !r.is_default).sort((a, b) => b.position - a.position)
    await prefillMatches()
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

// ------------------------------------------------------------------ credentials and fetch

async function saveSource() {
  if (!source.value) return
  saveError.value = ''
  busy.value = 'save'
  try {
    await saveMigration(props.serverId, guildId.value.trim() || null, source.value)
    if (source.value === 'own' && (clientId.value || clientSecret.value || botToken.value)) {
      await setOwnCredentials(props.serverId, {
        clientId: clientId.value.trim(),
        clientSecret: clientSecret.value.trim(),
        botToken: botToken.value.trim(),
      })
      clientSecret.value = ''
      botToken.value = ''
    }
    await reloadConfig()
    toast.success(t('discordMigration.source.saved'))
  } catch (e) {
    saveError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

async function refresh() {
  refreshError.value = ''
  refreshMessage.value = ''
  busy.value = 'refresh'
  try {
    const result = await refreshFromDiscord(props.serverId)
    if (!result.ok) {
      const known = ['credentials_missing', 'token_invalid', 'bot_not_in_guild', 'network', 'unauthenticated']
      refreshError.value = t(`discordMigration.refresh.errors.${known.includes(result.error) ? result.error : 'other'}`)
      return
    }
    await reloadConfig()
    await prefillMatches()
    refreshMessage.value = t('discordMigration.refresh.done', { count: result.roles }, result.roles)
  } catch (e) {
    refreshError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

// ------------------------------------------------------------------ role map

function mapWith(changes: Record<string, string>): RoleMapRow[] {
  const map = new Map((config.value?.role_map ?? []).map((m) => [m.discord_role_id, m.harmony_role_id]))
  for (const [did, hid] of Object.entries(changes)) map.set(did, hid)
  return [...map].map(([discord_role_id, harmony_role_id]) => ({ discord_role_id, harmony_role_id }))
}

/** The members who would become admins: the holders of each Administrator-bearing role in `discordRoleIds`. */
async function holdersFor(discordRoleIds: string[]): Promise<{ holders: AdminHolder[]; failed: boolean }> {
  const unique = new Map<string, AdminHolder>()
  let failed = false
  for (const did of discordRoleIds) {
    try {
      const impact = await adminImpact(props.serverId, did)
      for (const h of impact.holders) unique.set(h.user_id, h)
    } catch {
      // Never confirm an admin grant without naming who gets it.
      failed = true
    }
  }
  return { holders: [...unique.values()], failed }
}

async function openAdminDialog(discordRoleIds: string[], run: () => Promise<void>, pending = false) {
  const { holders, failed } = await holdersFor(discordRoleIds)
  adminDialog.value = { holders, loadFailed: failed, roleIds: discordRoleIds, pending, run }
}

async function retryHolders() {
  const dialog = adminDialog.value
  if (!dialog) return
  const { holders, failed } = await holdersFor(dialog.roleIds)
  if (adminDialog.value === dialog) adminDialog.value = { ...dialog, holders, loadFailed: failed }
}

/** A cancelled confirmation saved nothing: drop the unsaved pick so the select shows what is stored. */
async function cancelAdmin() {
  const ids = adminDialog.value?.roleIds ?? []
  adminDialog.value = null
  const next = { ...selection.value }
  for (const id of ids) delete next[id]
  selection.value = next
  try {
    await reloadConfig()
    await prefillMatches()
  } catch {
    // The panel keeps what it has; the next action reloads it.
  }
}

async function confirmAdmin() {
  const dialog = adminDialog.value
  if (!dialog) return
  adminBusy.value = true
  try {
    await dialog.run()
  } finally {
    adminBusy.value = false
    adminDialog.value = null
  }
}

async function saveMap(changes: Record<string, string>) {
  const changedIds = Object.keys(changes)
  const map = mapWith(changes)
  const attempt = async (confirmAdminFlag: boolean) => {
    try {
      await saveRoleMap(props.serverId, map, confirmAdminFlag)
      for (const id of changedIds) {
        delete rowErrors.value[id]
        suggested.value.delete(id)
      }
      await reloadConfig()
    } catch (e) {
      if (!confirmAdminFlag && isNeedsConfirm(e)) {
        const admin = changedIds.filter((id) => {
          const role = config.value?.discord_roles.find((r) => r.discord_role_id === id)
          return role ? discordAdmin(role) || harmonyAdmin(changes[id]) : false
        })
        const pending = !(admin.length ? admin : changedIds).some((id) => harmonyAdmin(changes[id]))
        await openAdminDialog(admin.length ? admin : changedIds, () => attempt(true), pending)
        return
      }
      for (const id of changedIds) rowErrors.value[id] = errorText(e)
      await reloadConfig().catch(() => undefined)
    }
  }
  busy.value = 'map'
  try {
    await attempt(false)
  } finally {
    busy.value = ''
  }
}

async function onPick(role: DiscordRoleRow, harmonyRoleId: string) {
  if (!harmonyRoleId) return
  selection.value = { ...selection.value, [role.discord_role_id]: harmonyRoleId }
  await saveMap({ [role.discord_role_id]: harmonyRoleId })
}

async function acceptSuggestions() {
  const changes: Record<string, string> = {}
  for (const id of suggested.value) {
    if (selection.value[id]) changes[id] = selection.value[id]
  }
  if (Object.keys(changes).length) await saveMap(changes)
}

// ------------------------------------------------------------------ permission gaps

async function runApply(ids: string[], onError: (message: string) => void) {
  const attempt = async (confirmAdminFlag: boolean) => {
    try {
      await applyPermissions(props.serverId, ids, confirmAdminFlag)
      for (const id of ids) delete gapErrors.value[id]
      allGapsError.value = ''
      await reloadConfig()
    } catch (e) {
      if (!confirmAdminFlag && isNeedsConfirm(e)) {
        const adminIds = ids.filter((id) =>
          config.value?.permission_gaps.some((g) => g.discord_role_id === id && g.missing.includes('ADMINISTRATOR')),
        )
        await openAdminDialog(adminIds.length ? adminIds : ids, () => attempt(true))
        return
      }
      onError(errorText(e))
    }
  }
  busy.value = 'gaps'
  try {
    await attempt(false)
  } finally {
    busy.value = ''
  }
}

async function applyGap(gap: PermissionGap) {
  await runApply([gap.discord_role_id], (message) => {
    gapErrors.value = { ...gapErrors.value, [gap.discord_role_id]: message }
  })
}

async function applyAll() {
  const ids = (config.value?.permission_gaps ?? []).map((g) => g.discord_role_id)
  await runApply(ids, (message) => {
    allGapsError.value = message
  })
}

// ------------------------------------------------------------------ readiness and lifecycle

const blockers = computed(() => {
  const r = config.value?.readiness
  if (!r) return []
  const list: string[] = []
  if (!r.has_credentials) list.push(t('discordMigration.ready.blockers.credentials'))
  if (!r.has_guild) list.push(t('discordMigration.ready.blockers.guild'))
  if (!r.roles_fetched) list.push(t('discordMigration.ready.blockers.roles'))
  else if (r.unmapped_roles.length) {
    list.push(t('discordMigration.roles.counter', { count: r.unmapped_roles.length }, r.unmapped_roles.length))
  }
  return list
})

const OVERRIDES_COLLAPSED = 5
const showAllOverrides = ref(false)
const memberOverrides = computed(() => config.value?.member_overrides ?? [])
const shownOverrides = computed(() =>
  showAllOverrides.value ? memberOverrides.value : memberOverrides.value.slice(0, OVERRIDES_COLLAPSED),
)

const warnings = computed(() => {
  const w = config.value?.readiness_warnings
  const list: string[] = []
  const unpaired = w?.unpaired_channels?.length ?? 0
  if (unpaired > 0) list.push(t('discordMigration.ready.warnings.unpaired', { count: unpaired }, unpaired))
  return list
})

async function changeState(state: 'open' | 'finished') {
  stateError.value = ''
  busy.value = 'state'
  try {
    await setState(props.serverId, state)
    await reloadConfig()
  } catch (e) {
    stateError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

const openMigration = () => changeState('open')

async function finish() {
  const ok = await confirm({
    title: t('discordMigration.open.finishConfirmTitle'),
    message: t('discordMigration.open.finishConfirmMessage'),
    confirmButtonText: t('discordMigration.open.finishConfirm'),
    dangerAction: true,
  })
  if (ok) await changeState('finished')
}

async function reopen() {
  const ok = await confirm({
    title: t('discordMigration.finished.reopenConfirmTitle'),
    message: t('discordMigration.finished.warning'),
    confirmButtonText: t('discordMigration.finished.reopenConfirm'),
  })
  if (ok) await changeState('open')
}

async function resume() {
  // Resuming a removal brake pause approves the removals that tripped it: ask first.
  if (config.value?.sync_paused_reason === 'removal_brake') {
    const ok = await confirm({
      title: t('discordMigration.open.resumeBrakeConfirmTitle'),
      message: t('discordMigration.open.resumeBrakeConfirmMessage'),
      confirmButtonText: t('discordMigration.open.resumeBrakeConfirm'),
      dangerAction: true,
    })
    if (!ok) return
  }
  await changeState('open')
}

async function syncNow() {
  stateError.value = ''
  busy.value = 'sync'
  try {
    await requestSync(props.serverId)
    await reloadConfig()
    toast.success(t('discordMigration.open.syncQueued'))
  } catch (e) {
    stateError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

async function regenerate() {
  const ok = await confirm({
    title: t('discordMigration.open.regenerateConfirmTitle'),
    message: t('discordMigration.open.regenerateConfirmMessage'),
    confirmButtonText: t('discordMigration.open.regenerate'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = 'token'
  try {
    await regenerateToken(props.serverId)
    await reloadConfig()
  } catch (e) {
    stateError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

async function allowMemberBack(member: MigrationMember) {
  busy.value = 'allow'
  try {
    await allowBack(props.serverId, member.user_id)
    await reloadConfig()
  } catch (e) {
    membersError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}

const pausedText = computed(() => {
  const reason = config.value?.sync_paused_reason ?? ''
  return reason === 'removal_brake' ? t('discordMigration.open.pausedReasons.removal_brake') : reason
})

const lastSyncText = computed(() => {
  const at = config.value?.last_sync_at
  return at
    ? t('discordMigration.open.lastSync', { when: ago(at) })
    : t('discordMigration.open.neverSynced')
})

const syncResultText = computed(() => {
  const r = config.value?.last_sync_result
  if (!r) return ''
  return t('discordMigration.open.result', {
    checked: r.checked ?? 0,
    roles: r.rolesChanged ?? 0,
    removed: r.removed ?? 0,
    errors: r.errors ?? 0,
  })
})

onMounted(load)
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.dm-title {
  margin-top: 0;
}

.dm-fieldset {
  border: 0;
  margin: 0 0 12px;
  padding: 0;
  min-width: 0;
}

.dm-radio {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 10px;
  cursor: pointer;
}

.dm-radio input {
  margin-top: 4px;
}

.dm-block {
  display: block;
  margin: 2px 0 0;
}

.dm-top {
  margin-top: 10px;
}

.dm-bottom {
  margin-bottom: 12px;
}

.dm-own {
  margin-bottom: 8px;
}

.dm-error {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--error);
}

.dm-counter {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.dm-counter--todo {
  color: var(--warning);
}

.dm-counter--done {
  color: var(--success);
}

.dm-roles,
.dm-gaps {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dm-role {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.2fr);
  gap: 10px;
  align-items: start;
}

.dm-role-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  min-width: 0;
  flex-wrap: wrap;
}

.dm-role-text {
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.dm-dot {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.dm-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

.dm-arrow {
  min-height: 40px;
  display: flex;
  align-items: center;
  color: var(--text-secondary);
}

.dm-role-pick {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dm-hint {
  font-size: 12px;
  margin: 0;
}

.dm-gap {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.dm-override {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  overflow-wrap: anywhere;
}

.dm-override-status[data-status='linked'] {
  color: var(--success);
}

.dm-override-status[data-status='not_linked'],
.dm-override-status[data-status='unpaired'] {
  color: var(--warning);
}

.dm-gap-text {
  min-width: 0;
}

.dm-gap-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.dm-gap-line .dm-arrow {
  min-height: 0;
}

.dm-table-wrap {
  overflow-x: auto;
}

.dm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  color: var(--text-primary);
}

.dm-table th,
.dm-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--background-quaternary);
  vertical-align: middle;
}

@media (max-width: 600px) {
  .dm-role {
    grid-template-columns: minmax(0, 1fr);
  }

  .dm-arrow {
    display: none;
  }
}
</style>
