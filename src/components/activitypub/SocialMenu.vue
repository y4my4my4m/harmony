<!--
  SocialMenu - role="menu" popup over composables/useMenu.ts, teleported to <body>
  at fixed viewport coordinates next to its anchor. Open while mounted (v-if).

    const open = ref(false)
    const { menuId, onTriggerKeydown, initialFocus } = useMenuButton(open)
    <button ref="moreBtn" aria-haspopup="menu" :aria-expanded="open" :aria-controls="open ? menuId : undefined"
            @click="open = !open" @keydown="onTriggerKeydown">
    <SocialMenu v-if="open" :id="menuId" :anchor="moreBtn" :label="t('...')" :initial-focus="initialFocus" @close="open = false">
      <button type="button" role="menuitem" class="social-menu-item" @click="...">...</button>
      <div role="separator" class="social-menu-divider" />
    </SocialMenu>

  Deviation from AppMenu: a pointer press on the anchor does not close the menu,
  so the trigger's own click toggles it closed instead of closing and reopening
  it. `align` 'end' lines the menu's right edge up with the anchor's; `placement`
  'above' prefers the space over the anchor. Both flip or clamp to stay EDGE px
  inside the viewport. `initial-item` (a selector, e.g. "[aria-checked='true']")
  takes first focus instead of the first item. Attributes (class, id,
  data-testid) land on the menu.
-->
<template>
  <Teleport to="body">
    <div
      ref="menuEl"
      v-bind="$attrs"
      class="social-menu"
      role="menu"
      :aria-label="label || undefined"
      :aria-labelledby="labelledby || undefined"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMenu, type MenuCloseReason } from '@/composables/useMenu'
import { focusElement } from '@/utils/a11y/focus'
import { styleRect, styleViewport } from '@/utils/appZoom'

defineOptions({ inheritAttrs: false })

interface Props {
  anchor?: HTMLElement | null
  label?: string
  labelledby?: string
  align?: 'start' | 'end'
  placement?: 'below' | 'above'
  initialFocus?: 'first' | 'last' | 'none'
  initialItem?: string
}

const props = withDefaults(defineProps<Props>(), {
  anchor: null,
  label: undefined,
  labelledby: undefined,
  align: 'end',
  placement: 'below',
  initialFocus: 'first',
  initialItem: undefined,
})

const emit = defineEmits<{ close: [reason: MenuCloseReason] }>()

/** Viewport margin kept around the menu, px. */
const EDGE = 8
/** Gap between anchor and menu, px. */
const GAP = 4

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

const { close } = useMenu(menuEl, {
  onClose: (reason) => emit('close', reason),
  trigger: () => props.anchor,
  initialFocus: () => (props.initialItem ? 'none' : props.initialFocus),
  closeOnOutsidePointer: false,
})

const onPointerDown = (event: PointerEvent) => {
  const target = event.target as Node | null
  if (!target || menuEl.value?.contains(target) || props.anchor?.contains(target)) return
  close('outside')
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  if (props.initialItem) {
    void nextTick(() => {
      const item = menuEl.value?.querySelector<HTMLElement>(props.initialItem!)
      if (!focusElement(item)) focusElement(menuEl.value?.querySelector<HTMLElement>('[role^="menuitem"]'))
    })
  }
  const el = menuEl.value
  if (!el || !props.anchor) return
  const r = styleRect(el)
  const a = styleRect(props.anchor)
  const viewport = styleViewport()
  const below = a.bottom + GAP
  const above = a.top - r.height - GAP
  const fitsBelow = below + r.height <= viewport.height - EDGE
  const fitsAbove = above >= EDGE
  const y = props.placement === 'above'
    ? (fitsAbove || !fitsBelow ? above : below)
    : (fitsBelow || !fitsAbove ? below : above)
  const x = props.align === 'end' ? a.right - r.width : a.left
  pos.value = {
    x: Math.max(EDGE, Math.min(x, viewport.width - r.width - EDGE)),
    y: Math.max(EDGE, Math.min(y, viewport.height - r.height - EDGE)),
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
})

defineExpose({ element: menuEl })
</script>

<style>
.social-menu {
  position: fixed;
  z-index: 10003;
  min-width: 180px;
  max-width: min(320px, calc(100 * var(--app-vw) - 16px));
  padding: var(--space-1);
  background-color: var(--background-floating, var(--background-primary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
}

.social-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.social-menu-item:hover:not([aria-disabled='true']),
.social-menu-item:focus-visible {
  background-color: var(--background-modifier-hover);
}

.social-menu-item:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.social-menu-item.danger {
  color: var(--text-danger);
}

.social-menu-item.danger:hover:not([aria-disabled='true']) {
  background-color: color-mix(in srgb, var(--error) 12%, transparent);
}

.social-menu-item[aria-disabled='true'] {
  color: var(--text-secondary);
  cursor: default;
}

.social-menu-divider {
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--border-color);
}
</style>
