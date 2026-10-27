<template>
  <section class="admin-module instance-emoji-admin" aria-labelledby="instance-emoji-browse-title">
    <div class="module-header">
      <Icon name="search" :size="20" />
      <h2 id="instance-emoji-browse-title">{{ t('admin.instanceEmojis.browseTitle') }}</h2>
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
          :placeholder="searchPlaceholder"
          :aria-label="t('admin.instanceEmojis.searchLabel')"
        />
        <select v-model="source" class="cyber-select emoji-select" :aria-label="t('admin.instanceEmojis.source.label')">
          <option value="all">{{ t('admin.instanceEmojis.source.all') }}</option>
          <option value="local">{{ t('admin.instanceEmojis.source.local') }}</option>
          <option value="remote">{{ t('admin.instanceEmojis.source.remote') }}</option>
          <option value="user">{{ t('admin.instanceEmojis.source.user') }}</option>
        </select>
        <select v-model="sort" class="cyber-select emoji-select" :aria-label="t('admin.instanceEmojis.sort.label')">
          <option value="newest">{{ t('admin.instanceEmojis.sort.newest') }}</option>
          <option value="name">{{ t('admin.instanceEmojis.sort.name') }}</option>
        </select>
      </div>

      <div v-if="loading && rows.length === 0" class="loading-state" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('admin.instanceEmojis.loading') }}</span>
      </div>
      <EmptyState
        v-else-if="rows.length === 0"
        class="empty-state"
        size="sm"
        icon="smile"
        :title="source === 'user' ? t('admin.instanceEmojis.emptyUser') : t('admin.instanceEmojis.empty')"
      />
      <ul v-else class="emoji-list" :aria-busy="loading || undefined" aria-labelledby="instance-emoji-browse-title">
        <li v-for="emoji in rows" :key="emoji.id" class="emoji-row" :class="{ renaming: editingId === emoji.id }">
          <img class="emoji-img" :src="getEmojiUrl(emoji.url)" :alt="`:${emoji.name}:`" loading="lazy" />
          <div class="emoji-main">
            <form v-if="editingId === emoji.id" class="rename-form" @submit.prevent="saveRename(emoji)">
              <input
                ref="renameInput"
                v-model="editName"
                class="cyber-input rename-input"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('admin.instanceEmojis.newName')"
                @keydown.esc="cancelRename"
              />
              <div class="rename-actions">
                <button type="submit" class="primary-btn-sm" :disabled="busy.has(emoji.id)">{{ t('common.save') }}</button>
                <button type="button" class="action-btn" @click="cancelRename">{{ t('common.cancel') }}</button>
              </div>
            </form>
            <span v-else class="emoji-name">:{{ emoji.name }}:</span>
            <div class="emoji-meta">
              <span v-if="emoji.scope === 'user'" class="badge personal">{{ t('admin.instanceEmojis.personalBadge') }}</span>
              <span v-else class="badge" :class="emoji.domain ? 'remote' : 'local'">{{ emoji.domain || t('admin.instanceEmojis.localBadge') }}</span>
              <span v-if="emoji.is_ai_generated" class="badge ai" :title="t('admin.instanceEmojis.aiGenerated')">
                <span aria-hidden="true">{{ t('admin.instanceEmojis.aiBadge') }}</span>
                <span class="sr-only">{{ t('admin.instanceEmojis.aiGenerated') }}</span>
              </span>
              <span v-if="emoji.scope === 'user'">{{ emoji.uploader_username ? t('admin.instanceEmojis.ownedBy', { user: '@' + emoji.uploader_username }) : t('admin.instanceEmojis.noOwner') }}</span>
              <span v-else-if="emoji.uploader_username">{{ t('admin.instanceEmojis.uploadedBy', { user: '@' + emoji.uploader_username }) }}</span>
              <span>{{ t('admin.instanceEmojis.reactions', { count: emoji.reaction_count }, emoji.reaction_count) }}</span>
              <span>{{ formatDate(emoji.created_at) }}</span>
            </div>
          </div>
          <div v-if="editingId !== emoji.id" class="emoji-actions">
            <button
              type="button"
              class="action-btn icon-btn"
              :disabled="busy.has(emoji.id)"
              :aria-label="`${t('admin.instanceEmojis.rename')} :${emoji.name}:`"
              :title="t('admin.instanceEmojis.rename')"
              @click="startRename(emoji)"
            >
              <Icon name="pencil" :size="15" />
            </button>
            <button
              type="button"
              class="action-btn icon-btn danger"
              :disabled="busy.has(emoji.id)"
              :aria-label="`${t('common.delete')} :${emoji.name}:`"
              :title="t('common.delete')"
              @click="remove(emoji)"
            >
              <Icon name="trash" :size="15" />
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
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import EmptyState from '@/components/common/EmptyState.vue'
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
import { getEmojiUrl } from '@/utils/emojiUtils'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

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

