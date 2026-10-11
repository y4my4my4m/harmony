<!--
  KeyboardNavigationHelp - the app-wide keyboard navigation keys (region cycling,
  skip link, Escape), listed in Settings > Keybinds. Fixed keys: not remappable.
-->
<template>
  <section class="kbd-nav-help" :aria-labelledby="titleId">
    <h3 :id="titleId" class="kbd-nav-help__title">{{ t('a11y.shortcuts.title') }}</h3>
    <dl class="kbd-nav-help__list">
      <div class="kbd-nav-help__row">
        <dt><kbd>{{ t('a11y.shortcuts.regionsKeys') }}</kbd></dt>
        <dd>
          {{ t('a11y.shortcuts.regions') }}
          <span class="kbd-nav-help__note">{{ t('a11y.shortcuts.browserNote') }}</span>
        </dd>
      </div>
      <div class="kbd-nav-help__row">
        <dt><kbd>{{ t('a11y.shortcuts.skipKeys') }}</kbd></dt>
        <dd>{{ t('a11y.shortcuts.skip') }}</dd>
      </div>
      <div class="kbd-nav-help__row">
        <dt><kbd>{{ t('a11y.shortcuts.escapeKeys') }}</kbd></dt>
        <dd>{{ t('a11y.shortcuts.escape') }}</dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'

const { t } = useT()
const titleId = uid('kbd-nav-help')
</script>

<style scoped>
.kbd-nav-help {
  margin-bottom: var(--space-6);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
}

.kbd-nav-help__title {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.kbd-nav-help__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
}

.kbd-nav-help__row {
  display: grid;
  grid-template-columns: minmax(120px, max-content) 1fr;
  gap: var(--space-3);
  align-items: baseline;
}

.kbd-nav-help__row dt,
.kbd-nav-help__row dd {
  margin: 0;
}

.kbd-nav-help__row dd {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.kbd-nav-help__note {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

kbd {
  display: inline-block;
  padding: 2px 6px;
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-sm);
  background: var(--background-primary);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
</style>
