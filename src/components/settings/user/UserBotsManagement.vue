<template>
  <div class="user-bots-management">
    <div class="settings-header">
      <h2 class="settings-title">{{ t('settings.myBots') }}</h2>
      <p class="settings-description">{{ t('bots.pageDescription') }}</p>
    </div>

    <!-- Bot page -->
    <template v-if="detailBot">
      <button type="button" class="back-link" @click="closeDetail">
        <Icon name="arrow-left" :size="16" />
        <span>{{ t('bots.back') }}</span>
      </button>

      <header class="bot-hero">
        <BotAvatar :bot="detailBot" :size="64" :show-status="true" :online="isOnline(detailBot.id)" />
        <div class="bot-hero-text">
          <div class="bot-title">
            <h3>{{ botName(detailBot) }}</h3>
            <span class="bot-badge">{{ t('bots.badge.bot') }}</span>
            <span v-if="detailBot.bot_type === 'bridge'" class="bot-badge bridge">{{ t('bots.badge.bridge') }}</span>
            <span v-if="detailBot.is_public === false" class="bot-badge muted">{{ t('bots.badge.private') }}</span>
          </div>
          <p class="bot-subtitle">
            <span class="bot-handle">@{{ detailBot.username }}</span>
            <span class="status-text" :class="{ online: isOnline(detailBot.id) }">
              {{ isOnline(detailBot.id) ? t('bots.status.online') : t('bots.status.offline') }}
            </span>
          </p>
        </div>
      </header>

      <!-- General information -->
      <section class="settings-section">
        <h3 class="section-title">{{ t('bots.general.title') }}</h3>
        <p class="section-description">{{ t('bots.general.description') }}</p>

        <div class="form-group">
          <label>{{ t('bots.fields.avatar') }}</label>
          <div class="avatar-row">
            <BotAvatar :bot="editAvatarPreview" :size="72" />
            <div class="avatar-actions">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="uploadingAvatar"
                @click="botAvatarInput?.click()"
              >
                <Icon name="upload" :size="14" />
                {{ uploadingAvatar ? t('bots.fields.uploading') : t('bots.fields.changeAvatar') }}
              </button>
              <button
                v-if="editForm.avatar_url"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="uploadingAvatar"
                @click="editForm.avatar_url = null"
              >
                {{ t('bots.fields.removeAvatar') }}
              </button>
              <input
                ref="botAvatarInput"
                type="file"
                accept="image/png, image/jpeg, image/webp, image/gif"
                class="visually-hidden"
                @change="handleBotAvatarUpload"
              />
            </div>
          </div>
          <span class="hint">{{ t('bots.fields.avatarHint') }}</span>
        </div>

        <div class="form-group">
          <label for="bot-edit-username">{{ t('bots.fields.username') }}</label>
          <input id="bot-edit-username" :value="detailBot.username" type="text" disabled />
          <span class="hint">{{ t('bots.fields.usernameLocked') }}</span>
        </div>

        <div class="form-group">
          <label for="bot-edit-display-name">{{ t('bots.fields.displayName') }}</label>
          <input
            id="bot-edit-display-name"
            v-model="editForm.display_name"
            type="text"
            :placeholder="detailBot.username"
            maxlength="100"
          />
        </div>

        <div class="form-group">
          <label for="bot-edit-description">{{ t('bots.fields.description') }}</label>
          <textarea
            id="bot-edit-description"
            v-model="editForm.bio"
            :placeholder="t('bots.fields.descriptionPlaceholder')"
            rows="3"
            maxlength="500"
          ></textarea>
          <span class="hint counter">{{ editForm.bio.length }} / 500</span>
        </div>

        <fieldset class="form-group">
          <legend>{{ t('bots.fields.type') }}</legend>
          <div class="type-options">
            <label v-for="option in typeOptions" :key="option.value" class="type-option" :class="{ selected: editForm.bot_type === option.value }">
              <input v-model="editForm.bot_type" type="radio" name="bot-edit-type" :value="option.value" />
              <span class="type-option-text">
                <span class="type-option-label">{{ option.label }}</span>
                <span class="type-option-hint">{{ option.hint }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <label class="checkbox-row">
          <input v-model="editForm.is_public" type="checkbox" />
          <span>
            <span class="checkbox-label">{{ t('bots.fields.public') }}</span>
            <span class="hint">{{ t('bots.fields.publicHint') }}</span>
          </span>
        </label>

        <div class="section-actions">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!editDirty || savingEdit || uploadingAvatar"
            @click="saveEdit"
          >
            {{ savingEdit ? t('bots.general.saving') : t('bots.general.save') }}
          </button>
        </div>
      </section>

      <!-- Token -->
      <section class="settings-section">
        <h3 class="section-title">{{ t('bots.token.title') }}</h3>
        <p class="section-description">{{ t('bots.token.description') }}</p>

        <div v-if="tokenLoading" class="inline-loading">
          <LoadingSpinner :size="20" />
        </div>
        <div v-else-if="tokenMeta" class="token-summary">
          <Icon name="key" :size="18" class="token-summary-icon" />
          <div class="token-summary-text">
            <code v-if="tokenHint" class="token-hint">{{ tokenHint }}</code>
            <span v-else class="token-hint-legacy">{{ t('bots.token.legacyHint') }}</span>
            <span class="meta">
              <template v-if="tokenMeta.created_at">{{ t('bots.token.created', { time: relativeTime(tokenMeta.created_at) }) }} · </template>
              {{ tokenMeta.last_used_at ? t('bots.token.lastUsed', { time: relativeTime(tokenMeta.last_used_at) }) : t('bots.token.neverUsed') }}
            </span>
          </div>
        </div>
        <p v-else class="muted">{{ t('bots.token.none') }}</p>

        <div class="section-actions">
          <button
            type="button"
            :class="['btn', tokenMeta ? 'btn-secondary btn-outline-danger' : 'btn-primary']"
            :disabled="resettingToken || tokenLoading"
            @click="resetToken"
          >
            <Icon name="refresh-cw" :size="14" />
            {{ tokenMeta ? t('bots.token.reset') : t('bots.token.generate') }}
          </button>
        </div>
      </section>

      <!-- Connection -->
      <section class="settings-section">
        <h3 class="section-title">{{ t('bots.connection.title') }}</h3>
        <p class="section-description">{{ t('bots.connection.description') }}</p>

        <dl class="kv-list">
          <div v-for="row in connectionRows" :key="row.key" class="kv-row">
            <dt>{{ row.label }}</dt>
            <dd>
              <code>{{ row.value }}</code>
              <button
                v-if="row.copyable"
                type="button"
                class="icon-button"
                :title="t('bots.connection.copy', { label: row.label })"
                :aria-label="t('bots.connection.copy', { label: row.label })"
                @click="copyConnectionValue(row)"
              >
                <Icon :name="copiedKey === row.key ? 'check' : 'copy'" :size="16" />
              </button>
            </dd>
          </div>
        </dl>

        <a class="doc-link" :href="BOT_API_DOCS_URL" target="_blank" rel="noopener noreferrer">
          <Icon name="file" :size="16" />
          <span>{{ t('bots.connection.docs') }}</span>
          <Icon name="external-link" :size="14" />
        </a>
      </section>

      <!-- Add to server -->
      <section class="settings-section">
        <h3 class="section-title">{{ t('bots.install.title') }}</h3>
        <p class="section-description">
          {{ t('bots.install.description') }}
          <template v-if="serverCounts[detailBot.id] !== undefined">
            {{ t('bots.serverCount', serverCounts[detailBot.id]) }}.
          </template>
        </p>

        <div v-if="serversLoading" class="inline-loading">
          <LoadingSpinner :size="20" />
        </div>
        <p v-else-if="ownedServers.length === 0" class="muted">{{ t('bots.install.noServers') }}</p>
        <ul v-else class="server-list">
          <li v-for="server in ownedServers" :key="server.id" class="server-row">
            <ServerIcon :src="server.icon" size="mini" shape="rounded" :show-title="false" />
            <span class="server-name">{{ server.name }}</span>
            <span v-if="installedServerIds.has(server.id)" class="installed-tag">
              <Icon name="check" :size="14" />
              {{ t('bots.install.added') }}
            </span>
            <button
              v-else
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="addingServerId !== null"
              @click="addToServer(server)"
            >
              <Icon name="plus" :size="14" />
              {{ t('bots.install.add') }}
            </button>
          </li>
        </ul>
      </section>

      <BridgeBotGuide v-if="detailBot.bot_type === 'bridge'" class="bridge-guide" />

      <!-- Delete -->
      <section class="settings-section danger-zone">
        <div class="danger-row">
          <div>
            <h3 class="section-title">{{ t('bots.delete.title') }}</h3>
            <p class="section-description">{{ t('bots.delete.description') }}</p>
          </div>
          <button type="button" class="btn btn-danger" :disabled="deleting" @click="deleteBot(detailBot)">
            <Icon name="trash-2" :size="14" />
            {{ t('bots.delete.action') }}
          </button>
        </div>
      </section>
    </template>

    <div v-else-if="isLoading" class="loading-state">
      <LoadingSpinner :size="48" />
      <p>{{ t('bots.loading') }}</p>
    </div>

    <div v-else-if="myBots.length === 0" class="settings-section">
      <EmptyState
        icon="bot-message-square"
        :title="t('bots.empty.title')"
        :description="t('bots.empty.body')"
      >
        <template #actions>
          <button type="button" class="list-empty__button" @click="openCreateModal">
            <Icon name="plus" :size="16" />
            {{ t('bots.empty.action') }}
          </button>
        </template>
      </EmptyState>
    </div>

    <div v-else class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ t('bots.listTitle', { count: myBots.length }) }}</h3>
        <button type="button" class="btn btn-primary" @click="openCreateModal">
          <Icon name="plus" :size="16" />
          {{ t('bots.newBot') }}
        </button>
      </div>

      <ul class="bots-list">
        <li v-for="bot in myBots" :key="bot.id">
          <button type="button" class="bot-row" @click="openDetail(bot)">
            <BotAvatar :bot="bot" :size="44" :show-status="true" :online="isOnline(bot.id)" />
            <span class="bot-row-main">
              <span class="bot-title">
                <span class="bot-name">{{ botName(bot) }}</span>
                <span v-if="bot.is_verified" class="verified" :title="t('bots.badge.verified')">
                  <Icon name="check-circle" :size="14" />
                </span>
                <span v-if="bot.bot_type === 'bridge'" class="bot-badge bridge">{{ t('bots.badge.bridge') }}</span>
                <span v-if="bot.is_public === false" class="bot-badge muted">{{ t('bots.badge.private') }}</span>
              </span>
              <span class="bot-bio">{{ bot.bio || t('bots.noDescription') }}</span>
              <span class="bot-meta">
                <span>@{{ bot.username }}</span>
                <span v-if="serverCounts[bot.id] !== undefined">{{ t('bots.serverCount', serverCounts[bot.id]) }}</span>
                <span>
                  {{ bot.last_online_at ? t('bots.lastConnected', { time: relativeTime(bot.last_online_at) }) : t('bots.neverConnected') }}
                </span>
              </span>
            </span>
            <Icon name="chevron-right" :size="18" class="row-chevron" />
          </button>
        </li>
      </ul>
    </div>

    <BaseModal
      :show="showCreateModal"
      :title="t('bots.create.title')"
      :close-on-overlay="!creating"
      :show-close-button="!creating"
      @close="closeCreateModal"
    >
      <form class="create-form" @submit.prevent="createBot">
        <div class="form-group">
          <label for="bot-create-username">{{ t('bots.fields.username') }}</label>
          <input
            id="bot-create-username"
            :value="createForm.username"
            type="text"
            :placeholder="t('bots.fields.usernamePlaceholder')"
            :maxlength="BOT_USERNAME_MAX"
            autocomplete="off"
            spellcheck="false"
            @input="onUsernameInput"
            @blur="usernameTouched = true"
          />
          <span v-if="usernameTouched && createUsernameError" class="error">{{ createUsernameError }}</span>
          <span v-else class="hint">{{ t('bots.fields.usernameHint') }}</span>
        </div>

        <div class="form-group">
          <label for="bot-create-display-name">{{ t('bots.fields.displayName') }}</label>
          <input
            id="bot-create-display-name"
            v-model="createForm.display_name"
            type="text"
            :placeholder="t('bots.fields.displayNamePlaceholder')"
            maxlength="100"
          />
        </div>

        <div class="form-group">
          <label for="bot-create-description">{{ t('bots.fields.description') }}</label>
          <textarea
            id="bot-create-description"
            v-model="createForm.bio"
            :placeholder="t('bots.fields.descriptionPlaceholder')"
            rows="3"
            maxlength="500"
          ></textarea>
        </div>

        <fieldset class="form-group">
          <legend>{{ t('bots.fields.type') }}</legend>
          <div class="type-options">
            <label v-for="option in typeOptions" :key="option.value" class="type-option" :class="{ selected: createForm.bot_type === option.value }">
              <input v-model="createForm.bot_type" type="radio" name="bot-create-type" :value="option.value" />
              <span class="type-option-text">
                <span class="type-option-label">{{ option.label }}</span>
                <span class="type-option-hint">{{ option.hint }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <label class="checkbox-row">
          <input v-model="createForm.is_public" type="checkbox" />
          <span>
            <span class="checkbox-label">{{ t('bots.fields.public') }}</span>
            <span class="hint">{{ t('bots.fields.publicHint') }}</span>
          </span>
        </label>
      </form>

      <template #footer>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" :disabled="creating" @click="closeCreateModal">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="!canCreate" @click="createBot">
            {{ creating ? t('bots.create.creating') : t('bots.create.submit') }}
          </button>
        </div>
      </template>
    </BaseModal>

    <!-- One-time token reveal. Dismissed only through the footer button. -->
    <BaseModal
      :show="revealedToken !== null"
      :title="t('bots.token.revealTitle')"
      :show-close-button="false"
      :close-on-overlay="false"
      @close="ignoreClose"
    >
      <div class="token-warning" role="alert">
        <Icon name="alert-triangle" :size="18" />
        <p>{{ t('bots.token.revealWarning') }}</p>
      </div>
      <div class="token-reveal">
        <code ref="tokenCodeEl" class="token-value">{{ revealedToken }}</code>
        <button type="button" class="btn btn-secondary" @click="copyRevealedToken">
          <Icon :name="tokenCopied ? 'check' : 'copy'" :size="16" />
          {{ tokenCopied ? t('common.copied') : t('common.copy') }}
        </button>
      </div>

      <template #footer>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" @click="dismissTokenReveal">
            {{ t('bots.token.done') }}
          </button>
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { formatDistanceToNow } from 'date-fns'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'
import { getStoredInstance } from '@/services/instanceConfig'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import {
  BOT_API_DOCS_URL,
  BOT_USERNAME_MAX,
  botUsernameError,
  buildBotEndpoints,
  defaultBotPermissions,
  formatTokenHint,
  isBotOnline,
  type BotPresenceRow,
} from '@/utils/botUtils'
import BaseModal from '@/components/common/BaseModal.vue'
import BotAvatar from '@/components/common/BotAvatar.vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import BridgeBotGuide from '@/components/settings/BridgeBotGuide.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

defineProps<{ loading: boolean }>()

type BotType = 'bot' | 'bridge'

interface BotRow {
  id: string
  username: string
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  bot_type: string | null
  is_public: boolean | null
  is_verified: boolean | null
  created_at: string
  last_online_at: string | null
}

interface TokenMeta {
  token_prefix: string | null
  created_at: string | null
  last_used_at: string | null
}

interface OwnedServer {
  id: string
  name: string
  icon: string | null
}

interface ConnectionRow {
  key: string
  label: string
  value: string
  copyable: boolean
}

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const BOT_COLUMNS = 'id, username, display_name, bio, avatar_url, bot_type, is_public, is_verified, created_at, last_online_at'
const PRESENCE_REFRESH_MS = 30_000
const AVATAR_MAX_BYTES = 4 * 1024 * 1024

const typeOptions = computed(() => [
  { value: 'bot' as BotType, label: t('bots.type.bot'), hint: t('bots.type.botHint') },
  { value: 'bridge' as BotType, label: t('bots.type.bridge'), hint: t('bots.type.bridgeHint') },
])

function botName(bot: Pick<BotRow, 'display_name' | 'username'>): string {
  return bot.display_name || bot.username
}

// 'integration' has no behavior of its own and renders as 'bot'.
function normalizedType(bot: BotRow): BotType {
  return bot.bot_type === 'bridge' ? 'bridge' : 'bot'
}

function relativeTime(date: string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    debug.warn('Clipboard write failed:', error)
    return false
  }
}

