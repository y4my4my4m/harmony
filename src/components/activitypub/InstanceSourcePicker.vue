<!--
  InstanceSourcePicker - Trending's source chip: '' (all instances), 'local' or one
  domain. The chip opens a non-modal dialog holding a search field (WAI-ARIA combobox
  with list autocomplete: focus stays in the field, aria-activedescendant names the
  highlighted option) over a listbox. Empty field: All instances, This instance, the selected
  domain, then the domains ranked from the rows on screen, filled up with recently seen
  instances. Typed text: matching suggestions, then known instances whose domain
  contains it.

  Keys on the chip: Enter, Space or ArrowDown open. In the field: Up/Down move and
  wrap, Enter picks, Escape closes without a change, Tab closes; focus returns to the
  chip. A touch opens without focusing the field, so no keyboard covers the list.

  Attributes (data-testid, class) land on the chip; the popover's test id is the
  chip's with "-popover" appended.
-->
<template>
  <button
    ref="triggerRef"
    type="button"
    class="source-chip"
    :class="{ 'is-active': active }"
    v-bind="$attrs"
    aria-haspopup="dialog"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-controls="open ? popoverId : undefined"
    :aria-label="`${label}, ${currentLabel}`"
    @pointerdown="lastPointer = $event.pointerType"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <Icon name="globe" :size="14" class="source-chip-icon" />
    <span class="source-chip-label" aria-hidden="true">{{ currentLabel }}</span>
    <Icon name="chevron-down" :size="14" class="source-chip-caret" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="popoverId"
      ref="popoverRef"
      class="source-popover"
      role="dialog"
      :aria-label="label"
      :data-testid="popoverTestId"
      :style="popoverStyle"
    >
      <div class="source-search">
        <Icon name="search" :size="14" class="source-search-icon" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          class="source-search-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="activeRow ? optionId(activeRow.index) : undefined"
          :aria-label="t('activitypub.trendingSourceSearch')"
          :placeholder="t('activitypub.searchInstances')"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          enterkeyhint="go"
          @input="onInput"
          @keydown="onInputKeydown"
        />
      </div>
      <div :id="listId" class="source-list" role="listbox" :aria-label="label" @mousedown.prevent>
        <div
          v-for="section in sections"
          :key="section.id"
          class="source-group"
          :role="section.title ? 'group' : 'none'"
          :aria-labelledby="section.title ? `${listId}-${section.id}` : undefined"
        >
          <div v-if="section.title" :id="`${listId}-${section.id}`" class="source-group-title" role="presentation">
            {{ section.title }}
          </div>
          <div
            v-for="row in section.rows"
            :id="optionId(row.index)"
            :key="row.value"
            role="option"
            class="source-option"
            :class="{ active: row.index === activeIndex, current: row.value === modelValue }"
            :aria-selected="row.index === activeIndex ? 'true' : 'false'"
            :data-value="row.value"
            @mousemove="activeIndex = row.index"
            @click="pick(row.value)"
          >
            <span class="source-check" aria-hidden="true">
              <Icon v-if="row.value === modelValue" name="check" :size="14" />
            </span>
            <span class="source-option-label">{{ row.label }}</span>
            <span v-if="row.hint" class="source-option-hint">{{ row.hint }}</span>
          </div>
        </div>
      </div>
      <div class="source-status" role="status">{{ statusText }}</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { trendingService } from '@/services/TrendingService'
import { runtimeConfig } from '@/services/runtimeConfig'
import { pushLayer } from '@/utils/a11y/layers'
import { focusElement, uid } from '@/utils/a11y/focus'
import { styleRect, styleViewport } from '@/utils/appZoom'
import { debug } from '@/utils/debug'
import {
  normalizeDomainQuery,
  sourceSuggestions,
  type DomainCount,
  type SourceSuggestion,
} from '@/utils/instanceSourceRanking'

defineOptions({ inheritAttrs: false })

