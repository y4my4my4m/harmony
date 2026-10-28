<template>
  <section class="sticker-settings" :aria-labelledby="`${uid}-title`" :data-testid="`${scope}-stickers`">
    <div class="settings-header">
      <h2 :id="`${uid}-title`" class="settings-title" tabindex="-1">{{ title }}</h2>
      <p class="settings-description">{{ description }}</p>
    </div>

    <div v-if="loading" class="sticker-settings-state" role="status">
      <LoadingSpinner :size="20" />
      <span class="sr-only">{{ t('stickers.manage.loading') }}</span>
    </div>
    <div v-else-if="loadFailed" class="sticker-settings-state">
      <p>{{ t('stickers.manage.loadFailed') }}</p>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('common.retry') }}</button>
    </div>
    <StickerLibraryManager
      v-else
      :stickers="list"
      :adapter="adapter"
      :max="max"
      :can-manage="canManage"
      :title="t('stickers.manage.listTitle')"
      :off-notice="offNotice"
      :test-id="`${scope}-sticker-library`"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import StickerLibraryManager from '@/components/stickers/StickerLibraryManager.vue'
import type { StickerLibraryAdapter } from '@/components/stickers/stickerLibrary'
import { deleteSticker, updateSticker, uploadSticker, type StickerScope } from '@/services/stickerService'
import { useStickersStore } from '@/stores/useStickers'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useProfileStore } from '@/stores/useProfile'
import { uid as makeUid } from '@/utils/a11y/focus'
import { debug } from '@/utils/debug'

const props = defineProps<{
  scope: StickerScope
  /** The server of server stickers. */
  serverId?: string
  canManage: boolean
  title: string
  description: string
}>()

const { t } = useI18n()
const stickers = useStickersStore()
const instanceSettings = useInstanceSettingsStore()
const profileStore = useProfileStore()
const uid = makeUid('sticker-settings')

const loading = ref(true)
const loadFailed = ref(false)

const profileId = computed(() => profileStore.profile?.id ?? '')
const listKey = computed(() =>
  props.scope === 'server' ? `server:${props.serverId}` : props.scope === 'user' ? `user:${profileId.value}` : 'instance')
const list = computed(() => stickers.cached(listKey.value))

const max = computed(() => {
  const s = instanceSettings.settings
  return props.scope === 'server' ? s.maxStickersPerServer : props.scope === 'instance' ? s.maxInstanceStickers : s.maxPersonalStickersPerUser
})

const offNotice = computed(() => t(`stickers.manage.off.${props.scope}`))

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    await Promise.all([
      props.scope === 'server' && props.serverId
        ? stickers.serverStickers(props.serverId, true)
        : props.scope === 'user'
        ? stickers.myStickers(profileId.value, true)
        : stickers.instanceStickers(true),
      instanceSettings.fetchSettings(true),
    ])
  } catch (error) {
    debug.warn('Sticker settings load failed:', error)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

const adapter: StickerLibraryAdapter = {
  async upload(file, name, description, onProgress) {
    try {
      const sticker = await uploadSticker({
        scope: props.scope,
        serverId: props.serverId ?? null,
        profileId: profileId.value,
        file,
        name,
        description,
        onProgress,
      })
      stickers.upsert(sticker)
      return sticker
    } catch (error) {
      // A refusal rereads the caps, which an admin can change while the page is open.
      void instanceSettings.fetchSettings(true)
      throw error
    }
  },
  async update(sticker, changes) {
    const updated = await updateSticker(sticker.id, changes)
    stickers.upsert(updated)
    return updated
  },
  async remove(sticker) {
    await deleteSticker(sticker.id)
    stickers.markRemoved(sticker.id)
  },
}

onMounted(load)
</script>

<style scoped>
.sticker-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sticker-settings-state {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
