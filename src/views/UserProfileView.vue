<!-- UserProfileView - Federated user profile page -->
<template>
  <div class="user-profile-wrapper">
    <!-- Mony Header -->
    <div class="mony-header-container">
      <MonyHeader
        :current-view="currentView"
        :is-mobile="isMobile"
        :right-sidebar-open="props.rightSidebarOpen ?? false"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefresh"
        @open-composer="handleOpenComposer"
        @open-search="handleOpenSearch"
        @toggle-left-sidebar="emit('toggleLeftSidebar')"
        @toggle-right-sidebar="emit('toggleRightSidebar')"
      />
    </div>

    <!-- Main Content -->
    <div 
      ref="scrollContainerRef"
      class="user-profile-view"
      @scroll="handleScroll"
    >
      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="32" />
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

              <div class="more-actions" ref="moreActionsBtnRef">
                <button
                  @click.stop="toggleActionsMenu"
                  class="banner-action-btn"
                  title="More actions"
                >
                  <Icon name="more-horizontal" />
                </button>
                
                <Teleport to="body">
                  <div v-if="showActionsMenu" class="actions-menu actions-menu-teleported" :style="actionsMenuStyle" v-click-outside="() => showActionsMenu = false">
                  <!-- View in remote instance (for federated users) -->
                  <a 
                    v-if="!user.is_local && remoteProfileUrl" 
                    :href="remoteProfileUrl" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    class="action-item"
                    @click="showActionsMenu = false"
                  >
                    <Icon name="external-link" />
                    <span>View on {{ user.domain }}</span>
                  </a>
                  
                  <div v-if="!user.is_local && remoteProfileUrl" class="action-divider"></div>
                  
                  <button @click="handleMute" class="action-item" :class="{ active: isMuted }">
                    <Icon name="volume-x" />
                    <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
                  </button>
                  
                  <button @click="handleBlock" class="action-item danger" :class="{ active: isBlocked }">
                    <Icon name="user-x" />
                    <span>{{ isBlocked ? 'Unblock' : 'Block' }}</span>
                  </button>
                  
                  <button @click="handleReport" class="action-item danger">
                    <Icon name="flag" />
                    <span>Report</span>
                  </button>
                </div>
                </Teleport>
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
                  :alt="plainDisplayName"
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
                    <h1 class="display-name">
                      <DisplayName :userId="user.id" :fallback="user.display_name || user.username" />
                    </h1>
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

              <!-- Profile Fields (ActivityPub PropertyValue) -->
              <div v-if="userFields?.length" class="profile-fields-section">
                <div class="profile-fields-grid">
                  <div v-for="field in userFields" :key="field.name" class="profile-field-item">
                    <span class="field-label">{{ field.name }}</span>
                    <span class="field-value" v-html="formatFieldValue(field.value)"></span>
                  </div>
                </div>
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
          <!-- Blocked User Banner (like Twitter) -->
          <div v-if="isBlocked && !isCurrentUser" class="blocked-user-banner">
            <div class="blocked-banner-content">
              <Icon name="user-x" :size="48" class="blocked-icon" />
              <h3>You blocked @{{ user?.username }}</h3>
              <p>You can't view or interact with their posts.</p>
              <button @click="handleBlock" class="unblock-btn">
                Unblock
              </button>
            </div>
          </div>
          
          <!-- Posts Tab (hidden if blocked) -->
          <div v-else-if="activeTab === 'posts'" class="posts-tab">
            <!-- Pinned Posts -->
            <div v-if="pinnedPosts.length > 0" class="pinned-posts-section">
              <!-- MonyPost emits `delete`/`edit` as bare ids and doesn't
                   emit favorite/reblog/bookmark at all (handled internally).
                   Our handlers want the full post (so they can update the
                   local list), so adapt via the loop variable here. -->
              <MonyPost
                v-for="post in pinnedPosts"
                :key="post.id"
                :post="post"
                show-pinned-header
                @reply="replyToPost"
                @favorite="handleFavorite(post)"
                @reblog="handleReblog(post)"
                @bookmark="handleBookmark(post)"
                @delete="handleDelete(post)"
                @user-click="showUserProfile"
                @hashtag-click="navigateToHashtag"
                @show-conversation="showConversation"
              />
            </div>

            <PostsContainer
              :posts="unpinnedUserPosts"
              :is-loading="isLoadingPosts"
              :has-more="hasMorePosts"
              :empty-title="t('activitypub.noMoniesHereYet')"
              :empty-message="(isCurrentUser ? 'You haven\'t' : `${plainDisplayName} hasn\'t`) + ' posted anything yet.'"
              empty-icon="message-circle"
              @load-more="loadMorePosts"
              @reply="replyToPost"
              @favorite="handleFavorite"
              @reblog="handleReblog"
              @bookmark="handleBookmark"
              @delete="handleDelete"
              @user-click="showUserProfile"
              @hashtag-click="navigateToHashtag"
              @show-conversation="showConversation"
            />
          </div>

          <!-- Following Tab -->
          <div v-else-if="activeTab === 'following'" class="following-tab">
            <div v-if="followingUsers.length === 0" class="empty-state">
              <Icon name="users" :size="48" />
              <h3>{{ t('activitypub.notFollowingAnyone') }}</h3>
              <p>{{ isCurrentUser ? t('activitypub.notFollowingAnyoneYet') : `${plainDisplayName} ${t('activitypub.notFollowingAnyoneYet')}` }}</p>
            </div>
            
            <div v-else class="users-grid">
              <ProfileCard
                v-for="followedUser in followingUsers"
                :key="followedUser.id"
                :user="followedUser"
                :is-compact="true"
                @click="showUserProfile"
              />
            </div>
          </div>

          <!-- Followers Tab -->
          <div v-else-if="activeTab === 'followers'" class="followers-tab">
            <div v-if="followerUsers.length === 0" class="empty-state">
              <Icon name="users" :size="48" />
              <h3>No followers</h3>
              <p>{{ isCurrentUser ? "You don't" : `${plainDisplayName} doesn't` }} have any followers yet.</p>
            </div>
            
            <div v-else class="users-grid">
              <ProfileCard
                v-for="follower in followerUsers"
                :key="follower.id"
                :user="follower"
                :is-compact="true"
                @click="showUserProfile"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- User Profile Modal -->
  <UserProfileModal
    :show="showProfileModal"
    :user="selectedModalUser"
    @close="showProfileModal = false; selectedModalUser = null"
  />

  <ReportModal
    v-if="showReportModal && user"
    report-type="user"
    :target-user-id="user.id"
    :target-user="{ username: user.username, display_name: user.display_name, avatar_url: user.avatar_url }"
    @close="showReportModal = false"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { debug } from '@/utils/debug'
