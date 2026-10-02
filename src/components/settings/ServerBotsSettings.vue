<template>
  <div id="server-bots" ref="rootEl" class="server-bots-settings">
    <div class="settings-section">
      <h2 class="section-title">{{ t('bots.server.title') }}</h2>
      <p class="section-description">{{ t('bots.server.description') }}</p>
    </div>

    <div v-if="installedLoading" class="loading-state">
      <LoadingSpinner :size="40" />
    </div>

    <!-- Installed -->
    <div v-else-if="installedBots.length > 0" class="settings-card">
      <div class="card-header">
        <h3>{{ t('bots.server.installedTitle', { count: installedBots.length }) }}</h3>
      </div>

      <ul class="bots-list">
        <li v-for="installation in installedBots" :key="installation.id" class="bot-item">
          <BotAvatar
            :bot="installation.bot"
            :size="40"
            :show-status="true"
            :online="isBotOnline(presence[installation.bot_id])"
          />

          <div class="bot-info">
            <h4>{{ botName(installation.bot) }}</h4>
            <p>{{ installation.bot.bio || t('bots.noDescription') }}</p>
            <span class="install-date">{{ t('bots.server.addedOn', { time: relativeTime(installation.installed_at) }) }}</span>
          </div>

          <div class="bot-actions">
            <button type="button" class="btn btn-secondary btn-sm" @click="openPermissionsModal(installation)">
              {{ t('bots.server.permissions') }}
            </button>
            <button type="button" class="btn btn-danger btn-sm" @click="removeBot(installation)">
              {{ t('bots.server.remove') }}
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Directory -->
    <div class="settings-card">
      <div class="card-header">
        <h3>{{ t('bots.server.browseTitle') }}</h3>
        <div class="search-field">
          <Icon name="search" :size="16" class="search-icon" />
          <input
            v-model="searchQuery"
            type="search"
            class="search-input"
            :placeholder="t('bots.server.searchPlaceholder')"
            :aria-label="t('bots.server.searchPlaceholder')"
          />
        </div>
      </div>

      <div v-if="directoryLoading && availableBots.length === 0" class="loading-state">
        <LoadingSpinner :size="32" />
      </div>

      <EmptyState
        v-else-if="availableBots.length === 0 && activeSearch"
        size="sm"
        icon="search"
        :title="t('bots.server.noResults', { query: activeSearch })"
      />

      <EmptyState
        v-else-if="availableBots.length === 0"
        size="sm"
        icon="bot-message-square"
        :title="t('bots.server.emptyDirectory')"
      />

      <template v-else>
        <div class="bots-grid">
          <div v-for="bot in availableBots" :key="bot.id" class="bot-card">
            <div class="bot-card-header">
              <BotAvatar :bot="bot" :size="48" />
              <div class="bot-badges">
                <span v-if="bot.bot_type === 'bridge'" class="bot-badge bridge">{{ t('bots.badge.bridge') }}</span>
                <span v-if="bot.is_public === false" class="bot-badge private">{{ t('bots.badge.private') }}</span>
              </div>
            </div>

            <div class="bot-info">
              <h4>{{ botName(bot) }}</h4>
              <p class="bot-bio">{{ bot.bio || t('bots.noDescription') }}</p>
            </div>

            <button
              v-if="!isInstalled(bot.id)"
              type="button"
              class="btn btn-primary btn-sm"
              @click="openAddModal(bot)"
            >
              {{ t('bots.server.add') }}
            </button>
            <button v-else type="button" disabled class="btn btn-secondary btn-sm">
              <Icon name="check" :size="14" />
              {{ t('bots.server.added') }}
            </button>
          </div>
        </div>

        <div v-if="hasMore" class="load-more">
          <button type="button" class="btn btn-secondary" :disabled="directoryLoading" @click="loadDirectoryPage(false)">
            {{ t('bots.server.loadMore') }}
          </button>
        </div>
      </template>
    </div>

    <BaseModal
      :show="selectedBot !== null"
      :title="t('bots.server.addTitle')"
      :close-on-overlay="!adding"
      :show-close-button="!adding"
      @close="closeAddModal"
    >
      <template v-if="selectedBot">
        <div class="bot-preview">
          <BotAvatar :bot="selectedBot" :size="48" />
          <div class="bot-preview-text">
            <h4>{{ botName(selectedBot) }}</h4>
            <p>{{ selectedBot.bio || t('bots.noDescription') }}</p>
          </div>
        </div>

        <div class="permissions-section-header">
          <h4>{{ t('bots.server.permissionsTitle') }}</h4>
          <p class="permissions-hint">{{ t('bots.server.permissionsHint') }}</p>
        </div>
        <div class="permissions-list">
          <label
            v-for="perm in permissionRows"
            :key="perm.key"
            class="permission-row"
            :class="{ disabled: perm.required }"
          >
            <input v-model="selectedPermissions[perm.key]" type="checkbox" :disabled="perm.required" />
            <span class="permission-text">
              <span class="permission-label">
                {{ perm.label }}
                <span v-if="perm.required" class="permission-required-badge">{{ t('bots.server.required') }}</span>
              </span>
              <span class="permission-description">{{ perm.description }}</span>
            </span>
          </label>
        </div>
      </template>

      <template #footer>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" :disabled="adding" @click="closeAddModal">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="adding" @click="addBot">
            {{ adding ? t('bots.server.adding') : t('bots.server.addSubmit') }}
          </button>
        </div>
      </template>
    </BaseModal>

    <BaseModal
      :show="selectedInstallation !== null"
      :title="t('bots.server.permissionsTitle')"
      :subtitle="selectedInstallation ? botName(selectedInstallation.bot) : undefined"
      :close-on-overlay="!updatingPerms"
      :show-close-button="!updatingPerms"
      @close="closePermissionsModal"
    >
      <p class="permissions-hint">{{ t('bots.server.permissionsHint') }}</p>
      <div class="permissions-list">
        <label
          v-for="perm in permissionRows"
          :key="perm.key"
          class="permission-row"
          :class="{ disabled: perm.required }"
        >
          <input v-model="editingPermissions[perm.key]" type="checkbox" :disabled="perm.required" />
          <span class="permission-text">
            <span class="permission-label">
              {{ perm.label }}
              <span v-if="perm.required" class="permission-required-badge">{{ t('bots.server.required') }}</span>
            </span>
            <span class="permission-description">{{ perm.description }}</span>
          </span>
        </label>
      </div>

      <template #footer>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" :disabled="updatingPerms" @click="closePermissionsModal">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="updatingPerms" @click="updatePermissions">
            {{ updatingPerms ? t('bots.server.saving') : t('bots.server.save') }}
          </button>
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useToast } from 'vue-toastification'
import { formatDistanceToNow } from 'date-fns'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { useProfileStore } from '@/stores/useProfile'
import {
  ENFORCED_BOT_PERMISSIONS,
  REQUIRED_BOT_PERMISSIONS,
  botSearchFilter,
  defaultBotPermissions,
  enforcedPermissionsFrom,
  isBotOnline,
  type BotPresenceRow,
  type EnforcedBotPermission,
} from '@/utils/botUtils'
import BaseModal from '@/components/common/BaseModal.vue'
import BotAvatar from '@/components/common/BotAvatar.vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

