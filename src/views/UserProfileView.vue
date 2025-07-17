<!-- UserProfileView - Federated user profile page -->
<template>
  <!-- Mony Header -->
  <div class="mony-header-container">
    <MonyHeader
      :current-view="currentView"
      :is-mobile="isMobile"
      @switch-feed="handleSwitchFeed"
      @refresh-timeline="handleRefresh"
      @open-composer="handleOpenComposer"
      @open-search="handleOpenSearch"
      @toggle-left-sidebar="$emit('toggleLeftSidebar')"
      @toggle-right-sidebar="$emit('toggleRightSidebar')"
    />
  </div>
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
        <!-- Banner with gradient overlay -->
        <div class="profile-banner" :style="bannerStyle">
          <div class="banner-gradient"></div>
          
          <!-- Action buttons overlay on banner -->
          <div class="banner-actions">
            <button
              @click="mentionUser"
              class="banner-action-btn"
              title="Mention user"
            >
              <Icon name="at-sign" />
            </button>

            <div class="more-actions">
              <button
                @click="showActionsMenu = !showActionsMenu"
                class="banner-action-btn"
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
        
        <!-- Profile info container -->
        <div class="profile-info-container">
          <!-- Avatar section with status indicator -->
          <div class="avatar-container">
            <div class="avatar-wrapper">
              <Avatar 
                :src="user.avatar_url" 
                :alt="user.display_name"
                size="2xl" 
                class="profile-avatar"
              />
              <div v-if="!user.is_local" class="federation-badge" :title="`From ${user.domain}`">
                <Icon name="federation" size="12" />
              </div>
            </div>
          </div>

          <!-- Main profile content -->
          <div class="profile-main-content">
            <!-- Top row: Name/handle + Follow button -->
            <div class="profile-top-row">
              <div class="name-handle-section">
                <div class="display-name-row">
                  <h1 class="display-name">{{ user.display_name || user.username }}</h1>
                  <Icon v-if="(user as any).verified" name="verified" class="verified-icon" />
                  <span v-if="!user.is_local" class="domain-tag">{{ user.domain }}</span>
                </div>
                <p class="user-handle">{{ user.handle }}</p>
              </div>

              <!-- Primary action button -->
              <div class="primary-actions" v-if="!isCurrentUser">
                <button
                  @click="toggleFollow"
                  :disabled="isFollowLoading"
                  :class="['primary-action-btn', 'follow-btn', { following: isFollowing }]"
                >
                  <Icon v-if="isFollowLoading" name="loader" class="spinning" />
                  <Icon v-else-if="isFollowing" name="user-check" />
                  <Icon v-else name="user-plus" />
                  <span>{{ followButtonText }}</span>
                </button>
              </div>
            </div>

            <!-- Bio section -->
            <div v-if="user.bio" class="bio-section">
              <MonyContent :content="user.bio" />
            </div>

            <!-- Meta info row -->
            <div class="meta-info-row">
              <div v-if="user.created_at" class="join-date">
                <Icon name="calendar" :size="16" />
                <span>Joined {{ formatJoinDate(user.created_at) }}</span>
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
            <p>{{ isCurrentUser ? "You haven't" : `${(user?.display_name || user?.username) || 'Unknown User'} hasn't` }} posted anything yet.</p>
          </div>
          
          <div v-else class="posts-list">
            <MonyPost
              v-for="post in userPosts"
              data-timeline
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
            <p>{{ isCurrentUser ? "You're" : `${user?.display_name || user?.username} is` }} not following anyone yet.</p>
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
            <p>{{ isCurrentUser ? "You don't" : `${user?.display_name || user?.username} doesn't` }} have any followers yet.</p>
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
import { useLayoutState } from '@/composables/useLayoutState'
import { useUserData } from '@/composables/useUserData' 

import { activityPubService } from '@/services/activityPubService';
import { getBannerUrl } from '@/utils/bannerUtils';
import type { FederatedUser, TimelinePost } from '@/types';
import { format } from 'date-fns';

// Components
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import MonyPost from '@/components/activitypub/MonyPost.vue';
import MonyContent from '@/components/activitypub/MonyContent.vue';
import UserCard from '@/components/activitypub/UserCard.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

// Layout state
const { isMobile } = useLayoutState()

// Props
interface Props {
  profileHandle?: string;
  currentView?: string;
  viewType?: string;
  posts?: any[];
  isLoadingFeed?: boolean;
  hasMorePosts?: boolean;
  profileUser?: any;
  specialViewData?: any;
  hasMoreSpecialData?: boolean;
  postId?: string;
}

