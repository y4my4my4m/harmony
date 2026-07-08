<template>
  <div class="emoji-importer">
    <div class="importer-header">
      <h2>
        <Icon name="package-import" />
        Remote Emoji Importer
      </h2>
      <p class="description">
        Browse custom emojis encountered from remote instances. Import the ones you like to make them available locally.
      </p>
    </div>

    <!-- Filters -->
    <div class="filters">
      <div class="filter-group">
        <label>Filter by Domain</label>
        <select v-model="selectedDomain" @change="loadEmojis">
          <option value="">All domains</option>
          <option v-for="domain in uniqueDomains" :key="domain" :value="domain">
            {{ domain }}
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label>Sort by</label>
        <select v-model="sortBy" @change="sortEmojis">
          <option value="usage_count">Most Used</option>
          <option value="last_seen_at">Recently Seen</option>
          <option value="first_seen_at">First Seen</option>
          <option value="shortcode">Name (A-Z)</option>
        </select>
      </div>

      <div class="filter-group">
        <label>Status</label>
        <select v-model="importStatus" @change="loadEmojis">
          <option value="not_imported">Not Imported</option>
          <option value="imported">Already Imported</option>
          <option value="all">All</option>
        </select>
      </div>

      <button @click="loadEmojis" class="refresh-btn">
        <Icon name="refresh-cw" :class="{ spinning: isLoading }" />
        Refresh
      </button>
    </div>

    <!-- Stats -->
    <div class="stats">
      <div class="stat">
        <span class="stat-value">{{ totalEmojis }}</span>
        <span class="stat-label">Total Remote Emojis</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ importedCount }}</span>
        <span class="stat-label">Imported</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ uniqueDomains.length }}</span>
        <span class="stat-label">Domains</span>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="loading">
      <Icon name="loader" class="spinning" />
      <span>Loading emojis...</span>
    </div>

    <!-- Emoji Grid -->
    <div v-else-if="filteredEmojis.length > 0" class="emoji-grid">
      <div 
        v-for="emoji in filteredEmojis" 
        :key="emoji.id"
        class="emoji-card"
        :class="{ imported: emoji.imported_as }"
      >
        <div class="emoji-preview">
          <img 
            :src="emoji.url" 
            :alt="emoji.shortcode"
            @error="handleImageError($event, emoji)"
          />
        </div>
        
        <div class="emoji-info">
          <div class="emoji-name">:{{ emoji.shortcode }}:</div>
          <div class="emoji-domain">{{ emoji.origin_domain }}</div>
          <div class="emoji-stats">
            <span class="usage">
              <Icon name="bar-chart-2" />
              {{ emoji.usage_count }}
            </span>
            <span class="date" :title="formatDate(emoji.last_seen_at)">
              <Icon name="clock" />
              {{ formatRelativeTime(emoji.last_seen_at) }}
            </span>
          </div>
        </div>

        <div class="emoji-actions">
          <button 
            v-if="!emoji.imported_as"
            @click="importEmoji(emoji)"
            :disabled="importingIds.has(emoji.id)"
            class="import-btn"
          >
            <Icon v-if="importingIds.has(emoji.id)" name="loader" class="spinning" />
            <Icon v-else name="download" />
            <span>{{ importingIds.has(emoji.id) ? 'Importing...' : 'Import' }}</span>
          </button>
          <div v-else class="imported-badge">
            <Icon name="check-circle" />
            <span>Imported</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else class="empty-state">
      <Icon name="inbox" :size="48" />
      <h3>No remote emojis found</h3>
      <p>Emojis from remote instances will appear here as you interact with federated content.</p>
    </div>

    <!-- Pagination -->
    <div v-if="emojiTotal > emojiPageSize" class="emoji-pagination">
      <button @click="loadPrevEmojiPage" :disabled="emojiOffset === 0" class="page-btn">Previous</button>
      <span class="page-info">{{ emojiOffset + 1 }}-{{ Math.min(emojiOffset + emojiPageSize, emojiTotal) }} of {{ emojiTotal }}</span>
      <button @click="loadNextEmojiPage" :disabled="emojiOffset + emojiPageSize >= emojiTotal" class="page-btn">Next</button>
    </div>

    <!-- Import Modal -->
    <div v-if="showImportModal" class="modal-overlay" @click.self="closeImportModal">
      <div class="import-modal">
        <div class="modal-header">
          <h3>Import Emoji</h3>
          <button @click="closeImportModal" class="close-btn">
            <Icon name="x" />
          </button>
        </div>

        <div class="modal-body">
          <div class="emoji-preview-large">
            <img :src="selectedEmoji?.url" :alt="selectedEmoji?.shortcode" />
          </div>

          <div class="form-group">
            <label>Emoji Name (without colons)</label>
            <input 
              v-model="importName" 
              type="text"
              :placeholder="selectedEmoji?.shortcode"
            />
            <small>Leave empty to use original name</small>
          </div>

          <div class="import-info">
            <p>
              <Icon name="info" />
              This will download the emoji and add it to your local emoji collection.
            </p>
          </div>
        </div>

        <div class="modal-footer">
          <button @click="closeImportModal" class="cancel-btn">Cancel</button>
          <button @click="confirmImport" class="confirm-btn" :disabled="isImporting">
            <Icon v-if="isImporting" name="loader" class="spinning" />
            <Icon v-else name="download" />
            {{ isImporting ? 'Importing...' : 'Import Emoji' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';
import Icon from '@/components/common/Icon.vue';
import { useToast } from 'vue-toastification'

interface RemoteEmoji {
  id: string;
  shortcode: string;
  origin_domain: string;
  full_code: string;
  url: string;
  static_url?: string;
  first_seen_at: string;
  last_seen_at: string;
  usage_count: number;
  imported_as?: string;
  imported_at?: string;
  category?: string;
  is_animated: boolean;
}

const emojis = ref<RemoteEmoji[]>([]);
const toast = useToast()
const isLoading = ref(false);
const selectedDomain = ref('');
const sortBy = ref('usage_count');
const importStatus = ref('not_imported');
const uniqueDomains = ref<string[]>([]);
const totalEmojis = ref(0);
const importedCount = ref(0);

const showImportModal = ref(false);
const selectedEmoji = ref<RemoteEmoji | null>(null);
const importName = ref('');
const isImporting = ref(false);
const importingIds = ref(new Set<string>());

const filteredEmojis = computed(() => {
  let result = [...emojis.value];
  
  switch (sortBy.value) {
    case 'usage_count':
      result.sort((a, b) => b.usage_count - a.usage_count);
      break;
    case 'last_seen_at':
      result.sort((a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime());
      break;
    case 'first_seen_at':
      result.sort((a, b) => new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime());
      break;
    case 'shortcode':
      result.sort((a, b) => a.shortcode.localeCompare(b.shortcode));
      break;
  }
  
  return result;
});

const emojiPageSize = 50;
const emojiOffset = ref(0);
const emojiTotal = ref(0);

const loadNextEmojiPage = () => {
  if (emojiOffset.value + emojiPageSize < emojiTotal.value) {
    emojiOffset.value += emojiPageSize;
    loadEmojis();
  }
};

const loadPrevEmojiPage = () => {
  if (emojiOffset.value > 0) {
    emojiOffset.value = Math.max(0, emojiOffset.value - emojiPageSize);
    loadEmojis();
  }
};

const loadEmojis = async () => {
  isLoading.value = true;
  
  try {
    debug.log('Loading remote emojis from cache...');
    
    let query = supabase
      .from('remote_emojis_cache')
      .select('*', { count: 'exact' })
      .order('usage_count', { ascending: false })
      .range(emojiOffset.value, emojiOffset.value + emojiPageSize - 1);
    
    if (selectedDomain.value) {
      query = query.eq('origin_domain', selectedDomain.value);
    }
    
    if (importStatus.value === 'not_imported') {
      query = query.is('imported_as', null);
    } else if (importStatus.value === 'imported') {
      query = query.not('imported_as', 'is', null);
    }
    
    const { data, error, count } = await query;
    emojiTotal.value = count || 0;
    
    if (error) {
      debug.error('Failed to load remote emojis:', error);
      console.error('Supabase error:', error);
      return;
    }
    
    debug.log(`Loaded ${data?.length || 0} remote emojis`);
    emojis.value = data || [];
    
    const { data: domainData, error: domainError } = await supabase
      .from('remote_emojis_cache')
      .select('origin_domain')
      .order('origin_domain');
    
    if (domainError) {
      debug.error('Failed to load domains:', domainError);
    } else if (domainData) {
      uniqueDomains.value = [...new Set(domainData.map(d => d.origin_domain))];
      debug.log(`Found ${uniqueDomains.value.length} unique domains:`, uniqueDomains.value);
    }
    
    const { count: total, error: countError } = await supabase
      .from('remote_emojis_cache')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      debug.error('Failed to get total count:', countError);
    }
    
    const { count: imported } = await supabase
      .from('remote_emojis_cache')
      .select('*', { count: 'exact', head: true })
      .not('imported_as', 'is', null);
    
    totalEmojis.value = total || 0;
    importedCount.value = imported || 0;
    
    debug.log(`Stats: ${totalEmojis.value} total, ${importedCount.value} imported`);
    
  } catch (error) {
    debug.error('Error loading emojis:', error);
    console.error('Exception:', error);
  } finally {
    isLoading.value = false;
  }
};

const sortEmojis = () => {
  // Sorting is handled by computed property
};

const importEmoji = (emoji: RemoteEmoji) => {
  selectedEmoji.value = emoji;
  importName.value = '';
  showImportModal.value = true;
};

const closeImportModal = () => {
  showImportModal.value = false;
  selectedEmoji.value = null;
  importName.value = '';
};

const confirmImport = async () => {
  if (!selectedEmoji.value) return;
  
  isImporting.value = true;
  importingIds.value.add(selectedEmoji.value.id);
  
  try {
    const { data, error } = await supabase.rpc('import_remote_emoji', {
      p_remote_emoji_id: selectedEmoji.value.id,
      p_new_name: importName.value || null,
    });
    
    if (error) {
      debug.error('Failed to import emoji:', error);
      toast.error(`Failed to import emoji: ${error.message}`);
      return;
    }
    
    debug.log('Emoji imported successfully:', data);
    
    const idx = emojis.value.findIndex(e => e.id === selectedEmoji.value!.id);
    if (idx !== -1) {
      emojis.value[idx].imported_as = data;
      emojis.value[idx].imported_at = new Date().toISOString();
    }
    
    importedCount.value++;
    closeImportModal();
    
  } catch (error) {
    debug.error('Error importing emoji:', error);
    toast.error('An error occurred while importing the emoji.');
  } finally {
    isImporting.value = false;
    if (selectedEmoji.value) {
      importingIds.value.delete(selectedEmoji.value.id);
    }
  }
};

const handleImageError = (event: Event, _emoji: RemoteEmoji) => {
  const img = event.target as HTMLImageElement;
  img.src = '/emoji-placeholder.png'; // Fallback image
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString();
};

const formatRelativeTime = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

onMounted(() => {
  loadEmojis();
});
</script>

<style scoped>
.emoji-importer {
  padding: 1.5rem;
  margin: 0 auto;
}

.importer-header {
  margin-bottom: 1.5rem;
}

.importer-header h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.5rem;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
}

.description {
  color: #a0a4a8;
  margin: 0;
}

/* Filters */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.filter-group label {
  font-size: 0.75rem;
  color: #a0a4a8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.filter-group select {
  padding: 0.5rem 1rem;
  /* background: #2a2d32; */
  background: var(--background-secondary);
  /* border: 1px solid rgba(255, 255, 255, 0.1); */
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
  min-width: 150px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--harmony-primary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  margin-left: auto;
  align-self: flex-end;
}

.refresh-btn:hover {
  background: rgba(14, 165, 233, 0.3);
}

/* Stats */
.stats {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
}

.stat {
  display: flex;
  flex-direction: column;
  padding: 1rem 1.5rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 0.75rem;
  color: #a0a4a8;
  text-transform: uppercase;
}

/* Loading */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem;
  color: #a0a4a8;
}

