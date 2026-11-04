<template>
  <section
    class="sticker-settings"
    :class="{ 'admin-module': variant === 'module' }"
    :aria-labelledby="`${uid}-title`"
    :data-testid="`${scope}-stickers`"
  >
    <div v-if="variant === 'module'" class="module-header">
      <Icon name="sticker" :size="20" />
      <h2 :id="`${uid}-title`" tabindex="-1">{{ title }}</h2>
    </div>
    <div v-else class="settings-header">
      <h2 :id="`${uid}-title`" class="settings-title" tabindex="-1">{{ title }}</h2>
      <p class="settings-description">{{ description }}</p>
    </div>

    <div class="sticker-settings-body">
      <p v-if="variant === 'module'" class="module-description">{{ description }}</p>
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import StickerLibraryManager from '@/components/stickers/StickerLibraryManager.vue'
import type { StickerLibraryAdapter } from '@/components/stickers/stickerLibrary'
import { deleteSticker, updateSticker, uploadSticker, type StickerScope } from '@/services/stickerService'
import { useStickersStore } from '@/stores/useStickers'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useProfileStore } from '@/stores/useProfile'
import { uid as makeUid } from '@/utils/a11y/focus'
import { debug } from '@/utils/debug'

const props = withDefaults(defineProps<{
  scope: StickerScope
  /** The server of server stickers. */
  serverId?: string
  canManage: boolean
  title: string
  description: string
  /** page: a settings section (User and Server settings); module: an Admin panel card. */
  variant?: 'page' | 'module'
}>(), { serverId: undefined, variant: 'page' })

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

.settings-title:focus,
.module-header h2:focus {
  outline: none;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.sticker-settings-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.sticker-settings-state p {
  margin: 0;
}

/* Admin panel card: AdminPanel.vue .admin-module and adminShared.css .module-header. */
.sticker-settings.admin-module {
  max-width: none;
  min-width: 0;
  overflow: hidden;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.module-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.module-header h2 {
  flex: 1;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.admin-module .sticker-settings-body {
  padding: 16px 24px 24px;
}

.module-description {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .admin-module .sticker-settings-body {
    padding: 12px 12px 16px;
  }
}
</style>
