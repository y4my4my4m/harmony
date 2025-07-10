<template>
  <div class="profile-content">
    <div v-if="user" class="profile-display">
      <!-- Profile Header -->
      <div class="profile-header">
        <div class="profile-banner"></div>
        <div class="profile-info">
          <div class="profile-avatar-section">
            <Avatar 
              :src="user.avatar_url" 
              :alt="user.display_name"
              class="profile-avatar"
              size="2xl"
              @click="$emit('profile-click', user)"
            />
          </div>
          <div class="profile-details">
            <h1 class="profile-name" @click="$emit('profile-click', user)">{{ user.display_name || user.username }}</h1>
            <p class="profile-handle" @click="$emit('profile-click', user)">{{ user.handle }}</p>
            <p v-if="user.bio" class="profile-bio">{{ user.bio }}</p>
            
            <div class="profile-stats">
              <div class="stat">
                <span class="stat-value">{{ user.posts_count || 0 }}</span>
                <span class="stat-label">Posts</span>
              </div>
              <div class="stat">
                <span class="stat-value">{{ user.following_count || 0 }}</span>
                <span class="stat-label">Following</span>
              </div>
              <div class="stat">
                <span class="stat-value">{{ user.followers_count || 0 }}</span>
                <span class="stat-label">Followers</span>
              </div>
            </div>
            
            <!-- Follow/Unfollow Button -->
            <div v-if="!user.is_local" class="profile-actions">
              <button 
                v-if="!user.is_following"
                @click="$emit('follow', user.id)"
                class="follow-btn"
              >
                Follow
              </button>
              <button 
                v-else
                @click="$emit('unfollow', user.id)"
                class="unfollow-btn"
              >
                Unfollow
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Profile Tabs -->
      <div class="profile-tabs">
        <div 
          v-for="tab in tabs"
          :key="tab.id"
          :class="['tab', { active: activeTab === tab.id }]"
          @click="setActiveTab(tab.id)"
        >
          {{ tab.label }}
        </div>
      </div>
      
      <!-- Profile Content -->
      <div class="profile-posts">
        <div class="posts-container">
          <!-- Posts Tab -->
          <div v-if="activeTab === 'posts'" class="tab-content">
            <div v-if="posts.length > 0" class="user-posts">
              <MonyPost
                v-for="post in posts"
                :key="post.id"
                :post="post"
                @reply="$emit('reply-to-post', $event)"
                @favorite="$emit('favorite-post', $event)"
                @reblog="$emit('reblog-post', $event)"
                @delete="$emit('delete-post', $event)"
                @user-click="$emit('show-user-profile', $event)"
              />
            </div>
                         <div v-else class="empty-posts">
               <UserIcon />
               <h3>No posts yet</h3>
               <p>This user hasn't posted anything yet.</p>
             </div>
           </div>
           
           <!-- Media Tab -->
           <div v-else-if="activeTab === 'media'" class="tab-content">
             <div class="empty-posts">
               <UserIcon />
               <h3>No media</h3>
               <p>This user hasn't shared any media yet.</p>
             </div>
           </div>
           
           <!-- Replies Tab -->
           <div v-else-if="activeTab === 'replies'" class="tab-content">
             <div class="empty-posts">
               <ReplyIcon />
               <h3>No replies</h3>
               <p>This user hasn't replied to any posts yet.</p>
             </div>
          </div>
        </div>
      </div>
    </div>
    
    <div v-else class="profile-loading">
      <div class="loading-spinner"></div>
      <p>Loading profile...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import UserIcon from '@/components/icons/User.vue';
import type { FederatedUser, TimelinePost } from '@/types';
import Avatar from '@/components/common/Avatar.vue';

interface Props {
  user: FederatedUser | null;
  posts?: TimelinePost[];
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  posts: () => [],
  loading: false
});

defineEmits<{
  'follow': [userId: string];
  'unfollow': [userId: string];
  'reply-to-post': [post: TimelinePost];
  'favorite-post': [postId: string];
  'reblog-post': [postId: string];
  'delete-post': [postId: string];
  'show-user-profile': [user: any];
  'load-more-posts': [];
  'profile-click': [user: FederatedUser];
}>();

const activeTab = ref('posts');

const tabs = [
  { id: 'posts', label: 'Posts' },
  { id: 'media', label: 'Media' },
  { id: 'replies', label: 'Replies' }
];

const setActiveTab = (tabId: string) => {
  activeTab.value = tabId;
  // TODO: Load different content based on tab
};
</script>

<style scoped>
.profile-content {
  height: 100%;
  overflow-y: auto;
  background: var(--background-primary);
}

.profile-display {
  height: 100%;
}

.profile-header {
  position: relative;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
}

.profile-banner {
  height: 200px;
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-secondary, #4752c4));
  position: absolute;
}

.profile-avatar-section {
  position: relative;
  padding: 40px 0 20px 0;
}

.profile-info {
  padding: 0 24px 24px 24px;
  position: relative;
}


.profile-avatar {
  border: 4px solid var(--background-primary);
  border-radius: 50%;
  background: var(--background-secondary);
  cursor: pointer;
  transition: transform 0.2s ease;
}

.profile-avatar:hover {
  transform: scale(1.05);
}

.profile-name {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.profile-name:hover {
  color: var(--brand-primary);
}

.profile-handle {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  cursor: pointer;
  transition: color 0.2s ease;
}

.profile-handle:hover {
  color: var(--brand-primary);
}

.profile-bio {
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0 0 16px 0;
}

.profile-stats {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.profile-actions {
  margin-top: 16px;
}

.follow-btn, .unfollow-btn {
  padding: 8px 24px;
  border-radius: 20px;
  border: none;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.follow-btn {
  background: var(--brand-primary);
  color: white;
}

.follow-btn:hover {
  background: var(--brand-primary-hover, #4752c4);
}

.unfollow-btn {
  background: var(--background-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.unfollow-btn:hover {
  background: var(--background-hover);
}

.profile-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.tab {
  padding: 16px 24px;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  transition: all 0.2s ease;
}

.tab:hover {
  color: var(--text-primary);
  background: var(--background-hover);
}

.tab.active {
  color: var(--brand-primary);
  border-bottom-color: var(--brand-primary);
}

.profile-posts {
  flex: 1;
  overflow-y: auto;
}

.tab-content {
  padding: var(--space-4);
}

.user-posts {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.empty-posts {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: var(--text-secondary);
  gap: 16px;
  text-align: center;
}

.empty-posts h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.empty-posts p {
  font-size: 16px;
  margin: 0;
  color: var(--text-secondary);
}

.profile-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
  color: var(--text-secondary);
  gap: 1rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top: 3px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Mobile Responsive */
@media (max-width: 768px) {
  .profile-banner {
    height: 150px;
  }
  
  .profile-avatar {
    width: 80px;
    height: 80px;
  }
  
  .profile-details {
    margin-top: 50px;
  }
  
  .profile-name {
    font-size: 20px;
  }
  
  .profile-stats {
    gap: 16px;
  }
  
  .tab {
    padding: 12px 16px;
    font-size: 14px;
  }
}
</style> 