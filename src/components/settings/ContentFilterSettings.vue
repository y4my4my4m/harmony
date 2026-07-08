<template>
  <div class="content-filter-settings">
    <div class="settings-header">
      <h3 class="settings-title">Content Filtering</h3>
      <p class="settings-description">
        Customize what content appears in your explore feeds
      </p>
    </div>

    <div class="settings-content">
      <!-- Content Types -->
      <div class="setting-group">
        <h4 class="group-title">Content Types</h4>
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.showMedia"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Show posts with media
          </label>
          <p class="setting-help">Include images, videos, and other media in explore feeds</p>
        </div>
        
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.showReblogs"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Show reblogs/boosts
          </label>
          <p class="setting-help">Include boosted content from other users</p>
        </div>
        
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.showReplies"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Show replies
          </label>
          <p class="setting-help">Include replies to other posts</p>
        </div>
      </div>

      <!-- Language Filters -->
      <div class="setting-group">
        <h4 class="group-title">Language Preferences</h4>
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.autoDetectLanguage"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Auto-detect preferred languages
          </label>
          <p class="setting-help">Automatically filter content based on your language preferences</p>
        </div>
        
        <div class="setting-item">
          <label class="setting-field-label">Preferred Languages:</label>
          <div class="language-chips">
            <span
              v-for="lang in selectedLanguages"
              :key="lang"
              class="language-chip"
              @click="removeLanguage(lang)"
            >
              {{ getLanguageName(lang) }}
              <Icon name="x" :size="14" />
            </span>
            <button @click="showLanguageSelector = true" class="add-language-btn">
              <Icon name="plus" :size="14" />
              Add Language
            </button>
          </div>
        </div>
      </div>

      <!-- Instance Filters -->
      <div class="setting-group">
        <h4 class="group-title">Instance Filtering</h4>
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.trustedInstancesOnly"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Show content from trusted instances only
          </label>
          <p class="setting-help">Only display content from instances marked as trusted</p>
        </div>
        
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.excludeBlockedInstances"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Exclude blocked instances
          </label>
          <p class="setting-help">Hide content from blocked instances</p>
        </div>
      </div>

      <!-- Content Warnings -->
      <div class="setting-group">
        <h4 class="group-title">Content Warnings</h4>
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.hideSensitiveContent"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Hide sensitive content by default
          </label>
          <p class="setting-help">Automatically hide posts marked as sensitive</p>
        </div>
        
        <div class="setting-item">
          <label class="setting-label">
            <input
              type="checkbox"
              v-model="filters.requireContentWarnings"
              @change="updateFilters"
            />
            <span class="checkmark"></span>
            Always show content warnings
          </label>
          <p class="setting-help">Display content warnings even for non-sensitive content</p>
        </div>
      </div>

      <!-- Trending Filters -->
      <div class="setting-group">
        <h4 class="group-title">Trending Content</h4>
        <div class="setting-item">
          <label class="setting-field-label">Minimum engagement for trending:</label>
          <div class="slider-container">
            <input
              type="range"
              v-model="filters.trendingThreshold"
              min="1"
              max="100"
              @change="updateFilters"
              class="slider"
            />
            <span class="slider-value">{{ filters.trendingThreshold }} interactions</span>
          </div>
        </div>
        
        <div class="setting-item">
          <label class="setting-field-label">Trending time window:</label>
          <select v-model="filters.trendingWindow" @change="updateFilters" class="select-input">
            <option value="1h">Last hour</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last week</option>
          </select>
        </div>
      </div>

      <!-- Blocked Keywords -->
      <div class="setting-group">
        <h4 class="group-title">Keyword Filters</h4>
        <div class="setting-item">
          <label class="setting-field-label">Blocked keywords/hashtags:</label>
          <div class="keyword-input-container">
            <input
              v-model="newKeyword"
              @keyup.enter="addKeyword"
              placeholder="Add keyword or #hashtag"
              class="keyword-input"
            />
            <button @click="addKeyword" class="add-keyword-btn">Add</button>
          </div>
          <div class="keyword-chips" v-if="filters.blockedKeywords.length > 0">
            <span
              v-for="keyword in filters.blockedKeywords"
              :key="keyword"
              class="keyword-chip"
              @click="removeKeyword(keyword)"
            >
              {{ keyword }}
              <Icon name="x" :size="14" />
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-footer">
      <button @click="resetToDefaults" class="secondary-btn">
        Reset to Defaults
      </button>
      <button @click="saveSettings" class="primary-btn">
        Save Settings
      </button>
    </div>

    <!-- Language Selector Modal -->
    <BaseModal v-if="showLanguageSelector" :show="showLanguageSelector" @close="showLanguageSelector = false">
      <div class="language-selector">
        <h3>Select Languages</h3>
        <div class="language-grid">
          <label
            v-for="lang in availableLanguages"
            :key="lang.code"
            class="language-option"
          >
            <input
              type="checkbox"
              :value="lang.code"
              :checked="selectedLanguages.includes(lang.code)"
              @change="toggleLanguage(lang.code)"
            />
            <span class="language-name">{{ lang.name }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button @click="showLanguageSelector = false" class="primary-btn">Done</button>
        </div>
      </div>
    </BaseModal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification';
import Icon from '@/components/common/Icon.vue';
import BaseModal from '@/components/common/BaseModal.vue';
import { supabase } from '@/supabase';
import { useAuthStore } from '@/stores/auth';

interface ContentFilters {
  showMedia: boolean;
  showReblogs: boolean;
  showReplies: boolean;
  autoDetectLanguage: boolean;
  trustedInstancesOnly: boolean;
  excludeBlockedInstances: boolean;
  hideSensitiveContent: boolean;
  requireContentWarnings: boolean;
  trendingThreshold: number;
  trendingWindow: string;
  blockedKeywords: string[];
}

const authStore = useAuthStore();
const toast = useToast();

const filters = reactive<ContentFilters>({
  showMedia: true,
  showReblogs: true,
  showReplies: false,
  autoDetectLanguage: true,
  trustedInstancesOnly: false,
  excludeBlockedInstances: true,
  hideSensitiveContent: true,
  requireContentWarnings: false,
  trendingThreshold: 10,
  trendingWindow: '24h',
  blockedKeywords: []
});

const selectedLanguages = ref<string[]>(['en']);
const newKeyword = ref('');
const showLanguageSelector = ref(false);

const availableLanguages = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' }
];

