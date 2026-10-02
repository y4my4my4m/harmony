<template>
  <div class="explore-content">
    <div class="explore-controls">
      <div class="filter-group">
        <select v-model="instanceStatusFilter" class="filter-select">
          <option value="all">{{ $t('activitypub.allStatuses', 'All Statuses') }}</option>
          <option value="online">{{ $t('activitypub.online') }}</option>
          <option value="slow">{{ $t('activitypub.slow') }}</option>
          <option value="idle">{{ $t('activitypub.lastSeenLongAgo', 'Idle') }}</option>
        </select>

        <select v-model="instanceSoftwareFilter" class="filter-select">
          <option value="all">{{ $t('activitypub.allSoftware', 'All Software') }}</option>
          <option v-for="sw in availableSoftware" :key="sw" :value="sw">{{ softwareDisplayName(sw) }}</option>
        </select>

        <button @click="refreshContent" class="refresh-btn" :disabled="isLoading">
          <Icon name="refresh-cw" :size="16" :class="{ spinning: isLoading }" />
          {{ $t('activitypub.refresh') }}
        </button>
      </div>

      <div class="search-group">
        <input 
          v-model="instanceSearchTerm" 
          @input="searchInstances(instanceSearchTerm)"
          type="text" 
          :placeholder="$t('activitypub.searchInstances')" 
          class="search-input"
        />
        <Icon name="search" class="search-icon" />
      </div>
    </div>

    <div class="explore-content-area">
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="24" :thickness="3" />
        <p class="loading-state-label">{{ $t('activitypub.loadingExploreContent') }}</p>
      </div>

      <div v-else class="instances-content">
        <div class="section instances-browser">
          <h3 class="section-title">
            <Icon name="server" />
            {{ $t('activitypub.federatedInstances') }}
          </h3>
          <div v-if="filteredInstances.length > 0" class="instances-grid">
            <article
              v-for="instance in filteredInstances"
              :key="instance.domain"
              class="instance-card"
              :class="{ 'has-banner': getInstanceBanner(instance) }"
              tabindex="0"
              :aria-label="instance.domain"
              @click="showInstanceDetails(instance)"
              @keydown.enter.self="showInstanceDetails(instance)"
            >
              <!-- Banner background -->
              <div
                v-if="getInstanceBanner(instance)"
                class="instance-card-banner"
                :style="{ backgroundImage: `url(${getInstanceBanner(instance)})` }"
              >
              </div>

              <div class="instance-card-header">
                <div class="instance-card-icon">
                  <img
                    v-if="getInstanceIcon(instance)"
                    :src="getInstanceIcon(instance)!"
                    :alt="instance.domain"
                    class="instance-icon-img"
                    @error="handleIconError(getInstanceIcon(instance)!)"
                  />
                  <span v-else class="instance-monogram" aria-hidden="true">{{ instanceMonogram(instance.domain) }}</span>
                </div>
                <div class="instance-card-meta">
                  <h4 class="instance-card-domain">{{ instance.domain }}</h4>
                  <span class="instance-card-software">{{ softwareDisplayName(instance.software) || t('activitypub.unknown') }}{{ instance.version ? ` ${instance.version}` : '' }}</span>
                </div>
                <span class="instance-status-pill" :class="getInstanceStatusClass(instance)">
                  {{ getInstanceStatusText(instance) }}
                </span>
              </div>

              <p class="instance-card-desc">
                {{ stripHtml(instance.description) || $t('activitypub.noDescriptionAvailable') }}
              </p>

              <div class="instance-card-stats">
                <span class="instance-stat">
                  <Icon name="users" :size="14" />
                  {{ formatNumber(instance.user_count || 0) }} {{ $t('activitypub.usersCount') }}
                </span>
                <span class="instance-stat">
                  <Icon name="message-circle" :size="14" />
                  {{ formatNumber(instance.status_count || 0) }} {{ $t('activitypub.postsCount') }}
                </span>
                <span class="instance-stat">
                  <Icon name="globe" :size="14" />
                  {{ formatNumber(instance.connection_count || 0) }}
                </span>
              </div>

              <div class="instance-card-footer">
                <span class="instance-last-seen">{{ $t('activitypub.lastSeen') }} {{ getTimeAgo(instance?.last_seen_at) }}</span>
                <div class="instance-card-actions">
                  <button type="button" @click.stop="visitInstance(instance)" class="instance-btn">
                    <Icon name="external-link" :size="14" />
                    {{ $t('activitypub.visit') }}
                  </button>
                  <button type="button" @click.stop="viewInstancePosts(instance)" class="instance-btn instance-btn-alt">
                    <Icon name="eye" :size="14" />
                    {{ $t('activitypub.viewPosts') }}
                  </button>
                </div>
              </div>
            </article>
          </div>
          <EmptyState v-else icon="server" :title="$t('activitypub.noInstancesFound')" />
        </div>
      </div>
    </div>

    <!-- Instance Detail Modal -->
    <InstanceDetailModal
      v-if="showInstanceModal"
      :instance="selectedInstanceDetails"
      @close="showInstanceModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { activityPubService } from '@/services/activityPubService';
