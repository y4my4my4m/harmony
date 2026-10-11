<!--
  SkipLink - "Skip to content", the first focusable element of the app shell.
  Hidden until focused; activating it focuses the element with `target` id
  (default #main-content), the shell's <main>.
-->
<template>
  <a :href="`#${target}`" class="skip-link" data-testid="skip-link" @click.prevent="skip">{{ $t('a11y.skipToContent') }}</a>
</template>

<script setup lang="ts">
import { focusProgrammatically } from '@/utils/a11y/focus'
import { MAIN_CONTENT_ID } from '@/composables/useRouteA11y'

const props = withDefaults(defineProps<{ target?: string }>(), { target: MAIN_CONTENT_ID })

function skip() {
  const el = document.getElementById(props.target) ?? document.querySelector<HTMLElement>('main')
  focusProgrammatically(el)
}
</script>

<style>
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 11001;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  background: var(--background-floating, var(--background-primary));
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  box-shadow: var(--shadow-large);
}

/* Off screen until focused; clipped rather than moved, so its shadow does not show. */
.skip-link:not(:focus) {
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  box-shadow: none;
}

.skip-link:focus {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