function selectContents(el: HTMLElement | null) {
  const selection = window.getSelection()
  if (!el || !selection) return
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

// List -----------------------------------------------------------------------

const isLoading = ref(false)
const myBots = ref<BotRow[]>([])
const serverCounts = ref<Record<string, number>>({})
const presence = ref<Record<string, BotPresenceRow>>({})
let presenceTimer: ReturnType<typeof setInterval> | null = null

function isOnline(botId: string): boolean {
  return isBotOnline(presence.value[botId])
}

async function loadMyBots() {
  isLoading.value = true
  try {
    const profileId = await authContextService.getCurrentProfileId()
    const { data, error } = await supabase
      .from('bots')
      .select(BOT_COLUMNS)
      .eq('owner_id', profileId)
      .order('created_at', { ascending: false })
    if (error) throw error
    myBots.value = (data ?? []) as BotRow[]
    await Promise.all([loadServerCounts(), loadPresence()])
  } catch (error) {
    debug.error('Failed to load bots:', error)
    toast.error(t('bots.loadFailed'))
  } finally {
    isLoading.value = false
  }
}

async function loadServerCounts() {
  const { data, error } = await supabase.rpc('get_owned_bot_server_counts')
  if (error) {
    debug.warn('get_owned_bot_server_counts failed:', error)
    return
  }
  const rows = (data ?? []) as Array<{ bot_id: string; server_count: number }>
  serverCounts.value = Object.fromEntries(rows.map(r => [r.bot_id, r.server_count]))
}

async function loadPresence() {
  const ids = myBots.value.map(b => b.id)
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

// Bot page -------------------------------------------------------------------

const detailBotId = ref<string | null>(null)
const detailBot = computed(() => myBots.value.find(b => b.id === detailBotId.value) ?? null)

const editForm = reactive({
  display_name: '',
  bio: '',
  bot_type: 'bot' as BotType,
  is_public: true,
  avatar_url: null as string | null,
})
const savingEdit = ref(false)
const uploadingAvatar = ref(false)
const deleting = ref(false)
const botAvatarInput = ref<HTMLInputElement | null>(null)

const editAvatarPreview = computed(() => ({
  username: detailBot.value?.username ?? '',
  bot_type: detailBot.value?.bot_type ?? null,
  avatar_url: editForm.avatar_url,
}))

function resetEditForm(bot: BotRow) {
  editForm.display_name = bot.display_name ?? ''
  editForm.bio = bot.bio ?? ''
  editForm.bot_type = normalizedType(bot)
  editForm.is_public = bot.is_public !== false
  editForm.avatar_url = bot.avatar_url ?? null
}

const editDirty = computed(() => {
  const bot = detailBot.value
  if (!bot) return false
  return (
    editForm.display_name !== (bot.display_name ?? '') ||
    editForm.bio !== (bot.bio ?? '') ||
    editForm.bot_type !== normalizedType(bot) ||
    editForm.is_public !== (bot.is_public !== false) ||
    editForm.avatar_url !== (bot.avatar_url ?? null)
  )
})

function openDetail(bot: BotRow) {
  detailBotId.value = bot.id
  resetEditForm(bot)
  loadTokenMeta(bot.id)
  loadInstallTargets(bot.id)
}

function closeDetail() {
  detailBotId.value = null
  tokenMeta.value = null
  ownedServers.value = []
  installedServerIds.value = new Set()
}

function replaceBot(updated: BotRow) {
  myBots.value = myBots.value.map(b => (b.id === updated.id ? updated : b))
}

async function saveEdit() {
  const bot = detailBot.value
  if (!bot || savingEdit.value) return
  savingEdit.value = true
  try {
    const patch: Record<string, unknown> = {
      display_name: editForm.display_name.trim() || null,
      bio: editForm.bio.trim() || null,
      is_public: editForm.is_public,
      avatar_url: editForm.avatar_url,
    }
    if (editForm.bot_type !== normalizedType(bot)) patch.bot_type = editForm.bot_type

    const { data, error } = await supabase
      .from('bots')
      .update(patch)
      .eq('id', bot.id)
      .select(BOT_COLUMNS)
      .single()
    if (error) throw error

    const updated = data as BotRow
    replaceBot(updated)
    resetEditForm(updated)

    // Invalidates in-memory bot row caches.
    window.dispatchEvent(new CustomEvent('bot:updated', {
      detail: {
        id: updated.id,
        display_name: updated.display_name,
        avatar_url: updated.avatar_url,
        bio: updated.bio,
      },
    }))
    toast.success(t('bots.general.saved'))
  } catch (error) {
    debug.error('Failed to update bot:', error)
    toast.error(t('bots.general.saveFailed'))
  } finally {
    savingEdit.value = false
  }
}

async function handleBotAvatarUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared so selecting the same file again fires change.
  input.value = ''
  const bot = detailBot.value
  if (!file || !bot) return

  if (file.size > AVATAR_MAX_BYTES) {
    toast.error(t('bots.avatar.tooLarge'))
    return
  }

  uploadingAvatar.value = true
  try {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `bots/${bot.id}/avatar-${Date.now()}.${ext}`
    const { error } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type })
    if (error) throw error

    const { data } = supabase.storage.from('avatars').getPublicUrl(path)
    editForm.avatar_url = data.publicUrl
    toast.info(t('bots.avatar.uploaded'))
  } catch (error) {
    debug.error('Failed to upload bot avatar:', error)
    toast.error(t('bots.avatar.failed'))
  } finally {
    uploadingAvatar.value = false
  }
}

