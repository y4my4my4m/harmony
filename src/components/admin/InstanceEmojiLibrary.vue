<!-- Local instance emojis: upload, rename, delete. The picker shows them to every local user
     under the instance's name. Same library as My emojis and server emojis. -->
<template>
  <section class="admin-module instance-emoji-library" aria-labelledby="instance-emoji-library-title" data-testid="instance-emoji-library">
    <div class="module-header">
      <Icon name="emoji" :size="20" />
      <h2 id="instance-emoji-library-title">{{ t('admin.instanceEmojis.title') }}</h2>
    </div>
    <div class="library-body">
      <p class="library-description">{{ t('admin.instanceEmojis.library.description') }}</p>

      <div v-if="loading" class="library-state" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('admin.instanceEmojis.library.loading') }}</span>
      </div>
      <div v-else-if="loadFailed" class="library-state">
        <p>{{ t('admin.instanceEmojis.errors.load') }}</p>
        <button type="button" class="action-btn" @click="load">{{ t('admin.instanceEmojis.library.retry') }}</button>
      </div>
      <EmojiLibraryManager
        v-else
        :emojis="emojis"
        :adapter="adapter"
        :max="null"
        :texts="texts"
        @uploaded="onUploaded"
        @renamed="onRenamed"
        @deleted="onDeleted"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import EmojiLibraryManager from '@/components/settings/EmojiLibraryManager.vue'
import type { EmojiLibraryAdapter, EmojiLibraryTexts } from '@/components/settings/emojiLibrary'
import { useT } from '@/composables/useT'
import { adminService } from '@/services/AdminService'
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver'
import {
  deleteInstanceEmoji,
  listLocalInstanceEmojis,
  renameInstanceEmoji,
  type InstanceEmojiRow,
} from '@/services/InstanceEmojiAdminService'
import { uploadInstanceEmoji } from '@/services/instanceEmojiUpload'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { debug } from '@/utils/debug'

const emit = defineEmits<{ (e: 'changed'): void }>()

const { t } = useT()

const emojis = ref<InstanceEmojiRow[]>([])
const loading = ref(true)
const loadFailed = ref(false)

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    emojis.value = await listLocalInstanceEmojis()
  } catch (err) {
    debug.error('Failed to load local instance emojis:', err)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

/** The picker's instance group and :name: lookups refetch on next open. */
function refreshPicker() {
  invalidateEmojiResolverCache()
  useEmojiCacheStore().expirePersonalEmojis()
  emit('changed')
}

async function removeOne(emoji: InstanceEmojiRow): Promise<void> {
  await deleteInstanceEmoji(emoji.id)
  void adminService.logAdminAction({
    action: 'instance_emoji_delete',
    targetType: 'emoji',
    targetId: emoji.id,
    details: { name: emoji.name, domain: emoji.domain, url: emoji.url },
  })
}

const adapter: EmojiLibraryAdapter<InstanceEmojiRow> = {
  upload: (file, options) => uploadInstanceEmoji(file, options),
  async rename(emoji, name) {
    await renameInstanceEmoji(emoji.id, name)
    void adminService.logAdminAction({
      action: 'instance_emoji_rename',
      targetType: 'emoji',
      targetId: emoji.id,
      details: { from: emoji.name, to: name },
    })
  },
  remove: removeOne,
  async removeMany(rows) {
    const success: string[] = []
    const failed: string[] = []
    for (const emoji of rows) {
      try {
        await removeOne(emoji)
        success.push(emoji.id)
      } catch (err) {
        debug.error('Instance emoji delete failed:', err)
        failed.push(emoji.id)
      }
    }
    return { success, failed }
  },
  describeError(operation, error) {
    const code = (error as { code?: string } | null)?.code
    if (code === '42501') return t('admin.instanceEmojis.errors.notAdmin')
    if (operation === 'upload' && code === '23505') return t('admin.instanceEmojis.errors.duplicateFile')
    if (operation === 'rename' && code === '23505') return t('admin.instanceEmojis.errors.nameTaken')
    if (operation === 'rename' && code === '22023') return t('admin.instanceEmojis.errors.invalidName')
    return null
  },
}

const texts = computed<EmojiLibraryTexts>(() => ({
  title: t('admin.instanceEmojis.library.listLabel'),
  empty: t('admin.instanceEmojis.library.empty'),
  emptyHint: t('admin.instanceEmojis.library.emptyHint'),
  confirmDelete: (name) => {
    const count = emojis.value.find((e) => e.name === name)?.reaction_count ?? 0
    return count > 0
      ? t('admin.instanceEmojis.confirmDeleteInUse', { name, count }, count)
      : t('admin.instanceEmojis.confirmDelete', { name })
  },
}))

function onUploaded(emoji: InstanceEmojiRow) {
  emojis.value = [emoji, ...emojis.value]
  refreshPicker()
}

function onRenamed(emoji: InstanceEmojiRow, name: string) {
  emojis.value = emojis.value.map((e) => (e.id === emoji.id ? { ...e, name } : e))
  refreshPicker()
}

function onDeleted(ids: string[]) {
  const gone = new Set(ids)
  emojis.value = emojis.value.filter((e) => !gone.has(e.id))
  refreshPicker()
}

defineExpose({ load })

onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.library-body {
  padding: 16px 24px 24px;
}

.library-description {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.library-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 0;
  color: var(--text-secondary);
}

.library-state p {
  margin: 0;
}

@media (max-width: 640px) {
  .library-body {
    padding: 12px 12px 16px;
  }
}
</style>
