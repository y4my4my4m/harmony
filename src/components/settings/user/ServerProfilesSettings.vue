<template>
  <section class="server-profiles-settings" aria-labelledby="server-profiles-title" data-testid="server-profiles">
    <div class="settings-header">
      <h2 id="server-profiles-title" class="settings-title" tabindex="-1">{{ t('serverProfile.title') }}</h2>
      <p class="settings-description">{{ t('serverProfile.description') }}</p>
    </div>

    <p v-if="servers.length === 0" class="empty-note" data-testid="server-profiles-empty">{{ t('serverProfile.noServers') }}</p>

    <template v-else>
      <div class="form-group">
        <label class="form-label" :for="`${uid}-server`">{{ t('serverProfile.server') }}</label>
        <select :id="`${uid}-server`" v-model="selectedServerId" class="form-input" data-testid="server-picker">
          <option
            v-for="s in servers"
            :key="s.id"
            :value="s.id"
            :disabled="s.is_local_server === false"
          >
            {{ s.is_local_server === false ? `${s.name} (${t('serverProfile.remoteUnavailable')})` : s.name }}
          </option>
        </select>
      </div>

      <div
        v-if="selectedServerId && loading"
        class="profile-layout profile-skeleton"
        aria-busy="true"
        data-testid="server-profile-loading"
      >
        <span class="sr-only" role="status">{{ t('common.loading') }}</span>
        <div class="profile-form" aria-hidden="true">
          <div v-for="n in 5" :key="n" class="form-group">
            <div class="skeleton skeleton-label"></div>
            <div class="skeleton skeleton-input" :class="{ tall: n === 3 }"></div>
          </div>
          <div class="skeleton skeleton-button"></div>
        </div>
        <div class="profile-preview" aria-hidden="true">
          <div class="skeleton skeleton-label"></div>
          <div class="skeleton skeleton-card"></div>
        </div>
      </div>

      <template v-else>
        <p v-if="locked" class="locked-note" role="status" data-testid="server-profile-locked">{{ t('serverProfile.locked') }}</p>

      <div v-if="selectedServerId" class="profile-layout">
        <form class="profile-form" @submit.prevent="save">
          <div class="form-group">
            <label class="form-label" :for="`${uid}-nickname`">{{ t('serverProfile.nickname') }}</label>
            <div class="field-row">
              <input
                :id="`${uid}-nickname`"
                v-model="draft.nickname"
                type="text"
                class="form-input"
                maxlength="64"
                :placeholder="accountName"
                :disabled="locked"
                data-testid="field-nickname"
              />
              <button type="button" class="btn btn-secondary btn-sm" :disabled="locked || !hasStored('nickname')" data-testid="reset-nickname" :aria-label="t('serverProfile.resetField', { field: t('serverProfile.nickname') })" @click="reset('nickname')">
                {{ t('serverProfile.reset') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" :for="`${uid}-pronouns`">{{ t('serverProfile.pronouns') }}</label>
            <div class="field-row">
              <input
                :id="`${uid}-pronouns`"
                v-model="draft.pronouns"
                type="text"
                class="form-input"
                maxlength="40"
                :placeholder="accountPronouns || t('serverProfile.pronounsPlaceholder')"
                :disabled="locked"
                data-testid="field-pronouns"
              />
              <button type="button" class="btn btn-secondary btn-sm" :disabled="locked || !hasStored('pronouns')" data-testid="reset-pronouns" :aria-label="t('serverProfile.resetField', { field: t('serverProfile.pronouns') })" @click="reset('pronouns')">
                {{ t('serverProfile.reset') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" :for="`${uid}-bio`">{{ t('serverProfile.bio') }}</label>
            <div class="field-row">
              <textarea
                :id="`${uid}-bio`"
                v-model="draft.bio"
                class="form-input"
                rows="3"
                maxlength="500"
                :placeholder="accountBio || t('serverProfile.bioPlaceholder')"
                :disabled="locked"
                data-testid="field-bio"
              ></textarea>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="locked || !hasStored('bio')" data-testid="reset-bio" :aria-label="t('serverProfile.resetField', { field: t('serverProfile.bio') })" @click="reset('bio')">
                {{ t('serverProfile.reset') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <span class="form-label" :id="`${uid}-avatar-label`">{{ t('serverProfile.avatar') }}</span>
            <div class="field-row">
              <input
                type="file"
                accept="image/*"
                class="form-input"
                :aria-labelledby="`${uid}-avatar-label`"
                :disabled="locked || uploading"
                data-testid="field-avatar"
                @change="onUpload('avatar_url', $event)"
              />
              <button type="button" class="btn btn-secondary btn-sm" :disabled="locked || !hasStored('avatar_url')" data-testid="reset-avatar_url" :aria-label="t('serverProfile.resetField', { field: t('serverProfile.avatar') })" @click="reset('avatar_url')">
                {{ t('serverProfile.reset') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <span class="form-label" :id="`${uid}-banner-label`">{{ t('serverProfile.banner') }}</span>
            <div class="field-row">
              <input
                type="file"
                accept="image/*"
                class="form-input"
                :aria-labelledby="`${uid}-banner-label`"
                :disabled="locked || uploading"
                data-testid="field-banner"
                @change="onUpload('banner_url', $event)"
              />
              <button type="button" class="btn btn-secondary btn-sm" :disabled="locked || !hasStored('banner_url')" data-testid="reset-banner_url" :aria-label="t('serverProfile.resetField', { field: t('serverProfile.banner') })" @click="reset('banner_url')">
                {{ t('serverProfile.reset') }}
              </button>
            </div>
          </div>

          <button type="submit" class="btn btn-primary" :disabled="locked || saving || changedKeys.length === 0" data-testid="save-server-profile">
            {{ t('serverProfile.save') }}
          </button>
        </form>

        <div v-if="previewUser" class="profile-preview" data-testid="server-profile-preview">
          <h3 class="preview-title">{{ t('serverProfile.preview') }}</h3>
          <UnifiedProfileCard
            :user="previewUser"
            :server-id="selectedServerId"
            :server-profile="previewProfile"
            :is-interactive="false"
            :show-actions="false"
            :has-stats="false"
          />
        </div>
      </div>
      <section v-if="discordSyncShown" class="discord-sync" data-testid="discord-sync">
        <h3 class="discord-sync-title">{{ t('discordMigration.sync.title') }}</h3>
        <p class="discord-sync-lead">{{ t('discordMigration.sync.settingsLead') }}</p>
        <DiscordSyncFields v-model="discordSync" :disabled="discordSyncing" />
        <p v-if="discordSyncError" class="discord-sync-lead" role="alert" data-testid="discord-sync-error">{{ discordSyncError }}</p>
        <p v-else-if="discordSynced" class="discord-sync-lead" role="status" data-testid="discord-sync-done">{{ t('discordMigration.sync.done') }}</p>
        <div class="discord-sync-actions">
          <button type="button" class="btn btn-primary btn-sm" :disabled="discordSyncing" data-testid="discord-sync-save" @click="saveDiscordSync">
            {{ discordSyncing ? t('discordMigration.sync.syncing') : t('discordMigration.sync.saveAndSync') }}
          </button>
        </div>
      </section>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useToast } from 'vue-toastification'
import UnifiedProfileCard from '@/components/common/UnifiedProfileCard.vue'
import DiscordSyncFields from '@/components/settings/user/DiscordSyncFields.vue'
import { getMemberServerProfile } from '@/composables/useMemberProfile'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useUserData } from '@/composables/useUserData'
import { profileService } from '@/services/ProfileService'
import { Permission } from '@/services/RoleService'
import { initialSyncFields } from '@/components/settings/user/discordSyncFieldList'
import { myLink, setMySync, type SyncField } from '@/services/discordMigrationService'
import { loadMyServerProfile, setMyServerProfile, type ServerProfileFields } from '@/services/serverProfileService'
import { userDataService } from '@/services/userDataService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { debug } from '@/utils/debug'
import type { User } from '@/types'

type FieldKey = 'nickname' | 'avatar_url' | 'banner_url' | 'bio' | 'pronouns'
type TextKey = 'nickname' | 'bio' | 'pronouns'
const TEXT_KEYS: TextKey[] = ['nickname', 'bio', 'pronouns']

const { t } = useI18n()
const route = useRoute()
const toast = useToast()
const uid = `server-profile-${useId()}`
const serverChannelStore = useServerChannelStore()
const { getCurrentUser, getUserPronouns } = useUserData()
const { hasPermissionAsync } = useServerPermissions()

/** Joined servers; those hosted elsewhere are listed but cannot be picked. */
const servers = computed(() => serverChannelStore.servers)

const queryServer = computed(() => {
  const q = route.query.server
  return Array.isArray(q) ? q[0] : q
})

function initialServerId(): string {
  const list = servers.value
  const wanted = list.find(s => s.id === queryServer.value && s.is_local_server !== false)
  return (wanted ?? list.find(s => s.is_local_server !== false))?.id ?? ''
}

const selectedServerId = ref(initialServerId())
// The servers list can arrive after mount.
watch([servers, queryServer], () => {
  const current = servers.value.find(s => s.id === selectedServerId.value)
  if (!current || current.is_local_server === false) selectedServerId.value = initialServerId()
  else if (queryServer.value && queryServer.value !== selectedServerId.value
    && servers.value.some(s => s.id === queryServer.value && s.is_local_server !== false)) {
    selectedServerId.value = queryServer.value
  }
})

const me = computed(() => getCurrentUser.value)
const userId = computed(() => me.value?.id ?? '')

// Tri-state permission check plus the stored-profile load, per selected server.
const permState = ref<'loading' | 'allowed' | 'denied'>('loading')
const profileLoaded = ref(false)
const loading = computed(() => permState.value === 'loading' || !profileLoaded.value)
const locked = computed(() => !selectedServerId.value || permState.value !== 'allowed')

const stored = computed(() => (userId.value && selectedServerId.value
  ? getMemberServerProfile(userId.value, selectedServerId.value).value
  : null))
const hasStored = (key: FieldKey) => !!(stored.value?.[key] ?? '').trim()

// Account values stand in as placeholders.
const accountName = computed(() => me.value?.displayName || me.value?.username || '')
const accountBio = computed(() => me.value?.bio || '')
const accountPronouns = computed(() => (userId.value ? getUserPronouns(userId.value).value : null) || '')

const draft = reactive<Record<TextKey, string>>({ nickname: '', bio: '', pronouns: '' })

const storedText = (k: TextKey) => stored.value?.[k] ?? ''

// A server switch reloads every field. Otherwise a stored change (an upload, a Reset, a
// moderator's edit arriving live) only moves fields the member has not edited, so unsaved
// text survives.
watch(selectedServerId, () => {
  for (const k of TEXT_KEYS) draft[k] = storedText(k)
}, { immediate: true })
watch(
  () => TEXT_KEYS.map(storedText),
  (now, before) => {
    TEXT_KEYS.forEach((k, i) => {
      if (draft[k].trim() === (before?.[i] ?? '').trim()) draft[k] = now[i]
    })
  },
)

watch(
  () => [selectedServerId.value, userId.value] as const,
  async ([serverId, id]) => {
    permState.value = 'loading'
    profileLoaded.value = false
    if (!serverId || !id) return
    const current = () => selectedServerId.value === serverId && userId.value === id
    const perm: Promise<'allowed' | 'denied'> = hasPermissionAsync(serverId, id, Permission.CHANGE_NICKNAME)
      .then(ok => (ok ? 'allowed' : 'denied'))
      .catch((error) => {
        debug.warn('Checking nickname permission failed:', error)
        return 'denied'
      })
    const profile = loadMyServerProfile(serverId, id).catch((error) => {
      debug.warn('Loading own server profile failed:', error)
    })
    const [state] = await Promise.all([perm, profile])
    if (!current()) return
    permState.value = state
    profileLoaded.value = true
  },
  { immediate: true },
)

/** Text keys whose trimmed draft differs from the stored value. */
const changedKeys = computed(() => TEXT_KEYS.filter(k => draft[k].trim() !== (stored.value?.[k] ?? '').trim()))

const saving = ref(false)
const uploading = ref(false)

function applyLocal(serverId: string, fields: ServerProfileFields) {
  userDataService.setMemberServerProfile(serverId, userId.value, fields)
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message
  return message || t('serverProfile.saveFailed')
}

async function write(fields: ServerProfileFields): Promise<boolean> {
  const serverId = selectedServerId.value
  try {
    await setMyServerProfile(serverId, fields)
    applyLocal(serverId, fields)
    return true
  } catch (error) {
    debug.error('Saving server profile failed:', error)
    toast.error(errorMessage(error))
    return false
  }
}

async function save() {
  if (locked.value || saving.value || changedKeys.value.length === 0) return
  const fields: ServerProfileFields = {}
  for (const k of changedKeys.value) fields[k] = draft[k].trim() || null
  saving.value = true
  try {
    if (await write(fields)) toast.success(t('serverProfile.saved'))
  } finally {
    saving.value = false
  }
}

async function reset(key: FieldKey) {
  if (locked.value) return
  if (await write({ [key]: null })) toast.success(t('serverProfile.saved'))
}

async function onUpload(key: 'avatar_url' | 'banner_url', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || locked.value) return
  uploading.value = true
  try {
    const serverId = selectedServerId.value
    const result = key === 'avatar_url'
      ? await profileService.uploadServerAvatar(serverId, file)
      : await profileService.uploadServerBanner(serverId, file)
    if (!result.success || !result.url) {
      toast.error(result.error || t('serverProfile.uploadFailed'))
      return
    }
    if (await write({ [key]: result.url })) toast.success(t('serverProfile.saved'))
  } finally {
    uploading.value = false
  }
}

// "Sync from Discord": only for a server where the member linked a Discord account.
const discordSync = ref<SyncField[]>([])
const discordSyncShown = ref(false)
const discordSyncing = ref(false)
const discordSynced = ref(false)
const discordSyncError = ref('')
watch(selectedServerId, async (serverId) => {
  discordSyncShown.value = false
  discordSynced.value = false
  discordSyncError.value = ''
  if (!serverId) return
  const link = await myLink(serverId).catch(() => null)
  if (selectedServerId.value !== serverId) return
  discordSync.value = initialSyncFields(link)
  discordSyncShown.value = link?.status === 'active'
}, { immediate: true })

/** Saves the ticked fields and copies them now; nothing is saved by toggling alone. */
async function saveDiscordSync() {
  const serverId = selectedServerId.value
  if (!serverId || discordSyncing.value) return
  discordSyncing.value = true
  discordSyncError.value = ''
  try {
    await setMySync(serverId, discordSync.value)
    discordSynced.value = true
  } catch {
    discordSynced.value = false
    discordSyncError.value = t('discordMigration.sync.saveFailed')
  } finally {
    discordSyncing.value = false
  }
}

const previewUser = computed<User | null>(() => {
  const u = me.value
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    avatar_url: u.avatarUrl,
    banner_url: u.bannerUrl,
    bio: u.bio,
    color: u.color,
    status: u.status,
  } as User
})

const previewProfile = computed(() => ({
  nickname: draft.nickname.trim() || null,
  bio: draft.bio.trim() || null,
  pronouns: draft.pronouns.trim() || null,
  avatar_url: stored.value?.avatar_url ?? null,
  banner_url: stored.value?.banner_url ?? null,
}))
</script>

<style scoped>
.server-profiles-settings {
  max-width: 900px;
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

.settings-title:focus {
  outline: none;
}

.settings-description,
.empty-note,
.locked-note {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

.profile-layout {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}

.profile-form {
  flex: 1 1 320px;
  min-width: 0;
}

.profile-preview {
  flex: 0 1 300px;
}

.discord-sync {
  margin-top: 24px;
  max-width: 480px;
}

.discord-sync-actions {
  margin-top: 12px;
}

.discord-sync-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.discord-sync-lead {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}

.preview-title {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.skeleton {
  background-color: var(--background-modifier-hover);
  background-image: linear-gradient(90deg, transparent 0%, var(--background-modifier-hover) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
  border-radius: var(--radius-sm);
}

.skeleton-label {
  width: 90px;
  height: 12px;
  margin-bottom: 6px;
}

.skeleton-input {
  height: 36px;
  border-radius: var(--radius-md);
}

.skeleton-input.tall {
  height: 80px;
}

.skeleton-button {
  width: 80px;
  height: 36px;
  border-radius: var(--radius-md);
}

.skeleton-card {
  height: 240px;
  border-radius: var(--radius-lg);
}

@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.field-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.field-row .form-input {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