async function deleteBot(bot: BotRow) {
  const name = botName(bot)
  const confirmed = await confirm({
    title: t('bots.delete.confirmTitle', { name }),
    message: t('bots.delete.confirmBody', { name }),
    confirmButtonText: t('bots.delete.action'),
    dangerAction: true,
  })
  if (!confirmed) return

  deleting.value = true
  try {
    // RLS filters a disallowed delete to zero rows without an error.
    const { data, error } = await supabase.from('bots').delete().eq('id', bot.id).select('id')
    if (error) throw error
    if (!data?.length) throw new Error('bot row was not deleted')

    closeDetail()
    myBots.value = myBots.value.filter(b => b.id !== bot.id)
    toast.success(t('bots.delete.success', { name }))
  } catch (error) {
    debug.error('Failed to delete bot:', error)
    toast.error(t('bots.delete.failed'))
  } finally {
    deleting.value = false
  }
}

// Token ----------------------------------------------------------------------

const tokenMeta = ref<TokenMeta | null>(null)
const tokenLoading = ref(false)
const resettingToken = ref(false)
const tokenHint = computed(() => formatTokenHint(tokenMeta.value?.token_prefix))

async function loadTokenMeta(botId: string) {
  tokenLoading.value = true
  tokenMeta.value = null
  try {
    const { data, error } = await supabase
      .from('bot_tokens')
      .select('token_prefix, created_at, last_used_at')
      .eq('bot_id', botId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (detailBotId.value === botId) tokenMeta.value = (data as TokenMeta | null) ?? null
  } catch (error) {
    debug.error('Failed to load token metadata:', error)
    toast.error(t('bots.token.loadFailed'))
  } finally {
    tokenLoading.value = false
  }
}

async function resetToken() {
  const bot = detailBot.value
  if (!bot || resettingToken.value) return

  if (tokenMeta.value) {
    const confirmed = await confirm({
      title: t('bots.token.resetConfirmTitle'),
      message: t('bots.token.resetConfirmBody'),
      confirmButtonText: t('bots.token.reset'),
      dangerAction: true,
    })
    if (!confirmed) return
  }

  resettingToken.value = true
  try {
    // Revoke and issue commit together; an error means the previous token is untouched.
    const { data, error } = await supabase.rpc('rotate_bot_token', { p_bot_id: bot.id })
    if (error) throw error
    if (typeof data?.token !== 'string' || !data.token) throw new Error('rotate_bot_token returned no token')

    tokenMeta.value = {
      token_prefix: data.token_hint ?? null,
      created_at: data.token_created_at ?? null,
      last_used_at: null,
    }
    revealToken(data.token)
  } catch (error) {
    debug.error('Failed to reset token:', error)
    toast.error(t('bots.token.resetFailed'))
  } finally {
    resettingToken.value = false
  }
}

const revealedToken = ref<string | null>(null)
const tokenCopied = ref(false)
const tokenCodeEl = ref<HTMLElement | null>(null)

function revealToken(token: string) {
  tokenCopied.value = false
  revealedToken.value = token
}

async function copyRevealedToken() {
  if (!revealedToken.value) return
  if (await writeClipboard(revealedToken.value)) {
    tokenCopied.value = true
    return
  }
  selectContents(tokenCodeEl.value)
  toast.error(t('bots.token.copyFailed'))
}

function dismissTokenReveal() {
  revealedToken.value = null
  tokenCopied.value = false
}

// BaseModal emits close on Escape regardless of closeOnOverlay.
function ignoreClose() {}

// Connection -----------------------------------------------------------------

const endpoints = computed(() => buildBotEndpoints(getStoredInstance()?.origin ?? resolveHarmonyBaseUrl()))

const connectionRows = computed<ConnectionRow[]>(() => {
  const bot = detailBot.value
  if (!bot) return []
  return [
    { key: 'id', label: t('bots.connection.botId'), value: bot.id, copyable: true },
    { key: 'gateway', label: t('bots.connection.gatewayUrl'), value: endpoints.value.gatewayUrl, copyable: true },
    { key: 'rest', label: t('bots.connection.restUrl'), value: endpoints.value.restBaseUrl, copyable: true },
    { key: 'auth', label: t('bots.connection.authHeader'), value: 'Authorization: Bot <token>', copyable: false },
  ]
})

const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyConnectionValue(row: ConnectionRow) {
  if (!(await writeClipboard(row.value))) {
    toast.error(t('bots.connection.copyFailed', { label: row.label }))
    return
  }
  copiedKey.value = row.key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedKey.value = null
  }, 2000)
}

