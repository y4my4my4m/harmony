<template>
  <div class="public-servers-search">
    <!-- Search + category toggle: side-by-side on wide screens -->
    <div class="filters-row">
      <div class="search-section">
        <SearchInput 
          v-model="localSearchQuery"
          :placeholder="$t('server.searchCommunities')"
          :is-loading="isSearching"
          @clear="handleClearSearch"
        />
      </div>

      <div class="category-toggle-wrap">
        <button 
          type="button"
          @click="toggleCategories"
          class="category-toggle-btn"
          :class="{ 'category-toggle-btn--expanded': showCategories }"
          :aria-expanded="showCategories"
        >
          <div class="category-toggle-content">
            <div class="category-toggle-icon">
              <svg viewBox="0 0 24 24" class="toggle-chevron" :class="{ 'rotated': showCategories }">
                <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z" fill="currentColor"/>
              </svg>
              <svg viewBox="0 0 24 24" class="category-icon">
                <path d="M4,6H20V8H4V6M4,11H20V13H4V11M4,16H20V18H4V16Z" fill="currentColor"/>
              </svg>
            </div>
            <div class="category-toggle-text">
              <span class="category-title">{{ $t('server.categories') }}</span>
              <span v-if="selectedCategory && !showCategories" class="selected-category-preview">
                {{ translateCategory(selectedCategory) }}
              </span>
            </div>
          </div>
          <div v-if="selectedCategory" class="category-actions">
            <button 
              type="button"
              @click.stop="clearCategory"
              class="clear-category-btn"
              :title="$t('server.clearCategoryFilter')"
            >
              <svg viewBox="0 0 24 24" class="clear-icon">
                <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </button>
      </div>
    </div>

    <!-- Pills full width when open (room to wrap) -->
    <Transition name="categories-expand">
      <div v-show="showCategories" class="category-pills-container">
        <div class="category-pills">
          <button
            v-for="category in categories"
            :key="category"
            type="button"
            @click="selectCategory(category)"
            class="category-pill"
            :class="{ 'category-pill--active': category === selectedCategory }"
          >
            <span class="category-pill-text">{{ translateCategory(category) }}</span>
            <div v-if="category === selectedCategory" class="category-pill-indicator"></div>
          </button>
        </div>
      </div>
    </Transition>

    <!-- Stats -->
    <div class="search-stats">
      <div class="stats-content">
        <div class="stats-primary">
          <svg viewBox="0 0 24 24" class="stats-icon">
            <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
          </svg>
          <span class="stats-text">
            {{ formatStats(filteredCount, totalServers) }}
          </span>
        </div>
        
        <div v-if="searchQuery" class="stats-secondary">
          <span class="search-indicator">
            {{ t('server.searchingFor', { query: searchQuery }) }}
          </span>
        </div>
        
        <div v-if="selectedCategory" class="stats-secondary">
          <span class="category-indicator">
            {{ t('server.categoryLabel', { category: translateCategory(selectedCategory) }) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SearchInput from '@/components/common/SearchInput.vue'

const { t } = useI18n()

interface Props {
  searchQuery: string
  selectedCategory: string | null
  isSearching: boolean
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

// Local state
const showCategories = ref(false)

const localSearchQuery = computed({
  get: () => props.searchQuery,
  set: (value) => emit('update:searchQuery', value)
})

const toggleCategories = () => {
  showCategories.value = !showCategories.value
}

const selectCategory = (category: string) => {
  if (category === props.selectedCategory) {
    emit('update:selectedCategory', null)
  } else {
    emit('update:selectedCategory', category)
  }
}

const clearCategory = () => {
  emit('update:selectedCategory', null)
}

const handleClearSearch = () => {
  emit('update:searchQuery', '')
}

const translateCategory = (category: string): string => {
  const categoryMap: Record<string, string> = {
    'Gaming': t('server.categoryGaming'),
    'Technology': t('server.categoryTechnology'),
    'Art & Design': t('server.categoryArtDesign'),
    'Music': t('server.categoryMusic'),
    'Education': t('server.categoryEducation'),
    'Entertainment': t('server.categoryEntertainment'),
    'Community': t('server.categoryCommunity'),
    'Science': t('server.categoryScience'),
    'Sports': t('server.categorySports'),
    'Other': t('server.categoryOther')
  }
  return categoryMap[category] || category
}

const formatStats = (filtered: number, total: number): string => {
  if (props.searchQuery || props.selectedCategory) {
    return t('server.communitiesOfTotal', { filtered, total })
  }
  return t('server.communitiesFound', { total })
}
</script>

<style scoped>
.public-servers-search {
  /* Shared height for search + category controls */
  --filter-row-height: 44px;

  padding: 14px 24px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(32, 34, 37, 0.3);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Two equal columns: search | categories (stacks on narrow viewports) */
.filters-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
  align-items: stretch;
}

.search-section {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  order: 2; /* right column on wide layout */
}

/* Same fixed height as category dropdown */
.search-section :deep(.search-input) {
  border-radius: 10px;
  box-sizing: border-box;
  height: var(--filter-row-height);
  min-height: var(--filter-row-height);
  max-height: var(--filter-row-height);
}

.search-section :deep(.search-input__icon) {
  align-self: stretch;
  padding: 0 10px 0 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.search-section :deep(.search-icon) {
  width: 18px;
  height: 18px;
}

.search-section :deep(.loading-spinner) {
  width: 18px;
  height: 18px;
}

.search-section :deep(.spinner) {
  width: 16px;
  height: 16px;
}

.search-section :deep(.search-input__field) {
  padding: 0 8px 0 0;
  font-size: 14px;
  line-height: 1.25;
}

.search-section :deep(.search-input__clear) {
  align-self: stretch;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.category-toggle-wrap {
  min-width: 0;
  display: flex;
  order: 1; /* left column on wide layout */
}

.category-toggle-btn {
  width: 100%;
  box-sizing: border-box;
  height: var(--filter-row-height);
  min-height: var(--filter-row-height);
  max-height: var(--filter-row-height);
  background: linear-gradient(135deg, rgba(32, 34, 37, 0.8), rgba(47, 49, 54, 0.6));
  border: 1px solid rgba(14, 165, 233, 0.2);
  border-radius: 10px;
  padding: 0 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.category-toggle-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.1), transparent);
  transition: left 0.4s ease;
}

.category-toggle-btn:hover::before {
  left: 100%;
}

.category-toggle-btn:hover {
  border-color: rgba(14, 165, 233, 0.4);
  background: linear-gradient(135deg, rgba(47, 49, 54, 0.9), rgba(54, 57, 63, 0.7));
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(14, 165, 233, 0.15);
}

.category-toggle-btn--expanded {
  border-color: rgba(14, 165, 233, 0.6);
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.05));
  box-shadow: 0 4px 20px rgba(14, 165, 233, 0.2);
}

.category-toggle-content {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
  z-index: 1;
}

.category-toggle-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-chevron {
  width: 20px;
  height: 20px;
  color: rgba(14, 165, 233, 0.8);
  transition: transform 0.2s ease;
}

.toggle-chevron.rotated {
  transform: rotate(180deg);
}

.category-icon {
  width: 18px;
  height: 18px;
  color: rgba(255, 255, 255, 0.7);
}

.category-toggle-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  flex: 1;
  min-width: 0;
  text-align: left;
}

