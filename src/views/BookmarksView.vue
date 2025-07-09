<template>
  <div class="bookmarks-view">
    <!-- Header -->
    <div class="bookmarks-header">
      <div class="header-content">
        <h1 class="page-title">
          <Icon name="bookmark" />
          Bookmarks
        </h1>
        <p class="page-subtitle">Posts you've saved for later</p>
      </div>
      
      <!-- Clear All Button -->
      <button 
        v-if="bookmarks.length > 0"
        @click="showClearConfirm = true"
        class="clear-all-btn"
      >
        <Icon name="trash" />
        Clear All
      </button>
    </div>

    <!-- Bookmarks Content -->
    <div class="bookmarks-content">
      <!-- Loading State -->
      <div v-if="isLoading && bookmarks.length === 0" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading your bookmarks...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="bookmarks.length === 0" class="empty-state">
        <div class="empty-icon">
          <Icon name="bookmark" :size="64" />
        </div>
        <h3>No bookmarks yet</h3>
        <p>When you bookmark posts, they'll appear here.</p>
        <router-link to="/social/home" class="explore-btn">
          <Icon name="home" />
          Back to Home
        </router-link>
      </div>

      <!-- Bookmarks List -->
      <div v-else class="bookmarks-list">
        <div class="bookmarks-container">
          <MonyPost
            v-for="bookmark in bookmarks"
            :key="bookmark.id"
            :post="bookmark"
            @favorite="handleFavorite"
            @reblog="handleReblog"
            @bookmark="handleBookmark"
            @reply="handleReply"
            @delete="handleDelete"
            @user-click="handleUserClick"
          />
        </div>

        <!-- Load More -->
        <div v-if="hasMore" class="load-more-section">
          <button 
            @click="loadMore"
            :disabled="isLoading"
            class="load-more-btn"
          >
            <Icon v-if="isLoading" name="loader" class="spinning" />
            <span>{{ isLoading ? 'Loading...' : 'Load More' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Clear Confirmation Modal -->
    <div v-if="showClearConfirm" class="modal-overlay" @click="showClearConfirm = false">
      <div class="confirmation-modal" @click.stop>
        <div class="modal-header">
          <h3>Clear All Bookmarks</h3>
          <button @click="showClearConfirm = false" class="close-btn">
            <Icon name="x" />
          </button>
        </div>
        <div class="modal-content">
          <p>Are you sure you want to clear all your bookmarks? This action cannot be undone.</p>
        </div>
        <div class="modal-actions">
          <button @click="showClearConfirm = false" class="cancel-btn">
            Cancel
          </button>
          <button @click="clearAllBookmarks" class="confirm-btn">
            <Icon name="trash" />
            Clear All
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/activitypub';
import { useToast } from 'vue-toastification';
import type { TimelinePost, FederatedUser } from '@/types';

// Components
import MonyPost from '@/components/activitypub/MonyPost.vue';
import Icon from '@/components/common/Icon.vue';

// Stores and composables
const activityPubStore = useActivityPubStore();
const router = useRouter();
const toast = useToast();

// State
const bookmarks = ref<TimelinePost[]>([]);
const isLoading = ref(false);
const hasMore = ref(true);
const showClearConfirm = ref(false);
const cursor = ref<string | null>(null);

// Methods
const loadBookmarks = async (refresh = false) => {
  if (isLoading.value) return;
  
  isLoading.value = true;
  try {
    const result = await activityPubStore.getBookmarks({
      limit: 20,
      cursor: refresh ? null : cursor.value
    });
    
    if (refresh) {
      bookmarks.value = result.posts;
    } else {
      bookmarks.value.push(...result.posts);
    }
    
    cursor.value = result.cursor;
    hasMore.value = result.hasMore;
  } catch (error) {
    console.error('Failed to load bookmarks:', error);
    toast.error('Failed to load bookmarks');
  } finally {
    isLoading.value = false;
  }
};

const loadMore = () => {
  if (hasMore.value && !isLoading.value) {
    loadBookmarks(false);
  }
};

const clearAllBookmarks = async () => {
  try {
    await activityPubStore.clearAllBookmarks();
    bookmarks.value = [];
    cursor.value = null;
    hasMore.value = true;
    showClearConfirm.value = false;
    toast.success('All bookmarks cleared');
  } catch (error) {
    console.error('Failed to clear bookmarks:', error);
    toast.error('Failed to clear bookmarks');
  }
};

// Event handlers
const handleFavorite = async (postId: string) => {
  try {
    await activityPubStore.toggleFavorite(postId);
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const handleReblog = async (postId: string) => {
  try {
    await activityPubStore.toggleReblog(postId);
  } catch (error) {
    console.error('Failed to toggle reblog:', error);
  }
};

const handleBookmark = async (postId: string) => {
  try {
    await activityPubStore.toggleBookmark(postId);
    // Remove from bookmarks list if unbookmarked
    const postIndex = bookmarks.value.findIndex(p => p.id === postId);
    if (postIndex !== -1) {
      const post = bookmarks.value[postIndex];
      if (!post.interactions?.is_bookmarked) {
        bookmarks.value.splice(postIndex, 1);
      }
    }
  } catch (error) {
    console.error('Failed to toggle bookmark:', error);
  }
};

const handleReply = (post: TimelinePost) => {
  activityPubStore.openComposer({
    in_reply_to: post.id,
    content: `@${post.author.username}${post.author.domain !== 'har.mony.lol' ? '@' + post.author.domain : ''} `
  });
};

const handleDelete = async (postId: string) => {
  if (confirm('Are you sure you want to delete this post?')) {
    try {
      await activityPubStore.deletePost(postId);
      bookmarks.value = bookmarks.value.filter(p => p.id !== postId);
    } catch (error) {
      console.error('Failed to delete post:', error);
    }
  }
};

const handleUserClick = (user: FederatedUser) => {
  router.push(`/u/${user.handle.replace('@', '')}`);
};

// Lifecycle
onMounted(() => {
  loadBookmarks(true);
});
</script>

<style scoped>
.bookmarks-view {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}

.bookmarks-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.header-content {
  flex: 1;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.page-subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: 16px;
}

.clear-all-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.clear-all-btn:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.empty-state p {
  font-size: 16px;
  margin: 0 0 24px 0;
  max-width: 400px;
  line-height: 1.5;
}

.explore-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--brand-primary);
  color: white;
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.explore-btn:hover {
  background: var(--brand-primary-hover);
  transform: translateY(-1px);
}

.bookmarks-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.load-more-section {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirmation-modal {
  background: var(--background-primary);
  border-radius: 12px;
  width: 90%;
  max-width: 400px;
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.modal-content {
  padding: 20px 24px;
}

.modal-content p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  gap: 12px;
  padding: 20px 24px;
  border-top: 1px solid var(--border-color);
  justify-content: flex-end;
}

.cancel-btn,
.confirm-btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-btn {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.cancel-btn:hover {
  background: var(--background-hover);
}

.confirm-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--danger-color);
  border: 1px solid var(--danger-color);
  color: white;
}

.confirm-btn:hover {
  background: var(--danger-hover);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .bookmarks-view {
    padding: 16px;
  }
  
  .bookmarks-header {
    flex-direction: column;
    gap: 16px;
    align-items: flex-start;
  }
  
  .clear-all-btn {
    align-self: flex-end;
  }
}
</style> 