// Add to server --------------------------------------------------------------

const ownedServers = ref<OwnedServer[]>([])
const installedServerIds = ref<Set<string>>(new Set())
const serversLoading = ref(false)
const addingServerId = ref<string | null>(null)

// add_bot_to_server admits the server owner (and instance admins); the list is owned servers.
async function loadInstallTargets(botId: string) {
  serversLoading.value = true
  try {
    const profileId = await authContextService.getCurrentProfileId()
    const { data: servers, error } = await supabase
      .from('servers')
      .select('id, name, icon')
      .eq('owner', profileId)
      .order('name')
    if (error) throw error
    const list = (servers ?? []) as OwnedServer[]

    let installed = new Set<string>()
    if (list.length > 0) {
      const { data: rows, error: permError } = await supabase
        .from('bot_server_permissions')
        .select('server_id')
        .eq('bot_id', botId)
        .eq('is_active', true)
        .in('server_id', list.map(s => s.id))
      if (permError) throw permError
      installed = new Set(((rows ?? []) as Array<{ server_id: string }>).map(r => r.server_id))
    }

    if (detailBotId.value !== botId) return
    ownedServers.value = list
    installedServerIds.value = installed
  } catch (error) {
    debug.error('Failed to load install targets:', error)
    toast.error(t('bots.install.loadFailed'))
  } finally {
    serversLoading.value = false
  }
}