.category-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  margin: 0;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.selected-category-preview {
  font-size: 11px;
  color: rgba(14, 165, 233, 0.9);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: rgba(14, 165, 233, 0.1);
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid rgba(14, 165, 233, 0.2);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.clear-category-btn {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clear-category-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
  transform: scale(1.1);
}

.clear-icon {
  width: 14px;
  height: 14px;
  color: rgba(239, 68, 68, 0.8);
}

.category-pills-container {
  padding: 10px 12px;
  background: rgba(32, 34, 37, 0.4);
  border-radius: 10px;
  border: 1px solid rgba(14, 165, 233, 0.1);
  margin-top: 0;
}

.category-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.category-pill {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(10px);
}

.category-pill::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  transition: left 0.3s ease;
}

.category-pill:hover::before {
  left: 100%;
}

.category-pill:hover {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.05));
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(14, 165, 233, 0.15);
}

.category-pill--active {
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  border-color: #0EA5E9;
  color: var(--text-primary);
  box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.category-pill--active:hover {
  background: linear-gradient(135deg, #0284C7, #5b6ecd);
  transform: translateY(-3px);
  box-shadow: 0 8px 25px rgba(14, 165, 233, 0.4);
}

.category-pill-text {
  position: relative;
  z-index: 1;
}

.category-pill-indicator {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  background: rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.6);
}

/* Transition animations */
.categories-expand-enter-active,
.categories-expand-leave-active {
  transition: all 0.25s ease;
  overflow: hidden;
}

.categories-expand-enter-from,
.categories-expand-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-top: 0;
}

.categories-expand-enter-to,
.categories-expand-leave-from {
  opacity: 1;
  max-height: 420px;
  padding-top: 10px;
  padding-bottom: 10px;
  margin-top: 0;
}

.search-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stats-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stats-primary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stats-icon {
  width: 16px;
  height: 16px;
  color: rgba(14, 165, 233, 0.8);
}

.stats-text {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.stats-secondary {
  padding-left: 24px;
}

.search-indicator,
.category-indicator {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  font-style: italic;
}

/* Stack: search first (primary), categories below */
@media (max-width: 680px) {
  .filters-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .search-section {
    order: 1;
  }

  .category-toggle-wrap {
    order: 2;
  }
}

/* Mobile responsive */
@media (max-width: 768px) {
  .public-servers-search {
    padding: 12px 16px 14px;
    gap: 8px;
  }
  
  .category-toggle-btn {
    padding: 0 12px;
  }
  
  .category-title {
    font-size: 13px;
  }
  
  .category-pills-container {
    padding: 12px 14px;
    margin-top: 0;
  }
  
  .category-pills {
    gap: 8px;
  }
  
  .category-pill {
    padding: 8px 14px;
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .public-servers-search {
    padding: 10px 14px 12px;
  }
  
  .category-toggle-btn {
    padding: 0 10px;
  }
  
  .category-toggle-content {
    gap: 10px;
  }
  
  .category-title {
    font-size: 14px;
  }
  
  .selected-category-preview {
    font-size: 11px;
  }
  
  .category-pills-container {
    padding: 12px;
    margin-top: 10px;
  }
  
  .category-pills {
    gap: 6px;
  }
  
  .category-pill {
    padding: 6px 12px;
    font-size: 11px;
  }
  
  .stats-content {
    align-self: stretch;
  }
}
</style>