const props = withDefaults(defineProps<Props>(), {
  profileHandle: undefined,
  currentView: 'profile',
  viewType: 'profile',
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false,
  profileUser: undefined,
  specialViewData: undefined,
  hasMoreSpecialData: false,
  postId: undefined
});

// Emits
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  refreshTimeline: []
  postCreated: [post: any]
  switchFeed: [feed: string]
  replyToPost: [post: any]
  favoritePost: [postId: string]
  reblogPost: [postId: string]
  bookmarkPost: [postId: string]
  deletePost: [postId: string]
  showUserProfile: [user: any]
  loadMorePosts: []
  followUser: [userId: string]
  unfollowUser: [userId: string]
  clearAllBookmarks: []
  loadMoreSpecialData: []
  backToTimeline: []
}>()

// Stores
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const route = useRoute();
const router = useRouter();

// User data composable
const { getUserColor, getUserBannerUrl } = useUserData()

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
const hasMorePostsRef = ref(false);

// Social connections
const followingUsers = ref<FederatedUser[]>([]);
const followerUsers = ref<FederatedUser[]>([]);

// Computed properties
const hasMorePosts = computed(() => props.hasMorePosts || hasMorePostsRef.value);
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

const bannerUrl = computed(() => {
  if (!user.value) return null
  return getUserBannerUrl(user.value.id).value || (user.value as any).banner_url || null
})

const userColor = computed(() => {
  if (!user.value) return '#5865f2'
  return getUserColor(user.value.id).value || '#5865f2'
})

