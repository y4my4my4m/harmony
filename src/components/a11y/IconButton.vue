<!--
  IconButton - a button whose only content is an icon. `label` is required and must
  be translated: it becomes the accessible name (aria-label) and, unless `tooltip`
  says otherwise, the title. The icon is aria-hidden.

    <IconButton :label="t('common.close')" icon="x" @click="close" />
    <IconButton :label="t('chat.members')" icon="users" :pressed="open" />
    <IconButton :label="t('a11y.drawer.navigation')" icon="menu" v-bind="leftDrawerToggle" />
    <IconButton :label="t('common.more')" :expanded="menuOpen" haspopup="menu"><MoreIcon /></IconButton>

  `pressed` renders aria-pressed (toggle buttons; keep the label constant),
  `expanded`/`controls`/`haspopup` the disclosure state. Slot content replaces
  `icon` for custom SVGs and is aria-hidden as well. `hideTooltip` drops the
  title. Other attributes (class, data-testid) land on the <button>.
-->
<template>
  <button
    :type="type"
    class="icon-button"
    :aria-label="label"
    :title="hideTooltip ? undefined : (tooltip || label)"
    :aria-pressed="pressed === undefined ? undefined : pressed ? 'true' : 'false'"
    :aria-expanded="expanded === undefined ? undefined : expanded ? 'true' : 'false'"
    :aria-controls="controls || undefined"
    :aria-haspopup="haspopup || undefined"
    :disabled="disabled || undefined"
  >
    <span class="icon-button__icon" aria-hidden="true">
      <slot>
        <Icon v-if="icon" :name="icon" :size="size" />
      </slot>
    </span>
  </button>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

interface Props {
  label: string
  icon?: string
  size?: number
  /** Title text when it should differ from the label. */
  tooltip?: string
  hideTooltip?: boolean
  pressed?: boolean
  expanded?: boolean
  controls?: string
  haspopup?: 'menu' | 'listbox' | 'dialog' | 'true'
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

const props = withDefaults(defineProps<Props>(), {
  size: 18,
  type: 'button',
  pressed: undefined,
  expanded: undefined,
})

if (import.meta.env.DEV && !props.label?.trim()) {
  console.warn('[IconButton] label is empty; the button has no accessible name')
}
</script>

<style>
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 6px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-button:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.icon-button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.icon-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon-button__icon {
  display: inline-flex;
  line-height: 0;
}
</style>