import { throttle } from '@/utils/throttle'
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { usePostReactionsStore } from '@/stores/postReactions';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import { useLayoutState } from '@/composables/useLayoutState'
import { useUserData } from '@/composables/useUserData'
import { useFeedRealtime, type FeedKind } from '@/composables/useFeedRealtime'

const { t } = useI18n(); 

import { activityPubService } from '@/services/activityPubService';
import { services } from '@/services';
import { getBannerUrl } from '@/utils/bannerUtils';
import { getOriginalPost, getOriginalPostId } from '@/utils/postReblog';
import type { FederatedUser, TimelinePost } from '@/types';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';

// Components
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DisplayName from '@/components/DisplayName.vue'
import MonyContent from '@/components/activitypub/MonyContent.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import PostsContainer from '@/components/common/PostsContainer.vue';
import ProfileCard from '@/components/common/ProfileCard.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
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
  leftSidebarOpen?: boolean;
  rightSidebarOpen?: boolean;
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
  postId: undefined,
  leftSidebarOpen: false,
  rightSidebarOpen: false
});

// Emits - Define the component events
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  refreshTimeline: []
  openSearch: []
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
const { blockedUsers, mutedUsers } = storeToRefs(activityPubStore);
const authStore = useAuthStore();
const profileStore = useProfileStore();
const route = useRoute();
const router = useRouter();

// User data composable
const { getUserColor, getUserBannerUrl } = useUserData()

// Header and scroll state
const scrollContainerRef = ref<HTMLElement | null>(null);
const isScrolled = ref(false);

// State
const user = ref<FederatedUser | null>(null);
const isLoading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref('posts');
const showActionsMenu = ref(false);
const moreActionsBtnRef = ref<HTMLElement | null>(null);
const actionsMenuStyle = ref<Record<string, string>>({});
const isFollowLoading = ref(false);

const toggleActionsMenu = () => {
  if (!showActionsMenu.value && moreActionsBtnRef.value) {
    const rect = moreActionsBtnRef.value.getBoundingClientRect();
    actionsMenuStyle.value = {
      top: `${rect.bottom + 8}px`,
      right: `${window.innerWidth - rect.right}px`,
    };
  }
  showActionsMenu.value = !showActionsMenu.value;
};

// Posts
const userPosts = ref<TimelinePost[]>([]);
const pinnedPosts = ref<TimelinePost[]>([]);
const isLoadingPosts = ref(false);
const hasMorePostsRef = ref(false);
const remoteOutboxUrl = ref<string | null>(null); // For remote user pagination
const oldestRemotePostId = ref<string | null>(null); // Track oldest post for pagination
const isLoadingMoreRemote = ref(false);

