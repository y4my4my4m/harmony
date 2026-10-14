<!-- Asks for a folder or file name. -->
<template>
  <UnifiedModal
    :model-value="true"
    :title="title"
    size="sm"
    :actions="[
      { key: 'cancel', label: t('common.cancel'), variant: 'secondary', handler: () => emit('close') },
      { key: 'save', label: confirm, variant: 'primary', disabled: !value.trim(), handler: save },
    ]"
    @update:model-value="(open) => !open && emit('close')"
  >
    <form class="drive-name" @submit.prevent="save">
      <label :for="inputId" class="drive-name__label">{{ label }}</label>
      <input :id="inputId" ref="input" v-model="value" class="drive-input" maxlength="255" data-testid="drive-name-input" />
    </form>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, useId } from 'vue'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import { useT } from '@/composables/useT'

const props = withDefaults(defineProps<{
  title: string
  label: string
  confirm: string
  initial?: string
  /** Selects the name without its extension. */
  selectStem?: boolean
}>(), { initial: '', selectStem: false })

const emit = defineEmits<{ close: []; save: [name: string] }>()
const { t } = useT()
const inputId = useId()
const input = ref<HTMLInputElement | null>(null)
const value = ref(props.initial)

function save(): void {
  const name = value.value.trim()
  if (name) emit('save', name)
}

onMounted(() => {
  void nextTick(() => {
    const el = input.value
    if (!el) return
    el.focus()
    const dot = props.selectStem ? value.value.lastIndexOf('.') : -1
    el.setSelectionRange(0, dot > 0 ? dot : value.value.length)
  })
})
</script>

<style scoped>
.drive-name {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.drive-name__label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
</style>
