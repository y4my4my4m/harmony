<!-- Copies a user or server id; the server rail's "Copy server ID" toast pattern. -->
<template>
  <button
    type="button"
    class="copy-id-btn"
    :aria-label="label"
    :title="label"
    :data-copy-id="id"
    @click.stop="copy"
  >
    <Icon name="copy" :size="size" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { debug } from '@/utils/debug'

const props = withDefaults(defineProps<{
  id: string
  kind: 'user' | 'server'
  /** Appended to the accessible name, so rows of a list stay distinct. */
  target?: string | null
  size?: number
}>(), {
  target: null,
  size: 14,
})

const { t } = useT()
const toast = useToast()

const label = computed(() => {
  const action = t(`admin.copyId.${props.kind}`)
  return props.target ? t('admin.copyId.named', { action, target: props.target }) : action
})

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.id)
    toast.success(t(`admin.copyId.${props.kind}Copied`))
  } catch (error) {
    debug.error(`Failed to copy ${props.kind} ID:`, error)
    toast.error(t(`admin.copyId.${props.kind}Failed`))
  }
}
</script>

<style scoped>
.copy-id-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  vertical-align: middle;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.copy-id-btn:hover {
  color: var(--text-primary);
  background-color: var(--background-modifier-hover, var(--background-tertiary));
}

.copy-id-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
</style>