const getLanguageName = (code: string): string => {
  const lang = availableLanguages.find(l => l.code === code);
  return lang ? lang.name : code.toUpperCase();
};

const addKeyword = () => {
  if (newKeyword.value.trim() && !filters.blockedKeywords.includes(newKeyword.value.trim())) {
    filters.blockedKeywords.push(newKeyword.value.trim());
    newKeyword.value = '';
    updateFilters();
  }
};

const removeKeyword = (keyword: string) => {
  const index = filters.blockedKeywords.indexOf(keyword);
  if (index > -1) {
    filters.blockedKeywords.splice(index, 1);
    updateFilters();
  }
};

const toggleLanguage = (langCode: string) => {
  const index = selectedLanguages.value.indexOf(langCode);
  if (index > -1) {
    selectedLanguages.value.splice(index, 1);
  } else {
    selectedLanguages.value.push(langCode);
  }
  updateFilters();
};

const removeLanguage = (langCode: string) => {
  const index = selectedLanguages.value.indexOf(langCode);
  if (index > -1) {
    selectedLanguages.value.splice(index, 1);
    updateFilters();
  }
};

const updateFilters = () => {
  // Emit filter changes to parent component
  // This would be used by the ExploreView to apply filters
  debug.log('Filters updated:', filters);
};

const loadSettings = async () => {
  try {
    const userId = authStore.session?.user?.id;
    if (!userId) return;

    const { data, error } = await supabase
      .from('profiles')
      .select('content_filter_preferences')
      .eq('id', userId)
      .single();

    if (error) throw error;

    if (data?.content_filter_preferences) {
      Object.assign(filters, data.content_filter_preferences);
      selectedLanguages.value = data.content_filter_preferences.preferredLanguages || ['en'];
    }
  } catch (error) {
    debug.error('Failed to load content filter settings:', error);
  }
};

