<template>
  <section class="my-emojis-settings" aria-labelledby="my-emojis-title" data-testid="my-emojis">
    <div class="settings-header">
      <h2 id="my-emojis-title" class="settings-title" tabindex="-1">{{ t('settings.myEmojis.title') }}</h2>
      <p class="settings-description">{{ t('settings.myEmojis.description') }}</p>
    </div>

    <div v-if="loading" class="my-emojis-state" role="status">
      <LoadingSpinner :size="20" />
      <span class="sr-only">{{ t('settings.myEmojis.loading') }}</span>
    </div>
    <div v-else-if="loadFailed" class="my-emojis-state">
      <p>{{ t('settings.myEmojis.errors.load') }}</p>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('settings.myEmojis.retry') }}</button>
    </div>
    <EmojiLibraryManager
      v-else
      :emojis="emojis"
      :adapter="adapter"
      :max="max"
      :texts="texts"
      :can-upload="max !== 0"
      :upload-notice="t('settings.myEmojis.uploadsOff')"
      @uploaded="onUploaded"
      @renamed="onRenamed"
      @deleted="onDeleted"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import EmojiLibraryManager from '@/components/settings/EmojiLibraryManager.vue'
import type { EmojiLibraryAdapter, EmojiLibraryTexts } from '@/components/settings/emojiLibrary'
import { useT } from '@/composables/useT'
import { authContextService } from '@/services/AuthContextService'
import {
  deleteMyEmoji,
  deleteMyEmojis,
  listMyEmojis,
  refreshPersonalEmojis,
  renameMyEmoji,
  uploadMyEmoji,
  type MyEmoji,
} from '@/services/UserEmojiService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { debug } from '@/utils/debug'
import { personalEmojiLimitOf } from '@/utils/personalEmojiLimit'

const { t } = useT()
const instanceSettings = useInstanceSettingsStore()

const emojis = ref<MyEmoji[]>([])
const loading = ref(true)
const loadFailed = ref(false)

// instance_config max_personal_emojis_per_user; 0 turns personal emojis off.
const max = computed(() => instanceSettings.settings.maxPersonalEmojisPerUser)

let profileId: string | null = null

async function me(): Promise<string> {
  profileId ??= await authContextService.getCurrentProfileId()
  if (!profileId) throw new Error('No profile')
  return profileId
}

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const [rows] = await Promise.all([listMyEmojis(await me()), instanceSettings.fetchSettings(true)])
    emojis.value = rows
  } catch (err) {
    debug.error('Failed to load personal emojis:', err)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

function refreshPicker() {
  if (!profileId) return
  refreshPersonalEmojis(profileId).catch((err) => debug.warn('Personal emoji refresh failed:', err))
}

const adapter: EmojiLibraryAdapter<MyEmoji> = {
  upload: async (file) => uploadMyEmoji(await me(), file),
  rename: (emoji, name) => renameMyEmoji(emoji.id, name),
  remove: async (emoji) => deleteMyEmoji(emoji, await me()),
  removeMany: async (rows) => deleteMyEmojis(rows, await me()),
  describeError(operation, error) {
    const code = (error as { code?: string } | null)?.code
    const limit = personalEmojiLimitOf(error)
    if (limit !== null) {
      void instanceSettings.fetchSettings(true)
      return limit === 0 ? t('settings.myEmojis.uploadsOff') : t('server.maxEmojisReached', { max: limit })
    }
    if (operation === 'rename' && code === '23505') return t('settings.myEmojis.errors.nameTaken')
    if (operation === 'rename' && code === '22023') return t('settings.myEmojis.errors.invalidName')
    if (code === 'P0002') return t('settings.myEmojis.errors.notFound')
    return null
  },
}

const texts = computed<EmojiLibraryTexts>(() => ({
  title: t('settings.myEmojis.listLabel'),
  empty: t('settings.myEmojis.empty'),
  confirmDelete: (name) => t('settings.myEmojis.confirmDelete', { name }),
}))

function onUploaded(emoji: MyEmoji) {
  emojis.value = [emoji, ...emojis.value]
  refreshPicker()
}

function onRenamed(emoji: MyEmoji, name: string) {
  emojis.value = emojis.value.map((e) => (e.id === emoji.id ? { ...e, name } : e))
  refreshPicker()
}

function onDeleted(ids: string[]) {
  const gone = new Set(ids)
  emojis.value = emojis.value.filter((e) => !gone.has(e.id))
  refreshPicker()
}

onMounted(load)
</script>

<style scoped>
.my-emojis-settings {
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

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
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
</style>
