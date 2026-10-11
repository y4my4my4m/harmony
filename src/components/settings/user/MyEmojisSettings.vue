<template>
  <section ref="rootRef" class="my-emojis-settings" aria-labelledby="my-emojis-title" data-testid="my-emojis">
    <div class="settings-header">
      <h2 id="my-emojis-title" ref="headingRef" class="settings-title" tabindex="-1">{{ t('settings.myEmojis.title') }}</h2>
      <p class="settings-description">{{ t('settings.myEmojis.description') }}</p>
    </div>

    <div class="settings-section">
      <div v-if="loading" class="my-emojis-state" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('settings.myEmojis.loading') }}</span>
      </div>
      <div v-else-if="loadFailed" class="my-emojis-state">
        <p>{{ t('settings.myEmojis.errors.load') }}</p>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('settings.myEmojis.retry') }}</button>
      </div>
      <p v-else-if="emojis.length === 0" class="my-emojis-state">{{ t('settings.myEmojis.empty') }}</p>
      <ul v-else class="my-emojis-list" :aria-label="t('settings.myEmojis.listLabel')">
        <li v-for="emoji in emojis" :key="emoji.id" class="my-emoji-row" :data-emoji-id="emoji.id">
          <img v-if="emoji.url" class="my-emoji-img" :src="getEmojiUrl(emoji.url, 64)" alt="" loading="lazy" />
          <span v-else class="my-emoji-img" aria-hidden="true"></span>
          <div class="my-emoji-main">
            <form v-if="editingId === emoji.id" class="my-emoji-rename" @submit.prevent="saveRename(emoji)">
              <input
                ref="renameInput"
                v-model="editName"
                class="form-input my-emoji-input"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('settings.myEmojis.newName', { name: emoji.name })"
                :aria-invalid="renameError ? 'true' : undefined"
                :aria-describedby="renameError ? 'my-emoji-rename-error' : 'my-emoji-rename-hint'"
                @keydown.esc.prevent="closeRename(emoji)"
              />
              <button type="submit" class="btn btn-primary btn-sm" :disabled="busyIds.has(emoji.id)">{{ t('common.save') }}</button>
              <button type="button" class="btn btn-secondary btn-sm" @click="closeRename(emoji)">{{ t('common.cancel') }}</button>
              <p v-if="renameError" id="my-emoji-rename-error" class="my-emoji-error">{{ renameError }}</p>
              <p v-else id="my-emoji-rename-hint" class="my-emoji-hint">{{ t('settings.myEmojis.nameHint') }}</p>
            </form>
            <span v-else class="my-emoji-name">:{{ emoji.name }}:</span>
            <div class="my-emoji-meta">
              <span v-if="emoji.is_ai_generated" class="my-emoji-badge" :title="t('settings.myEmojis.aiGenerated')">
                <span aria-hidden="true">{{ t('settings.myEmojis.aiBadge') }}</span>
                <span class="sr-only">{{ t('settings.myEmojis.aiGenerated') }}</span>
              </span>
              <span>{{ t('settings.myEmojis.uses', { count: emoji.usage_count }, emoji.usage_count) }}</span>
            </div>
          </div>
          <div v-if="editingId !== emoji.id" class="my-emoji-actions">
            <IconButton
              :label="t('settings.myEmojis.rename', { name: emoji.name })"
              icon="pencil"
              :size="16"
              :disabled="busyIds.has(emoji.id)"
              data-action="rename"
              @click="startRename(emoji)"
            />
            <IconButton
              :label="t('settings.myEmojis.delete', { name: emoji.name })"
              icon="trash"
              :size="16"
              class="my-emoji-delete"
              :disabled="busyIds.has(emoji.id)"
              data-action="delete"
              @click="remove(emoji)"
            />
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import IconButton from '@/components/a11y/IconButton.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useT } from '@/composables/useT'
import { authContextService } from '@/services/AuthContextService'
import {
  MY_EMOJI_NAME,
  deleteMyEmoji,
  listMyEmojis,
  refreshPersonalEmojis,
  renameMyEmoji,
  type MyEmoji,
} from '@/services/UserEmojiService'
import { debug } from '@/utils/debug'
import { getEmojiUrl } from '@/utils/emojiUtils'

const { t } = useT()
const toast = useToast()
const { confirm } = useConfirmDialog()
const { polite, assertive } = useAnnouncer()

