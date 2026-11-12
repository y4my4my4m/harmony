<template>
  <fieldset class="thread-sidebar-default" data-testid="thread-sidebar-default" :disabled="busy || !loaded">
    <legend><h3>{{ t('threadSidebar.admin.title') }}</h3></legend>
    <p class="thread-sidebar-hint">{{ t('threadSidebar.admin.hint') }}</p>
    <label v-for="option in options" :key="option" class="thread-sidebar-option">
      <input
        type="radio"
        name="thread-sidebar-default"
        :value="option"
        :checked="mode === option"
        @change="save(option)"
      >
      <span>{{ t(`threadSidebar.modes.${option}`) }}</span>
    </label>
  </fieldset>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import type { ThreadSidebarMode } from '@/utils/threadSidebar'
import {
  getInstanceThreadSidebarDefault,
  setInstanceThreadSidebarDefault,
} from '@/services/ThreadSidebarService'

const { t } = useI18n()
const toast = useToast()

const options: ThreadSidebarMode[] = ['all', 'joined']
const mode = ref<ThreadSidebarMode>('all')
const loaded = ref(false)
const busy = ref(false)

async function save(value: ThreadSidebarMode) {
  if (busy.value || value === mode.value) return
  const previous = mode.value
  mode.value = value
  busy.value = true
  try {
    await setInstanceThreadSidebarDefault(value)
  } catch (error) {
    debug.error('Failed to save the thread sidebar default:', error)
    mode.value = previous
    toast.error(t('threadSidebar.saveFailed'))
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    mode.value = await getInstanceThreadSidebarDefault()
    loaded.value = true
  } catch (error) {
    debug.warn('Thread sidebar default unavailable:', error)
  }
})
</script>

<style scoped>
.thread-sidebar-default {
  margin: 24px 0 0;
  padding: 0;
  border: none;
  min-width: 0;
}

.thread-sidebar-default legend {
  padding: 0;
}

.thread-sidebar-default h3 {
  margin: 0 0 4px;
}

.thread-sidebar-hint {
  margin: 0 0 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.thread-sidebar-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-primary);
  cursor: pointer;
}
</style>
