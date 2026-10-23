<template>
  <div class="server-emoji-management">
    <div class="settings-section">
      <h2 class="section-title">{{ $t('server.emoji') }}</h2>
      <p class="section-description">
        {{ permissions.canUpload ? $t('server.customEmojisDesc') : $t('server.customEmojis') }}
      </p>
    </div>

    <!-- Permission Notice for Read-Only Users; a copy's emojis are its host's, and the banner says so. -->
    <div v-if="!permissions.canUpload && !permissions.canDelete && !isCopy" class="permission-notice" data-testid="emoji-view-only">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="currentColor" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h3>{{ $t('confirmation.emojiViewOnlyAccess') }}</h3>
          <p>{{ $t('confirmation.emojiViewOnlyMessage') }}</p>
        </div>
      </div>
    </div>
  
    <div class="settings-card" v-if="permissions.canManageCrossServer">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <span :id="`${uid}-cross-label`" class="form-label">{{ $t('server.allowCrossServer') }}</span>
            <div :id="`${uid}-cross-hint`" class="form-hint">
              {{ $t('server.allowCrossServerDesc') }}
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                role="switch"
                :aria-labelledby="`${uid}-cross-label`"
                :aria-describedby="`${uid}-cross-hint`"
                :checked="allowCrossServer"
                @change="handleCrossServerToggle"
                :disabled="loading"
              />
              <span class="toggle-slider" aria-hidden="true"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <EmojiLibraryManager
      :emojis="emojis"
      :adapter="adapter"
      :max="maxEmojis"
      :texts="texts"
      :can-upload="permissions.canUpload"
      :can-rename="permissions.canRename"
      :can-delete="permissions.canDelete"
      :disabled="loading"
      @uploaded="emit('emoji-uploaded', $event)"
      @renamed="onRenamed"
      @deleted="onDeleted"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { bulkDeleteEmojis, deleteEmoji, renameEmoji, uploadEmoji } from '@/services/emojiService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useProfileStore } from '@/stores/useProfile'
import type { Emoji } from '@/types'
import EmojiLibraryManager from './EmojiLibraryManager.vue'
import type { EmojiLibraryAdapter, EmojiLibraryTexts } from './emojiLibrary'

interface EmojiPermissions {
  canUpload: boolean
  canDelete: boolean
  canRename: boolean
  canManageCrossServer: boolean
}

interface Props {
  emojis: Emoji[]
  allowCrossServer: boolean
  serverId: string
  ownerId: string
  loading: boolean
  permissions: EmojiPermissions
  /** A copy of a server hosted on another instance. */
  isCopy?: boolean
}

interface Emits {
  (e: 'update:emojis', value: Emoji[]): void
  (e: 'update:allowCrossServer', value: boolean): void
  (e: 'emoji-uploaded', emoji: Emoji): void
  (e: 'emoji-deleted', emojiId: string): void
  (e: 'emojis-bulk-deleted', emojiIds: string[]): void
}

const props = withDefaults(defineProps<Props>(), { isCopy: false })
const emit = defineEmits<Emits>()

const { t } = useI18n()
const uid = `sem-${useId()}`
const instanceSettings = useInstanceSettingsStore()
const profileStore = useProfileStore()

// instance_config max_custom_emojis_per_server; 0 is no limit.
const maxEmojis = computed(() => {
  const limit = instanceSettings.settings.maxCustomEmojisPerServer
  return limit > 0 ? limit : null
})

// The uploader is whoever uploads; ownerId stands in only before the profile loads.
const uploaderId = (): string => profileStore.profile?.id ?? props.ownerId

const adapter: EmojiLibraryAdapter<Emoji> = {
  upload: (file) => uploadEmoji(props.serverId, uploaderId(), file),
  async rename(emoji, name) {
    if (!(await renameEmoji(emoji.id, name, props.serverId))) throw new Error('rename refused')
  },
  async remove(emoji) {
    if (!(await deleteEmoji(emoji.id))) throw new Error('delete refused')
  },
  removeMany: (emojis) => bulkDeleteEmojis(emojis.map((e) => e.id)),
}

const texts = computed<EmojiLibraryTexts>(() => ({
  title: t('server.customEmojis'),
  empty: t('server.noEmojis'),
  emptyHint: props.permissions.canUpload ? t('server.addFirstEmoji') : undefined,
  confirmDelete: (name) => t('server.confirmDeleteEmoji', { name }),
}))

const handleCrossServerToggle = (event: Event) => {
  if (!props.permissions.canManageCrossServer) return
  emit('update:allowCrossServer', (event.target as HTMLInputElement).checked)
}

function onRenamed(emoji: Emoji, name: string) {
  emit('update:emojis', props.emojis.map((e) => (e.id === emoji.id ? { ...e, name } : e)))
}

function onDeleted(ids: string[]) {
  if (ids.length === 1) emit('emoji-deleted', ids[0])
  else emit('emojis-bulk-deleted', ids)
}
</script>

<style scoped>
.server-emoji-management {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.permission-notice {
  padding: 16px;
  background-color: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

.notice-text h3 {
  margin: 0 0 4px 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--warning);
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid var(--background-quaternary);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  margin-top: 4px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.setting-info {
  flex: 1;
}

.setting-control {
  flex-shrink: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--text-muted);
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: var(--text-primary);
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: var(--harmony-primary);
}

input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>