// Realtime — anyone viewing this profile (including the author on another
// tab) gets prepends/edits/deletes via `feed:user:{profile_id}`. The DB
// trigger publishes every post event for this author there; the kind ref
// changes when the route param changes so navigation cleanly re-subscribes.
const feedKind = computed<FeedKind>(
  () => (user.value?.id ? `user:${user.value.id}` as const : 'home')
)
useFeedRealtime(feedKind, {
  onCreate: async (event) => {
    if (event.author_id !== user.value?.id) return
    if (userPosts.value.some(p => p.id === event.id)) return
    const fullPost = await activityPubService.loadPostWithAuthor(event.id)
    if (!fullPost) return
    userPosts.value = [fullPost as TimelinePost, ...userPosts.value]
    if (user.value) user.value.posts_count = (user.value.posts_count ?? 0) + 1
  },
  onUpdate: (event) => {
    if (event.author_id !== user.value?.id) return
    // We don't get content in the broadcast payload, just metadata —
    // visibility downgrades remove the post; content edits are reflected
    // via the per-post component refetch already in place. Skip noisy
    // count-update echoes here too.
    if (event.visibility === 'direct' || event.visibility === 'private') {
      userPosts.value = userPosts.value.filter(p => p.id !== event.id)
    }
  },
  onDelete: (event) => {
    if (event.author_id !== user.value?.id) return
    const before = userPosts.value.length
    userPosts.value = userPosts.value.filter(p => p.id !== event.id)
    if (user.value && before !== userPosts.value.length) {
      user.value.posts_count = Math.max(0, (user.value.posts_count ?? 1) - 1)
    }
  },
})

// Social connections
const followingUsers = ref<FederatedUser[]>([]);
const followerUsers = ref<FederatedUser[]>([]);

// Modal state
const showProfileModal = ref(false);
const selectedModalUser = ref<FederatedUser | null>(null);

// Computed properties
const plainDisplayName = computed(() => {
  const dn: unknown = user.value?.display_name
  if (!dn) return user.value?.username || 'Unknown User'
  if (typeof dn === 'string') return dn
  if (Array.isArray(dn)) {
    return (dn as any[]).map((part: any) => typeof part === 'string' ? part : (part.text || part.content || '')).join('')
  }
  return String(dn)
})

const hasMorePosts = computed(() => props.hasMorePosts || hasMorePostsRef.value);
const pinnedPostIds = computed(() => new Set(pinnedPosts.value.map(p => p.id)));
const unpinnedUserPosts = computed(() => userPosts.value.filter(p => !pinnedPostIds.value.has(p.id)));
const profileTabs = computed(() => [
  { 
    id: 'posts', 
    label: t('activitypub.monies'), 
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
  if (!user.value) return '#0EA5E9'
  return getUserColor(user.value.id).value || '#0EA5E9'
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
    background: userColor.value || '#0EA5E9'
  }
})

// Scroll handling with infinite scroll for posts
const handleScroll = throttle(() => {
  if (!scrollContainerRef.value) return;
  
  const container = scrollContainerRef.value;
  const scrollTop = container.scrollTop;
  isScrolled.value = scrollTop > 50;
  
  if (activeTab.value === 'posts' && !isLoadingPosts.value && !isLoadingMoreRemote.value) {
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    if (distanceFromBottom < 300 && hasMorePostsRef.value) {
      loadMorePosts();
    }
  }
}, 100);

// Header event handlers
const handleSwitchFeed = (feed: string) => {
  router.push({ name: 'Social', params: { timeline: feed } })
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}

const handleOpenSearch = () => {
  emit('openSearch')
}

const handleRefresh = () => {
  const handle = currentHandle.value;
  const isRemote = handle.includes('@') && !handle.endsWith('@' + import.meta.env.VITE_DOMAIN as string);
  debug.log(`🔄 Refreshing profile data...${isRemote ? ' (force refresh for remote user)' : ''}`);
  loadUserProfile(handle, isRemote); // Force refresh for remote users
};

// Computed
const isCurrentUser = computed(() => {
  return authStore.session?.user?.id === user.value?.id;
});

const isFollowing = computed(() => {
  return user.value ? activityPubStore.isFollowing(user.value.id) : false;
});

const isMuted = computed(() => {
  if (!user.value) return false;
  return mutedUsers.value.has(user.value.id);
});

const isBlocked = computed(() => {
  if (!user.value) return false;
  return blockedUsers.value.has(user.value.id);
});

// Remote profile URL for "View on remote instance" link
const remoteProfileUrl = computed(() => {
  if (!user.value || user.value.is_local) return null;
  
  // If we have a stored URL from the ActivityPub actor
  if ((user.value as any).url) {
    return (user.value as any).url;
  }
  
  // If we have the federated_id (ActivityPub actor URL)
  if (user.value.federated_id) {
    return user.value.federated_id;
  }
  
  // Fallback: construct URL (works for most Mastodon-compatible instances)
  return `https://${user.value.domain}/@${user.value.username}`;
});

