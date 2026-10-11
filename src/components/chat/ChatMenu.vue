<!--
  ChatMenu - components/a11y/AppMenu.vue with the chat menus' look (channel,
  category and thread context menus, the chat header's "More options").
  Items: <button type="button" role="menuitem" class="chat-menu-item">; .danger
  for destructive ones; role="menuitemradio" with aria-checked for a choice;
  .chat-menu-divider (role="separator") and .chat-menu-label between groups.
-->
<template>
  <AppMenu
    :x="x"
    :y="y"
    :anchor="anchor"
    :label="label"
    :trigger="trigger"
    :initial-focus="initialFocus"
    class="chat-menu"
    @close="emit('close', $event)"
  >
    <slot />
  </AppMenu>
</template>

<script setup lang="ts">
import AppMenu from '@/components/a11y/AppMenu.vue'
import type { MenuCloseReason } from '@/composables/useMenu'

withDefaults(defineProps<{
  x?: number
  y?: number
  anchor?: HTMLElement | null
  label: string
  trigger?: HTMLElement | null
  initialFocus?: 'first' | 'last' | 'none'
}>(), {
  x: 0,
  y: 0,
  anchor: null,
  trigger: null,
  initialFocus: 'first',
})

const emit = defineEmits<{ close: [reason: MenuCloseReason] }>()
</script>

<style>
.chat-menu {
  min-width: 200px;
  max-width: 280px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 6px;
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  box-shadow: var(--shadow-large);
  font-size: 14px;
}

.chat-menu-item {
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

.chat-menu-item > svg,
.chat-menu-item > .icon {
  flex-shrink: 0;
}

.chat-menu-item:hover:not([disabled]),
.chat-menu-item:focus-visible {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  outline: none;
}

.chat-menu-item[disabled] {
  opacity: 0.45;
  cursor: default;
}

.chat-menu-item.danger {
  color: var(--text-danger);
}

.chat-menu-item.danger:hover:not([disabled]),
.chat-menu-item.danger:focus-visible {
  background: var(--error-fill);
  color: var(--text-on-primary);
}

.chat-menu-item .chat-menu-trail {
  margin-left: auto;
  opacity: 0.7;
}

.chat-menu-item[aria-checked='true'] {
  color: var(--text-primary);
}

.chat-menu-divider {
  height: 1px;
  margin: 4px;
  background: var(--border-color);
}

.chat-menu-label {
  padding: 6px 8px 2px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .chat-menu {
    min-width: 220px;
  }

  .chat-menu-item {
    min-height: 44px;
    padding: 10px 12px;
    font-size: 15px;
  }
}
</style>
