<!--
  AppMenu - a role="menu" popup over useMenu, teleported to <body> at fixed viewport
  coordinates. Open while mounted (v-if). Items are the slot's
  [role=menuitem|menuitemcheckbox|menuitemradio] elements; submenus follow the
  wrapper pattern documented in composables/useMenu.ts.

    <AppMenu v-if="menu" :x="menu.x" :y="menu.y" :label="server.name" @close="menu = null">
      <button type="button" role="menuitem" @click="markRead">{{ t('...') }}</button>
    </AppMenu>

    <AppMenu v-if="open" :anchor="buttonEl" :id="menuId" :initial-focus="initialFocus" :label="t('...')" @close="open = false">

  Position: `x`/`y` (CSS px, see utils/appZoom; opens upward from the point
  when it would overflow below) or `anchor` (below it, left-aligned, flipped
  above when it would overflow), clamped EDGE px inside the viewport, and
  placed again when its size changes.
  `trigger` overrides the element focus returns to. Attributes (class, id,
  data-testid) land on the menu element. `@close` carries the reason
  ('escape' | 'tab' | 'outside' | 'dismiss').
-->
<template>
  <Teleport :to="portalTarget" :disabled="!teleport">
    <div
      ref="menuEl"
      v-bind="$attrs"
      class="app-menu"
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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useMenu, type MenuCloseReason } from '@/composables/useMenu'
import { styleRect, styleViewport } from '@/utils/appZoom'
import { usePortalTarget } from '@/composables/usePortalTarget'

const portalTarget = usePortalTarget()

defineOptions({ inheritAttrs: false })

interface Props {
  x?: number
  y?: number
  anchor?: HTMLElement | null
  label?: string
  labelledby?: string
  trigger?: HTMLElement | null
  initialFocus?: 'first' | 'last' | 'none'
  teleport?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  x: 0,
  y: 0,
  initialFocus: 'first',
  teleport: true,
})

const emit = defineEmits<{ close: [reason: MenuCloseReason] }>()

/** Viewport margin kept around the menu, px. */
const EDGE = 8

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

useMenu(menuEl, {
  onClose: (reason) => emit('close', reason),
  trigger: () => props.trigger ?? props.anchor ?? null,
  initialFocus: () => props.initialFocus,
})

const place = () => {
  const el = menuEl.value
  if (!el || !props.teleport) return
  // Layout size, not the box: an entrance animation that scales the menu (Flux's
  // harmony-flux-pour starts at 0.6) shrinks getBoundingClientRect while it runs.
  const r = { width: el.offsetWidth, height: el.offsetHeight }
  const viewport = styleViewport(el)
  let x = props.x
  let y = props.y
  if (props.anchor) {
    const a = styleRect(props.anchor)
    x = a.left
    y = a.bottom + 4
    if (y + r.height > viewport.height - EDGE) y = a.top - r.height - 4
  } else if (y + r.height > viewport.height - EDGE && y - r.height >= EDGE) {
    // No room under the point: the menu opens upward from it.
    y -= r.height
  }
  pos.value = {
    x: Math.max(EDGE, Math.min(x, viewport.width - r.width - EDGE)),
    y: Math.max(EDGE, Math.min(y, viewport.height - r.height - EDGE)),
  }
}

// Content rendered after mount changes the menu's size: it is placed again.
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  place()
  if (menuEl.value && props.teleport && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => place())
    resizeObserver.observe(menuEl.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())

defineExpose({ element: menuEl })
</script>

<style>
.app-menu {
  position: fixed;
  z-index: 10003;
}
</style>