async function addToServer(server: OwnedServer) {
  const bot = detailBot.value
  if (!bot || addingServerId.value) return
  addingServerId.value = server.id
  try {
    const profileId = await authContextService.getCurrentProfileId()
    const { error } = await supabase.rpc('add_bot_to_server', {
      p_bot_id: bot.id,
      p_server_id: server.id,
      p_installed_by: profileId,
      p_permissions: defaultBotPermissions(bot.bot_type),
    })
    if (error) throw error

    installedServerIds.value = new Set([...installedServerIds.value, server.id])
    toast.success(t('bots.install.success', { bot: botName(bot), server: server.name }))
    await loadServerCounts()
  } catch (error) {
    debug.error('Failed to add bot to server:', error)
    toast.error(t('bots.install.failed'))
  } finally {
    addingServerId.value = null
  }
}

// Create ---------------------------------------------------------------------

const showCreateModal = ref(false)
const creating = ref(false)
const usernameTouched = ref(false)
const createForm = reactive({
  username: '',
  display_name: '',
  bio: '',
  bot_type: 'bot' as BotType,
  is_public: true,
})

const createUsernameError = computed(() => {
  const code = botUsernameError(createForm.username)
  return code ? t(`bots.usernameErrors.${code}`) : ''
})

const canCreate = computed(() => !creating.value && botUsernameError(createForm.username) === null)

