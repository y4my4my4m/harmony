<!-- RailMenu - server rail context menu: components/a11y/AppMenu.vue with the rail's look. -->
<template>
  <AppMenu :x="x" :y="y" :label="label" :trigger="trigger" class="rail-menu" @close="emit('close')">
    <slot />
  </AppMenu>
</template>

<script setup lang="ts">
import AppMenu from '@/components/a11y/AppMenu.vue'

defineProps<{
  x: number
  y: number
  label: string
  trigger?: HTMLElement | null
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<style>
.rail-menu {
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
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  outline: none;
}

.rail-menu-item[disabled] {
  opacity: 0.45;
  cursor: default;
}

.rail-menu-item.danger {
  color: var(--text-danger);
}

.rail-menu-item.danger:hover:not([disabled]),
.rail-menu-item.danger:focus-visible {
  background: var(--error-fill);
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
