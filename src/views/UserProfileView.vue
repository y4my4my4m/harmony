<!-- UserProfileView - Federated user profile page -->
<template>
  <div class="user-profile-view">
    <!-- Loading State -->
    <div v-if="isLoading" class="loading-state">
      <div class="loading-spinner"></div>
      <p>Loading profile...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <Icon name="user-x" :size="48" />
      <h2>Profile not found</h2>
      <p>{{ error }}</p>
      <button @click="$router.go(-1)" class="back-btn">
        <Icon name="arrow-left" />
        Go back
      </button>
    </div>

    <!-- Profile Content -->
    <div v-else-if="user" class="profile-content">
      <!-- Profile Header -->
      <div class="profile-header">
        <div class="profile-banner" :style="{ backgroundImage: user.banner_url ? `url(${user.banner_url})` : undefined }">
          <div class="banner-overlay"></div>
        </div>
        
        <div class="profile-info">
          <div class="avatar-section">
            <Avatar 
              :src="user.avatar_url" 
              :alt="user.display_name"
              size="2xl" />
            <div v-if="!user.is_local" class="federation-badge" :title="`From ${user.domain}`">
              <Icon name="federation" />
              <span>{{ user.domain }}</span>
            </div>
          </div>

          <div class="user-details">
            <div class="name-section">
              <h1 class="display-name">
                {{ user.display_name || user.username }}
                <Icon v-if="user.verified" name="verified" class="verified-icon" />
              </h1>
              <p class="user-handle">{{ user.handle }}</p>
            </div>

            <div v-if="user.bio" class="bio-section">
              <MonyContent :content="user.bio" />
            </div>

            <div class="stats-section">
              <div class="stat-item">
                <strong>{{ formatNumber(user.posts_count || 0) }}</strong>
                <span>Monies</span>
              </div>
              <div class="stat-item">
                <strong>{{ formatNumber(user.following_count || 0) }}</strong>
                <span>Following</span>
              </div>
              <div class="stat-item">
                <strong>{{ formatNumber(user.followers_count || 0) }}</strong>
                <span>Followers</span>
              </div>
            </div>

            <div v-if="user.created_at" class="join-date">
              <Icon name="calendar" />
              <span>Joined {{ formatJoinDate(user.created_at) }}</span>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="profile-actions">
            <button
              v-if="!isCurrentUser"
              @click="toggleFollow"
              :disabled="isFollowLoading"
              :class="['action-btn', 'follow-btn', { following: isFollowing }]"
            >
              <Icon v-if="isFollowLoading" name="loader" class="spinning" />
              <Icon v-else-if="isFollowing" name="user-check" />
              <Icon v-else name="user-plus" />
              <span>{{ followButtonText }}</span>
            </button>

            <button
              @click="mentionUser"
              class="action-btn mention-btn"
              title="Mention user"
            >
              <Icon name="at-sign" />
            </button>

            <div class="more-actions">
              <button
                @click="showActionsMenu = !showActionsMenu"
                class="action-btn more-btn"
                title="More actions"
              >
                <Icon name="more-horizontal" />
              </button>
              
              <div v-if="showActionsMenu" class="actions-menu">
                <button @click="handleMute" class="action-item" :class="{ active: isMuted }">
                  <Icon name="volume-x" />
                  <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
                </button>
                
                <button @click="handleBlock" class="action-item danger" :class="{ active: isBlocked }">
                  <Icon name="user-x" />
                  <span>{{ isBlocked ? 'Unblock' : 'Block' }}</span>
                </button>
                
                <button v-if="!user.is_local" @click="handleReport" class="action-item danger">
                  <Icon name="flag" />
                  <span>Report</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Profile Tabs -->
      <div class="profile-tabs">
        <button
          v-for="tab in profileTabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          :class="['tab-btn', { active: activeTab === tab.id }]"
        >
          <Icon :name="tab.icon" />
          <span>{{ tab.label }}</span>
          <span v-if="tab.count !== undefined" class="tab-count">{{ tab.count }}</span>
        </button>
      </div>

      <!-- Tab Content -->
      <div class="tab-content">
        <!-- Posts Tab -->
        <div v-if="activeTab === 'posts'" class="posts-tab">
          <div v-if="userPosts.length === 0 && !isLoadingPosts" class="empty-state">
            <Icon name="message-circle" :size="48" />
            <h3>No monies yet</h3>
            <p>{{ isCurrentUser ? "You haven't" : `${user.display_name || user.username} hasn't` }} posted anything yet.</p>
          </div>
          
          <div v-else class="posts-list">
            <MonyPost
              v-for="post in userPosts"
              :key="post.id"
              :post="post"
              @reply="replyToPost"
              @favorite="handleFavorite"
              @reblog="handleReblog"
              @user-click="showUserProfile"
            />
            
            <div v-if="hasMorePosts" class="load-more-container">
              <button
                @click="loadMorePosts"
                :disabled="isLoadingPosts"
                class="load-more-btn"
              >
                <Icon v-if="isLoadingPosts" name="loader" class="spinning" />
                <span>{{ isLoadingPosts ? 'Loading...' : 'Load More' }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Following Tab -->
        <div v-else-if="activeTab === 'following'" class="following-tab">
          <div v-if="followingUsers.length === 0" class="empty-state">
            <Icon name="users" :size="48" />
            <h3>Not following anyone</h3>
            <p>{{ isCurrentUser ? "You're" : `${user.display_name || user.username} is` }} not following anyone yet.</p>
          </div>
          
          <div v-else class="users-grid">
            <UserCard
              v-for="followedUser in followingUsers"
              :key="followedUser.id"
              :user="followedUser"
              :is-compact="true"
              @user-click="showUserProfile"
            />
          </div>
        </div>

        <!-- Followers Tab -->
        <div v-else-if="activeTab === 'followers'" class="followers-tab">
          <div v-if="followerUsers.length === 0" class="empty-state">
            <Icon name="users" :size="48" />
            <h3>No followers</h3>
            <p>{{ isCurrentUser ? "You don't" : `${user.display_name || user.username} doesn't` }} have any followers yet.</p>
          </div>
          
          <div v-else class="users-grid">
            <UserCard
              v-for="follower in followerUsers"
              :key="follower.id"
              :user="follower"
              :is-compact="true"
              @user-click="showUserProfile"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import { federationService } from '@/services/activitypub/federationService';
import { activityPubService } from '@/services/activityPubService';
import type { FederatedUser, TimelinePost } from '@/types';
import { format } from 'date-fns';

// Components
import MonyPost from '@/components/activitypub/MonyPost.vue';
import MonyContent from '@/components/activitypub/MonyContent.vue';
import UserCard from '@/components/activitypub/UserCard.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

// Stores
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const route = useRoute();
const router = useRouter();

// State
const user = ref<FederatedUser | null>(null);
const isLoading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref('posts');
const showActionsMenu = ref(false);
const isFollowLoading = ref(false);

// Posts
const userPosts = ref<TimelinePost[]>([]);
const isLoadingPosts = ref(false);
const hasMorePosts = ref(false);

// Social connections
const followingUsers = ref<FederatedUser[]>([]);
const followerUsers = ref<FederatedUser[]>([]);

// Profile tabs configuration
const profileTabs = computed(() => [
  { 
    id: 'posts', 
    label: 'Monies', 
    icon: 'message-circle',
    count: user.value?.posts_count || 0
  },
  { 
    id: 'following', 
    label: 'Following', 
    icon: 'user-plus',
    count: user.value?.following_count || 0
  },
  { 
    id: 'followers', 
    label: 'Followers', 
    icon: 'users',
    count: user.value?.followers_count || 0
  }
]);

// Computed
const isCurrentUser = computed(() => {
  return authStore.session?.user?.id === user.value?.id;
});

const isFollowing = computed(() => {
  return user.value ? activityPubStore.isFollowing(user.value.id) : false;
});

const isMuted = computed(() => {
  return user.value ? activityPubStore.isMuted(user.value.id) : false;
});

const isBlocked = computed(() => {
  return user.value ? activityPubStore.isBlocked(user.value.id) : false;
});

const followButtonText = computed(() => {
  if (isFollowLoading.value) return 'Loading...';
  return isFollowing.value ? 'Following' : 'Follow';
});

// Methods
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatJoinDate = (dateString: string): string => {
  return format(new Date(dateString), 'MMMM yyyy');
};

const loadUserProfile = async (handle: string) => {
  console.log(`🔄 Loading profile for handle: ${handle}`);
  isLoading.value = true;
  error.value = null;
  user.value = null; // Clear previous user data
  
  try {
    // Clean the handle
    if (handle.startsWith('@')) {
      handle = handle.substring(1);
    }
    
    console.log(`🔍 Processing handle: ${handle}`);
    
    // Check if it's a federated handle (contains @)
    if (handle.includes('@')) {
      console.log('🌐 Resolving federated user...');
      user.value = await federationService.resolveRemoteUser(handle);
    } else {
      console.log('👤 Looking up local user...');
      
             // For local users, try to get from activity pub service first
       try {
         user.value = await activityPubService.getUserByHandle(`@${handle}`);
       } catch (localError) {
        console.log('⚠️ ActivityPub lookup failed, trying profile service...');
        
        // Fallback: check if this is the current user
        const currentUser = authStore.session?.user;
        const currentUsername = currentUser?.user_metadata?.username || currentUser?.email?.split('@')[0];
        
        if (currentUser && currentUsername === handle) {
          console.log('✅ Loading current user profile...');
          
          // Load current user's profile
          await profileStore.fetchProfile(currentUser.id);
          const profile = profileStore.profile;
          
          if (profile) {
            user.value = {
              id: currentUser.id,
              username: profile.username || currentUsername,
              domain: 'har.mony.lol',
              handle: `@${profile.username || currentUsername}@har.mony.lol`,
              display_name: profile.display_name || profile.username || currentUsername,
              avatar_url: profile.avatar_url || currentUser.user_metadata?.avatar_url || '/default_avatar.png',
              bio: profile.bio || 'Monyverse user',
              is_local: true,
              verified: false,
              followers_count: activityPubStore.followersCount || 0,
              following_count: activityPubStore.followingCount || 0,
              posts_count: activityPubStore.homeFeed.posts.filter(p => p.author_id === currentUser.id).length,
              created_at: profile.created_at || currentUser.created_at || new Date().toISOString(),
              updated_at: profile.updated_at || new Date().toISOString()
            };
          }
        } else {
          // Try to find user by username in the system
          console.log('🔎 Searching for user in system...');
          
          // Create a basic user object for display
          user.value = {
            id: handle,
            username: handle,
            domain: 'har.mony.lol',
            handle: `@${handle}@har.mony.lol`,
            display_name: handle,
            avatar_url: '/default_avatar.png',
            bio: 'Monyverse user',
            is_local: true,
            verified: false,
            followers_count: 0,
            following_count: 0,
            posts_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
        }
      }
    }
    
    if (user.value) {
      console.log('✅ User profile loaded:', user.value.display_name);
      await loadUserPosts();
    } else {
      console.log('❌ User not found');
      error.value = 'User not found';
    }
  } catch (err) {
    console.error('❌ Failed to load user profile:', err);
    error.value = 'Failed to load profile. The user might not exist or be unavailable.';
  } finally {
    isLoading.value = false;
  }
};

const loadUserPosts = async () => {
  if (!user.value) return;
  
  isLoadingPosts.value = true;
  try {
    // TODO: Implement user posts API call
    userPosts.value = [];
    hasMorePosts.value = false;
  } catch (error) {
    console.error('Failed to load user posts:', error);
  } finally {
    isLoadingPosts.value = false;
  }
};

const loadMorePosts = async () => {
  // TODO: Implement pagination
};

const toggleFollow = async () => {
  if (!user.value || isFollowLoading.value) return;
  
  isFollowLoading.value = true;
  try {
    if (isFollowing.value) {
      await activityPubStore.unfollowUser(user.value.id);
    } else {
      await activityPubStore.followUser(user.value.id);
    }
  } catch (error) {
    console.error('Failed to toggle follow:', error);
  } finally {
    isFollowLoading.value = false;
  }
};

const mentionUser = () => {
  if (!user.value) return;
  
  // Open the composer with a mention
  activityPubStore.openComposer({
    content: `${user.value.handle} `
  });
  
  // Navigate to Monyverse
  router.push('/monyverse');
};

const handleMute = async () => {
  if (!user.value) return;
  
  try {
    if (isMuted.value) {
      await activityPubStore.unmuteUser(user.value.id);
    } else {
      await activityPubStore.muteUser(user.value.id);
    }
  } catch (error) {
    console.error('Failed to toggle mute:', error);
  }
  showActionsMenu.value = false;
};

const handleBlock = async () => {
  if (!user.value) return;
  
  try {
    if (isBlocked.value) {
      await activityPubStore.unblockUser(user.value.id);
    } else {
      await activityPubStore.blockUser(user.value.id);
    }
  } catch (error) {
    console.error('Failed to toggle block:', error);
  }
  showActionsMenu.value = false;
};

const handleReport = () => {
  // TODO: Implement reporting
  showActionsMenu.value = false;
};

const showUserProfile = (clickedUser: FederatedUser) => {
  router.push(`/profile/${clickedUser.handle}`);
};

const replyToPost = (post: TimelinePost) => {
  activityPubStore.openComposer({
    in_reply_to: post.id,
    content: `${post.author.handle} `
  });
  router.push('/monyverse');
};

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

// Watch route changes
watch(() => route.params.handle, (newHandle, oldHandle) => {
  console.log(`👤 Profile route changed from ${oldHandle} to ${newHandle}`);
  if (newHandle && typeof newHandle === 'string') {
    loadUserProfile(newHandle);
  }
}, { immediate: true });

// Ensure profile loads on mount
onMounted(() => {
  const handle = route.params.handle;
  console.log(`🔄 UserProfileView mounted with handle: ${handle}`);
  if (handle && typeof handle === 'string') {
    loadUserProfile(handle);
  }
});

// Close actions menu when clicking outside
const handleClickOutside = (event: Event) => {
  if (showActionsMenu.value) {
    const target = event.target as Element;
    if (!target.closest('.more-actions')) {
      showActionsMenu.value = false;
    }
  }
};

document.addEventListener('click', handleClickOutside);
</script>

<style scoped>
.user-profile-view {
  min-height: 100vh;
  background: var(--h-chat, #313338);
  color: white;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
  color: #80848e;
  padding: 2rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.08);
  border-top: 3px solid var(--h-brand, #5865f2);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

.error-state h2 {
  color: white;
  margin: 1rem 0 0.5rem;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: white;
  padding: 0.75rem 1.5rem;
  cursor: pointer;
  margin-top: 1rem;
  transition: background 0.2s;
}

.back-btn:hover {
  background: #4752c4;
}

.profile-header {
  position: relative;
}

.profile-banner {
  height: 200px;
  background: linear-gradient(135deg, #5865f2, #7289da);
  background-size: cover;
  background-position: center;
  position: relative;
}

.banner-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
}

.profile-info {
  background: var(--h-sidebar, #2b2d31);
  /* border-radius: 12px 12px 0 0; */
  margin-top: -60px;
  position: relative;
  padding: 2rem;
}

.avatar-section {
  position: relative;
  margin-bottom: 1rem;
}

.profile-avatar {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  border: 4px solid var(--h-sidebar, #2b2d31);
  object-fit: cover;
}

.federation-badge {
  position: absolute;
  bottom: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: rgba(114, 137, 218, 0.1);
  color: #7289da;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  border: 1px solid rgba(114, 137, 218, 0.3);
}

.name-section {
  margin-bottom: 1rem;
}

.display-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  color: white;
}

.verified-icon {
  color: #1d9bf0;
  flex-shrink: 0;
}

.user-handle {
  color: #80848e;
  font-size: 1.1rem;
  margin: 0;
}

.bio-section {
  margin-bottom: 1.5rem;
  font-size: 1rem;
  line-height: 1.5;
}

.stats-section {
  display: flex;
  gap: 2rem;
  margin-bottom: 1rem;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-item strong {
  font-size: 1.5rem;
  font-weight: 700;
  color: white;
}

.stat-item span {
  font-size: 0.875rem;
  color: #80848e;
}

.join-date {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #80848e;
  font-size: 0.875rem;
}

.profile-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--h-chat, #313338);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: white;
  padding: 0.75rem 1rem;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.follow-btn {
  background: var(--h-brand, #5865f2);
  border-color: var(--h-brand, #5865f2);
}

.follow-btn:hover:not(:disabled) {
  background: #4752c4;
}

.follow-btn.following {
  background: transparent;
  border-color: var(--h-brand, #5865f2);
  color: var(--h-brand, #5865f2);
}

.follow-btn.following:hover:not(:disabled) {
  background: rgba(242, 63, 66, 0.1);
  border-color: #f23f42;
  color: #f23f42;
}

.follow-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.more-actions {
  position: relative;
}

.actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  width: 180px;
  background: var(--h-sidebar, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.5rem;
  z-index: 100;
  margin-top: 0.5rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.action-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  background: none;
  border: none;
  color: white;
  padding: 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background 0.2s;
}

.action-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.action-item.active {
  color: var(--h-brand, #5865f2);
}

.action-item.danger {
  color: #f23f42;
}

.action-item.danger:hover {
  background: rgba(242, 63, 66, 0.1);
}

.profile-tabs {
  display: flex;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: var(--h-sidebar, #2b2d31);
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  color: #80848e;
  padding: 1rem 1.5rem;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
}

.tab-btn:hover {
  color: white;
  background: rgba(255, 255, 255, 0.08);
}

.tab-btn.active {
  color: var(--h-brand, #5865f2);
  border-bottom-color: var(--h-brand, #5865f2);
}

.tab-count {
  background: rgba(255, 255, 255, 0.1);
  color: #80848e;
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}

.tab-btn.active .tab-count {
  background: rgba(88, 101, 242, 0.2);
  color: var(--h-brand, #5865f2);
}

.tab-content {
  background: var(--h-chat, #313338);
  min-height: 400px;
}

.posts-tab,
.following-tab,
.followers-tab {
  padding: 1.5rem;
}

.posts-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.users-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #80848e;
  padding: 3rem 2rem;
}

.empty-state h3 {
  color: white;
  margin: 1rem 0 0.5rem;
  font-size: 1.25rem;
}

.load-more-container {
  margin-top: 1rem;
  text-align: center;
}

.load-more-btn {
  background: var(--h-chat, #313338);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: white;
  padding: 0.75rem 1.5rem;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin: 0 auto;
}

.load-more-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .profile-info {
    padding: 1rem;
  }
  
  .profile-avatar {
    width: 80px;
    height: 80px;
  }
  
  .display-name {
    font-size: 1.5rem;
  }
  
  .stats-section {
    gap: 1rem;
  }
  
  .profile-actions {
    flex-wrap: wrap;
  }
  
  .users-grid {
    grid-template-columns: 1fr;
  }
  
  .tab-btn {
    padding: 0.75rem 1rem;
  }
}
</style>
