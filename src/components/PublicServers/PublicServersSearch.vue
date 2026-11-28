<template>
  <DiscoveryControls
    ref="controls"
    :expanded="expanded"
    :filters="activeFilters"
    :count="statsText"
    count-test-id="discovery-local-stats"
    @update:expanded="emit('update:expanded', $event)"
    @remove="removeFilter"
  >
    <div class="public-servers-search">
      <label :for="inputId" class="search-label">{{ $t('server.searchCommunitiesLabel') }}</label>
      <SearchInput
        v-model="localSearchQuery"
        class="search-field"
        :input-id="inputId"
        :placeholder="$t('server.searchCommunities')"
        :is-loading="isSearching"
        @clear="emit('update:searchQuery', '')"
      />
    </div>

    <div class="category-chips" role="group" :aria-label="$t('server.categories')">
      <button
        type="button"
        class="category-chip"
        :class="{ 'category-chip--active': !selectedCategory }"
        :aria-pressed="!selectedCategory"
        @click="emit('update:selectedCategory', null)"
      >
        <Icon name="grid" :size="14" class="category-chip__icon" />
        {{ $t('server.allCategories') }}
      </button>
      <button
        v-for="category in categories"
        :key="category"
        type="button"
        class="category-chip"
        :class="{ 'category-chip--active': category === selectedCategory }"
        :aria-pressed="category === selectedCategory"
        @click="selectCategory(category)"
      >
        <Icon :name="categoryIcon(category) ?? 'tag'" :size="14" class="category-chip__icon" />
        {{ translateCategory(category) }}
      </button>
    </div>
  </DiscoveryControls>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import SearchInput from '@/components/common/SearchInput.vue'
import Icon from '@/components/common/Icon.vue'
import DiscoveryControls, { type DiscoveryFilter } from '@/components/PublicServers/DiscoveryControls.vue'
import { categoryIcon, categoryLabelKey } from '@/utils/serverDiscovery'

const { t } = useI18n()

interface Props {
  searchQuery: string
  selectedCategory: string | null
  expanded: boolean
  isSearching: boolean
  hasActiveFilter: boolean
  categories: string[]
  totalServers: number
  filteredCount: number
}

interface Emits {
  (e: 'update:searchQuery', value: string): void
  (e: 'update:selectedCategory', value: string | null): void
  (e: 'update:expanded', value: boolean): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const controls = ref<InstanceType<typeof DiscoveryControls> | null>(null)
const inputId = `public-servers-search-${useId()}`

const localSearchQuery = computed({
  get: () => props.searchQuery,
  set: (value) => emit('update:searchQuery', value)
})

const selectCategory = (category: string) => {
  emit('update:selectedCategory', category === props.selectedCategory ? null : category)
}

const translateCategory = (category: string): string => {
  const key = categoryLabelKey(category)
  return key ? t(key) : category
}

const activeFilters = computed<DiscoveryFilter[]>(() => {
  const filters: DiscoveryFilter[] = []
  if (props.selectedCategory) {
    filters.push({
      key: 'category',
      label: translateCategory(props.selectedCategory),
      icon: categoryIcon(props.selectedCategory) ?? 'tag',
    })
  }
  const query = props.searchQuery.trim()
  if (query) filters.push({ key: 'query', label: t('server.queryChip', { query }), icon: 'search' })
  return filters
})

function removeFilter(key: string) {
  if (key === 'category') emit('update:selectedCategory', null)
  else if (key === 'query') emit('update:searchQuery', '')
}

const statsText = computed(() => {
  if (props.hasActiveFilter) {
    return t('server.communitiesOfTotal', { filtered: props.filteredCount, total: props.totalServers })
  }
  return t('server.communitiesFound', { total: props.totalServers })
})

defineExpose({
  listScrolled: (scrollTop: number) => controls.value?.listScrolled(scrollTop),
})
</script>

<style scoped>
.public-servers-search {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.search-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

/* SearchInput ships its own translucent grey and accent bar; align it with form tokens. */
.search-field.search-input {
  height: 40px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-md);
  box-shadow: none;
}

.search-field.search-input:hover {
  background: var(--input-bg);
  border-color: var(--border-hover);
}

.search-field.search-input--focused {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--harmony-primary-light);
}

.search-field :deep(.search-input__accent) {
  display: none;
}

.search-field :deep(.search-input__icon) {
  padding: 0 10px 0 12px;
  color: var(--text-muted);
}

.search-field :deep(.search-icon) {
  width: 18px;
  height: 18px;
}

.search-field :deep(.search-input__field) {
  padding: 0;
  font-size: var(--font-size-sm);
}

.search-field :deep(.search-input__field::placeholder) {
  color: var(--text-muted);
}

.category-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.category-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.category-chip__icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.category-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.category-chip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.category-chip--active,
.category-chip--active:hover {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

@media (max-width: 768px) {
  /* 16px keeps iOS Safari from zooming on focus. */
  .search-field :deep(.search-input__field) {
    font-size: 16px;
  }

  /* One scrollable row keeps the result list tall on phones. */
  .category-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin: -4px calc(-1 * var(--space-4));
    padding: 4px var(--space-4);
    scrollbar-width: none;
  }

  .category-chips::-webkit-scrollbar {
    display: none;
  }
}
</style>