/* Emoji Grid */
.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  height: 620px;
  overflow-y: auto;
}

.emoji-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  /* background: #2a2d32; */
  /* border: 1px solid rgba(255, 255, 255, 0.08); */
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  transition: all 0.2s;
}

.emoji-card:hover {
  /* border-color: rgba(255, 255, 255, 0.16); */
  border-color: var(--border-secondary);
  transform: translateY(-1px);
}

.emoji-card.imported {
  opacity: 0.7;
  /* background: rgba(88, 166, 88, 0.1); */
  background: var(--background-tertiary);
}

.emoji-preview {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* background: rgba(0, 0, 0, 0.3); */
  background: var(--background-primary-alpha);
  border-radius: 8px;
  flex-shrink: 0;
}

.emoji-preview img {
  max-width: 40px;
  max-height: 40px;
  object-fit: contain;
}

.emoji-info {
  flex: 1;
  min-width: 0;
}

.emoji-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.emoji-domain {
  font-size: 0.75rem;
  color: #38BDF8;
  margin-bottom: 0.25rem;
}

.emoji-stats {
  display: flex;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: #a0a4a8;
}

.emoji-stats span {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.emoji-actions {
  flex-shrink: 0;
}

.import-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.2s;
}

.import-btn:hover:not(:disabled) {
  background: #0284C7;
}

