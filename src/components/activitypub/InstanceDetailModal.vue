<template>
  <BaseModal :show="true" :show-header="false" @close="$emit('close')" class="instance-detail-modal">
    <div class="modal-header">
      <div class="instance-header">
        <div class="instance-icon">
          <Icon name="server" :size="32" />
        </div>
        <div class="instance-info">
          <h2 class="instance-domain">{{ instance.domain }}</h2>
          <p class="instance-software">
            {{ instance.software || 'Unknown' }} {{ instance.version || '' }}
          </p>
        </div>
        <div class="instance-status" :class="getStatusClass()">
          <Icon :name="getStatusIcon()" :size="20" />
          <span>{{ getStatusText() }}</span>
        </div>
      </div>
      
      <button @click="$emit('close')" class="close-btn">
        <Icon name="x" :size="20" />
      </button>
    </div>

    <div class="modal-body">
      <!-- Instance Stats -->
      <div class="stats-section">
        <h3 class="section-title">Instance Statistics</h3>
        <div class="stats-grid">
          <div class="stat-card">
            <Icon name="users" :size="24" />
            <div class="stat-content">
              <div class="stat-value">{{ formatNumber(instance.user_count) }}</div>
              <div class="stat-label">Users</div>
            </div>
          </div>
          <div class="stat-card">
            <Icon name="message-square" :size="24" />
            <div class="stat-content">
              <div class="stat-value">{{ formatNumber(instance.status_count) }}</div>
              <div class="stat-label">Posts</div>
            </div>
          </div>
          <div class="stat-card">
            <Icon name="activity" :size="24" />
            <div class="stat-content">
              <div class="stat-value">{{ formatTime(instance.last_seen_at) }}</div>
              <div class="stat-label">Last Seen</div>
            </div>
          </div>
          <div class="stat-card">
            <Icon name="link" :size="24" />
            <div class="stat-content">
              <div class="stat-value">{{ instance.connection_count || 0 }}</div>
              <div class="stat-label">Connections</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Instance Information -->
      <div class="info-section">
        <h3 class="section-title">About This Instance</h3>
        <div class="info-content">
          <div class="info-item">
            <label>Description:</label>
            <p>{{ instance.description || 'No description available' }}</p>
          </div>
          <div class="info-item" v-if="instance.admin_contact">
            <label>Admin Contact:</label>
            <p>{{ instance.admin_contact }}</p>
          </div>
          <div class="info-item">
            <label>Instance Type:</label>
            <p>{{ getInstanceType() }}</p>
          </div>
          <div class="info-item">
            <label>First Discovered:</label>
            <p>{{ formatDate(instance.created_at) }}</p>
          </div>
        </div>
      </div>

      <!-- Federation Status -->
      <div class="federation-section">
        <h3 class="section-title">Federation Status</h3>
        <div class="federation-info">
          <div class="federation-item" :class="{ active: !instance.is_blocked }">
            <Icon :name="instance.is_blocked ? 'shield-x' : 'shield-check'" :size="20" />
            <span>{{ instance.is_blocked ? 'Blocked' : 'Federation Enabled' }}</span>
          </div>
          <div class="federation-item" :class="{ active: instance.is_trusted }">
            <Icon :name="instance.is_trusted ? 'star' : 'star-off'" :size="20" />
            <span>{{ instance.is_trusted ? 'Trusted Instance' : 'Standard Instance' }}</span>
          </div>
          <div class="federation-item" :class="{ active: isActive }">
            <Icon :name="isActive ? 'wifi' : 'wifi-off'" :size="20" />
            <span>{{ isActive ? 'Recently Active' : 'Inactive' }}</span>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="activity-section">
        <h3 class="section-title">Recent Posts</h3>
        
        <!-- Loading state -->
        <div v-if="isLoadingPosts" class="loading-posts">
          <span>Loading posts...</span>
        </div>
        
        <!-- Posts list -->
        <div v-else-if="recentPosts.length > 0" class="recent-posts">
          <div
            v-for="post in recentPosts"
            :key="post.id"
            class="post-preview"
            @click="viewPost(post)"
          >
            <div class="post-author">
              <Avatar :src="post.author?.avatar_url" size="sm" :alt="post.author?.display_name" class="author-avatar" />
              <span class="author-name">{{ post.author?.display_name || post.author?.username || 'Unknown' }}</span>
            </div>
            <div class="post-content">
              {{ getPostText(post.content) }}
            </div>
            <div class="post-stats">
              <span class="post-time">{{ formatTime(post.created_at) }}</span>
              <div class="post-interactions">
                <span><Icon name="heart" :size="14" /> {{ post.favorites_count || 0 }}</span>
                <span><Icon name="repeat" :size="14" /> {{ post.reblogs_count || 0 }}</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Empty state -->
        <div v-else class="no-posts">
          <p>No recent posts from this instance</p>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <div class="footer-actions">
        <button @click="viewAllPosts" class="primary-btn">
          <Icon name="external-link" :size="16" />
          View All Posts
        </button>
        <button @click="copyInstanceUrl" class="secondary-btn">
          <Icon name="copy" :size="16" />
          Copy URL
        </button>
        <button @click="openInNewTab" class="secondary-btn">
          <Icon name="external-link" :size="16" />
          Visit Instance
        </button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { debug } from '@/utils/debug'