const searchPlaceholder = computed(() =>
  source.value === 'user' ? t('admin.instanceEmojis.searchHintUser') : t('admin.instanceEmojis.searchHint'),
)

/** Audit details naming the owner of a user-scope emoji. */
function ownerDetails(emoji: InstanceEmojiRow) {
  return { owner_id: emoji.uploader, owner_username: emoji.uploader_username, is_ai_generated: emoji.is_ai_generated }
}

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
    useEmojiCacheStore().expirePersonalEmojis()
    const isUser = emoji.scope === 'user'
    void adminService.logAdminAction({
      action: isUser ? 'user_emoji_rename' : 'instance_emoji_rename',
      targetType: 'emoji',
      targetId: emoji.id,
      details: isUser ? { from: emoji.name, to: name, ...ownerDetails(emoji) } : { from: emoji.name, to: name },
    })
    emoji.name = name
    cancelRename()
    toast.success(t('admin.instanceEmojis.renamed'))
  } catch (err: any) {
    const taken = emoji.scope === 'user' ? t('admin.instanceEmojis.errors.nameTakenUser') : t('admin.instanceEmojis.errors.nameTaken')
    toast.error(err?.code === '23505' ? taken : err?.message || t('admin.instanceEmojis.errors.rename'))
  } finally {
    busy.value.delete(emoji.id)
  }
}

async function remove(emoji: InstanceEmojiRow) {
  const isUser = emoji.scope === 'user'
  const owner = emoji.uploader_username ? '@' + emoji.uploader_username : t('admin.instanceEmojis.noOwner')
  const message = isUser
    ? emoji.reaction_count > 0
      ? t('admin.instanceEmojis.confirmDeleteUserInUse', { name: emoji.name, user: owner, count: emoji.reaction_count }, emoji.reaction_count)
      : t('admin.instanceEmojis.confirmDeleteUser', { name: emoji.name, user: owner })
    : emoji.reaction_count > 0
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
    useEmojiCacheStore().expirePersonalEmojis()
    void adminService.logAdminAction({
      action: isUser ? 'user_emoji_delete' : 'instance_emoji_delete',
      targetType: 'emoji',
      targetId: emoji.id,
      details: isUser
        ? { name: emoji.name, url: emoji.url, ...ownerDetails(emoji) }
        : { name: emoji.name, domain: emoji.domain, url: emoji.url },
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
.module-body {
  padding: 16px 24px 24px;
}

.module-hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.emoji-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.emoji-filters .cyber-input,
.emoji-filters .cyber-select {
  padding: 8px 12px;
}

.emoji-search {
  flex: 1 1 240px;
  min-width: 0;
}

.emoji-filters .emoji-select {
  flex: 0 1 auto;
  width: auto;
  min-width: 140px;
}

.emoji-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

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

.emoji-row.renaming {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.emoji-img {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  object-fit: contain;
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
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.badge {
  max-width: 100%;
  overflow: hidden;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge.local,
.badge.ai {
  color: var(--text-link);
}

.badge.ai {
  font-weight: 600;
}

.emoji-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
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

.emoji-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.page-info {
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .emoji-list {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .module-body {
    padding: 12px 12px 16px;
  }

  .emoji-filters .emoji-select {
    flex: 1 1 140px;
  }
}
</style>