import { adminService } from '@/services/AdminService';
import InstanceDetailModal from './InstanceDetailModal.vue';
import Icon from '@/components/common/Icon.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { softwareDisplayName, instanceMonogram } from '@/utils/fediverseSoftware';

const { t } = useI18n();

const isLoading = ref(false);

const instanceSearchTerm = ref('');
const instanceStatusFilter = ref('all');
const instanceSoftwareFilter = ref('all');

const knownInstances = ref<any[]>([]);
const selectedInstanceDetails = ref<any | null>(null);
const showInstanceModal = ref(false);

const availableSoftware = computed(() => {
  const set = new Set<string>();
  for (const inst of knownInstances.value) {
    if (inst.software) set.add(inst.software);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

const filteredInstances = computed(() => {
  if (!knownInstances.value) return [];

  let filtered = knownInstances.value;

  if (instanceSearchTerm.value.trim()) {
    const term = instanceSearchTerm.value.trim().toLowerCase();
    filtered = filtered.filter(i =>
      i.domain?.toLowerCase().includes(term) ||
      i.software?.toLowerCase().includes(term) ||
      i.description?.toLowerCase().includes(term)
    );
  }

  if (instanceStatusFilter.value !== 'all') {
    filtered = filtered.filter(i => {
      const status = getInstanceStatus(i);
      if (instanceStatusFilter.value === 'idle') return status === 'unknown';
      return status === instanceStatusFilter.value;
    });
  }

  if (instanceSoftwareFilter.value !== 'all') {
    filtered = filtered.filter(i =>
      i.software?.toLowerCase() === instanceSoftwareFilter.value.toLowerCase()
    );
  }

  return filtered;
});

const loadInstances = async () => {
  try {
    isLoading.value = true;

    const instances = await activityPubService.getDiscoverableInstances({
      limit: 50,
      filter: 'active'
    });

    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to load instances:', error);
    try {
      const adminInstances = await adminService.getFederatedInstances({
        limit: 50,
        filter: 'all'
      });
      knownInstances.value = adminInstances.instances || [];
    } catch (adminError) {
      debug.error('Failed to load instances from admin service:', adminError);
    }
  } finally {
    isLoading.value = false;
  }

  enrichMissingInstanceMetadata();
};

const enrichMissingInstanceMetadata = async () => {
  const toEnrich = knownInstances.value.filter(
    inst => !inst.metadata?.icon_url && !inst.metadata?.banner_url
  );
  if (!toEnrich.length) return;

  const BATCH = 5;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(inst => adminService.enrichInstanceMetadata(inst))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled' && result.value) {
        const inst = batch[j];
        const idx = knownInstances.value.findIndex(k => k.id === inst.id);
        if (idx !== -1) {
          knownInstances.value[idx] = {
            ...knownInstances.value[idx],
            metadata: {
              ...(knownInstances.value[idx].metadata || {}),
              ...result.value,
            },
          };
        }
      }
    }
  }
};

const showInstanceDetails = async (instance: any) => {
  try {
    selectedInstanceDetails.value = instance;
    
    const stats = await activityPubService.getInstanceStats(instance.domain);
    if (stats) {
      selectedInstanceDetails.value = { ...instance, ...stats };
    }
    
    showInstanceModal.value = true;
  } catch (error) {
    debug.error('Failed to load instance details:', error);
    selectedInstanceDetails.value = instance;
    showInstanceModal.value = true;
  }
};

const visitInstance = (instance: any) => {
  window.open(`https://${instance.domain}`, '_blank');
};

const viewInstancePosts = (instance: any) => {
  window.open(`https://${instance.domain}/public`, '_blank');
};

const searchInstances = async (searchTerm: string) => {
  if (!searchTerm.trim()) {
    await loadInstances();
    return;
  }
  
  try {
    const instances = await activityPubService.getDiscoverableInstances({
      limit: 20,
      filter: 'active',
      search: searchTerm.trim()
    });
    
    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to search instances:', error);
  }
};