interface Props {
  serverId: string
}

interface BotSummary {
  id: string
  username: string
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  bot_type: string | null
  is_public: boolean | null
}

interface Installation extends Partial<Record<EnforcedBotPermission, boolean>> {
  id: string
  bot_id: string
  installed_at: string
  bot: BotSummary
}

const props = defineProps<Props>()
const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const profileStore = useProfileStore()

const BOT_COLUMNS = 'id, username, display_name, bio, avatar_url, bot_type, is_public'
const PAGE_SIZE = 24
const SEARCH_DEBOUNCE_MS = 250

const permissionRows = computed(() =>
  ENFORCED_BOT_PERMISSIONS.map(key => ({
    key,
    label: t(`bots.permissions.${key}.label`),
    description: t(`bots.permissions.${key}.description`),
    required: REQUIRED_BOT_PERMISSIONS.has(key),
  })),
)

function botName(bot: Pick<BotSummary, 'display_name' | 'username'>): string {
  return bot.display_name || bot.username
}

function relativeTime(date: string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

function hiddenBot(botId: string): BotSummary {
  return {
    id: botId,
    username: botId,
    display_name: t('bots.server.hiddenBot'),
    bio: null,
    avatar_url: null,
    bot_type: null,
    is_public: false,
  }
}

// Installed ------------------------------------------------------------------

const installedLoading = ref(true)
const installedBots = ref<Installation[]>([])
const presence = ref<Record<string, BotPresenceRow>>({})

function isInstalled(botId: string): boolean {
  return installedBots.value.some(inst => inst.bot_id === botId)
}

async function loadInstalled() {
  try {
    const { data, error } = await supabase
      .from('bot_server_permissions')
      .select(`id, bot_id, installed_at, ${ENFORCED_BOT_PERMISSIONS.join(', ')}, bot:bots(${BOT_COLUMNS})`)
      .eq('server_id', props.serverId)
      .eq('is_active', true)
      .order('installed_at', { ascending: true })
    if (error) throw error
    // A private bot owned by someone else is invisible under RLS and embeds as null.
    installedBots.value = ((data ?? []) as unknown as Array<Omit<Installation, 'bot'> & { bot: BotSummary | null }>)
      .map(inst => ({ ...inst, bot: inst.bot ?? hiddenBot(inst.bot_id) }))
    await loadPresence()
  } catch (error) {
    debug.error('Failed to load installed bots:', error)
    toast.error(t('bots.server.loadFailed'))
  } finally {
    installedLoading.value = false
  }
}

async function loadPresence() {
  const ids = installedBots.value.map(inst => inst.bot_id)
  if (ids.length === 0) {
    presence.value = {}
    return
  }
  const { data, error } = await supabase
    .from('bot_presence')
    .select('bot_id, status, last_heartbeat_at')
    .in('bot_id', ids)
  if (error) {
    debug.warn('bot_presence load failed:', error)
    return
  }
  const rows = (data ?? []) as Array<BotPresenceRow & { bot_id: string }>
  presence.value = Object.fromEntries(rows.map(r => [r.bot_id, r]))
}

// Directory ------------------------------------------------------------------

// RLS on bots returns public bots plus the caller's own; no visibility filter is needed here.
const availableBots = ref<BotSummary[]>([])
const directoryLoading = ref(false)
const hasMore = ref(false)
const searchQuery = ref('')
const activeSearch = ref('')
let directoryRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function loadDirectoryPage(reset: boolean) {
  const request = ++directoryRequest
  const offset = reset ? 0 : availableBots.value.length
  directoryLoading.value = true
  try {
    let query = supabase
      .from('bots')
      .select(BOT_COLUMNS)
      .eq('is_active', true)
      .order('username', { ascending: true })
      .range(offset, offset + PAGE_SIZE)

    const filter = botSearchFilter(searchQuery.value)
    if (filter) query = query.or(filter)

    const { data, error } = await query
    if (error) throw error
    if (request !== directoryRequest) return

    const rows = (data ?? []) as BotSummary[]
    hasMore.value = rows.length > PAGE_SIZE
    const page = rows.slice(0, PAGE_SIZE)
    availableBots.value = reset ? page : [...availableBots.value, ...page]
    activeSearch.value = filter ? searchQuery.value.trim() : ''
  } catch (error) {
    if (request !== directoryRequest) return
    debug.error('Failed to load bot directory:', error)
    toast.error(t('bots.server.loadFailed'))
  } finally {
    if (request === directoryRequest) directoryLoading.value = false
  }
}

watch(searchQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadDirectoryPage(true), SEARCH_DEBOUNCE_MS)
})

