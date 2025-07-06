<template>
  <div class="public-servers-search">
    <!-- Search Input -->
    <div class="search-section">
      <SearchInput 
        v-model="localSearchQuery"
        placeholder="Search communities..."
        :is-loading="isSearching"
        @clear="handleClearSearch"
      />
    </div>

    <!-- Category Filter -->
    <div class="category-section">
      <div class="category-header">
        <h3 class="category-title">Categories</h3>
        <button 
          v-if="selectedCategory"
          @click="clearCategory"
          class="clear-category-btn"
        >
          Clear
        </button>
      </div>
      
      <div class="category-pills">
        <button
          v-for="category in categories"
          :key="category"
          @click="selectCategory(category)"
          class="category-pill"
          :class="{ 'category-pill--active': category === selectedCategory }"
        >
          {{ category }}
        </button>
      </div>
    </div>

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
            Searching for "{{ searchQuery }}"
          </span>
        </div>
        
        <div v-if="selectedCategory" class="stats-secondary">
          <span class="category-indicator">
            Category: {{ selectedCategory }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import SearchInput from '@/components/common/SearchInput.vue'

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

const localSearchQuery = computed({
  get: () => props.searchQuery,
  set: (value) => emit('update:searchQuery', value)
})

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

const formatStats = (filtered: number, total: number): string => {
  if (props.searchQuery || props.selectedCategory) {
    return `${filtered} of ${total} communities`
  }
  return `${total} communities found`
}
</script>

<style scoped>
.public-servers-search {
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(32, 34, 37, 0.3);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.search-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.category-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.category-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  margin: 0;
}

.clear-category-btn {
  background: transparent;
  border: none;
  color: rgba(88, 101, 242, 0.8);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.clear-category-btn:hover {
  color: #5865f2;
  background: rgba(88, 101, 242, 0.1);
}

.category-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.category-pill {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 20px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.category-pill:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.25);
  color: #ffffff;
}

.category-pill--active {
  background: linear-gradient(135deg, #5865f2, #7289da);
  border-color: #5865f2;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(88, 101, 242, 0.3);
}

.category-pill--active:hover {
  background: linear-gradient(135deg, #4752c4, #5b6ecd);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.4);
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
  color: rgba(88, 101, 242, 0.8);
}

.stats-text {
  font-size: 14px;
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

/* Mobile responsive */
@media (max-width: 768px) {
  .public-servers-search {
    padding: 20px 24px;
    gap: 16px;
  }
  
  .category-pills {
    gap: 6px;
  }
  
  .category-pill {
    padding: 6px 12px;
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .public-servers-search {
    padding: 16px 20px;
  }
  
  .category-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  
  .stats-content {
    align-self: stretch;
  }
}
</style>
