<template>
  <section v-if="isLocalServer" class="thread-sidebar settings-card" :aria-labelledby="headingId" data-testid="thread-sidebar">
    <h3 :id="headingId">{{ t('threadSidebar.server.title') }}</h3>
    <p>{{ t('threadSidebar.server.hint') }}</p>
    <fieldset class="options" :disabled="busy || !state">
      <label v-for="option in options" :key="option.id" class="option">
        <input
          type="radio"
          :name="`thread-sidebar-${serverId}`"
          :value="option.id"
          :checked="selected === option.id"
          @change="save(option)"
        >
        <span>{{ option.label }}</span>
      </label>
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import type { ThreadSidebarMode } from '@/utils/threadSidebar'
import {
  getServerThreadSidebar,
  setServerThreadSidebar,
  setCached,
  type ThreadSidebarState,
} from '@/services/ThreadSidebarService'

// The setting lives on the server's home instance; a copy of a remote server has none.
const props = withDefaults(defineProps<{ serverId: string; isLocalServer?: boolean }>(), { isLocalServer: true })

const { t } = useI18n()
const toast = useToast()

const state = ref<ThreadSidebarState | null>(null)
const busy = ref(false)
// The choice shown; set before a save is sent and put back if it fails.
const selected = ref<string | null>(null)
const headingId = computed(() => `thread-sidebar-${props.serverId}`)

const options = computed(() => {
  const instanceMode = state.value?.instance_default ?? 'all'
  return [
    { id: 'all', value: 'all' as ThreadSidebarMode | null, label: t('threadSidebar.modes.all') },
    { id: 'joined', value: 'joined' as ThreadSidebarMode | null, label: t('threadSidebar.modes.joined') },
    {
      id: 'instance',
      value: null as ThreadSidebarMode | null,
      label: t('threadSidebar.modes.instance', { mode: t(`threadSidebar.modes.${instanceMode}`) }),
    },
  ]
})

async function load() {
  const serverId = props.serverId
  state.value = null
  selected.value = null
  if (!props.isLocalServer) return
  try {
    const loaded = await getServerThreadSidebar(serverId)
    if (props.serverId !== serverId) return
    state.value = loaded
    selected.value = loaded.server_value ?? 'instance'
  } catch (error) {
    debug.warn('Thread sidebar setting unavailable:', error)
  }
}

async function save(option: { id: string; value: ThreadSidebarMode | null }) {
  if (busy.value) return
  const serverId = props.serverId
  const previous = selected.value
  selected.value = option.id
  busy.value = true
  try {
    const next = await setServerThreadSidebar(serverId, option.value)
    setCached(serverId, next.mode)
    if (props.serverId !== serverId) return
    state.value = next
    selected.value = next.server_value ?? 'instance'
  } catch (error) {
    debug.error('Failed to save the thread sidebar setting:', error)
    if (props.serverId !== serverId) return
    selected.value = previous
    toast.error(t('threadSidebar.saveFailed'))
  } finally {
    busy.value = false
  }
}

watch(() => [props.serverId, props.isLocalServer], load, { immediate: true })
</script>

<style scoped>
.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-top: 16px;
}

.thread-sidebar h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.thread-sidebar p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 8px;
}

.options {
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}

.option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-primary);
  cursor: pointer;
}

@media (max-width: 768px) {
  .settings-card {
    padding: 16px;
  }
}
</style>