.import-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.imported-badge {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 1rem;
  background: rgba(88, 166, 88, 0.2);
  border-radius: 6px;
  color: #58a658;
  font-size: 0.875rem;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
  color: #a0a4a8;
}

.emoji-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 16px;
  border-top: 1px solid var(--border-color, #2b2d31);
}

.page-btn {
  padding: 8px 16px;
  background: var(--background-tertiary, #2b2d31);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-weight: 500;
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-btn:hover:not(:disabled) {
  background: var(--background-hover);
}

.page-info {
  font-size: 14px;
  color: var(--text-secondary);
}

.empty-state h3 {
  color: var(--text-primary);
  margin: 1rem 0 0.5rem;
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.import-modal {
  background: #2a2d32;
  border-radius: 12px;
  width: 100%;
  max-width: 400px;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-header h3 {
  margin: 0;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: #a0a4a8;
  cursor: pointer;
  padding: 0.25rem;
}

.modal-body {
  padding: 1.5rem;
}

.emoji-preview-large {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  margin-bottom: 1.5rem;
}

.emoji-preview-large img {
  max-width: 80px;
  max-height: 80px;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: #a0a4a8;
  font-size: 0.875rem;
}

.form-group input {
  width: 100%;
  padding: 0.75rem 1rem;
  background: #1a1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 1rem;
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  color: #6b7280;
  font-size: 0.75rem;
}

.import-info {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
  background: rgba(14, 165, 233, 0.1);
  border-radius: 6px;
  color: #a0a4a8;
  font-size: 0.875rem;
}

.import-info p {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.cancel-btn {
  padding: 0.75rem 1.5rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
}

.confirm-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
}

.confirm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Animations */
.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Responsive */
@media (max-width: 768px) {
  .filters {
    flex-direction: column;
  }
  
  .refresh-btn {
    margin-left: 0;
  }
  
  .stats {
    flex-wrap: wrap;
  }
  
  .emoji-grid {
    grid-template-columns: 1fr;
  }
}
</style>