interface Props {
  /** '' for every instance, 'local' for this one, else a lowercase domain. */
  modelValue: string
  /** What the chip picks; the listbox's name and the start of the chip's. */
  label: string
  /** Remote domains of the loaded posts, ranked (rankPostDomains). */
  postDomains?: DomainCount[]
  /** Remote domains of the loaded people, ranked (rankPeopleDomains). */
  peopleDomains?: DomainCount[]
  active?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  postDomains: () => [],
  peopleDomains: () => [],
  active: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/** Domain rows on an empty field, the selected domain included. */
const SUGGESTION_LIMIT = 8
const SEARCH_LIMIT = 20
const SEARCH_DEBOUNCE_MS = 250
/** Viewport margin kept around the popover, px. */
const EDGE = 8
/** Gap between chip and popover, px. */
const GAP = 4
const WIDTH = 320
/** Height below the chip under which the popover opens above it, when more room is there, px. */
const MIN_BELOW = 240

interface Row {
  index: number
  value: string
  label: string
  hint?: string
}

interface Section {
  id: string
  title?: string
  rows: Row[]
}

const { t } = useI18n()
const attrs = useAttrs()

const triggerRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const popoverId = uid('source-popover')
const listId = `${popoverId}-list`
const optionId = (index: number) => `${popoverId}-option-${index}`

const open = ref(false)
const query = ref('')
const activeIndex = ref(-1)
const lastPointer = ref('')
const popoverStyle = ref<Record<string, string>>({})

const recent = ref<string[] | null>(null)
let recentRequested = false

const searchResults = ref<string[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchRequest = 0

const localDomain = () => (runtimeConfig.domain || '').toLowerCase()

const popoverTestId = computed(() => {
  const id = attrs['data-testid']
  return typeof id === 'string' ? `${id}-popover` : undefined
})

const currentLabel = computed(() => {
  if (props.modelValue === '') return t('activitypub.allInstances')
  if (props.modelValue === 'local') return t('activitypub.thisInstance')
  return props.modelValue
})

const suggestions = computed<SourceSuggestion[]>(() =>
  sourceSuggestions({
    selected: props.modelValue,
    posts: props.postDomains,
    people: props.peopleDomains,
    recent: recent.value ?? [],
    localDomain: localDomain(),
    limit: SUGGESTION_LIMIT,
  }),
)

const fragment = computed(() => normalizeDomainQuery(query.value))

const hintFor = (s: SourceSuggestion): string | undefined => {
  if (s.count === undefined) return undefined
  return s.kind === 'people'
    ? t('activitypub.hashtagPeopleCount', { count: s.count }, s.count)
    : t('activitypub.postsCountLabel', { count: s.count }, s.count)
}

const sections = computed<Section[]>(() => {
  let index = 0
  const row = (value: string, label: string, hint?: string): Row => ({ index: index++, value, label, hint })
  const domainRow = (s: SourceSuggestion) => row(s.domain, s.domain, hintFor(s))

  if (query.value.trim()) {
    const f = fragment.value
    const local = localDomain()
    const shown = new Set<string>()
    const rows: Row[] = []
    for (const s of suggestions.value) {
      if (!f || !s.domain.includes(f)) continue
      shown.add(s.domain)
      rows.push(domainRow(s))
    }
    for (const domain of searchResults.value) {
      const d = domain.toLowerCase()
      if (shown.has(d) || d === local) continue
      shown.add(d)
      rows.push(row(d, d))
    }
    return rows.length ? [{ id: 'matches', title: t('activitypub.trendingSourceMatches'), rows }] : []
  }

  const base: Row[] = [row('', t('activitypub.allInstances')), row('local', t('activitypub.thisInstance'))]
  for (const s of suggestions.value) if (s.group === 'pinned') base.push(domainRow(s))
  const out: Section[] = [{ id: 'base', rows: base }]
  const results = suggestions.value.filter(s => s.group === 'results').map(domainRow)
  if (results.length) out.push({ id: 'results', title: t('activitypub.trendingSourceActive'), rows: results })
  const seen = suggestions.value.filter(s => s.group === 'recent').map(domainRow)
  if (seen.length) out.push({ id: 'recent', title: t('activitypub.trendingSourceRecent'), rows: seen })
  return out
})

const rows = computed(() => sections.value.flatMap(s => s.rows))
const activeRow = computed(() => rows.value[activeIndex.value] ?? null)

const statusText = computed(() => {
  if (!query.value.trim() || rows.value.length) return ''
  return searching.value ? t('activitypub.trendingSourceSearching') : t('activitypub.noInstancesFound')
})

// Highlight stays in range as rows arrive; with none highlighted, the first match takes it.
watch(rows, list => {
  if (!open.value) return
  if (activeIndex.value >= list.length) activeIndex.value = list.length - 1
  if (activeIndex.value < 0 && list.length && query.value.trim()) activeIndex.value = 0
})

watch(activeIndex, index => {
  if (index < 0) return
  void nextTick(() => {
    document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' })
  })
})

const loadRecent = async () => {
  if (recentRequested) return
  const filled = new Set([...props.postDomains, ...props.peopleDomains].map(d => d.domain)).size
  if (filled >= SUGGESTION_LIMIT) return
  recentRequested = true
  try {
    recent.value = await trendingService.getRecentInstanceDomains(SUGGESTION_LIMIT + 1)
  } catch (error) {
    recentRequested = false
    debug.warn('Failed to load recently seen instances:', error)
  }
}

const runSearch = async (text: string) => {
  const request = ++searchRequest
  try {
    const found = await trendingService.searchInstanceDomains(text, SEARCH_LIMIT)
    if (request !== searchRequest) return
    searchResults.value = found
  } catch (error) {
    if (request !== searchRequest) return
    debug.warn('Failed to search instances:', error)
    searchResults.value = []
  } finally {
    if (request === searchRequest) searching.value = false
  }
}

const cancelSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = null
  searchRequest++
  searching.value = false
}

const onInput = () => {
  cancelSearch()
  searchResults.value = []
  activeIndex.value = query.value.trim() ? 0 : rows.value.findIndex(r => r.value === props.modelValue)
  if (activeIndex.value >= rows.value.length) activeIndex.value = rows.value.length - 1
  const text = query.value
  if (!normalizeDomainQuery(text)) return
  searching.value = true
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(text)
  }, SEARCH_DEBOUNCE_MS)
}

