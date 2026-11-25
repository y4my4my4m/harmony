<template>
  <div class="discovery-controls" :class="{ 'discovery-controls--expanded': expanded }" data-testid="discovery-controls">
    <div class="discovery-controls__bar">
      <button
        ref="toggleEl"
        type="button"
        class="discovery-controls__toggle"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        data-testid="discovery-controls-toggle"
        @click="toggle"
      >
        <Icon name="search" :size="14" />
        <span>{{ $t('server.searchAndFilters') }}</span>
        <Icon name="chevron-down" :size="14" class="discovery-controls__chevron" />
      </button>

      <!-- Folded controls keep every active filter on screen, each removable. -->
      <ul
        v-if="!expanded && filters.length > 0"
        ref="summaryEl"
        class="discovery-controls__summary"
        :aria-label="$t('server.activeFilters')"
        data-testid="discovery-filter-summary"
      >
        <li v-for="filter in filters" :key="filter.key">
          <button
            type="button"
            class="discovery-controls__chip"
            data-testid="discovery-filter-chip"
            @click="remove(filter.key)"
          >
            <span class="sr-only">{{ $t('server.removeFilter') }}</span> <Icon v-if="filter.icon" :name="filter.icon" :size="13" />
            <span class="discovery-controls__chip-label">{{ filter.label }}</span>
            <Icon name="x" :size="12" class="discovery-controls__chip-remove" />
          </button>
        </li>
      </ul>

      <p class="discovery-controls__count" aria-live="polite" :data-testid="countTestId">{{ count }}</p>
    </div>

    <div
      v-show="expanded"
      :id="panelId"
      ref="panelEl"
      class="discovery-controls__panel"
      data-testid="discovery-controls-panel"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { AUTO_COLLAPSE_PX, shouldAutoCollapse } from '@/utils/directorySearch'

export interface DiscoveryFilter {
  key: string
  label: string
  icon?: string
}

const props = defineProps<{
  expanded: boolean
  filters: DiscoveryFilter[]
  count: string
  countTestId?: string
}>()

const emit = defineEmits<{
  'update:expanded': [value: boolean]
  remove: [key: string]
}>()

const panelId = `discovery-controls-${useId()}`
const toggleEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const summaryEl = ref<HTMLElement | null>(null)

/** scrollTop of the list, in CSS px, at the last scroll event and when the controls last opened. */
let lastScrollTop = 0
let openedAt = 0

watch(() => props.expanded, (open) => {
  if (open) openedAt = lastScrollTop
})

/** Opens the controls with focus in their first text field. */
async function expand() {
  emit('update:expanded', true)
  await nextTick()
  panelEl.value?.querySelector<HTMLInputElement>('input')?.focus()
}

function toggle() {
  if (props.expanded) emit('update:expanded', false)
  else void expand()
}

/** Focus moves to the chip now in the removed one's place, else to the toggle. */
async function remove(key: string) {
  const index = props.filters.findIndex((f) => f.key === key)
  emit('remove', key)
  await nextTick()
  const chips = summaryEl.value?.querySelectorAll<HTMLButtonElement>('button') ?? []
  const next = chips[Math.min(index, chips.length - 1)]
  ;(next ?? toggleEl.value)?.focus()
}

/** The list scrolled to `scrollTop`; folds the controls past the height they take. */
function listScrolled(scrollTop: number) {
  lastScrollTop = scrollTop
  const active = document.activeElement
  const inPanel = active instanceof HTMLElement && !!panelEl.value?.contains(active)
  const typing = inPanel && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
  const threshold = Math.max(AUTO_COLLAPSE_PX, panelEl.value?.offsetHeight ?? 0)
  if (!shouldAutoCollapse({ expanded: props.expanded, scrollTop, openedAt, typing, threshold })) return
  // Focus inside a hidden panel would be lost.
  if (inPanel) toggleEl.value?.focus({ preventScroll: true })
  emit('update:expanded', false)
}

defineExpose({ expand, listScrolled })
</script>

<style scoped>
.discovery-controls {
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.discovery-controls--expanded {
  padding-bottom: var(--space-4);
}

.discovery-controls__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
}

.discovery-controls__toggle,
.discovery-controls__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.discovery-controls__toggle {
  flex-shrink: 0;
  padding: 7px 12px;
  border: 1px solid var(--border-primary);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.discovery-controls__toggle:hover {
  background: var(--background-modifier-active);
  border-color: var(--border-hover);
}

.discovery-controls__chevron {
  transition: transform var(--transition-fast);
}

.discovery-controls__toggle[aria-expanded='true'] .discovery-controls__chevron {
  transform: rotate(180deg);
}

.discovery-controls__summary {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  gap: var(--space-2);
  /* Room for focus rings, which the scroll box clips. */
  margin: -4px 0;
  padding: 4px;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
}

.discovery-controls__summary::-webkit-scrollbar {
  display: none;
}

.discovery-controls__chip {
  max-width: 240px;
  padding: 5px 8px 5px 10px;
  border: 1px solid var(--harmony-primary);
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.discovery-controls__chip:hover {
  background: var(--harmony-primary-fill-hover);
}

.discovery-controls__chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.discovery-controls__chip-remove {
  flex-shrink: 0;
  opacity: 0.85;
}

.discovery-controls__toggle:focus-visible,
.discovery-controls__chip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.discovery-controls__count {
  margin: 0 0 0 auto;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.discovery-controls__panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

@media (max-width: 768px) {
  .discovery-controls {
    padding: var(--space-2) var(--space-4);
  }

  .discovery-controls--expanded {
    padding-bottom: var(--space-3);
  }

  /* Chips take a row of their own under the toggle and count. */
  .discovery-controls__summary {
    order: 3;
    flex-basis: 100%;
    margin: -4px calc(-1 * var(--space-4));
    padding: 4px var(--space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .discovery-controls__chevron {
    transition: none;
  }
}
</style>