function onUsernameInput(event: Event) {
  const input = event.target as HTMLInputElement
  createForm.username = input.value.toLowerCase()
  input.value = createForm.username
}

function openCreateModal() {
  createForm.username = ''
  createForm.display_name = ''
  createForm.bio = ''
  createForm.bot_type = 'bot'
  createForm.is_public = true
  usernameTouched.value = false
  showCreateModal.value = true
}

function closeCreateModal() {
  if (creating.value) return
  showCreateModal.value = false
}

async function createBot() {
  if (!canCreate.value) {
    usernameTouched.value = true
    return
  }
  creating.value = true
  try {
    // Bot row and first token commit together.
    const { data, error } = await supabase.rpc('create_bot', {
      p_username: createForm.username,
      p_display_name: createForm.display_name.trim() || null,
      p_bio: createForm.bio.trim() || null,
      p_bot_type: createForm.bot_type,
      p_is_public: createForm.is_public,
    })
    if (error) throw error

    const bot = data?.bot as BotRow | undefined
    const token = data?.token
    if (!bot?.id || typeof token !== 'string' || !token) {
      throw new Error('create_bot returned an incomplete result')
    }

    showCreateModal.value = false
    myBots.value = [bot, ...myBots.value.filter(b => b.id !== bot.id)]
    serverCounts.value = { ...serverCounts.value, [bot.id]: 0 }
    openDetail(bot)
    revealToken(token)
    toast.success(t('bots.create.success', { name: botName(bot) }))
  } catch (error) {
    debug.error('Failed to create bot:', error)
    toast.error(t('bots.create.failed'))
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  loadMyBots()
  presenceTimer = setInterval(loadPresence, PRESENCE_REFRESH_MS)
})

