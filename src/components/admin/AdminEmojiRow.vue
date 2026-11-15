<!-- One row of the admin emoji list: an emojis row of any kind, or a remote emoji not yet
     imported. Actions are emitted; the list runs them. -->
<template>
  <li
    class="emoji-row"
    :class="{ renaming: editing, removed: !!row.deleted_at, selected }"
    data-testid="admin-emoji-row"
    :data-emoji-id="row.id"
    :data-kind="row.kind"
  >
    <input
      v-if="selectable"
      type="checkbox"
      class="row-check"
      :checked="selected"
      :aria-label="t('admin.emojis.actions.select', { name: `:${row.name}:` })"
      data-action="select"
      @change="emit('toggle-select')"
    />
    <span class="emoji-img-wrap">
      <span
        v-if="broken"
        class="emoji-broken"
        role="img"
        :aria-label="`:${row.name}:`"
        :title="t('admin.emojis.brokenImage')"
        data-testid="admin-emoji-broken"
      ><Icon name="image-off" :size="24" aria-hidden="true" /></span>
      <img
        v-else
        class="emoji-img"
        :src="imageUrl"
        :alt="`:${row.name}:`"
        loading="lazy"
        @error="emit('broken')"
      />
    </span>

    <div class="emoji-main">
      <form v-if="editing" class="rename-form" @submit.prevent="emit('save-rename', editName.trim())">
        <input
          ref="renameInput"
          v-model="editName"
          class="cyber-input rename-input"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          :aria-label="t('admin.emojis.newName')"
          @keydown.esc.stop.prevent="emit('cancel-rename')"
        />
        <div class="rename-actions">
          <button type="submit" class="primary-btn-sm" :disabled="busy">{{ t('common.save') }}</button>
          <button type="button" class="action-btn" @click="emit('cancel-rename')">{{ t('common.cancel') }}</button>
        </div>
      </form>
      <span v-else class="emoji-name">:{{ row.name }}:</span>

      <div class="emoji-meta">
        <span class="badge kind" :class="`kind-${row.kind}`">{{ t(`admin.emojis.kinds.${row.kind}`) }}</span>
        <span v-if="row.hotlinked" class="badge hotlinked" :title="t('admin.emojis.hotlinkedHint')">{{ t('admin.emojis.badges.hotlinked') }}</span>
        <span v-if="row.deleted_at" class="badge removed">{{ t('admin.emojis.badges.removed') }}</span>
        <span v-if="row.name_taken" class="badge name-taken" :title="t('admin.emojis.nameTakenHint')" data-testid="admin-emoji-name-taken">{{ t('admin.emojis.badges.nameTaken') }}</span>
        <span v-if="row.kind === 'server' && row.server_name" class="meta-server">{{ t('admin.emojis.meta.server', { server: row.server_name }) }}</span>
        <span v-if="origin">{{ t('admin.emojis.meta.from', { domain: origin }) }}</span>
        <span v-if="ownerText">{{ ownerText }}</span>
        <span v-if="row.kind === 'not_imported'">{{ t('admin.emojis.meta.seen', { count: row.usage_count }, row.usage_count) }}</span>
        <template v-else>
          <span>{{ t('admin.emojis.meta.usage', { count: row.usage_count }, row.usage_count) }}</span>
          <span>{{ t('admin.emojis.meta.reactions', { count: row.reaction_count }, row.reaction_count) }}</span>
        </template>
        <span v-if="row.deleted_at">{{ removedText }}</span>
        <span v-else>{{ formatDate(row.created_at) }}</span>
        <span v-if="row.license" :title="row.license" data-testid="admin-emoji-license">{{ t('admin.emojis.meta.license', { license: row.license }) }}</span>
      </div>
    </div>

    <div v-if="!editing" class="emoji-actions">
      <template v-if="row.kind === 'not_imported'">
        <button
          type="button"
          class="action-btn"
          data-action="import"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.import', { name: `:${row.name}:` })"
          @click="emit('import')"
        >
          <Icon :name="busy ? 'loader' : 'download'" :size="15" :class="{ spin: busy }" />
          <span>{{ t('admin.emojis.titles.import') }}</span>
        </button>
      </template>
      <template v-else>
        <button
          v-if="row.hotlinked && !row.deleted_at"
          type="button"
          class="action-btn icon-btn"
          data-action="rehost"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.rehost', { name: `:${row.name}:` })"
          :title="t('admin.emojis.titles.rehost')"
          @click="emit('rehost')"
        >
          <Icon name="cloud-upload" :size="15" />
        </button>
        <button
          type="button"
          class="action-btn icon-btn"
          data-action="rename"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.rename', { name: `:${row.name}:` })"
          :title="t('admin.emojis.titles.rename')"
          @click="emit('start-rename')"
        >
          <Icon name="pencil" :size="15" />
        </button>
        <button
          v-if="row.deleted_at"
          type="button"
          class="action-btn icon-btn"
          data-action="restore"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.restore', { name: `:${row.name}:` })"
          :title="t('admin.emojis.titles.restore')"
          @click="emit('restore')"
        >
          <Icon name="rotate-ccw" :size="15" />
        </button>
        <button
          v-else
          type="button"
          class="action-btn icon-btn danger"
          data-action="remove"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.remove', { name: `:${row.name}:` })"
          :title="t('admin.emojis.titles.remove')"
          @click="emit('remove')"
        >
          <Icon name="trash" :size="15" />
        </button>
        <button
          type="button"
          class="action-btn icon-btn danger"
          data-action="purge"
          :disabled="busy"
          :aria-label="t('admin.emojis.actions.purge', { name: `:${row.name}:` })"
          :title="t('admin.emojis.titles.purge')"
          @click="emit('purge')"
        >
          <Icon name="x-circle" :size="15" />
        </button>
      </template>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import type { AdminEmojiRow } from '@/services/InstanceEmojiAdminService'