const bannerStyle = computed(() => {
  const banner = bannerUrl.value
  if (banner) {
    // Get optimized banner URL with proper resize (640x350 at 80% quality)
    const optimizedBanner = getBannerUrl(banner, { width: 640, height: 350, quality: 80 })
    return {
      backgroundImage: `url(${optimizedBanner || banner})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat'
    }
  }
  return {
    background: userColor.value || '#5865f2'
  }
})


//  someday i want to add this as an option, have the user choose
// const bannerGradientStyle = computed(() => {
//   const color = userColor.value || '#5865f2'
  
//   // Create a sophisticated gradient overlay using the user's color
//   return {
//     background: `
//       linear-gradient(
//         135deg,
//         rgba(0, 0, 0, 0.75) 0%,
//         ${color}40 15%,
//         ${color}20 80%,
//         rgba(0, 0, 0, 0.59) 100%
//       ),
//       linear-gradient(
//         45deg,
//         ${color}30 0%,
//         transparent 70%,
//         transparent 80%,
//         ${color}25 100%
//       )
//     `,
//     opacity: 1.0
//   }
// })
const handleRefresh = () => {
  console.log('🔄 Refreshing profile data...');
  loadUserProfile(currentHandle.value);
};

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
    
    // Check if it's a federated handle (contains @) or local handle
    if (handle.includes('@')) {
      console.log('🌐 Resolving federated user...');
      user.value = await activityPubService.getUserByHandle(handle);
    } else {
      console.log('👤 Looking up local user...');
      
      // For local users, try to get from activity pub service first
      try {
        console.log(`🔎 Fetching user by handle: @${handle}`);
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
            // Get accurate post count - use the same consistent approach
            let posts_count = 0;
            try {
              // Try to get a sample of posts to validate the user exists and has posts
              const userPostsSample = await activityPubService.getUserPosts(currentUser.id, { limit: 5 });
              posts_count = userPostsSample?.length || 0;
              console.log(`📊 Post count sample: ${posts_count} (this will be updated after full posts load)`);
            } catch (error) {
              console.log('Could not get post count, using 0 as default:', error);
              posts_count = 0;
            }
            
            user.value = {
              id: currentUser.id,
              username: profile.username || currentUsername,
              domain: 'har.mony.lol',
              handle: `@${profile.username || currentUsername}@har.mony.lol`,
              display_name: profile.display_name || profile.username || currentUsername,
              avatar_url: profile.avatar_url || currentUser.user_metadata?.avatar_url || '/default_avatar.png',
              bio: profile.bio || 'Monyverse user',
              is_local: true,
              followers_count: activityPubStore.followersCount || 0,
              following_count: activityPubStore.followingCount || 0,
              posts_count: posts_count,
              created_at: profile.created_at || currentUser.created_at || new Date().toISOString(),
              updated_at: profile.updated_at || new Date().toISOString()
            };
            
            console.log(`✅ Created user object with ActivityPub counts:`, {
              followers_count: user.value.followers_count,
              following_count: user.value.following_count,
              posts_count: user.value.posts_count
            });
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
      console.log('📊 User stats:', {
        posts: user.value.posts_count,
        following: user.value.following_count,
        followers: user.value.followers_count
      });
      await loadUserPosts();
      await loadFollowing();
      await loadFollowers();
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
    console.log(`📝 Loading posts for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Use consistent getUserPosts method for all users
    // This ensures the same data structure and behavior regardless of whether it's the current user or not
    const posts = await activityPubService.getUserPosts(user.value.id, { limit: 20 });
    userPosts.value = posts as TimelinePost[] || [];
    
    hasMorePostsRef.value = posts && posts.length >= 20; // Enable pagination if we got a full page
    console.log(`📊 Loaded ${userPosts.value.length} posts for ${user.value.username}`);
    
    // Update post count for current user with actual loaded posts
    if (isCurrentUser.value && user.value) {
      user.value.posts_count = userPosts.value.length;
    }
    
    // Safe debugging with error handling
    try {
      console.log('📋 Posts sample:', userPosts.value.slice(0, 3).map(p => ({ 
        id: p.id, 
        content: p.content ? (typeof p.content === 'string' ? (p.content as string).substring(0, 50) : JSON.stringify(p.content).substring(0, 50)) : 'No content',
        content_type: typeof p.content,
        author: p.author?.username || p.author_id,
        visibility: p.visibility,
        created_at: p.created_at
      })));
    } catch (debugError) {
      console.log('📋 Posts debug error:', debugError);
      console.log('📋 Raw posts data:', userPosts.value.slice(0, 2));
    }
  } catch (error) {
    console.error('❌ Failed to load user posts:', error);
    userPosts.value = [];
    hasMorePostsRef.value = false;
  } finally {
    isLoadingPosts.value = false;
  }
};

const loadFollowing = async () => {
  if (!user.value) return;
  
  try {
    console.log(`👥 Loading following for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Use consistent getFollowing method for all users
    // This ensures the same data structure and behavior regardless of whether it's the current user or not
    const following = await activityPubService.getFollowing(user.value.id, { limit: 50 });
    followingUsers.value = following || [];
    
    console.log(`📊 Loaded ${followingUsers.value.length} following for ${user.value.username}`);
    console.log('👥 Following users:', followingUsers.value.map(u => u.display_name || u.username));
    
    // Update following count with actual loaded data
    if (user.value) {
      user.value.following_count = followingUsers.value.length;
    }
  } catch (error) {
    console.error('❌ Failed to load following:', error);
    followingUsers.value = [];
  }
};

const loadFollowers = async () => {
  if (!user.value) return;
  
  try {
    console.log(`👥 Loading followers for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Use consistent getFollowers method for all users
    // This ensures the same data structure and behavior regardless of whether it's the current user or not
    const followers = await activityPubService.getFollowers(user.value.id, { limit: 50 });
    followerUsers.value = followers || [];
    
    console.log(`📊 Loaded ${followerUsers.value.length} followers for ${user.value.username}`);
    console.log('👥 Follower users:', followerUsers.value.map(u => u.display_name || u.username));
    
    // Update followers count with actual loaded data
    if (user.value) {
      user.value.followers_count = followerUsers.value.length;
    }
    isLoading.value = false;
  } catch (error) {
    console.error('❌ Failed to load followers:', error);
    followerUsers.value = [];
  }
};

const loadMorePosts = async () => {
  if (!user.value || isLoadingPosts.value || !hasMorePostsRef.value) return;
  
  isLoadingPosts.value = true;
  try {
    console.log(`📖 Loading more posts for user: ${user.value.username}`);
    
    // Get the oldest post's created_at as max_id for pagination
    const oldestPost = userPosts.value[userPosts.value.length - 1];
    const maxId = oldestPost?.created_at;
    
    if (!maxId) {
      console.log('❌ No max_id found for pagination');
      hasMorePostsRef.value = false;
      return;
    }
    
    const posts = await activityPubService.getUserPosts(user.value.id, { 
      limit: 20, 
      max_id: maxId 
    });
    
    if (posts && posts.length > 0) {
      userPosts.value.push(...(posts as TimelinePost[]));
      hasMorePostsRef.value = posts.length >= 20; // Continue pagination if we got a full page
      console.log(`📊 Loaded ${posts.length} more posts. Total: ${userPosts.value.length}`);
    } else {
      hasMorePostsRef.value = false;
      console.log('📭 No more posts available');
    }
  } catch (error) {
    console.error('❌ Failed to load more posts:', error);
    hasMorePostsRef.value = false;
  } finally {
    isLoadingPosts.value = false;
  }
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

  // Navigate to Social Home
  router.push('/social/home');
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
  // Clean the handle for routing - remove leading @ and ensure proper format
  let handle = clickedUser.handle.replace(/^@/, ''); // Remove leading @
  
  // For routing, we need clean handles without domain for local users
  if (handle.endsWith('@har.mony.lol')) {
    handle = handle.replace('@har.mony.lol', '');
  }
  
  console.log(`🔗 Navigating to profile: ${handle} (from ${clickedUser.handle})`);
  console.log(`📍 Current route before navigation:`, route.path);
  
  // Use named route navigation to ensure proper handling
  router.push({ 
    name: 'UserProfile', 
    params: { handle: encodeURIComponent(handle) } 
  }).then(() => {
    console.log(`✅ Navigation completed to: /social/profile/${handle}`);
  }).catch((error) => {
    console.error(`❌ Navigation failed:`, error);
  });
};

const replyToPost = (post: TimelinePost) => {
  // activityPubStore.openComposer({
  //   replyTo: post.id,
  //   content: `${post.author.handle} `
  // });
  // router.push('/monyverse');
  // emit('replyToPost', post);
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

// Get the handle from props or route params
const currentHandle = computed(() => {
  return props.profileHandle || (route.params.handle as string);
});

// Watch for handle changes (from both props and route)
watch(currentHandle, (newHandle, oldHandle) => {
  console.log(`👤 Profile handle changed from ${oldHandle} to ${newHandle}`);
  console.log(`📍 Current route:`, route.path);
  console.log(`🏷️ Props handle:`, props.profileHandle);
  console.log(`🔗 Route handle:`, route.params.handle);
  
  if (newHandle && typeof newHandle === 'string') {
    loadUserProfile(newHandle);
  }
}, { immediate: true });

// Watch route changes specifically (for direct URL access)
watch(() => route.params.handle, (newHandle) => {
  console.log(`🔗 Route handle changed to: ${newHandle}`);
  console.log(`📍 Full route path:`, route.path);
  console.log(`🎯 Route name:`, route.name);
  
  if (newHandle && typeof newHandle === 'string' && !props.profileHandle) {
    loadUserProfile(newHandle);
  }
}, { immediate: true });

// Ensure profile loads on mount
onMounted(() => {
  const handle = currentHandle.value;
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

// MonyHeader event handlers
const handleSwitchFeed = (feed: string) => {
  router.push({ name: 'Social', params: { timeline: feed } })
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handleOpenSearch = () => {
  // TODO: Implement search functionality
  console.log('Open search')
}

document.addEventListener('click', handleClickOutside);
</script>

<style scoped>
.user-profile-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.mony-header-container {
  flex-shrink: 0;
}
.user-profile-view {
  height: 100vh;
  background: var(--background-primary);
  color: white;
  overflow-y: auto;
  overflow-x: hidden;
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

.profile-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.profile-header {
  position: relative;
  flex-shrink: 0;
}

.profile-banner {
  height: 300px;
  background: linear-gradient(135deg, #5865f2, #7289da);
  background-size: cover;
  background-position: center;
  position: relative;
  overflow: hidden;
}

.banner-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, 
    rgba(0, 0, 0, 0.1) 0%, 
    rgba(0, 0, 0, 0.2) 50%, 
    rgba(0, 0, 0, 0.4) 100%
  );
}

.banner-actions {
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: flex;
  gap: 0.5rem;
  z-index: 2;
}

.banner-action-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.banner-action-btn:hover {
  background: rgba(0, 0, 0, 0.6);
  border-color: rgba(255, 255, 255, 0.25);
  transform: scale(1.05);
}

.profile-info-container {
  background: var(--h-sidebar, #2b2d31);
  position: relative;
  padding: 0 1.5rem 1.5rem;
  z-index: 2;
}

.avatar-container {
  position: relative;
  margin-top: -50px;
  margin-bottom: 1rem;
  z-index: 3;
}

.avatar-wrapper {
  position: relative;
  display: inline-block;
}

.profile-avatar {
  border: 4px solid var(--h-sidebar, #2b2d31);
  border-radius: 50%;
  background: var(--h-sidebar, #2b2d31);
}

.federation-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #1d9bf0;
  border: 2px solid var(--h-sidebar, #2b2d31);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 10px;
}

.profile-main-content {
  flex: 1;
}

.profile-top-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
}

.name-handle-section {
  flex: 1;
  min-width: 0;
}

.display-name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  flex-wrap: wrap;
}

.display-name {
  font-size: 1.5rem;
  font-weight: 800;
  color: white;
  margin: 0;
  line-height: 1.2;
}

.verified-icon {
  color: #1d9bf0;
  flex-shrink: 0;
}

.domain-tag {
  background: rgba(29, 155, 240, 0.1);
  color: #1d9bf0;
  padding: 0.125rem 0.375rem;
  border-radius: 8px;
  font-size: 0.7rem;
  font-weight: 500;
  border: 1px solid rgba(29, 155, 240, 0.2);
  text-transform: lowercase;
}

.user-handle {
  color: #b9bbbe;
  font-size: 1rem;
  margin: 0;
  font-weight: 400;
}

.primary-actions {
  flex-shrink: 0;
}

.primary-action-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: white;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 20px;
  color: #000;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 700;
  font-size: 0.9rem;
  min-width: 100px;
  justify-content: center;
}

.primary-action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.9);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.primary-action-btn.following {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: white;
}

.primary-action-btn.following:hover:not(:disabled) {
  background: rgba(242, 63, 66, 0.15);
  border-color: #f23f42;
  color: #f23f42;
  box-shadow: 0 4px 12px rgba(242, 63, 66, 0.2);
}

.primary-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.bio-section {
  margin-bottom: 1rem;
  font-size: 0.95rem;
  line-height: 1.5;
  color: #dcddde;
}

.meta-info-row {
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.join-date {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #b9bbbe;
  font-size: 0.875rem;
  width: 100%;
}

.stats-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}

.stat-button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0.125rem 0.25rem;
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  transition: all 0.2s ease;
  border-radius: 4px;
  text-decoration: none;
}

.stat-button:hover {
  text-decoration: underline;
}

.stat-button.active strong {
  color: var(--h-brand, #5865f2);
}

.stat-button.active span {
  color: var(--h-brand, #5865f2);
}

.stat-button strong {
  font-size: 0.95rem;
  font-weight: 700;
  color: white;
  line-height: 1.2;
}

.stat-button span {
  font-size: 0.95rem;
  color: #b9bbbe;
  font-weight: 400;
}

.more-actions {
  position: relative;
}

.actions-menu {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  width: 200px;
  background: var(--h-sidebar, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 0.5rem;
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
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
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
  font-size: 0.9rem;
}

.action-item:hover {
  background: rgba(255, 255, 255, 0.1);
}

.action-item.active {
  color: var(--h-brand, #5865f2);
  background: rgba(88, 101, 242, 0.1);
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
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 10;
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
  min-height: 400px;
  flex: 1;
  overflow-y: auto;
}

.posts-tab,
.following-tab,
.followers-tab {
  padding: 1.5rem;
  padding-bottom: 100px;
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
  .profile-content {
    height: auto;
  }
  .profile-banner {
    height: 150px;
  }
  
  .profile-info-container {
    padding: 0 1rem 1rem;
  }
  
  .avatar-container {
    margin-top: -35px;
  }
  
  .display-name {
    font-size: 1.25rem;
  }
  
  .profile-top-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }
  
  .primary-action-btn {
    width: 100%;
    justify-content: center;
  }
  
  .stats-row {
    gap: 1rem;
  }
  
  .banner-actions {
    top: 0.75rem;
    right: 0.75rem;
    gap: 0.375rem;
  }
  
  .banner-action-btn {
    width: 32px;
    height: 32px;
  }
  
  .users-grid {
    grid-template-columns: 1fr;
  }
  .posts-tab, .following-tab, .followers-tab {
    padding: 0.75rem 1rem;
  }

  .profile-tabs {
    flex-direction: row;
    width: 100%;
    justify-content: stretch;
    max-width: 100%;
  }
  .tab-btn {
    flex: 1 1 0;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
    text-align: center;
    min-width: 0;
    flex-direction:column
  }
  
  .actions-menu {
    right: -0.5rem;
    width: 180px;
  }
}
</style>