onBeforeUnmount(() => {
  if (presenceTimer) clearInterval(presenceTimer)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.user-bots-management {
  max-width: 720px;
}

.settings-header {
  margin-bottom: 24px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 20px;
  padding: 20px 24px;
  background-color: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 16px 0;
  line-height: 1.5;
}

.section-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.muted {
  color: var(--text-muted, var(--text-secondary));
  font-size: 13px;
  margin: 0;
}

.loading-state,
.loading-state p {
  color: var(--text-secondary);
}

.inline-loading {
  display: flex;
  padding: 8px 0;
}

/* List */

.bots-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bot-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}

.bot-row:hover,
.bot-row:focus-visible {
  border-color: var(--harmony-primary);
  outline: none;
}

.bot-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bot-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bot-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.verified {
  display: inline-flex;
  color: var(--success);
}

.bot-bio {
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  color: var(--text-muted, var(--text-secondary));
}

.row-chevron {
  color: var(--text-muted, var(--text-secondary));
  flex-shrink: 0;
}

.bot-badge {
  padding: 1px 6px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 3px;
  flex-shrink: 0;
}

.bot-badge.bridge {
  background: #5865f2;
}

.bot-badge.muted {
  background: var(--background-quaternary);
  color: var(--text-secondary);
}

/* Bot page */

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.back-link:hover {
  color: var(--text-primary);
}

.bot-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.bot-hero-text {
  min-width: 0;
}

.bot-hero h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-subtitle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.status-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-text::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-offline, #747f8d);
}