const emojis = ref<MyEmoji[]>([])
const loading = ref(true)
const loadFailed = ref(false)
const busyIds = ref(new Set<string>())
const editingId = ref<string | null>(null)
const editName = ref('')
const renameError = ref('')
const renameInput = ref<HTMLInputElement[] | null>(null)
const headingRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

let profileId: string | null = null

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    profileId ??= await authContextService.getCurrentProfileId()
    emojis.value = await listMyEmojis(profileId)
  } catch (err) {
    debug.error('Failed to load personal emojis:', err)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

function rowControl(id: string, action: 'rename' | 'delete'): HTMLElement | null {
  return rootRef.value?.querySelector<HTMLElement>(`.my-emoji-row[data-emoji-id="${id}"] [data-action="${action}"]`) ?? null
}

function refreshPicker() {
  if (!profileId) return
  refreshPersonalEmojis(profileId).catch((err) => debug.warn('Personal emoji refresh failed:', err))
}

function startRename(emoji: MyEmoji) {
  editingId.value = emoji.id
  editName.value = emoji.name
  renameError.value = ''
  void nextTick(() => {
    const input = renameInput.value?.[0]
    input?.focus()
    input?.select()
  })
}

function closeRename(emoji: MyEmoji) {
  editingId.value = null
  editName.value = ''
  renameError.value = ''
  void nextTick(() => rowControl(emoji.id, 'rename')?.focus())
}

function failRename(message: string) {
  renameError.value = message
  assertive(message)
  renameInput.value?.[0]?.focus()
}

async function saveRename(emoji: MyEmoji) {
  const name = editName.value.trim()
  if (name === emoji.name) return closeRename(emoji)
  if (!MY_EMOJI_NAME.test(name)) return failRename(t('settings.myEmojis.errors.invalidName'))
  busyIds.value.add(emoji.id)
  try {
    await renameMyEmoji(emoji.id, name)
    const from = emoji.name
    emoji.name = name
    closeRename(emoji)
    polite(t('settings.myEmojis.renamed', { from, to: name }))
    refreshPicker()
  } catch (err: any) {
    debug.error('Failed to rename emoji:', err)
    failRename(
      err?.code === '23505'
        ? t('settings.myEmojis.errors.nameTaken')
        : err?.code === '22023'
          ? t('settings.myEmojis.errors.invalidName')
          : t('settings.myEmojis.errors.rename'),
    )
  } finally {
    busyIds.value.delete(emoji.id)
  }
}

async function remove(emoji: MyEmoji) {
  const ok = await confirm({
    title: t('settings.myEmojis.deleteTitle'),
    message: t('settings.myEmojis.confirmDelete', { name: emoji.name }),
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  })
  if (!ok || !profileId) return
  busyIds.value.add(emoji.id)
  try {
    await deleteMyEmoji(emoji, profileId)
    const index = emojis.value.findIndex((e) => e.id === emoji.id)
    emojis.value.splice(index, 1)
    polite(t('settings.myEmojis.deleted', { name: emoji.name }))
    refreshPicker()
    await nextTick()
    const next = emojis.value[Math.min(index, emojis.value.length - 1)]
    ;(next ? rowControl(next.id, 'delete') : headingRef.value)?.focus()
  } catch (err: any) {
    debug.error('Failed to delete emoji:', err)
    toast.error(err?.code === 'P0002' ? t('settings.myEmojis.errors.notFound') : t('settings.myEmojis.errors.delete'))
  } finally {
    busyIds.value.delete(emoji.id)
  }
}

onMounted(load)
</script>

<style scoped>
.my-emojis-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
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

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.settings-section {
  margin-bottom: 32px;
  padding: 16px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.my-emojis-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.my-emojis-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.my-emoji-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-md);
  background: var(--background-primary);
}

.my-emoji-img {
  width: 40px;
  height: 40px;
  object-fit: contain;
  flex-shrink: 0;
}

.my-emoji-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.my-emoji-name {
  font-family: var(--font-mono, monospace);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.my-emoji-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.my-emoji-badge {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-link);
  font-weight: 600;
}

.my-emoji-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.my-emoji-delete:hover:not(:disabled) {
  color: var(--text-danger);
}

.my-emoji-rename {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.my-emoji-input {
  flex: 1 1 180px;
  min-width: 0;
  width: auto;
  padding: 6px 10px;
  font-family: var(--font-mono, monospace);
}

.my-emoji-hint,
.my-emoji-error {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
}

.my-emoji-hint {
  color: var(--text-tertiary);
}

.my-emoji-error {
  color: var(--text-danger);
}
</style>
