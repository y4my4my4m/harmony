<template>
  <div class="search-query" :class="{ focused }" @mousedown.self.prevent="focus()">
    <Icon name="search" :size="18" class="search-query-icon" />
    <div class="search-query-field" @mousedown.self.prevent="focus()">
      <span
        v-for="(token, index) in tokens"
        :key="`${token.key}-${index}`"
        class="search-chip"
        :class="{ incomplete: !isTokenComplete(token) }"
        :title="isTokenComplete(token) ? undefined : t('messageSearch.unresolved')"
      >
        <span class="search-chip-key">{{ token.key }}:</span>
        <span class="search-chip-value">
          <DisplayName
            v-if="(token.key === 'from' || token.key === 'mentions') && token.id"
            :user-id="token.id"
            :fallback="token.value"
            truncate
          />
          <template v-else-if="token.key === 'in'">#{{ token.value }}</template>
          <template v-else>{{ token.value }}</template>
        </span>
        <button
          type="button"
          class="search-chip-remove"
          :aria-label="t('messageSearch.removeFilter', { filter: token.key })"
          @mousedown.prevent
          @click="removeToken(index)"
        >
          <Icon name="x" :size="12" />
        </button>
      </span>
      <input
        ref="inputRef"
        v-model="draft"
        class="search-query-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="popoverOpen"
        :aria-activedescendant="activeIndex >= 0 ? `search-option-${activeIndex}` : undefined"
        :placeholder="tokens.length ? '' : placeholder"
        @input="handleInput"
        @keydown="handleKeydown"
        @keyup="syncCaret"
        @click="syncCaret"
        @focus="focused = true; syncCaret()"
        @blur="focused = false"
      />
    </div>
    <button
      v-if="tokens.length || draft"
      type="button"
      class="search-query-clear"
      :aria-label="t('messageSearch.clear')"
      @mousedown.prevent
      @click="clear"
    >
      <Icon name="x" :size="16" />
    </button>

    <div v-if="popoverOpen" class="search-popover" role="listbox" @mousedown.prevent>
      <div class="search-popover-title">{{ popoverTitle }}</div>
      <button
        v-for="(s, index) in suggestions"
        :id="`search-option-${index}`"
        :key="s.id"
        type="button"
        role="option"
        class="search-option"
        :class="{ active: index === activeIndex }"
        :aria-selected="index === activeIndex"
        @mouseenter="activeIndex = index"
        @click="apply(s)"
      >
        <template v-if="s.kind === 'key'">
          <span class="search-option-key">{{ s.key }}:</span>
          <span class="search-option-hint">{{ s.hint }}</span>
        </template>
        <template v-else-if="s.kind === 'member'">
          <Avatar :src="getUserAvatarUrl(s.member.id).value" size="mini" />
          <DisplayName :user-id="s.member.id" :fallback="s.member.displayName || s.member.username" truncate />
          <span class="search-option-hint">@{{ s.member.username }}</span>
        </template>
        <template v-else-if="s.kind === 'channel'">
          <Icon name="hash" :size="14" class="search-option-icon" />
          <span class="search-option-label">{{ s.channel.name }}</span>
        </template>
        <template v-else>
          <Icon v-if="s.icon" :name="s.icon" :size="14" class="search-option-icon" />
          <span class="search-option-label">{{ s.label }}</span>
          <span v-if="s.hint" class="search-option-hint">{{ s.hint }}</span>
        </template>
      </button>
      <label v-if="dateKey" class="search-date">
        <span>{{ t('messageSearch.pickDate') }}</span>
        <input type="date" class="search-date-input" :max="todayValue" @change="pickDate" />
      </label>
      <div class="search-popover-footer">{{ t('messageSearch.enterToSearch') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useUserData } from '@/composables/useUserData'
import {
  FILTER_KEYS,
  HAS_VALUES,
  activeTokenAt,
  formatSearchDate,
  isTokenComplete,
  parseSearchDate,
  parseSearchQuery,
  resolveToken,
  serializeToken,
  suggestChannels,
  suggestMembers,
  type FilterKey,
  type SearchChannel,
  type SearchMember,
  type SearchToken,
} from '@/utils/searchQuery'

type Suggestion =
  | { kind: 'key'; id: string; key: FilterKey; hint: string }
  | { kind: 'member'; id: string; key: FilterKey; member: SearchMember }
  | { kind: 'channel'; id: string; channel: SearchChannel }
  | { kind: 'value'; id: string; key: FilterKey; value: string; label: string; hint?: string; icon?: string }

const props = defineProps<{
  members: SearchMember[]
  channels: SearchChannel[]
  /** in: needs a server. */
  allowChannels: boolean
  placeholder: string
}>()

const emit = defineEmits<{
  (e: 'submit'): void
}>()

const tokens = defineModel<SearchToken[]>('tokens', { required: true })
const draft = defineModel<string>('text', { required: true })

const { t } = useI18n()
const { getUserAvatarUrl } = useUserData()

const inputRef = ref<HTMLInputElement>()
const focused = ref(false)
const caret = ref(0)
const activeIndex = ref(-1)
const dismissed = ref(false)

const HAS_ICONS: Record<string, string> = {
  link: 'link', embed: 'layers', file: 'file', image: 'image', video: 'video', sound: 'volume-2',
}

const active = computed(() => activeTokenAt(draft.value, caret.value))
const dateKey = computed(() => {
  const key = active.value.key
  return key === 'before' || key === 'during' || key === 'after' ? key : null
})
const todayValue = computed(() => formatSearchDate(new Date()))

const keyHint = (key: FilterKey): string => t(`messageSearch.hint.${key}`)

const suggestions = computed<Suggestion[]>(() => {
  const { key, partial } = active.value
  if (!key) {
    const p = partial.toLowerCase()
    return FILTER_KEYS
      .filter(k => (props.allowChannels || k !== 'in') && k.startsWith(p))
      .map(k => ({ kind: 'key' as const, id: `key-${k}`, key: k, hint: keyHint(k) }))
  }
  if (key === 'from' || key === 'mentions') {
    return suggestMembers(props.members, partial).map(m => ({
      kind: 'member' as const, id: `member-${m.id}`, key, member: m,
    }))
  }
  if (key === 'in') {
    return props.allowChannels
      ? suggestChannels(props.channels, partial).map(c => ({ kind: 'channel' as const, id: `channel-${c.id}`, channel: c }))
      : []
  }
  if (key === 'has') {
    return HAS_VALUES.filter(v => v.startsWith(partial.toLowerCase())).map(v => ({
      kind: 'value' as const, id: `has-${v}`, key, value: v, label: v,
      hint: t(`messageSearch.has.${v}`), icon: HAS_ICONS[v],
    }))
  }
  if (key === 'pinned') {
    return (['true', 'false'] as const).filter(v => v.startsWith(partial.toLowerCase())).map(v => ({
      kind: 'value' as const, id: `pinned-${v}`, key, value: v, label: v,
      hint: t(`messageSearch.pinnedHint.${v}`),
    }))
  }
  const out: Suggestion[] = []
  const typed = parseSearchDate(partial)
  if (partial && typed) {
    out.push({ kind: 'value', id: `date-${partial}`, key, value: partial, label: partial, icon: 'calendar' })
  }
  for (const rel of ['today', 'yesterday']) {
    if (rel.startsWith(partial.toLowerCase()) && rel !== partial.toLowerCase()) {
      out.push({ kind: 'value', id: `date-${rel}`, key, value: rel, label: t(`messageSearch.${rel}`), icon: 'clock' })
    }
  }
  return out
})

const popoverOpen = computed(() =>
  focused.value && !dismissed.value && (suggestions.value.length > 0 || dateKey.value !== null))

const popoverTitle = computed(() => {
  const key = active.value.key
  if (!key) return t('messageSearch.options')
  if (key === 'from' || key === 'mentions') return t('messageSearch.members')
  if (key === 'in') return t('messageSearch.channels')
  if (dateKey.value) return t('messageSearch.date')
  return key === 'has' ? t('messageSearch.contains') : t('messageSearch.pinned')
})

const syncCaret = () => {
  caret.value = inputRef.value?.selectionStart ?? draft.value.length
}

// A bare word may be search text, so Enter submits it; a key's values take the first option.
const resetActive = () => {
  activeIndex.value = active.value.key ? 0 : -1
}

const setCaret = (pos: number) => {
  nextTick(() => {
    inputRef.value?.setSelectionRange(pos, pos)
    syncCaret()
  })
}

/** Replaces the active word with `insert`. */
const replaceActive = (insert: string) => {
  const { start, end } = active.value
  const before = draft.value.slice(0, start)
  const after = draft.value.slice(end).replace(/^\s+/, '')
  draft.value = before + insert + (after ? ' ' + after : '')
  setCaret((before + insert).length)
}

const addToken = (token: SearchToken) => {
  const same = tokens.value.some(x => x.key === token.key && x.value === token.value && x.id === token.id)
  if (!same) tokens.value = [...tokens.value, token]
}

const apply = (s: Suggestion) => {
  dismissed.value = false
  if (s.kind === 'key') {
    replaceActive(`${s.key}:`)
  } else {
    if (s.kind === 'member') addToken({ key: s.key, value: s.member.username, id: s.member.id })
    else if (s.kind === 'channel') addToken({ key: 'in', value: s.channel.name, id: s.channel.id })
    else addToken({ key: s.key, value: s.value })
    replaceActive('')
  }
  nextTick(resetActive)
}

const pickDate = (event: Event) => {
  const value = (event.target as HTMLInputElement).value
  const key = dateKey.value
  if (!value || !key) return
  addToken({ key, value })
  replaceActive('')
  inputRef.value?.focus()
}

/** Moves complete key:value words out of the draft into chips; the rest stays as typed. */
const extractTokens = (all: boolean) => {
  const parsed = parseSearchQuery(draft.value)
  if (parsed.tokens.length === 0) return
  const keep: SearchToken[] = []
  for (const raw of parsed.tokens) {
    const token = resolveToken(raw, { members: props.members, channels: props.channels })
    if (isTokenComplete(token) || all) addToken(token)
    else keep.push(raw)
  }
  const rest = [parsed.text, ...keep.map(serializeToken)].filter(Boolean).join(' ')
  draft.value = rest && !all ? rest + ' ' : rest
  setCaret(draft.value.length)
}

const handleInput = () => {
  dismissed.value = false
  syncCaret()
  // A space typed at the end closes the word before it.
  if (draft.value.endsWith(' ') && caret.value === draft.value.length) extractTokens(false)
  resetActive()
}

const move = (delta: number) => {
  const n = suggestions.value.length
  if (!n) return
  activeIndex.value = (activeIndex.value + delta + n) % n
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) return
  const open = popoverOpen.value && suggestions.value.length > 0
  switch (event.key) {
    case 'ArrowDown':
      if (open) { event.preventDefault(); move(1) }
      break
    case 'ArrowUp':
      if (open) { event.preventDefault(); move(-1) }
      break
    case 'Tab':
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        apply(suggestions.value[Math.max(activeIndex.value, 0)])
      }
      break
    case 'Enter':
      event.preventDefault()
      if (open && activeIndex.value >= 0) {
        apply(suggestions.value[activeIndex.value])
      } else {
        extractTokens(true)
        dismissed.value = true
        emit('submit')
      }
      break
    case 'Escape':
      if (popoverOpen.value) {
        event.stopPropagation()
        dismissed.value = true
      }
      break
    case 'Backspace':
      if (inputRef.value?.selectionStart === 0 && inputRef.value?.selectionEnd === 0 && tokens.value.length) {
        event.preventDefault()
        tokens.value = tokens.value.slice(0, -1)
      }
      break
  }
}