const position = () => {
  const el = popoverRef.value
  const anchor = triggerRef.value
  if (!el || !anchor) return
  const a = styleRect(anchor)
  const viewport = styleViewport(anchor)
  const width = Math.min(WIDTH, viewport.width - 2 * EDGE)
  const left = Math.max(EDGE, Math.min(a.left, viewport.width - width - EDGE))
  const below = viewport.height - a.bottom - GAP - EDGE
  const above = a.top - GAP - EDGE
  const style: Record<string, string> = { left: `${left}px`, width: `${width}px` }
  if (below >= MIN_BELOW || below >= above) {
    style.top = `${a.bottom + GAP}px`
    style.maxHeight = `${Math.max(below, 0)}px`
  } else {
    style.bottom = `${viewport.height - a.top + GAP}px`
    style.maxHeight = `${Math.max(above, 0)}px`
  }
  popoverStyle.value = style
}

const onPointerDownOutside = (event: PointerEvent) => {
  const target = event.target as Node | null
  if (!target || popoverRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  close(false)
}

let releaseLayer: (() => void) | null = null

const show = (focusField: boolean) => {
  if (open.value) return
  open.value = true
  query.value = ''
  searchResults.value = []
  activeIndex.value = Math.max(0, rows.value.findIndex(r => r.value === props.modelValue))
  void loadRecent()
  void nextTick(() => {
    if (!open.value) return
    position()
    releaseLayer = pushLayer({ kind: 'popover', element: () => popoverRef.value, onEscape: () => close(true) })
    document.addEventListener('pointerdown', onPointerDownOutside, true)
    window.addEventListener('resize', position)
    if (focusField) focusElement(inputRef.value)
  })
}

function close(restoreFocus: boolean) {
  if (!open.value) return
  open.value = false
  cancelSearch()
  query.value = ''
  searchResults.value = []
  activeIndex.value = -1
  releaseLayer?.()
  releaseLayer = null
  document.removeEventListener('pointerdown', onPointerDownOutside, true)
  window.removeEventListener('resize', position)
  if (restoreFocus) focusElement(triggerRef.value)
}

const toggle = () => {
  if (open.value) close(true)
  else show(lastPointer.value !== 'touch')
  lastPointer.value = ''
}

const onTriggerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    show(true)
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}

const move = (delta: number) => {
  const n = rows.value.length
  if (!n) return
  activeIndex.value = activeIndex.value < 0
    ? (delta > 0 ? 0 : n - 1)
    : (activeIndex.value + delta + n) % n
}

const pick = (value: string) => {
  close(true)
  if (value !== props.modelValue) emit('update:modelValue', value)
}

const onInputKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) return
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Enter':
      event.preventDefault()
      if (activeRow.value) pick(activeRow.value.value)
      break
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      close(true)
      break
    case 'Tab':
      event.preventDefault()
      close(true)
      break
  }
}

onBeforeUnmount(() => close(false))
</script>

<style scoped>
.source-chip {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast), border-color var(--transition-fast);
}

.source-chip:hover,
.source-chip[aria-expanded='true'] {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.source-chip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.source-chip.is-active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light, var(--harmony-primary-light));
  color: var(--text-primary);
}

.source-chip.is-active .source-chip-icon {
  color: var(--text-link);
}

.source-chip-label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-chip-caret {
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.source-chip[aria-expanded='true'] .source-chip-caret {
  transform: rotate(180deg);
}

/* Layer and surface match SocialMenu's. */
.source-popover {
  position: fixed;
  z-index: 10003;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background-color: var(--background-floating, var(--background-primary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
  overflow: hidden;
}

.source-search {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2);
  padding: 0 var(--space-2);
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: var(--radius-sm);
  background: var(--input-bg, var(--background-tertiary));
}

.source-search:focus-within {
  border-color: var(--border-focus);
}

.source-search-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.source-search-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm);
}

.source-search-input::placeholder {
  color: var(--text-muted);
}

.source-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-1) var(--space-1);
}

.source-group + .source-group {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--border-color);
}

.source-group-title {
  padding: var(--space-1) var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.source-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: 36px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.source-option.active {
  background-color: var(--background-modifier-hover);
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.source-option.current {
  font-weight: var(--font-weight-semibold);
}

.source-check {
  display: inline-flex;
  width: 14px;
  flex-shrink: 0;
  color: var(--text-link);
}

.source-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-option-hint {
  margin-left: auto;
  padding-left: var(--space-2);
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.source-status {
  flex-shrink: 0;
  padding: var(--space-2) var(--space-3) var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

/* Rendered while empty: a live region added with its text is not announced. */
.source-status:empty {
  padding: 0;
}

@media (pointer: coarse) {
  .source-option {
    min-height: 44px;
  }
}
</style>
