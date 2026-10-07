<!-- ImageEditorShell - Modal chrome for the image editors: labelled dialog, focus trap, Escape cancels, Enter confirms -->
<template>
  <Teleport to="body">
    <div class="image-editor-overlay">
      <div
        ref="dialogRef"
        class="image-editor"
        :class="{ 'image-editor--wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-busy="busy || undefined"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="image-editor-header">
          <h2 :id="titleId" class="image-editor-title">{{ title }}</h2>
          <button
            type="button"
            class="image-editor-close"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            @click="emit('cancel')"
          >
            <Icon name="x" :size="18" />
          </button>
        </header>

        <div class="image-editor-body">
          <slot />
        </div>

        <footer class="image-editor-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

interface Props {
  title: string
  busy?: boolean
  wide?: boolean
}

withDefaults(defineProps<Props>(), { busy: false, wide: false })

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const { t } = useI18n()

const titleId = `image-editor-title-${Math.random().toString(36).slice(2, 8)}`
const dialogRef = ref<HTMLElement | null>(null)

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Targets whose Enter key is their own: activation, newlines, text entry. */
const OWN_ENTER = 'button, a[href], textarea, select, [contenteditable="true"], input:not([type="range"]):not([type="radio"]):not([type="checkbox"])'

function focusables(): HTMLElement[] {
  const root = dialogRef.value
  return root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
}

function trapTab(event: KeyboardEvent) {
  const root = dialogRef.value
  const items = focusables()
  if (!root) return
  if (items.length === 0) {
    event.preventDefault()
    root.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  const inside = active instanceof Node && root.contains(active) && active !== root
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault()
    first.focus()
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    trapTab(event)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key === 'Enter' && !event.defaultPrevented && !event.isComposing) {
    const target = event.target as Element | null
    if (target?.closest?.(OWN_ENTER)) return
    event.preventDefault()
    event.stopPropagation()
    emit('confirm')
  }
}

// Focus leaving the dialog (a click on the page behind, a script) comes back.
function onFocusIn(event: FocusEvent) {
  const root = dialogRef.value
  if (root && event.target instanceof Node && !root.contains(event.target)) root.focus()
}

let returnFocusTo: HTMLElement | null = null
let previousOverflow = ''

onMounted(() => {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('focusin', onFocusIn)
  dialogRef.value?.focus()
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn)
  document.body.style.overflow = previousOverflow
  if (returnFocusTo?.isConnected) returnFocusTo.focus()
})

defineExpose({ focus: () => dialogRef.value?.focus() })
</script>

<style scoped>
/* Above the 9997-10500 overlay-modal band these editors open from; below --z-gate. */
.image-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 10800;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.image-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: calc(100dvh - 2 * var(--space-4));
  overflow: hidden;
  background: var(--background-quinary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
  outline: none;
}

.image-editor--wide {
  max-width: 640px;
}

.image-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;
}

.image-editor-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}

.image-editor-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.image-editor-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.image-editor-close:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.image-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5);
}

.image-editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--border-secondary);
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .image-editor-overlay {
    padding: var(--space-2);
  }

  .image-editor {
    max-height: calc(100dvh - 2 * var(--space-2));
  }

  .image-editor-header,
  .image-editor-body,
  .image-editor-footer {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
}

@media (prefers-reduced-motion: no-preference) {
  .image-editor {
    animation: image-editor-in 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  }
}

@keyframes image-editor-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
