<template>
  <div class="admin-module instance-emoji-admin">
    <div class="module-header">
      <Icon name="emoji" :size="20" />
      <h2>{{ t('admin.instanceEmojis.title') }}</h2>
      <div class="module-actions">
        <button class="action-btn" :disabled="loading" @click="load">
          <Icon :name="loading ? 'loader' : 'refresh-cw'" :size="16" :class="{ spin: loading }" />
          {{ t('admin.instanceEmojis.refresh') }}
        </button>
      </div>
    </div>
    <div class="module-body">
      <p class="module-hint">{{ t('admin.instanceEmojis.hint') }}</p>

      <div class="emoji-filters">
        <input
          v-model="search"
          type="search"
          class="cyber-input emoji-search"
          :placeholder="t('admin.instanceEmojis.searchPlaceholder')"
          :aria-label="t('admin.instanceEmojis.searchPlaceholder')"
        />
        <select v-model="source" class="cyber-select compact" :aria-label="t('admin.instanceEmojis.source.label')">
          <option value="all">{{ t('admin.instanceEmojis.source.all') }}</option>
          <option value="local">{{ t('admin.instanceEmojis.source.local') }}</option>
          <option value="remote">{{ t('admin.instanceEmojis.source.remote') }}</option>
        </select>
        <select v-model="sort" class="cyber-select compact" :aria-label="t('admin.instanceEmojis.sort.label')">
          <option value="newest">{{ t('admin.instanceEmojis.sort.newest') }}</option>
          <option value="name">{{ t('admin.instanceEmojis.sort.name') }}</option>
        </select>
      </div>

      <div v-if="loading && rows.length === 0" class="loading-state"><LoadingSpinner :size="20" /></div>
      <div v-else-if="rows.length === 0" class="empty-state">{{ t('admin.instanceEmojis.empty') }}</div>
      <ul v-else class="emoji-list">
        <li v-for="emoji in rows" :key="emoji.id" class="emoji-row">
          <img class="emoji-img" :src="emoji.url" :alt="`:${emoji.name}:`" loading="lazy" />
          <div class="emoji-main">
            <form v-if="editingId === emoji.id" class="rename-form" @submit.prevent="saveRename(emoji)">
              <input
                ref="renameInput"
                v-model="editName"
                class="cyber-input rename-input"
                maxlength="64"
                :aria-label="t('admin.instanceEmojis.newName')"
                @keydown.esc="cancelRename"
              />
              <button type="submit" class="primary-btn-sm" :disabled="busy.has(emoji.id)">{{ t('common.save') }}</button>
              <button type="button" class="action-btn" @click="cancelRename">{{ t('common.cancel') }}</button>
            </form>
            <span v-else class="emoji-name">:{{ emoji.name }}:</span>
            <div class="emoji-meta">
              <span class="badge" :class="emoji.domain ? 'remote' : 'local'">{{ emoji.domain || t('admin.instanceEmojis.localBadge') }}</span>
              <span v-if="emoji.uploader_username">{{ t('admin.instanceEmojis.uploadedBy', { user: '@' + emoji.uploader_username }) }}</span>
              <span>{{ t('admin.instanceEmojis.reactions', { count: emoji.reaction_count }, emoji.reaction_count) }}</span>
              <span>{{ formatDate(emoji.created_at) }}</span>
            </div>
          </div>
          <div v-if="editingId !== emoji.id" class="emoji-actions">
            <button class="action-btn" :disabled="busy.has(emoji.id)" @click="startRename(emoji)">
              <Icon name="pencil" :size="14" />
              {{ t('admin.instanceEmojis.rename') }}
            </button>
            <button class="action-btn danger" :disabled="busy.has(emoji.id)" @click="remove(emoji)">
              <Icon name="trash" :size="14" />
              {{ t('common.delete') }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="total > PAGE_SIZE" class="emoji-pagination">
        <button class="action-btn" :disabled="offset === 0 || loading" @click="goTo(offset - PAGE_SIZE)">{{ t('admin.instanceEmojis.previous') }}</button>
        <span class="page-info">{{ t('admin.instanceEmojis.range', { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total }) }}</span>
        <button class="action-btn" :disabled="offset + PAGE_SIZE >= total || loading" @click="goTo(offset + PAGE_SIZE)">{{ t('admin.instanceEmojis.next') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { adminService } from '@/services/AdminService'
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver'
import {
  INSTANCE_EMOJI_NAME,
  deleteInstanceEmoji,
  listInstanceEmojis,
  renameInstanceEmoji,
  type InstanceEmojiRow,
  type InstanceEmojiSort,
  type InstanceEmojiSource,
} from '@/services/InstanceEmojiAdminService'
import { debug } from '@/utils/debug'

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const rows = ref<InstanceEmojiRow[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const search = ref('')
const source = ref<InstanceEmojiSource>('all')
const sort = ref<InstanceEmojiSort>('newest')
const busy = ref(new Set<string>())
const editingId = ref<string | null>(null)
const editName = ref('')
const renameInput = ref<HTMLInputElement[] | null>(null)

let requestSeq = 0

async function load() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const page = await listInstanceEmojis({
      search: search.value,
      source: source.value,
      sort: sort.value,
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    if (seq !== requestSeq) return
    // A deletion can empty the last page; step back to the new last page.
    if (page.rows.length === 0 && offset.value > 0) {
      offset.value = Math.max(0, offset.value - PAGE_SIZE)
      return load()
    }
    rows.value = page.rows
    total.value = page.total
  } catch (err: any) {
    if (seq !== requestSeq) return
    debug.error('Failed to load instance emojis:', err)
    toast.error(err?.message || t('admin.instanceEmojis.errors.load'))
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function goTo(next: number) {
  offset.value = Math.max(0, next)
  void load()
}

function reloadFromStart() {
  offset.value = 0
  void load()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(reloadFromStart, SEARCH_DEBOUNCE_MS)
})
watch([source, sort], reloadFromStart)

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}

function startRename(emoji: InstanceEmojiRow) {
  editingId.value = emoji.id
  editName.value = emoji.name
  void nextTick(() => renameInput.value?.[0]?.focus())
}

function cancelRename() {
  editingId.value = null
  editName.value = ''
}

async function saveRename(emoji: InstanceEmojiRow) {
  const name = editName.value.trim()
  if (name === emoji.name) return cancelRename()
  if (!INSTANCE_EMOJI_NAME.test(name)) {
    toast.error(t('admin.instanceEmojis.errors.invalidName'))
    return
  }
  busy.value.add(emoji.id)
  try {
    await renameInstanceEmoji(emoji.id, name)
    invalidateEmojiResolverCache()
    void adminService.logAdminAction({
      action: 'instance_emoji_rename',
      targetType: 'emoji',
      targetId: emoji.id,
      details: { from: emoji.name, to: name },
    })
    emoji.name = name
    cancelRename()
    toast.success(t('admin.instanceEmojis.renamed'))
  } catch (err: any) {
    toast.error(err?.code === '23505' ? t('admin.instanceEmojis.errors.nameTaken') : err?.message || t('admin.instanceEmojis.errors.rename'))
  } finally {
    busy.value.delete(emoji.id)
  }
}

async function remove(emoji: InstanceEmojiRow) {
  const message = emoji.reaction_count > 0
    ? t('admin.instanceEmojis.confirmDeleteInUse', { name: emoji.name, count: emoji.reaction_count }, emoji.reaction_count)
    : t('admin.instanceEmojis.confirmDelete', { name: emoji.name })
  const ok = await confirm({
    title: t('admin.instanceEmojis.deleteTitle'),
    message,
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value.add(emoji.id)
  try {
    await deleteInstanceEmoji(emoji.id)
    invalidateEmojiResolverCache()
    void adminService.logAdminAction({
      action: 'instance_emoji_delete',
      targetType: 'emoji',
      targetId: emoji.id,
      details: { name: emoji.name, domain: emoji.domain, url: emoji.url },
    })
    toast.success(t('admin.instanceEmojis.deleted'))
    await load()
  } catch (err: any) {
    toast.error(err?.message || t('admin.instanceEmojis.errors.delete'))
  } finally {
    busy.value.delete(emoji.id)
  }
}

onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.emoji-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.emoji-search {
  flex: 1 1 220px;
  min-width: 0;
}

.emoji-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.emoji-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.emoji-img {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex-shrink: 0;
}

.emoji-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.emoji-name {
  font-family: var(--font-mono, monospace);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.emoji-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.badge {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.badge.local {
  color: var(--harmony-primary);
}

.emoji-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.action-btn.danger:hover:not(:disabled) {
  border-color: var(--error, #ef4444);
  color: var(--error, #ef4444);
}

.rename-form {
  display: flex;
  gap: 6px;
  align-items: center;
}

.rename-input {
  flex: 1;
  min-width: 0;
}

.emoji-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 12px;
}

.page-info {
  font-size: 13px;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .emoji-row {
    flex-wrap: wrap;
  }

  .emoji-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