const followButtonText = computed(() => {
  if (isFollowLoading.value) return 'Loading...';
  return isFollowing.value ? 'Following' : 'Follow';
});

// Profile fields from ActivityPub PropertyValue attachments
const userFields = computed(() => {
  if (!user.value) return [];
  const u = user.value as any;
  return u.fields || u.profile_fields || [];
});

const formatFieldValue = (value: string): string => {
  if (!value) return '';
  // ActivityPub PropertyValue fields are attacker-controlled (remote profile).
  // DOMPurify strips disallowed tags AND dangerous URI schemes (javascript:, data:, etc.)
  // from href/src by default. ALLOWED_URI_REGEXP enforces http(s)/mailto only.
  const sanitized = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: ['a', 'br', 'span', 'em', 'strong', 'b', 'i'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
  });
  // Force-add rel/target on links so external profile links don't leak window.opener
  // and open in a new tab. DOMPurify's afterSanitizeAttributes hook would also work,
  // but a single regex pass is fine here since the input is already sanitized.
  return sanitized.replace(/<a\b(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer nofollow"');
};

// Methods
const formatJoinDate = (dateString: string): string => {
  return format(new Date(dateString), 'MMMM yyyy');
};

const loadUserProfile = async (handle: string, forceRefresh: boolean = false) => {
  debug.log(`🔄 Loading profile for handle: ${handle}${forceRefresh ? ' (force refresh)' : ''}`);
  isLoading.value = true;
  error.value = null;
  user.value = null; // Clear previous user data
  
  try {
    // Clean the handle
    if (handle.startsWith('@')) {
      handle = handle.substring(1);
    }
    
    debug.log(`🔍 Processing handle: ${handle}`);
    
    // Check if it's a federated handle (contains @) or local handle
    if (handle.includes('@')) {
      debug.log(`🌐 Resolving federated user...${forceRefresh ? ' (force refresh)' : ''}`);
      user.value = await activityPubService.getUserByHandle(handle, forceRefresh);
      
      // Save outbox URL for remote pagination (if remote user)
      if (user.value && !user.value.is_local && (user.value as any).outbox_url) {
        remoteOutboxUrl.value = (user.value as any).outbox_url;
        debug.log(`📬 Saved outbox URL for remote pagination: ${remoteOutboxUrl.value}`);
      }
    } else {
      debug.log('👤 Looking up local user...');
      
      // For local users, try to get from activity pub service first
      try {
        debug.log(`🔎 Fetching user by handle: @${handle}`);
        user.value = await activityPubService.getUserByHandle(`@${handle}`);
      } catch (localError) {
        debug.log('⚠️ ActivityPub lookup failed, trying profile service...');
        
        // Fallback: check if this is the current user
        const currentUser = authStore.session?.user;
        const currentUsername = currentUser?.user_metadata?.username || currentUser?.email?.split('@')[0];
        
        if (currentUser && currentUsername === handle) {
          debug.log('✅ Loading current user profile...');
          
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
              debug.log(`📊 Post count sample: ${posts_count} (this will be updated after full posts load)`);
            } catch (error) {
              debug.log('Could not get post count, using 0 as default:', error);
              posts_count = 0;
            }
            
            user.value = {
              id: currentUser.id,
              username: profile.username || currentUsername,
              domain: import.meta.env.VITE_DOMAIN as string,
              handle: `@${profile.username || currentUsername}@${import.meta.env.VITE_DOMAIN as string}`,
              display_name: profile.display_name || profile.username || currentUsername,
              avatar_url: profile.avatar_url || currentUser.user_metadata?.avatar_url || '/default_avatar.webp',
              bio: profile.bio || 'Monyverse user',
              is_local: true,
              followers_count: activityPubStore.followersCount || 0,
              following_count: activityPubStore.followingCount || 0,
              posts_count: posts_count,
              created_at: profile.created_at || currentUser.created_at || new Date().toISOString(),
              updated_at: profile.updated_at || new Date().toISOString()
            };
            
            debug.log(`✅ Created user object with ActivityPub counts:`, {
              followers_count: user.value.followers_count,
              following_count: user.value.following_count,
              posts_count: user.value.posts_count
            });
          }
        } else {
          // Try to find user by username in the system
          debug.log('🔎 Searching for user in system...');
          
          // Create a basic user object for display
          user.value = {
            id: handle,
            username: handle,
            domain: import.meta.env.VITE_DOMAIN as string,
            handle: `@${handle}@${import.meta.env.VITE_DOMAIN as string}`,
            display_name: handle,
            avatar_url: '/default_avatar.webp',
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
      debug.log('✅ User profile loaded:', user.value.display_name);
      debug.log('📊 User stats:', {
        posts: user.value.posts_count,
        following: user.value.following_count,
        followers: user.value.followers_count
      });
      // Load posts, pinned posts, following, and followers in parallel
      await Promise.all([
        loadUserPosts(),
        loadPinnedPosts(),
        loadFollowing(),
        loadFollowers()
      ]);
    } else {
      debug.log('❌ User not found');
      error.value = 'User not found';
    }
  } catch (err) {
    debug.error('❌ Failed to load user profile:', err);
    error.value = 'Failed to load profile. The user might not exist or be unavailable.';
  } finally {
    isLoading.value = false;
  }
};

const loadUserPosts = async (retryCount = 0) => {
  if (!user.value) return;
  
  isLoadingPosts.value = true;
  try {
    debug.log(`📝 Loading posts for user: ${user.value.username} (ID: ${user.value.id})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
    
    // Use consistent getUserPosts method for all users
    const posts = await activityPubService.getUserPosts(user.value.id, { limit: 20 });
    userPosts.value = posts as TimelinePost[] || [];
    
    // For remote users, always enable "load more" since we can fetch from their outbox
    // For local users, enable if we got a full page
    if (!user.value.is_local && remoteOutboxUrl.value) {
      hasMorePostsRef.value = true; // Remote users can always have more posts to fetch
      debug.log(`📬 Remote user - enabling infinite scroll (outbox: ${remoteOutboxUrl.value})`);
    } else {
      hasMorePostsRef.value = posts && posts.length >= 20;
    }
    debug.log(`📊 Loaded ${userPosts.value.length} posts for ${user.value.username}`);

    // Batch-load reactions to prevent N+1 per-post queries
    if (userPosts.value.length > 0) {
      const postReactionsStore = usePostReactionsStore();
      const postIds = userPosts.value.map(p => p.id);
      postReactionsStore.fetchMultiplePostReactions(postIds, true);
      activityPubStore.batchFetchRemoteReactions(userPosts.value);
    }
    
    // For remote users with no posts initially, poll a few times as background fetch may still be running
    if (!user.value.is_local && userPosts.value.length === 0 && retryCount < 3) {
      debug.log(`📬 No posts yet for remote user, will retry in 2s (attempt ${retryCount + 1}/3)`);
      setTimeout(() => {
        loadUserPosts(retryCount + 1);
      }, 2000);
      return; // Don't set isLoadingPosts to false yet
    }
    
    // Update post count for current user with actual loaded posts
    if (isCurrentUser.value && user.value) {
      user.value.posts_count = userPosts.value.length;
    }
    
    // Safe debugging with error handling
    try {
      debug.log('📋 Posts sample:', userPosts.value.slice(0, 3).map(p => ({ 
        id: p.id, 
        content: p.content ? (typeof p.content === 'string' ? (p.content as string).substring(0, 50) : JSON.stringify(p.content).substring(0, 50)) : 'No content',
        content_type: typeof p.content,
        author: p.author?.username || p.author_id,
        visibility: p.visibility,
        created_at: p.created_at
      })));
    } catch (debugError) {
      debug.log('📋 Posts debug error:', debugError);
      debug.log('📋 Raw posts data:', userPosts.value.slice(0, 2));
    }
  } catch (error) {
    debug.error('❌ Failed to load user posts:', error);
    userPosts.value = [];
    hasMorePostsRef.value = false;
  } finally {
    // Only stop loading indicator if we're not retrying
    if (retryCount >= 3 || userPosts.value.length > 0 || user.value?.is_local) {
      isLoadingPosts.value = false;
    }
  }
};

const loadFollowing = async () => {
  if (!user.value) return;
  
  try {
    debug.log(`👥 Loading following for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Use consistent getFollowing method for all users
    // This ensures the same data structure and behavior regardless of whether it's the current user or not
    const following = await activityPubService.getFollowing(user.value.id, { limit: 50 });
    followingUsers.value = following || [];
    
    debug.log(`📊 Loaded ${followingUsers.value.length} following for ${user.value?.username || 'unknown'}`);
    debug.log('👥 Following users:', followingUsers.value.map(u => u?.display_name || u?.username || 'Unknown'));
    
    // Update following count with actual loaded data
    if (user.value) {
      user.value.following_count = followingUsers.value.length;
    }
  } catch (error) {
    debug.error('❌ Failed to load following:', error);
    followingUsers.value = [];
  }
};

const loadFollowers = async () => {
  if (!user.value) return;
  
  try {
    debug.log(`👥 Loading followers for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Use consistent getFollowers method for all users
    // This ensures the same data structure and behavior regardless of whether it's the current user or not
    const followers = await activityPubService.getFollowers(user.value.id, { limit: 50 });
    followerUsers.value = followers || [];
    
    debug.log(`📊 Loaded ${followerUsers.value.length} followers for ${user.value?.username || 'unknown'}`);
    debug.log('👥 Follower users:', followerUsers.value.map(u => u?.display_name || u?.username || 'Unknown'));
    
    // Don't override the database count - trust profiles.followers_count
    isLoading.value = false;
  } catch (error) {
    debug.error('❌ Failed to load followers:', error);
    followerUsers.value = [];
  }
};

const loadPinnedPosts = async () => {
  if (!user.value) return;
  try {
    const posts = await services.posts.getPinnedPosts(user.value.id);
    pinnedPosts.value = posts as TimelinePost[] || [];
    debug.log(`📌 Loaded ${pinnedPosts.value.length} pinned posts for ${user.value.username}`);
  } catch (err) {
    debug.error('Failed to load pinned posts:', err);
    pinnedPosts.value = [];
  }
};

const loadMorePosts = async () => {
  if (!user.value || isLoadingPosts.value || isLoadingMoreRemote.value || !hasMorePostsRef.value) return;
  
  isLoadingPosts.value = true;
  try {
    debug.log(`📖 Loading more posts for user: ${user.value.username}`);
    
    // For remote users, fetch from federation backend first
    if (!user.value.is_local && remoteOutboxUrl.value) {
      isLoadingMoreRemote.value = true;
      debug.log(`🌐 Fetching more posts from remote outbox...`);
      
      try {
        // Get oldest post ID for pagination
        const oldestPost = userPosts.value[userPosts.value.length - 1];
        const maxId = oldestPost?.ap_id || oldestRemotePostId.value;
        
        const response = await fetch('/api/federation/fetch-posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.value.id,
            outbox_url: remoteOutboxUrl.value,
            max_id: maxId,
            limit: 10
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          hasMorePostsRef.value = result.has_more;
          oldestRemotePostId.value = result.oldest_id;
          debug.log(`📬 Federation response: has_more=${result.has_more}, next_page=${result.next_page}`);
          
          // Refresh local posts from database
          const posts = await activityPubService.getUserPosts(user.value.id, { limit: 100 });
          if (posts && posts.length > 0) {
            userPosts.value = posts as TimelinePost[];
            debug.log(`📊 Refreshed ${posts.length} total posts after remote fetch`);
            
            const postReactionsStore = usePostReactionsStore();
            postReactionsStore.fetchMultiplePostReactions(posts.map(p => p.id), true);
            activityPubStore.batchFetchRemoteReactions(posts as TimelinePost[]);
          }
        } else {
          debug.warn('Failed to fetch remote posts:', response.status);
          hasMorePostsRef.value = false;
        }
      } catch (fetchError) {
        debug.error('Remote fetch error:', fetchError);
        hasMorePostsRef.value = false;
      } finally {
        isLoadingMoreRemote.value = false;
      }
    } else {
      // Local user: load from database directly
      const oldestPost = userPosts.value[userPosts.value.length - 1];
      const cursor = oldestPost?.created_at;

      if (!cursor) {
        debug.log('❌ No cursor found for pagination');
        hasMorePostsRef.value = false;
        return;
      }

      const posts = await activityPubService.getUserPosts(user.value.id, {
        limit: 20,
        before: cursor
      });
      
      if (posts && posts.length > 0) {
        userPosts.value.push(...(posts as TimelinePost[]));
        hasMorePostsRef.value = posts.length >= 20;
        debug.log(`📊 Loaded ${posts.length} more posts. Total: ${userPosts.value.length}`);
        
        const postReactionsStore = usePostReactionsStore();
        postReactionsStore.fetchMultiplePostReactions(posts.map(p => p.id), true);
        activityPubStore.batchFetchRemoteReactions(posts as TimelinePost[]);
      } else {
        hasMorePostsRef.value = false;
        debug.log('📭 No more posts available');
      }
    }
  } catch (error) {
    debug.error('❌ Failed to load more posts:', error);
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
    debug.error('Failed to toggle follow:', error);
  } finally {
    isFollowLoading.value = false;
  }
};

const mentionUser = () => {
  if (!user.value) return;
  
  const handle = user.value.handle || '';
  const mentionText = handle.startsWith('@') ? handle : `@${handle}`;
  activityPubStore.openComposer({
    content: `${mentionText} `
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
    debug.error('Failed to toggle mute:', error);
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
    debug.error('Failed to toggle block:', error);
  }
  showActionsMenu.value = false;
};

const showReportModal = ref(false);

const handleReport = () => {
  showReportModal.value = true;
  showActionsMenu.value = false;
};

// Accepts both `User` (chat-side) and `FederatedUser` (federation-side) since
// the `ProfileCard` emit may emit either depending on the source list.
const showUserProfile = (clickedUser: import('@/types').User | FederatedUser) => {
  selectedModalUser.value = clickedUser as FederatedUser;
  showProfileModal.value = true;
  debug.log(`👤 Showing profile modal for: ${(clickedUser as FederatedUser).handle}`);
};

// eslint-disable-next-line unused-imports/no-unused-vars
const navigateToProfile = (clickedUser: FederatedUser) => {
  // Close modal first
  showProfileModal.value = false;
  selectedModalUser.value = null;
  
  // Clean the handle for routing - remove leading @ and ensure proper format
  let handle = clickedUser.handle?.replace(/^@/, '') || clickedUser.username; // Remove leading @
  
  // For routing, we need clean handles without domain for local users
  const currentDomain = import.meta.env.VITE_DOMAIN as string;
  if (handle.endsWith(`@${currentDomain}`)) {
    handle = handle.replace(`@${currentDomain}`, '');
  }
  
  debug.log(`🔗 Navigating to profile: ${handle} (from ${clickedUser.handle})`);
  debug.log(`📍 Current route before navigation:`, route.path);
  
  router.push({ 
    name: 'UserProfile', 
    params: { handle } 
  }).then(() => {
    debug.log(`✅ Navigation completed to: /social/profile/${handle}`);
  }).catch((error) => {
    debug.error(`❌ Navigation failed:`, error);
  });
};

const replyToPost = (post: TimelinePost) => {
  // For reblogs, address the original author and thread under the original
  // note (Mastodon/Pleroma/Misskey behaviour). The reblog wrapper has the
  // booster as `author`, which isn't what the user wants to reply to.
  const target = getOriginalPost(post);
  const handle = target.author?.handle || '';
  const mentionText = handle.startsWith('@') ? handle : `@${handle}`;
  activityPubStore.openComposer({
    replyTo: getOriginalPostId(post),
    content: `${mentionText} `
  });
  router.push('/social/home');
};

// Handlers receive the full TimelinePost (PostsContainer forwards
// `posts[index]` for these chains, since MonyPost handles favorite/reblog/
// bookmark internally and only fires these as a pass-through hook for
// consumers that need the post object).
const handleFavorite = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleFavorite(post.id);
  } catch (error) {
    debug.error('Failed to toggle favorite:', error);
  }
};

const handleReblog = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleReblog(post.id);
  } catch (error) {
    debug.error('Failed to toggle reblog:', error);
  }
};

const handleBookmark = async (post: TimelinePost) => {
  try {
    await activityPubStore.toggleBookmark(post.id);
  } catch (error) {
    debug.error('Failed to toggle bookmark:', error);
  }
};

const handleDelete = async (post: TimelinePost) => {
  try {
    await activityPubStore.deletePost(post.id);
    userPosts.value = userPosts.value.filter(p => p.id !== post.id);
  } catch (error) {
    debug.error('Failed to delete post:', error);
  }
};

const navigateToHashtag = (tag: string) => {
  debug.log(`#️⃣ Navigating to hashtag: #${tag}`);
  router.push({ name: 'HashtagView', params: { tag } });
};

const showConversation = (postId: string) => {
  debug.log(`🎯 Showing conversation for post: ${postId}`);
  router.push({ name: 'PostDetail', params: { postId } });
};

// Get the handle from props or route params, always decode URI components
// (handles may arrive as "user%40domain" from encodeURIComponent callers)
const currentHandle = computed(() => {
  const raw = props.profileHandle || (route.params.handle as string);
  if (!raw) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
});

// Track current loading handle to prevent duplicate loads
let currentLoadingHandle: string | null = null;

// Single consolidated watcher for handle changes
// FIXED: Removed redundant watchers that caused 3x profile loads
watch(currentHandle, async (newHandle, oldHandle) => {
  // Skip if handle hasn't actually changed or is already loading
  if (!newHandle || typeof newHandle !== 'string') return;
  if (newHandle === currentLoadingHandle) {
    debug.log(`⏭️ Skipping duplicate load for handle: ${newHandle}`);
    return;
  }
  
  debug.log(`👤 Profile handle changed from ${oldHandle} to ${newHandle}`);
  currentLoadingHandle = newHandle;
  
  try {
    await loadUserProfile(newHandle);
  } finally {
    // Clear loading handle after load completes
    if (currentLoadingHandle === newHandle) {
      currentLoadingHandle = null;
    }
  }
}, { immediate: true });

// Initialize store on mount (profile loading handled by watcher above)
onMounted(async () => {
  debug.log(`🔄 UserProfileView mounted with handle: ${currentHandle.value}`);
  
  // Initialize ActivityPub store to load followed users
  await activityPubStore.initialize();
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

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<style scoped>
/* ===== MODERN PROFILE VIEW ===== */

.user-profile-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}

.mony-header-container {
  flex-shrink: 0;
}

/* ===== MAIN CONTENT ===== */

.user-profile-view {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
}


.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 64px);
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

.error-state h2 {
  color: var(--text-primary);
  margin: 1rem 0 0.5rem;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--harmony-primary);
  border: none;
  border-radius: 8px;
  color: var(--text-primary);
  padding: 0.75rem 1.5rem;
  cursor: pointer;
  margin-top: 1rem;
  transition: all 0.2s ease;
}

.back-btn:hover {
  background: var(--harmony-primary-hover);
  transform: translateY(-1px);
}

.profile-content {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 64px);
}

.profile-header {
  position: relative;
  flex-shrink: 0;
}

.profile-banner {
  height: 300px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-secondary));
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
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
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
  background: var(--background-quaternary);
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
  border: 8px solid var(--background-quaternary);
  border-radius: 50%;
  background: var(--background-secondary);
}

.federation-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #1d9bf0;
  border: 2px solid var(--background-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  color: var(--text-secondary);
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
  color: var(--text-primary);
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
  color: var(--text-secondary);
}

.profile-fields-section {
  margin-bottom: 1rem;
}

.profile-fields-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.profile-field-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  min-width: 120px;
  flex: 1;
  max-width: 280px;
}