import { getEmojiUrl } from '@/utils/emojiUtils'

const props = withDefaults(defineProps<{
  row: AdminEmojiRow
  busy?: boolean
  editing?: boolean
  broken?: boolean
  selectable?: boolean
  selected?: boolean
}>(), {
  busy: false,
  editing: false,
  broken: false,
  selectable: false,
  selected: false,
})

const emit = defineEmits<{
  (e: 'start-rename'): void
  (e: 'save-rename', name: string): void
  (e: 'cancel-rename'): void
  (e: 'remove'): void
  (e: 'restore'): void
  (e: 'purge'): void
  (e: 'rehost'): void
  (e: 'import'): void
  (e: 'toggle-select'): void
  (e: 'broken'): void
}>()

const { t } = useT()

const editName = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

watch(() => props.editing, async (editing) => {
  if (!editing) return
  editName.value = props.row.name
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}, { immediate: true })

const imageUrl = computed(() => getEmojiUrl(props.row.url, 64))

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/**
 * Instance a federated, not-imported or imported emoji comes from. An import recorded before
 * source_domain existed shows the host of its image.
 */
const origin = computed(() => {
  const { row } = props
  if (row.kind === 'federated' || row.kind === 'not_imported') return row.domain
  if (row.source_domain) return row.source_domain
  if (row.kind === 'imported' || row.imported_from) return hostOf(row.imported_from) ?? row.domain
  if (row.hotlinked) return hostOf(row.url)
  return null
})

const ownerText = computed(() => {
  const { row } = props
  if (row.kind === 'not_imported' || row.kind === 'federated') return null
  if (row.kind === 'personal' || row.kind === 'ai') {
    return row.uploader_username
      ? t('admin.emojis.meta.ownedBy', { user: '@' + row.uploader_username })
      : t('admin.emojis.meta.noOwner')
  }
  return row.uploader_username ? t('admin.emojis.meta.uploadedBy', { user: '@' + row.uploader_username }) : null
})

function formatDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

const removedText = computed(() => {
  const { row } = props
  const date = formatDate(row.deleted_at)
  return row.deleted_by_username
    ? t('admin.emojis.meta.removedBy', { user: '@' + row.deleted_by_username, date })
    : t('admin.emojis.meta.removedOn', { date })
})
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.emoji-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  background-color: var(--surface-inset);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-base);
}

.emoji-row.renaming,
.emoji-row.selected {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.emoji-row.removed .emoji-img {
  opacity: 0.6;
}

.row-check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--harmony-primary);
}

.emoji-img-wrap {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
}

.emoji-img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.emoji-broken {
  color: var(--text-muted);
}

.emoji-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.emoji-name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.emoji-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.emoji-meta > span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: none;
}

.badge.kind-instance,
.badge.kind-imported,
.badge.kind-ai {
  color: var(--text-link);
}

.badge.hotlinked,
.badge.name-taken {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--text-primary);
}

.badge.removed {
  background: color-mix(in srgb, var(--error) 18%, transparent);
  color: var(--text-danger);
}

.emoji-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.emoji-actions .action-btn:not(.icon-btn) {
  padding: 4px 10px;
  font-size: 13px;
}

.icon-btn {
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-color: transparent;
  background: none;
  color: var(--text-secondary);
}

.icon-btn:hover:not(:disabled) {
  border-color: transparent;
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--text-danger);
}

.rename-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rename-input {
  min-width: 0;
  padding: 4px 8px;
  font-size: var(--font-size-sm);
}

.rename-actions {
  display: flex;
  gap: 6px;
}

.rename-actions .action-btn {
  padding: 4px 10px;
  font-size: 13px;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
