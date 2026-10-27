<!--
  AppToolbar - a row of related controls as one Tab stop (WAI-ARIA APG toolbar
  pattern). Left/Right move between the controls, mirrored in RTL, and wrap;
  Home/End go to the first and last. The control focused last keeps the Tab stop.
  Up/Down, Enter and Escape pass through to the control and any enclosing list.

    <AppToolbar :label="t('messageA11y.actions.label')" :home-end="false">
      <button type="button" ...>...</button>
    </AppToolbar>

  `items`: selector of the controls; default every button and link. Controls of
  a menu or dialog rendered inside the toolbar are never items; aria-disabled
  controls stay focusable.
  `homeEnd` false leaves Home/End to an enclosing list (a toolbar in a message).
  Attributes (class, style, data-testid) fall through to the root.

  Controls rendered by a child component (TransitionGroup) change without a
  render of this component; a MutationObserver re-syncs the Tab stop. Controls
  a media query hides are not items; a viewport resize, zoom included, re-syncs
  the Tab stop off a control that stopped rendering.
-->
<template>
  <div ref="root" role="toolbar" :aria-label="label" @keydown="onKeydown" @focusin="sync">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRovingTabindex } from '@/composables/useRovingTabindex'

const props = withDefaults(defineProps<{
  label: string
  items?: string
  homeEnd?: boolean
}>(), {
  items: 'button, a[href]',
  homeEnd: true,
})

const root = ref<HTMLElement | null>(null)
const { onKeydown, sync } = useRovingTabindex(root, {
  itemSelector: props.items,
  orientation: 'horizontal',
  homeEnd: props.homeEnd,
  focusableDisabled: true,
})

let observer: MutationObserver | null = null
let queued = false
const queueSync = () => {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    sync()
  })
}
onMounted(() => {
  window.addEventListener('resize', queueSync)
  if (!root.value || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(queueSync)
  observer.observe(root.value, { childList: true, subtree: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', queueSync)
  observer?.disconnect()
})

defineExpose({ sync })
</script>
