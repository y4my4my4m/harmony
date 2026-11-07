<template>
  <button
    v-if="handle"
    type="button"
    class="copy-handle-btn"
    :title="t('activitypub.profileA11y.copyHandle')"
    :aria-label="t('activitypub.profileA11y.copyHandleNamed', { handle })"
    data-testid="copy-handle"
    @click.stop="copy"
  >
    <Icon :name="copied ? 'check' : 'copy'" :size="size" />
  </button>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import { copyableHandle, useCopyHandle, type CopyHandleAccount } from '@/composables/useCopyHandle'

const props = withDefaults(defineProps<{
  account: CopyHandleAccount | null | undefined
  size?: number
}>(), { size: 14 })

const { t } = useI18n()
const copyHandle = useCopyHandle()
const handle = computed(() => copyableHandle(props.account))
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  if (!(await copyHandle(handle.value))) return
  copied.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1500)
}

onUnmounted(() => {
  if (timer) clearTimeout(timer)
})
</script>

<style scoped>
.copy-handle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 2px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  vertical-align: middle;
  transition: color var(--transition-fast, 0.15s), background-color var(--transition-fast, 0.15s);
}

.copy-handle-btn:hover,
.copy-handle-btn:focus-visible {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.copy-handle-btn:focus-visible {
  outline: 2px solid var(--brand-primary, #0EA5E9);
  outline-offset: 1px;
}
</style>
