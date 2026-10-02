<template>
  <div class="public-servers-search">
    <SearchInput
      v-model="localSearchQuery"
      class="search-field"
      :placeholder="$t('server.searchCommunities')"
      :is-loading="isSearching"
      @clear="emit('update:searchQuery', '')"
    />

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

    <p class="search-stats" aria-live="polite">
      {{ statsText }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SearchInput from '@/components/common/SearchInput.vue'
import Icon from '@/components/common/Icon.vue'
import { categoryIcon, categoryLabelKey } from '@/utils/serverDiscovery'

const { t } = useI18n()

interface Props {
  searchQuery: string
  selectedCategory: string | null
  isSearching: boolean
  hasActiveFilter: boolean
  categories: string[]
  totalServers: number
  filteredCount: number
}

interface Emits {
  (e: 'update:searchQuery', value: string): void
  (e: 'update:selectedCategory', value: string | null): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

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

const statsText = computed(() => {
  if (props.hasActiveFilter) {
    return t('server.communitiesOfTotal', { filtered: props.filteredCount, total: props.totalServers })
  }
  return t('server.communitiesFound', { total: props.totalServers })
})
</script>

<style scoped>
.public-servers-search {
  padding: var(--space-4) var(--space-6) var(--space-3);
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.search-stats {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .public-servers-search {
    padding: var(--space-3) var(--space-4);
  }

  /* 16px keeps iOS Safari from zooming on focus. */
  .search-field :deep(.search-input__field) {
    font-size: 16px;
  }

  /* One scrollable row keeps the result list tall on phones. */
  .category-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin: 0 calc(-1 * var(--space-4));
    padding: 0 var(--space-4);
    scrollbar-width: none;
  }

  .category-chips::-webkit-scrollbar {
    display: none;
  }
}
</style>