import type { FederatedInstance, TimelinePost } from '@/types';
import BaseModal from '@/components/common/BaseModal.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

const router = useRouter();

interface Props {
  instance: FederatedInstance;
}

const props = defineProps<Props>();

defineEmits<{
  close: [];
  'view-posts': [instance: FederatedInstance];
}>();

// State
const recentPosts = ref<TimelinePost[]>([]);
const isLoadingPosts = ref(false);

// Computed
const isActive = computed(() => {
  const lastSeen = new Date(props.instance.last_seen_at);
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return lastSeen > oneWeekAgo;
});

// Methods
const getStatusClass = () => {
  if (props.instance.is_blocked) return 'blocked';
  if (props.instance.is_trusted) return 'trusted';
  return 'neutral';
};

const getStatusIcon = () => {
  if (props.instance.is_blocked) return 'shield-x';
  if (props.instance.is_trusted) return 'shield-check';
  return 'shield';
};

const getStatusText = () => {
  if (props.instance.is_blocked) return 'Blocked';
  if (props.instance.is_trusted) return 'Trusted';
  return 'Federated';
};

const getInstanceType = () => {
  if (props.instance.software) {
    switch (props.instance.software.toLowerCase()) {
      case 'mastodon': return 'Mastodon Instance';
      case 'pleroma': return 'Pleroma Instance';
      case 'misskey': return 'Misskey Instance';
      case 'peertube': return 'PeerTube Instance';
      case 'pixelfed': return 'PixelFed Instance';
      default: return `${props.instance.software} Instance`;
    }
  }
  return 'ActivityPub Instance';
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const formatDate = (timestamp: string): string => {
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

const getPostText = (content: any): string => {
  if (Array.isArray(content)) {
    const textPart = content.find(part => part.type === 'text');
    return textPart ? textPart.text.substring(0, 120) + '...' : '';
  }
  if (typeof content === 'string') {
    return content.substring(0, 120) + '...';
  }
  return '';
};

const loadRecentPosts = async () => {
  isLoadingPosts.value = true;
  try {
    // Import the service dynamically
    const { activityPubService } = await import('@/services/activityPubService');
    
    // Try to get real posts from this instance
    const result = await activityPubService.getInstanceActivity(props.instance.domain, { limit: 3 });
    
    if (result.posts && result.posts.length > 0) {
      recentPosts.value = result.posts;
    } else {
      // No posts found, leave empty
      recentPosts.value = [];
    }
  } catch (error) {
    debug.error('Failed to load recent posts:', error);
    recentPosts.value = [];
  } finally {
    isLoadingPosts.value = false;
  }
};

const viewPost = (post: TimelinePost) => {
  router.push({ name: 'PostDetail', params: { postId: post.id } });
};

const viewAllPosts = () => {
  window.open(`https://${props.instance.domain}/public`, '_blank');
};

const copyInstanceUrl = async () => {
  try {
    await navigator.clipboard.writeText(`https://${props.instance.domain}`);
    // TODO: Show success toast
  } catch (error) {
    debug.error('Failed to copy URL:', error);
  }
};

const openInNewTab = () => {
  window.open(`https://${props.instance.domain}`, '_blank');
};

// Lifecycle
onMounted(() => {
  loadRecentPosts();
});
</script>

<style scoped>
.instance-detail-modal {
  max-width: 700px;
  width: 90vw;
  max-height: 90vh;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}

.instance-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex: 1;
}

.instance-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: var(--background-tertiary);
  border-radius: 12px;
  color: var(--text-secondary);
}

.instance-info {
  flex: 1;
}

.instance-domain {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
}

.instance-software {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.instance-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
}

.instance-status.trusted {
  background: var(--success-background);
  color: var(--success-color);
}

.instance-status.blocked {
  background: var(--error-background);
  color: var(--error-color);
}

.instance-status.neutral {
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  max-height: 60vh;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px 0;
  color: var(--text-primary);
}

.stats-section {
  margin-bottom: 32px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.stat-content {
  flex: 1;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.info-section {
  margin-bottom: 32px;
}

.info-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-item label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  display: block;
  margin-bottom: 4px;
}

.info-item p {
  font-size: 14px;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.4;
}

.federation-section {
  margin-bottom: 32px;
}

.federation-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.federation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  transition: all 0.2s ease;
}

.federation-item.active {
  background: var(--success-background);
  color: var(--success-color);
}

.activity-section {
  margin-bottom: 16px;
}

.loading-posts,
.no-posts {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}

.recent-posts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.post-preview {
  padding: 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.2s ease;
}

.post-preview:hover {
  border-color: var(--harmony-primary);
  background: var(--background-hover);
}

.post-author {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.author-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.author-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.post-content {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.4;
  margin-bottom: 8px;
}

.post-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}

.post-interactions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.post-interactions span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.modal-footer {
  padding: 24px;
  border-top: 1px solid var(--border-color);
}

.footer-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.primary-btn,
.secondary-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.primary-btn {
  background: var(--harmony-primary);
  border: none;
  color: white;
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
  border-color: var(--border-hover);
}

/* Mobile Responsiveness */
@media (max-width: 768px) {
  .instance-detail-modal {
    width: 95vw;
    max-height: 95vh;
  }
  
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .footer-actions {
    flex-direction: column;
  }
  
  .federation-info {
    gap: 8px;
  }
}
</style> 