const saveSettings = async () => {
  try {
    const userId = authStore.session?.user?.id;
    if (!userId) return;

    const preferences = {
      ...filters,
      preferredLanguages: selectedLanguages.value
    };

    const { error } = await supabase
      .from('profiles')
      .update({ content_filter_preferences: preferences })
      .eq('id', userId);

    if (error) throw error;

    toast.success('Content filter settings saved');
  } catch (error) {
    debug.error('Failed to save content filter settings:', error);
    toast.error('Failed to save settings');
  }
};

const resetToDefaults = () => {
  Object.assign(filters, {
    showMedia: true,
    showReblogs: true,
    showReplies: false,
    autoDetectLanguage: true,
    trustedInstancesOnly: false,
    excludeBlockedInstances: true,
    hideSensitiveContent: true,
    requireContentWarnings: false,
    trendingThreshold: 10,
    trendingWindow: '24h',
    blockedKeywords: []
  });
  selectedLanguages.value = ['en'];
  updateFilters();
};

onMounted(() => {
  loadSettings();
});
</script>

<style scoped>
.content-filter-settings {
  max-width: 600px;
  margin: 0 auto;
  padding: 24px;
}

.settings-header {
  margin-bottom: 32px;
  text-align: center;
}

.settings-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.settings-description {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.setting-group {
  background: var(--background-secondary);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--border-color);
}

.group-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px 0;
  color: var(--text-primary);
}

.setting-item {
  margin-bottom: 16px;
}

.setting-item:last-child {
  margin-bottom: 0;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.setting-label input[type="checkbox"] {
  display: none;
}

.checkmark {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.setting-label input[type="checkbox"]:checked + .checkmark {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.setting-label input[type="checkbox"]:checked + .checkmark::after {
  content: '✓';
  color: var(--text-primary);
  font-size: 12px;
  font-weight: bold;
}

.setting-help {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0 32px;
  line-height: 1.4;
}

.setting-field-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.language-chips,
.keyword-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.language-chip,
.keyword-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--harmony-primary);
  color: var(--text-primary);
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.language-chip:hover,
.keyword-chip:hover {
  background: var(--harmony-primary-hover);
}

.add-language-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--background-tertiary);
  border: 1px dashed var(--border-color);
  border-radius: 16px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.add-language-btn:hover {
  background: var(--background-hover);
  border-color: var(--harmony-primary);
  color: var(--harmony-primary);
}

.slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--background-tertiary);
  outline: none;
  -webkit-appearance: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--harmony-primary);
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--harmony-primary);
  cursor: pointer;
  border: none;
}

.slider-value {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 100px;
}

.select-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.keyword-input-container {
  display: flex;
  gap: 8px;
}

.keyword-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.add-keyword-btn {
  padding: 8px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s ease;
}

.add-keyword-btn:hover {
  background: var(--harmony-primary-hover);
}

.settings-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--border-color);
}

.primary-btn,
.secondary-btn {
  padding: 12px 24px;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.primary-btn {
  background: var(--harmony-primary);
  border: none;
  color: var(--text-primary);
}

.primary-btn:hover {
  background: var(--harmony-primary-hover);
}

.secondary-btn {
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.secondary-btn:hover {
  background: var(--background-hover);
}

/* Language Selector Modal */
.language-selector {
  padding: 24px;
}

.language-selector h3 {
  margin: 0 0 20px 0;
  color: var(--text-primary);
}

.language-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.language-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.language-option:hover {
  background: var(--background-hover);
}

.language-option input[type="checkbox"] {
  margin: 0;
}

.language-name {
  font-size: 14px;
  color: var(--text-primary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
}

/* Mobile Responsiveness */
@media (max-width: 768px) {
  .content-filter-settings {
    padding: 16px;
  }
  
  .settings-footer {
    flex-direction: column;
    gap: 12px;
  }
  
  .language-grid {
    grid-template-columns: 1fr;
  }
  
  .keyword-input-container {
    flex-direction: column;
  }
  
  .slider-container {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
}
</style> 