.status-text.online::before {
  background: var(--status-online, #43b581);
}

.form-group {
  margin: 0 0 18px 0;
  padding: 0;
  border: none;
}

.form-group label,
.form-group legend {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  padding: 0;
}

.form-group input[type="text"],
.form-group textarea {
  width: 100%;
  padding: 9px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-group textarea {
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-group input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.hint {
  display: block;
  color: var(--text-muted, var(--text-secondary));
  font-size: 12px;
  margin-top: 4px;
}

.hint.counter {
  text-align: right;
}

.error {
  display: block;
  color: var(--error, #ed4245);
  font-size: 12px;
  margin-top: 4px;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.avatar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.type-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

/* Qualified to outrank `.form-group label`. */
.type-options .type-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--background-quaternary);
  border-radius: 6px;
  cursor: pointer;
  font-weight: 400;
  margin-bottom: 0;
}

.type-option.selected {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-light, color-mix(in srgb, var(--harmony-primary) 10%, transparent));
}

.type-option input {
  margin-top: 3px;
  accent-color: var(--harmony-primary);
}

.type-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.type-option-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.type-option-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary);
  line-height: 1.4;
}

.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.checkbox-row input {
  margin-top: 3px;
  accent-color: var(--harmony-primary);
}

.checkbox-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.token-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 6px;
}

.token-summary-icon {
  color: var(--text-secondary);
}

.token-summary-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.token-hint {
  font-family: var(--font-mono, 'JetBrains Mono', 'Consolas', monospace);
  font-size: 13px;
  color: var(--text-primary);
}

.token-hint-legacy {
  font-size: 13px;
  color: var(--text-primary);
}

.meta {
  font-size: 12px;
  color: var(--text-muted, var(--text-secondary));
}

.btn-outline-danger {
  color: var(--error, #ed4245);
  border-color: rgba(237, 66, 69, 0.4);
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.1);
  border-color: var(--error, #ed4245);
}

.kv-list {
  margin: 0 0 16px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kv-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  align-items: center;
  gap: 12px;
}

.kv-row dt {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.kv-row dd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
}

.kv-row code {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  font-family: var(--font-mono, 'JetBrains Mono', 'Consolas', monospace);
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-button:hover {
  color: var(--text-primary);
  background: var(--background-quaternary);
}

.doc-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--harmony-primary);
  text-decoration: none;
}

.doc-link:hover {
  text-decoration: underline;
}

.server-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.server-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--background-tertiary);
  border-radius: 6px;
}

.server-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.installed-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--success, #23a55a);
}

.bridge-guide {
  margin-bottom: 20px;
}

.danger-zone {
  border-color: rgba(237, 66, 69, 0.5);
}

.danger-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.danger-row .section-description {
  margin-bottom: 0;
}

/* Modals */

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.token-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: rgba(250, 166, 26, 0.08);
  border: 1px solid rgba(250, 166, 26, 0.35);
  border-radius: 6px;
  color: var(--status-away, #faa61a);
}

.token-warning p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.token-reveal {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.token-value {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  font-family: var(--font-mono, 'JetBrains Mono', 'Consolas', monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-all;
  user-select: all;
}

@media (max-width: 640px) {
  .type-options {
    grid-template-columns: 1fr;
  }

  .kv-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .danger-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .token-reveal {
    flex-direction: column;
  }
}
</style>