const getInstanceStatus = (instance: any): 'online' | 'slow' | 'offline' | 'unknown' => {
  if (instance.status && ['online', 'slow', 'offline', 'unknown'].includes(instance.status)) {
    return instance.status;
  }
  if (!instance.last_seen_at) return 'unknown';
  const hours = (Date.now() - new Date(instance.last_seen_at).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return 'online';
  if (hours < 24 * 7) return 'slow';
  return 'unknown';
};

const getInstanceStatusClass = (instance: any) => {
  const status = getInstanceStatus(instance);
  return [`status-${status}`];
};

const getInstanceStatusText = (instance: any) => {
  const status = getInstanceStatus(instance);
  switch (status) {
    case 'online':
      return t('activitypub.online');
    case 'slow':
      return t('activitypub.slow');
    case 'offline':
      return t('activitypub.offline');
    default:
      return t('activitypub.lastSeenLongAgo', 'Idle');
  }
};

const failedIconUrls = ref(new Set<string>());

const getInstanceIcon = (instance: any): string | null => {
  const url = instance.metadata?.icon_url || null;
  if (url && failedIconUrls.value.has(url)) return null;
  return url;
};

const getInstanceBanner = (instance: any): string | null => {
  return instance.metadata?.banner_url || null;
};

const handleIconError = (url: string) => {
  failedIconUrls.value.add(url);
};

const stripHtml = (raw: string): string => {
  if (!raw) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');
  return doc.body.textContent || '';
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const getTimeAgo = (dateString: string | null | undefined): string => {
  if (!dateString) return t('activitypub.unknown');
  const now = new Date();
  const date = new Date(dateString);
  const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) return t('activitypub.justNow');
  if (diffInHours < 24) return t('activitypub.hoursAgo', { hours: diffInHours });
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return t('activitypub.daysAgo', { days: diffInDays });
  
  const diffInMonths = Math.floor(diffInDays / 30);
  return t('activitypub.monthsAgo', { months: diffInMonths });
};

const refreshContent = async () => {
  await loadInstances();
};

onMounted(() => {
  void loadInstances();
});

defineExpose({ refreshContent });
</script>

<style scoped>
.explore-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}

.explore-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.filter-group {
  display: flex;
  gap: 12px;
}

.filter-select,
.search-input {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  border-color: var(--harmony-primary-alpha);
  background: var(--harmony-primary-light);
  color: var(--harmony-primary);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.explore-content-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-5, 20px);
  padding: var(--space-16, 64px) var(--space-4, 16px);
  min-height: 280px;
  text-align: center;
  color: var(--text-secondary);
}

.loading-state-label {
  margin: 0;
  font-size: var(--font-size-sm, 0.875rem);
  line-height: var(--line-height-relaxed, 1.5);
  color: var(--text-secondary);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 16px;
  color: var(--text-primary);
  border-left: 3px solid var(--harmony-primary);
  padding-left: 12px;
}

.instances-browser {
  max-width: 1000px;
  margin: 0 auto;
}

.instances-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.instance-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: border-color 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
  overflow: hidden;
}

.instance-card.has-banner {
  padding-top: 80px;
}

.instance-card-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 80px;
  background-size: cover;
  background-position: center;
  z-index: 0;
}

.instance-card:hover {
  border-color: var(--border-hover);
}

.instance-card:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.instance-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  position: relative;
  z-index: 1;
}

.instance-card-icon {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-tertiary);
  border-radius: 10px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.instance-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 9px;
}

.instance-monogram {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  color: var(--text-secondary);
}

.instance-card-meta {
  flex: 1;
  min-width: 0;
}

.instance-card-domain {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px;
  letter-spacing: -0.01em;
}

.instance-card-software {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.instance-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 500;
  flex-shrink: 0;
}

.instance-status-pill.status-online {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
}

.instance-status-pill.status-slow {
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
}

.instance-status-pill.status-offline {
  background: color-mix(in srgb, var(--error) 14%, transparent);
  color: var(--error);
}

.instance-status-pill.status-unknown {
  background: var(--background-modifier-active);
  color: var(--text-secondary);
}

.instance-card-desc {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.45;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.instance-card-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  position: relative;
  z-index: 1;
}

.instance-stat {
  display: flex;
  align-items: center;
  gap: 5px;
}

.instance-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
  margin-top: 2px;
  position: relative;
  z-index: 1;
}

.instance-last-seen {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.instance-card-actions {
  display: flex;
  gap: 8px;
}

.instance-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  font-size: 0.8125rem;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.instance-btn:hover {
  background: var(--background-hover);
}

.instance-btn-alt {
  border-color: transparent;
  background: transparent;
}

.instance-btn-alt:hover {
  background: var(--background-tertiary);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsive */
@media (max-width: 768px) {
  .explore-controls {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }

  .filter-group {
    flex-wrap: wrap;
  }

  .filter-select,
  .refresh-btn {
    min-height: 40px;
  }

  .instances-grid {
    grid-template-columns: 1fr;
  }

  .instance-card-stats {
    flex-wrap: wrap;
    gap: 10px;
  }
}
</style>