const removeToken = (index: number) => {
  tokens.value = tokens.value.filter((_, i) => i !== index)
  inputRef.value?.focus()
}

const clear = () => {
  tokens.value = []
  draft.value = ''
  dismissed.value = false
  inputRef.value?.focus()
}

const focus = () => {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<style scoped>
.search-query {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  background: var(--input-bg, var(--background-tertiary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: var(--radius-md);
  cursor: text;
  transition: border-color var(--transition-fast);
}

.search-query.focused {
  border-color: var(--border-focus);
}

.search-query-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-query-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.search-query-input {
  flex: 1;
  min-width: 120px;
  padding: var(--space-1) 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
}

.search-query-input::placeholder {
  color: var(--text-muted);
}

.search-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  padding: 2px 2px 2px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--harmony-primary-alpha);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  line-height: 20px;
}

.search-chip.incomplete {
  background: color-mix(in srgb, var(--error) 18%, transparent);
}

.search-chip-key {
  color: var(--text-secondary);
  font-weight: var(--font-weight-semibold);
}

.search-chip-value {
  display: inline-flex;
  min-width: 0;
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.search-chip-remove,
.search-query-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.search-chip-remove {
  padding: 2px;
}

.search-query-clear {
  flex-shrink: 0;
  padding: var(--space-1);
}

.search-chip-remove:hover,
.search-query-clear:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.search-popover {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  right: 0;
  z-index: var(--z-popover);
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-2);
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
  cursor: default;
}

.search-popover-title {
  padding: var(--space-1) var(--space-2);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.search-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.search-option.active {
  background: var(--background-modifier-selected);
}

.search-option-key {
  font-weight: var(--font-weight-semibold);
}

.search-option-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.search-option-hint {
  margin-left: auto;
  padding-left: var(--space-2);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.search-option-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-date {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.search-date-input {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: var(--background-primary);
  color: var(--text-primary);
  color-scheme: light dark;
  font-family: inherit;
}

.search-popover-footer {
  margin-top: var(--space-1);
  padding: var(--space-2) var(--space-2) var(--space-1);
  border-top: 1px solid var(--border-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
</style>
