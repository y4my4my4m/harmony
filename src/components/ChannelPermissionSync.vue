<template>
  <div
    v-if="categoryName && synced !== null"
    class="permission-sync"
    :class="{ unsynced: !synced }"
    data-testid="channel-permission-sync"
    :data-synced="synced ? 'true' : 'false'"
  >
    <Icon :name="synced ? 'link' : 'alert-triangle'" :size="16" class="permission-sync-icon" aria-hidden="true" />
    <div class="permission-sync-text">
      <span class="permission-sync-title">
        {{ synced ? t('category.sync.synced', { category: categoryName }) : t('category.sync.notSynced', { category: categoryName }) }}
      </span>
      <span v-if="!synced" :id="hintId" class="permission-sync-hint">
        {{ dirty ? t('category.sync.saveFirst') : t('category.sync.notSyncedHint') }}
      </span>
    </div>
    <button
      v-if="!synced"
      type="button"
      class="permission-sync-button"
      :aria-describedby="hintId"
      :aria-disabled="dirty || syncing ? 'true' : undefined"
      data-testid="channel-permission-sync-now"
      @click="syncNow"
    >
      {{ syncing ? t('category.sync.syncing') : t('category.sync.syncNow') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { channelPermissionsSynced } from '@/services/categoryPermissions'
import { debug } from '@/utils/debug'
import { uid } from '@/utils/a11y/focus'
import type { Channel } from '@/types'

const props = defineProps<{
  channel: Channel
  /** The editor's saved state; a change re-reads the sync state. */
  savedState: unknown
  /** Unsaved edits in the editor; Sync now waits for them to be saved or reset. */
  dirty: boolean
}>()

const emit = defineEmits<{
  synced: []
}>()

const { t } = useI18n()
const toast = useToast()
const { polite } = useAnnouncer()
const serverChannelStore = useServerChannelStore()

const hintId = uid('permission-sync-hint')
const synced = ref<boolean | null>(null)
const syncing = ref(false)

const categoryName = computed(() =>
  serverChannelStore.categories.find(c => c.id === props.channel.category)?.name ?? null)

async function refresh() {
  if (!props.channel.category) {
    synced.value = null
    return
  }
  try {
    synced.value = await channelPermissionsSynced(props.channel.id)
  } catch (error) {
    debug.warn('Sync state lookup failed:', error)
    synced.value = null
  }
}

async function syncNow() {
  if (props.dirty || syncing.value || !categoryName.value) return
  syncing.value = true
  try {
    await serverChannelStore.syncChannelPermissions(props.channel.id)
    synced.value = true
    polite(t('category.sync.done', { category: categoryName.value }))
    toast.success(t('category.sync.done', { category: categoryName.value }))
    emit('synced')
  } catch (error: any) {
    debug.error('Failed to sync channel permissions:', error)
    toast.error(error?.message || t('category.sync.failed'))
  } finally {
    syncing.value = false
  }
}

watch(() => [props.channel.id, props.channel.category, props.savedState], refresh, { immediate: true, deep: true })
</script>

<style scoped>
.permission-sync {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 16px;
  border-radius: var(--radius-base);
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.permission-sync.unsynced {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}

.permission-sync-icon {
  flex-shrink: 0;
}

.permission-sync.unsynced .permission-sync-icon {
  color: var(--warning);
}

.permission-sync-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.permission-sync-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.permission-sync-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.permission-sync-button {
  flex-shrink: 0;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-base);
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.permission-sync-button[aria-disabled='true'] {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
