<template>
  <Teleport to="body">
    <div
      ref="menuEl"
      class="rail-menu"
      role="menu"
      :aria-label="label"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  x: number
  y: number
  label: string
}>()

const emit = defineEmits<{ close: [] }>()

/** Viewport margin kept around the menu, px. */
const EDGE = 8

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

const items = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([disabled]), :scope > .rail-menu-sub > [role="menuitem"]'))

const onKeydown = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement
  const scope = (target.closest('[role="menu"]') as HTMLElement | null) ?? menuEl.value
  if (!scope) return
  const list = items(scope)
  const i = list.indexOf(target)
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (scope !== menuEl.value) {
      const owner = scope.parentElement?.querySelector<HTMLElement>(':scope > [role="menuitem"]')
      scope.parentElement?.classList.remove('open')
      owner?.focus()
    } else emit('close')
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const d = e.key === 'ArrowDown' ? 1 : -1
    list[(i + d + list.length) % list.length]?.focus()
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
  } else if (e.key === 'ArrowRight' && target.getAttribute('aria-haspopup') === 'menu') {
    e.preventDefault()
    const sub = target.parentElement
    sub?.classList.add('open')
    void nextTick(() => sub?.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]:not([disabled])')?.focus())
  } else if (e.key === 'ArrowLeft' && scope !== menuEl.value) {
    e.preventDefault()
    scope.parentElement?.classList.remove('open')
    scope.parentElement?.querySelector<HTMLElement>(':scope > [role="menuitem"]')?.focus()
  } else if (e.key === 'Tab') {
    e.preventDefault()
    emit('close')
  }
}

const onPointerDownOutside = (e: PointerEvent) => {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) emit('close')
}

const onWindowChange = () => emit('close')

onMounted(() => {
  const el = menuEl.value
  if (el) {
    const r = el.getBoundingClientRect()
    pos.value = {
      x: Math.max(EDGE, Math.min(props.x, window.innerWidth - r.width - EDGE)),
      y: Math.max(EDGE, Math.min(props.y, window.innerHeight - r.height - EDGE)),
    }
    el.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
  }
  document.addEventListener('pointerdown', onPointerDownOutside, true)
  window.addEventListener('resize', onWindowChange)
  window.addEventListener('blur', onWindowChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDownOutside, true)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('blur', onWindowChange)
})
</script>

<style>
.rail-menu {
  position: fixed;
  z-index: 10003;
  min-width: 200px;
  max-width: 260px;
  padding: 6px;
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  box-shadow: var(--shadow-large);
  font-size: 14px;
}

.rail-menu [role='menu'] {
  position: absolute;
  top: -6px;
  left: 100%;
  min-width: 180px;
  padding: 6px;
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  box-shadow: var(--shadow-large);
  display: none;
}

.rail-menu-sub {
  position: relative;
}

.rail-menu-sub:hover > [role='menu'],
.rail-menu-sub:focus-within > [role='menu'],
.rail-menu-sub.open > [role='menu'] {
  display: block;
}

.rail-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.rail-menu-item:hover:not([disabled]),
.rail-menu-item:focus-visible {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  outline: none;
}

.rail-menu-item[disabled] {
  opacity: 0.45;
  cursor: default;
}

.rail-menu-item.danger {
  color: var(--error);
}

.rail-menu-item.danger:hover:not([disabled]),
.rail-menu-item.danger:focus-visible {
  background: var(--error);
  color: var(--text-on-primary);
}

.rail-menu-item .rail-menu-trail {
  margin-left: auto;
  opacity: 0.7;
}

.rail-menu-swatch {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rail-menu-divider {
  height: 1px;
  margin: 4px 4px;
  background: var(--border-color);
}

@media (max-width: 600px) {
  .rail-menu [role='menu'] {
    position: static;
    padding: 0 0 0 12px;
    border: none;
    box-shadow: none;
  }
}

.rail-menu-note {
  padding: 2px 8px 6px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