.profile-field-item .field-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.profile-field-item .field-value {
  font-size: 0.875rem;
  color: var(--text-primary);
  word-break: break-word;
}

.profile-field-item .field-value :deep(a) {
  color: var(--primary);
  text-decoration: none;
}

.profile-field-item .field-value :deep(a:hover) {
  text-decoration: underline;
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
  color: var(--text-tertiary);
  font-size: 0.875rem;
  width: 100%;
}

.more-actions {
  position: relative;
}

.actions-menu {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  width: 200px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 12px;
  padding: 0.5rem;
  z-index: 100;
  box-shadow: var(--shadow-modal);
  backdrop-filter: blur(8px);
}

.actions-menu-teleported {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
}

.action-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  background: none;
  border: none;
  color: var(--text-primary);
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
  color: var(--harmony-primary);
  background: rgba(14, 165, 233, 0.1);
}

.action-item.danger {
  color: var(--error);
}

.action-item.danger:hover {
  background: rgba(242, 63, 66, 0.1);
}

.action-divider {
  height: 1px;
  background: var(--border-primary);
  margin: 0.25rem 0;
}

.profile-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-primary);
  background: var(--background-quaternary);
  flex-shrink: 0;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  color: var(--text-tertiary);
  padding: 1rem 1.5rem;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

.tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}

.tab-count {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-tertiary);
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}

.tab-btn.active .tab-count {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--harmony-primary);
}

.tab-content {
  flex: 1;
  overflow-y: auto;
}

.posts-tab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pinned-posts-section {
  max-width: 600px;
  margin: 0 auto;
  width: 100%;
  border-bottom: 1px solid var(--border-color);
  padding: 6px 16px;
}

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
  color: var(--text-tertiary);
  padding: 3rem 2rem;
}

.empty-state h3 {
  color: var(--text-primary);
  margin: 1rem 0 0.5rem;
  font-size: 1.25rem;
}

/* Blocked User Banner (Twitter-like) */
.blocked-user-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
  background: var(--background-secondary);
  border-radius: 12px;
  margin: 1rem;
}

.blocked-banner-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  max-width: 300px;
}

.blocked-banner-content .blocked-icon {
  color: var(--text-muted);
  opacity: 0.6;
}

.blocked-banner-content h3 {
  color: var(--text-primary);
  margin: 0;
  font-size: 1.25rem;
}

.blocked-banner-content p {
  color: var(--text-muted);
  margin: 0;
  font-size: 0.9rem;
}

.unblock-btn {
  margin-top: 0.5rem;
  padding: 8px 24px;
  background: transparent;
  border: 1px solid var(--brand-color, #0EA5E9);
  color: var(--brand-color, #0EA5E9);
  border-radius: 20px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.unblock-btn:hover {
  background: var(--brand-color, #0EA5E9);
  color: var(--text-primary);
}

.load-more-container {
  margin-top: 1rem;
  text-align: center;
}

.load-more-btn {
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  color: var(--text-primary);
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
  border-color: var(--border-hover);
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

/* ===== RESPONSIVE DESIGN ===== */

@media (max-width: 768px) {
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
  
  .following-tab, .followers-tab {
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
    flex-direction: column;
  }
  
  .actions-menu {
    right: -0.5rem;
    width: 180px;
  }
}

@media (max-width: 480px) {
  .profile-content {
    min-height: calc(100vh - 56px);
  }
  
  .loading-state,
  .error-state {
    min-height: calc(100vh - 56px);
  }
}
</style>