// Add ------------------------------------------------------------------------

const selectedBot = ref<BotSummary | null>(null)
const selectedPermissions = ref<Record<EnforcedBotPermission, boolean>>(defaultBotPermissions())
const adding = ref(false)

function openAddModal(bot: BotSummary) {
  selectedPermissions.value = defaultBotPermissions(bot.bot_type)
  selectedBot.value = bot
}

function closeAddModal() {
  if (adding.value) return
  selectedBot.value = null
}

async function addBot() {
  const bot = selectedBot.value
  if (!bot || adding.value) return

  adding.value = true
  try {
    const profileId = profileStore.profileId
    if (!profileId) throw new Error('Profile not loaded')

    // Flags outside ENFORCED_BOT_PERMISSIONS take the RPC's column defaults.
    const { error } = await supabase.rpc('add_bot_to_server', {
      p_bot_id: bot.id,
      p_server_id: props.serverId,
      p_installed_by: profileId,
      p_permissions: selectedPermissions.value,
    })
    if (error) throw error

    toast.success(t('bots.server.addSuccess', { name: botName(bot) }))
    selectedBot.value = null
    await loadInstalled()
  } catch (error) {
    debug.error('Failed to add bot:', error)
    toast.error(t('bots.server.addFailed'))
  } finally {
    adding.value = false
  }
}

// Permissions ----------------------------------------------------------------

const selectedInstallation = ref<Installation | null>(null)
const editingPermissions = ref<Record<EnforcedBotPermission, boolean>>(defaultBotPermissions())
const updatingPerms = ref(false)

function openPermissionsModal(installation: Installation) {
  editingPermissions.value = enforcedPermissionsFrom(installation)
  selectedInstallation.value = installation
}

function closePermissionsModal() {
  if (updatingPerms.value) return
  selectedInstallation.value = null
}

async function updatePermissions() {
  const installation = selectedInstallation.value
  if (!installation || updatingPerms.value) return

  updatingPerms.value = true
  try {
    // RLS limits writes to the server owner and filters anyone else to zero rows.
    const { data, error } = await supabase
      .from('bot_server_permissions')
      .update(editingPermissions.value)
      .eq('id', installation.id)
      .select('id')
    if (error) throw error
    if (!data?.length) throw new Error('bot_server_permissions row was not updated')

    toast.success(t('bots.server.permissionsSaved'))
    selectedInstallation.value = null
    await loadInstalled()
  } catch (error) {
    debug.error('Failed to update permissions:', error)
    toast.error(t('bots.server.permissionsFailed'))
  } finally {
    updatingPerms.value = false
  }
}

async function removeBot(installation: Installation) {
  const name = botName(installation.bot)
  const confirmed = await confirm({
    title: t('bots.server.removeConfirmTitle', { name }),
    message: t('bots.server.removeConfirmBody'),
    confirmButtonText: t('bots.server.remove'),
    dangerAction: true,
  })
  if (!confirmed) return

  try {
    const { data, error } = await supabase
      .from('bot_server_permissions')
      .update({ is_active: false })
      .eq('id', installation.id)
      .select('id')
    if (error) throw error
    if (!data?.length) throw new Error('bot_server_permissions row was not updated')

    toast.success(t('bots.server.removeSuccess', { name }))
    await loadInstalled()
  } catch (error) {
    debug.error('Failed to remove bot:', error)
    toast.error(t('bots.server.removeFailed'))
  }
}

const route = useRoute()
const rootEl = ref<HTMLElement | null>(null)

onMounted(() => {
  if (route.hash === '#server-bots') rootEl.value?.scrollIntoView({ block: 'start' })
  loadInstalled()
  loadDirectoryPage(true)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped>
.server-bots-settings {
  margin-top: 24px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.card-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.search-field {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted, var(--text-secondary));
  pointer-events: none;
}

.search-input {
  padding: 8px 12px 8px 32px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 220px;
}

.search-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}

.bots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.bot-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background-color: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  transition: border-color 0.15s;
}

.bot-card:hover {
  border-color: var(--harmony-primary);
}

.bot-card .bot-info {
  flex: 1;
}

.bot-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bot-badges {
  display: flex;
  gap: 6px;
  align-items: center;
}

.bot-badge {
  display: inline-block;
  padding: 1px 6px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 3px;
}

.bot-badge.private {
  background: var(--background-quaternary);
  color: var(--text-secondary);
}

.bot-badge.bridge {
  background: #5865f2;
}

.bot-info h4 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.bot-info p,
.bot-bio {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.load-more {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

.bots-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bot-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background-color: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
}

.bot-item .bot-info {
  flex: 1;
  min-width: 0;
}

.install-date {
  font-size: 12px;
  color: var(--text-muted, var(--text-secondary));
  display: block;
  margin-top: 4px;
}

.bot-actions {
  display: flex;
  gap: 8px;
}

.bot-preview {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  margin-bottom: 20px;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
}

.bot-preview-text {
  flex: 1;
  min-width: 0;
}

.bot-preview-text h4 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-preview-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.permissions-section-header h4 {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.permissions-hint {
  margin: 0 0 12px 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.permissions-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.permission-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.permission-row:hover:not(.disabled) {
  background: var(--background-modifier-hover, var(--background-secondary));
}

.permission-row.disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.permission-row input[type="checkbox"] {
  margin-top: 2px;
  width: 16px;
  height: 16px;
  accent-color: var(--harmony-primary);
  flex-shrink: 0;
}

.permission-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.permission-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-required-badge {
  font-size: 10px;
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.permission-description {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 640px) {
  .card-header {
    flex-direction: column;
    align-items: stretch;
  }

  .search-input {
    min-width: 0;
    width: 100%;
  }

  .bot-item {
    flex-wrap: wrap;
  }

  .bot-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
