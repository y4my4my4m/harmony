<!-- UserProfileView - Federated user profile page -->
<template>
  <div class="user-profile-wrapper">
    <ViewHeader
      :title="user ? plainDisplayName : t('activitypub.profile')"
      :subtitle="postsCount !== null ? t('activitypub.postsCountLabel', { count: postsCount }, postsCount) : undefined"
    />

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
          <div class="profile-banner">
            <BannerImage
              v-if="bannerSrc"
              :src="bannerSrc"
              :fallback-src="bannerFullSize"
              :width="BANNER_BOX.width"
              :height="BANNER_BOX.height"
              expandable
            />
          </div>

          <!-- Profile info container -->
          <div class="profile-info-container">
            <div class="avatar-row">
              <div class="avatar-wrapper">
                <Avatar
                  :src="user.avatar_url"
                  :alt="plainDisplayName"
                  size="xl"
                  class="profile-avatar"
                  expandable
                />
                <div v-if="!user.is_local" class="federation-badge" :title="t('activitypub.fromDomain', { domain: user.domain })">
                  <Icon name="federation" size="12" />
                </div>
              </div>

              <div v-if="!isCurrentUser" class="profile-actions">
                <button
                  type="button"
                  class="profile-icon-btn"
                  :aria-label="t('activitypub.mentionUser', { handle: user.username })"
                  :title="t('activitypub.mentionUser', { handle: user.username })"
                  @click="mentionUser"
                >
                  <Icon name="at-sign" :size="18" />
                </button>

                <div class="more-actions" ref="moreActionsBtnRef">
                  <button
                    type="button"
                    class="profile-icon-btn"
                    :aria-label="t('activitypub.moreOptions')"
                    :title="t('activitypub.moreOptions')"
                    aria-haspopup="menu"
                    :aria-expanded="showActionsMenu"
                    @click.stop="toggleActionsMenu"
                  >
                    <Icon name="more-horizontal" :size="18" />
                  </button>
                                
                <Teleport to="body">
                  <div v-if="showActionsMenu" class="actions-menu actions-menu-teleported" :style="actionsMenuStyle" v-click-outside="() => showActionsMenu = false">
                  <!-- View in remote instance (for federated users) -->
                  <a 
                    v-if="!user.is_local && remoteProfileUrl" 
                    :href="safeHref(remoteProfileUrl)" 
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

                <button
                  v-if="!isMoved || isFollowing || followRequested"
                  type="button"
                  :class="['follow-btn', { 'is-following': isFollowing || followRequested, 'is-loading': isFollowLoading }]"
                  :disabled="isFollowLoading"
                  :aria-busy="isFollowLoading"
                  :aria-label="followButtonLabel"
                  data-testid="profile-follow-btn"
                  @click="toggleFollow"
                >
                  <Icon v-if="isFollowLoading" name="loader" :size="16" class="spinning" />
                  <template v-else>
                    <span class="follow-label">{{ followButtonText }}</span>
                    <span v-if="isFollowing || followRequested" class="follow-label-hover">
                      {{ isFollowing ? t('activitypub.unfollow') : t('activitypub.cancelFollowRequest') }}
                    </span>
                  </template>
                </button>
              </div>

              <div v-else class="profile-actions">
                <RouterLink :to="{ name: 'UserSettings', params: { section: 'account' } }" class="edit-profile-btn">
                  {{ t('activitypub.editProfile') }}
                </RouterLink>
              </div>
            </div>

            <!-- Main profile content -->
            <div class="profile-main-content">
              <div class="profile-top-row">
                <div class="name-handle-section">
                  <div class="display-name-row">
                    <h1 class="display-name">
                      <DisplayName :userId="user.id" :fallback="user.display_name || user.username" />
                    </h1>
                    <Icon v-if="(user as any).verified" name="verified" class="verified-icon" />
                    <span v-if="user.is_local && user.is_admin" class="instance-badge admin" title="Instance admin">
                      <Icon name="shield" :size="11" /> Admin
                    </span>
                    <span v-else-if="user.is_local && user.is_moderator" class="instance-badge mod" title="Instance moderator">
                      <Icon name="shield" :size="11" /> Mod
                    </span>
                  </div>
                  <p class="user-handle">
                    {{ user.handle }}
                    <span
                      v-if="user.manually_approves_followers"
                      class="locked-badge"
                      role="img"
                      :aria-label="t('activitypub.lockedAccount')"
                      :title="t('activitypub.lockedAccount')"
                      data-testid="profile-locked-badge"
                    ><Icon name="lock" :size="14" /></span>
                  </p>
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

        <MovedAccountNotice
          v-if="movedTo"
          class="moved-notice"
          :name="plainDisplayName"
          :target="movedTo"
        />

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
            <span
              v-else-if="tab.hidden"
              class="tab-count tab-count-hidden"
              :title="t('activitypub.countHiddenBy', { domain: user.domain })"
              :aria-label="t('activitypub.countHiddenBy', { domain: user.domain })"
            >–</span>
          </button>
        </div>

        <!-- Tab Content -->
        <div class="tab-content">
          <!-- Blocked User Banner -->
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
              <!-- MonyPost emits `delete`/`edit` as bare ids and handles
                   favorite/reblog/bookmark internally. The handlers below take
                   the full post to update the local list, so the loop variable
                   is passed explicitly. -->
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
              :empty-message="isCurrentUser ? t('empty.profilePosts.self') : t('empty.profilePosts.other', { name: plainDisplayName })"
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

          <ProfileMediaGrid
            v-else-if="activeTab === 'media'"
            :author-id="user.id"
            :display-name="plainDisplayName"
            :is-own-profile="isCurrentUser"
            :outbox-url="user.is_local ? null : remoteOutboxUrl"
            :domain="user.domain"
            :scroll-root="scrollContainerRef"
            @imported="loadMediaCount"
          />

          <!-- Following Tab -->
          <div v-else-if="activeTab === 'following'" class="following-tab">
            <RemoteListNote
              v-if="isRemoteUser"
              :domain="user.domain || ''"
              :profile-url="remoteProfileUrl"
            />
            <EmptyState
              v-if="followingUsers.length === 0"
              icon="users"
              :title="isRemoteUser ? t('activitypub.noKnownAccounts') : t('activitypub.notFollowingAnyone')"
              :description="isRemoteUser ? undefined : isCurrentUser ? t('activitypub.notFollowingAnyoneYet') : t('empty.profileFollowing.other', { name: plainDisplayName })"
            />
            
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
            <RemoteListNote
              v-if="isRemoteUser"
              :domain="user.domain || ''"
              :profile-url="remoteProfileUrl"
            />
            <EmptyState
              v-if="followerUsers.length === 0"
              icon="users"
              :title="isRemoteUser ? t('activitypub.noKnownAccounts') : t('empty.profileFollowers.title')"
              :description="isRemoteUser ? undefined : isCurrentUser ? t('empty.profileFollowers.self') : t('empty.profileFollowers.other', { name: plainDisplayName })"
            />
            
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
    :target-user="{ username: user.username, display_name: user.display_name, avatar_url: user.avatar_url, domain: user.domain, is_local: user.is_local }"
    @close="showReportModal = false"
  />
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
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
import { useUserData } from '@/composables/useUserData'
import { useFeedRealtime, type FeedKind } from '@/composables/useFeedRealtime'
import { useMovedAccount } from '@/composables/useMovedAccount'
import { runtimeConfig } from '@/services/runtimeConfig'
import { isRemoteProfile, profileCount, remoteCountFields } from '@/utils/profileCounts'

const { t } = useI18n(); 

import { activityPubService } from '@/services/activityPubService';
import { services } from '@/services';
import { getBannerUrl, getRawBannerUrl } from '@/utils/bannerUtils';
import BannerImage from '@/components/common/BannerImage.vue';
import { getOriginalPost, getOriginalPostId } from '@/utils/postReblog';
import type { FederatedUser, TimelinePost } from '@/types';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';

// Components
import ViewHeader from '@/components/common/ViewHeader.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DisplayName from '@/components/DisplayName.vue'
import MonyContent from '@/components/activitypub/MonyContent.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import PostsContainer from '@/components/common/PostsContainer.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ProfileMediaGrid from '@/components/activitypub/ProfileMediaGrid.vue';
import ProfileCard from '@/components/common/ProfileCard.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import MovedAccountNotice from '@/components/activitypub/MovedAccountNotice.vue';
import RemoteListNote from '@/components/activitypub/RemoteListNote.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

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

// Emits
defineEmits<{
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
const { getUserBannerUrl } = useUserData()

const scrollContainerRef = ref<HTMLElement | null>(null);

// State
const user = ref<FederatedUser | null>(null);
const isLoading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref('posts');
const showActionsMenu = ref(false);
const moreActionsBtnRef = ref<HTMLElement | null>(null);
const actionsMenuStyle = ref<Record<string, string>>({});
const isFollowLoading = ref(false);
// Pending request to an account that approves followers manually.
const followRequested = ref(false);
const { movedTo, isMoved } = useMovedAccount(() => user.value);

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
const oldestRemotePostId = ref<string | null>(null); // pagination cursor
const isLoadingMoreRemote = ref(false);

// Realtime: prepends/edits/deletes arrive on `feed:user:{profile_id}`, where
// a DB trigger publishes every post event for this author. The kind ref
// changes with the route param, so navigation re-subscribes.
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
    // A remote account's figure is its origin's; an outbox backfill also lands here.
    if (user.value && !isRemoteUser.value) user.value.posts_count = (user.value.posts_count ?? 0) + 1
    void loadMediaCount()
  },
  onUpdate: (event) => {
    if (event.author_id !== user.value?.id) return
    // The broadcast payload carries metadata, not content. Visibility
    // downgrades remove the post; content edits arrive through the per-post
    // component refetch. Count-update echoes are ignored.
    if (event.visibility === 'direct' || event.visibility === 'private') {
      userPosts.value = userPosts.value.filter(p => p.id !== event.id)
      void loadMediaCount()
    }
  },
  onDelete: (event) => {
    if (event.author_id !== user.value?.id) return
    const before = userPosts.value.length
    userPosts.value = userPosts.value.filter(p => p.id !== event.id)
    if (user.value && !isRemoteUser.value && before !== userPosts.value.length) {
      user.value.posts_count = Math.max(0, (user.value.posts_count ?? 1) - 1)
    }
    void loadMediaCount()
  },
})

// Posts with images or video visible to the viewer; null until counted.
const mediaCount = ref<number | null>(null);

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

// A remote account shows its origin's totals; its lists hold the accounts known here.
const isRemoteUser = computed(() => isRemoteProfile(user.value));
const postsCount = computed(() => profileCount(user.value, 'posts'));
const followingCount = computed(() => profileCount(user.value, 'following'));
const followersCount = computed(() => profileCount(user.value, 'followers'));

interface ProfileTab {
  id: string;
  label: string;
  icon: string;
  count?: number;
  /** The account's server withholds the figure. */
  hidden?: boolean;
}

const countTab = (id: string, label: string, icon: string, count: number | null): ProfileTab =>
  count === null && user.value ? { id, label, icon, hidden: true } : { id, label, icon, count: count ?? 0 };

const profileTabs = computed<ProfileTab[]>(() => [
  countTab('posts', t('activitypub.monies'), 'message-circle', postsCount.value),
  {
    id: 'media',
    label: t('activitypub.media'),
    icon: 'image',
    count: mediaCount.value ?? undefined
  },
  countTab('following', t('activitypub.following'), 'user-plus', followingCount.value),
  countTab('followers', t('activitypub.followers'), 'users', followersCount.value),
]);

const bannerUrl = computed(() => {
  if (!user.value) return null
  return getUserBannerUrl(user.value.id).value || (user.value as any).banner_url || null
})

// Banner box in CSS px: the profile column is at most 600 wide, the banner 3:1.
const BANNER_BOX = { width: 600, height: 200 } as const

const bannerSrc = computed(() => getBannerUrl(bannerUrl.value, BANNER_BOX))
const bannerFullSize = computed(() => getRawBannerUrl(bannerUrl.value))

// Infinite scroll for the posts tab.
const handleScroll = throttle(() => {
  if (!scrollContainerRef.value) return;
  
  const container = scrollContainerRef.value;
  const scrollTop = container.scrollTop;
  
  if (activeTab.value === 'posts' && !isLoadingPosts.value && !isLoadingMoreRemote.value) {
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    if (distanceFromBottom < 300 && hasMorePostsRef.value) {
      loadMorePosts();
    }
  }
}, 100);

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
  
  // URL stored on the ActivityPub actor.
  if ((user.value as any).url) {
    return (user.value as any).url;
  }
  
  // federated_id is the actor URL.
  if (user.value.federated_id) {
    return user.value.federated_id;
  }
  
  // Fallback shape, valid on Mastodon-compatible instances.
  return `https://${user.value.domain}/@${user.value.username}`;
});

const followButtonText = computed(() => {
  if (isFollowing.value) return t('activitypub.following');
  if (followRequested.value) return t('activitypub.requested');
  return t('activitypub.follow');
});

const followButtonLabel = computed(() => {
  const handle = user.value?.username || '';
  if (isFollowing.value) return t('activitypub.unfollowUser', { handle });
  if (followRequested.value) return t('activitypub.cancelFollowRequest');
  return t('activitypub.followUser', { handle });
});

const loadRelationship = async () => {
  const target = user.value;
  if (!target?.id || isCurrentUser.value) return;
  try {
    const relationships = await services.interactions.getUserRelationships([target.id]);
    const rel = relationships[target.id] as { followRequestPending?: boolean } | undefined;
    if (user.value?.id === target.id) {
      followRequested.value = !!rel?.followRequestPending;
    }
  } catch (err) {
    debug.warn('Failed to load relationship:', err);
  }
};

// Profile fields from ActivityPub PropertyValue attachments
const userFields = computed(() => {
  if (!user.value) return [];
  const u = user.value as any;
  return u.fields || u.profile_fields || [];
});

const formatFieldValue = (value: string): string => {
  if (!value) return '';
  // PropertyValue fields come from a remote profile and are attacker-controlled.
  // DOMPurify strips disallowed tags and dangerous URI schemes (javascript:,
  // data:) from href/src. ALLOWED_URI_REGEXP narrows this to http(s)/mailto.
  const sanitized = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: ['a', 'br', 'span', 'em', 'strong', 'b', 'i'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
  });
  // rel/target are forced onto links: external profile links open in a new tab
  // and must not leak window.opener. A regex pass suffices because the input
  // is already sanitized.
  return sanitized.replace(/<a\b(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer nofollow"');
};

// Methods
const formatJoinDate = (dateString: string): string => {
  return format(new Date(dateString), 'MMMM yyyy');
};

const loadUserProfile = async (handle: string, forceRefresh: boolean = false) => {
  debug.log(`Loading profile for handle: ${handle}${forceRefresh ? ' (force refresh)' : ''}`);
  isLoading.value = true;
  error.value = null;
  user.value = null;
  followRequested.value = false;
  mediaCount.value = null;
  
  try {
    if (handle.startsWith('@')) {
      handle = handle.substring(1);
    }
    
    debug.log(`Processing handle: ${handle}`);
    
    if (handle.includes('@')) {
      debug.log(`Resolving federated user...${forceRefresh ? ' (force refresh)' : ''}`);
      user.value = await activityPubService.getUserByHandle(handle, forceRefresh);
      
      if (user.value && !user.value.is_local && (user.value as any).outbox_url) {
        remoteOutboxUrl.value = (user.value as any).outbox_url;
        debug.log(`Saved outbox URL for remote pagination: ${remoteOutboxUrl.value}`);
      }
    } else {
      debug.log('Looking up local user...');
      
      // Local users resolve through the ActivityPub service first.
      try {
        debug.log(`Fetching user by handle: @${handle}`);
        user.value = await activityPubService.getUserByHandle(`@${handle}`);
      } catch (localError) {
        debug.log('ActivityPub lookup failed, trying profile service...');
        
        // Fallback: the handle may be the signed-in user.
        const currentUser = authStore.session?.user;
        const currentUsername = currentUser?.user_metadata?.username;
        
        if (currentUser && currentUsername === handle) {
          debug.log('Loading current user profile...');
          
          await profileStore.fetchProfile(currentUser.id);
          const profile = profileStore.profile;
          
          if (profile) {
            // Placeholder; the posts load sets the real count.
            const posts_count = 0;

            user.value = {
              id: currentUser.id,
              username: profile.username || currentUsername,
              domain: runtimeConfig.domain as string,
              handle: `@${profile.username || currentUsername}@${runtimeConfig.domain as string}`,
              display_name: profile.display_name || profile.username || currentUsername,
              avatar_url: profile.avatar_url || currentUser.user_metadata?.avatar_url || '/default_avatar.webp',
              bio: profile.bio || 'Fediverse user',
              is_local: true,
              followers_count: activityPubStore.followersCount || 0,
              following_count: activityPubStore.followingCount || 0,
              posts_count: posts_count,
              created_at: profile.created_at || currentUser.created_at || new Date().toISOString(),
              updated_at: profile.updated_at || new Date().toISOString()
            };
            
            debug.log(`Created user object with ActivityPub counts:`, {
              followers_count: user.value.followers_count,
              following_count: user.value.following_count,
              posts_count: user.value.posts_count
            });
          }
        } else {
          // Unresolved handle: synthesize a placeholder local profile.
          debug.log('Searching for user in system...');
          
          user.value = {
            id: handle,
            username: handle,
            domain: runtimeConfig.domain as string,
            handle: `@${handle}@${runtimeConfig.domain as string}`,
            display_name: handle,
            avatar_url: '/default_avatar.webp',
            bio: 'Fediverse user',
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
      debug.log('User profile loaded:', user.value.display_name);
      debug.log('User stats:', {
        posts: user.value.posts_count,
        following: user.value.following_count,
        followers: user.value.followers_count
      });
      if (isRemoteUser.value) void syncRemoteProfile(handle);
      await Promise.all([
        loadUserPosts(),
        loadPinnedPosts(),
        loadMediaCount(),
        loadFollowing(),
        loadFollowers(),
        loadRelationship()
      ]);
    } else {
      debug.log('User not found');
      error.value = 'User not found';
    }
  } catch (err) {
    debug.error('Failed to load user profile:', err);
    error.value = 'Failed to load profile. The user might not exist or be unavailable.';
  } finally {
    isLoading.value = false;
  }
};

// Delay, ms, before the posts list is read again once the backend starts an outbox backfill.
const BACKFILL_RELOAD_MS = 4000;

/**
 * Re-reads a remote account's collection totals when stale and starts its outbox backfill
 * when due, both through the federation backend's /lookup-user.
 */
const syncRemoteProfile = async (handle: string) => {
  const target = user.value;
  if (!target) return;
  const result = await activityPubService.refreshRemoteProfile(handle);
  if (!result || user.value?.id !== target.id || result.user.id !== target.id) return;
  Object.assign(user.value, remoteCountFields(result.user));
  if (!remoteOutboxUrl.value && result.user.outbox_url) {
    remoteOutboxUrl.value = result.user.outbox_url;
    hasMorePostsRef.value = true;
  }
  if (result.backfilling) {
    setTimeout(() => {
      if (user.value?.id === target.id && !isLoadingMoreRemote.value) void loadUserPosts();
    }, BACKFILL_RELOAD_MS);
  }
};

const loadUserPosts = async (retryCount = 0) => {
  if (!user.value) return;
  
  isLoadingPosts.value = true;
  try {
    debug.log(`Loading posts for user: ${user.value.username} (ID: ${user.value.id})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
    
    // Same path for local and remote users.
    const posts = (await activityPubService.getUserPosts(user.value.id, { limit: 20 })) as TimelinePost[] || [];

    // Retries poll while the backend backfills a freshly-imported remote
    // profile. The array is swapped, and reactions refetched, only when the
    // post set changed; unchanged polls must not repaint the list.
    const changed =
      posts.length !== userPosts.value.length ||
      posts.some((p, i) => p.id !== userPosts.value[i]?.id);
    if (changed) {
      userPosts.value = posts;
      if (posts.length > 0) {
        const postReactionsStore = usePostReactionsStore();
        postReactionsStore.fetchMultiplePostReactions(posts.map(p => p.id), true);
        activityPubStore.batchFetchRemoteReactions(posts);
      }
    }

    // Remote users always have "load more": the outbox can yield more.
    // Local users get it only on a full page.
    if (!user.value.is_local && remoteOutboxUrl.value) {
      hasMorePostsRef.value = true;
      debug.log(`Remote user - enabling infinite scroll (outbox: ${remoteOutboxUrl.value})`);
    } else {
      hasMorePostsRef.value = posts && posts.length >= 20;
    }
    debug.log(`Loaded ${userPosts.value.length} posts for ${user.value.username}`);
    
    // An empty remote profile may still be backfilling; poll a few times.
    if (!user.value.is_local && userPosts.value.length === 0 && retryCount < 3) {
      debug.log(`No posts yet for remote user, will retry in 2s (attempt ${retryCount + 1}/3)`);
      setTimeout(() => {
        loadUserPosts(retryCount + 1);
      }, 2000);
      return; // retry pending; leave isLoadingPosts set
    }

    // Only correct the displayed post count upward - the loaded page is
    // capped at 20, so its length must never overwrite a larger DB count.
    if (isCurrentUser.value && user.value && userPosts.value.length > (user.value.posts_count || 0)) {
      user.value.posts_count = userPosts.value.length;
    }

    try {
      debug.log('Posts sample:', userPosts.value.slice(0, 3).map(p => ({ 
        id: p.id, 
        content: p.content ? (typeof p.content === 'string' ? (p.content as string).substring(0, 50) : JSON.stringify(p.content).substring(0, 50)) : 'No content',
        content_type: typeof p.content,
        author: p.author?.username || p.author_id,
        visibility: p.visibility,
        created_at: p.created_at
      })));
    } catch (debugError) {
      debug.log('Posts debug error:', debugError);
      debug.log('Raw posts data:', userPosts.value.slice(0, 2));
    }
  } catch (error) {
    debug.error('Failed to load user posts:', error);
    userPosts.value = [];
    hasMorePostsRef.value = false;
  } finally {
    // Loading indicator stays on while retries are pending.
    if (retryCount >= 3 || userPosts.value.length > 0 || user.value?.is_local) {
      isLoadingPosts.value = false;
    }
  }
};

const loadMediaCount = async () => {
  const target = user.value;
  if (!target?.id) return;
  try {
    const count = await activityPubService.countProfileMedia(target.id);
    if (user.value?.id === target.id) mediaCount.value = count;
  } catch (err) {
    debug.warn('Failed to count profile media:', err);
  }
};

const loadFollowing = async () => {
  if (!user.value) return;
  
  try {
    debug.log(`Loading following for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Same path for local and remote users.
    const following = await activityPubService.getFollowing(user.value.id, { limit: 50 });
    followingUsers.value = following || [];
    
    debug.log(`Loaded ${followingUsers.value.length} following for ${user.value?.username || 'unknown'}`);

    // following_count comes from the DB. This list is capped at the page size
    // of 50, so its length is not the count.
  } catch (error) {
    debug.error('Failed to load following:', error);
    followingUsers.value = [];
  }
};

const loadFollowers = async () => {
  if (!user.value) return;
  
  try {
    debug.log(`Loading followers for user: ${user.value.username} (ID: ${user.value.id})`);
    
    // Same path for local and remote users.
    const followers = await activityPubService.getFollowers(user.value.id, { limit: 50 });
    followerUsers.value = followers || [];
    
    debug.log(`Loaded ${followerUsers.value.length} followers for ${user.value?.username || 'unknown'}`);
    debug.log('Follower users:', followerUsers.value.map(u => u?.display_name || u?.username || 'Unknown'));
    
    // Count comes from profiles.followers_count; it is not overwritten here.
    isLoading.value = false;
  } catch (error) {
    debug.error('Failed to load followers:', error);
    followerUsers.value = [];
  }
};

const loadPinnedPosts = async () => {
  if (!user.value) return;
  try {
    const posts = await services.posts.getPinnedPosts(user.value.id);
    pinnedPosts.value = posts as TimelinePost[] || [];
    debug.log(`Loaded ${pinnedPosts.value.length} pinned posts for ${user.value.username}`);
  } catch (err) {
    debug.error('Failed to load pinned posts:', err);
    pinnedPosts.value = [];
  }
};

const loadMorePosts = async () => {
  if (!user.value || isLoadingPosts.value || isLoadingMoreRemote.value || !hasMorePostsRef.value) return;
  
  isLoadingPosts.value = true;
  try {
    debug.log(`Loading more posts for user: ${user.value.username}`);
    
    // Remote users page through the federation backend first.
    if (!user.value.is_local && remoteOutboxUrl.value) {
      isLoadingMoreRemote.value = true;
      debug.log(`Fetching more posts from remote outbox...`);
      
      try {
        const oldestPost = userPosts.value[userPosts.value.length - 1];
        const maxId = oldestPost?.ap_id || oldestRemotePostId.value;

        const result = await activityPubService.importRemoteOutboxPage(user.value.id, remoteOutboxUrl.value, {
          maxId,
          limit: 10
        });
        oldestRemotePostId.value = result.oldestId;
        debug.log(`Federation response: has_more=${result.hasMore}`);

        // Newly-imported posts are merged, not swapped in wholesale: a full
        // replace re-renders every visible note on each page fetch, and on
        // short pages the scroll handler fires repeatedly.
        const posts = await activityPubService.getUserPosts(user.value.id, { limit: 100 });
        const knownIds = new Set(userPosts.value.map(p => p.id));
        const newPosts = ((posts as TimelinePost[]) || []).filter(p => !knownIds.has(p.id));

        if (newPosts.length > 0) {
          userPosts.value = [...userPosts.value, ...newPosts]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
          hasMorePostsRef.value = result.hasMore;
          debug.log(`Merged ${newPosts.length} new posts (total ${userPosts.value.length})`);

          const postReactionsStore = usePostReactionsStore();
          postReactionsStore.fetchMultiplePostReactions(newPosts.map(p => p.id), true);
          activityPubStore.batchFetchRemoteReactions(newPosts);
          void loadMediaCount();
        } else {
          // Nothing new; clearing the flag stops the scroll handler from
          // re-firing this request in a loop.
          hasMorePostsRef.value = false;
          debug.log('Remote fetch returned no new posts - stopping pagination');
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
        debug.log('No cursor found for pagination');
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
        debug.log(`Loaded ${posts.length} more posts. Total: ${userPosts.value.length}`);
        
        const postReactionsStore = usePostReactionsStore();
        postReactionsStore.fetchMultiplePostReactions(posts.map(p => p.id), true);
        activityPubStore.batchFetchRemoteReactions(posts as TimelinePost[]);
      } else {
        hasMorePostsRef.value = false;
        debug.log('No more posts available');
      }
    }
  } catch (error) {
    debug.error('Failed to load more posts:', error);
    hasMorePostsRef.value = false;
  } finally {
    isLoadingPosts.value = false;
  }
};

const toggleFollow = async () => {
  if (!user.value || isFollowLoading.value) return;
  
  isFollowLoading.value = true;
  try {
    if (isFollowing.value || followRequested.value) {
      // Deletes an accepted follow or withdraws a pending request.
      await activityPubStore.unfollowUser(user.value.id);
      followRequested.value = false;
    } else {
      const result = await activityPubStore.followUser(user.value.id) as { pending?: boolean } | undefined;
      followRequested.value = !!result?.pending;
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

// Accepts `User` (chat-side) and `FederatedUser` (federation-side): the
// `ProfileCard` emit carries either, depending on the source list.
const showUserProfile = (clickedUser: import('@/types').User | FederatedUser) => {
  selectedModalUser.value = clickedUser as FederatedUser;
  showProfileModal.value = true;
  debug.log(`Showing profile modal for: ${(clickedUser as FederatedUser).handle}`);
};

// eslint-disable-next-line unused-imports/no-unused-vars
const navigateToProfile = (clickedUser: FederatedUser) => {
  showProfileModal.value = false;
  selectedModalUser.value = null;
  
  // Routes take handles without the leading @.
  let handle = clickedUser.handle?.replace(/^@/, '') || clickedUser.username;
  
  // Local handles route without the domain suffix.
  const currentDomain = runtimeConfig.domain as string;
  if (handle.endsWith(`@${currentDomain}`)) {
    handle = handle.replace(`@${currentDomain}`, '');
  }
  
  debug.log(`Navigating to profile: ${handle} (from ${clickedUser.handle})`);
  debug.log(`Current route before navigation:`, route.path);
  
  router.push({ 
    name: 'UserProfile', 
    params: { handle } 
  }).then(() => {
    debug.log(`Navigation completed to: /social/profile/${handle}`);
  }).catch((error) => {
    debug.error(`Navigation failed:`, error);
  });
};

const replyToPost = (post: TimelinePost) => {
  // Reblogs address the original author and thread under the original note,
  // matching Mastodon/Pleroma/Misskey. The reblog wrapper's `author` is the
  // booster, not the reply target.
  const target = getOriginalPost(post);
  const handle = target.author?.handle || '';
  const mentionText = handle.startsWith('@') ? handle : `@${handle}`;
  activityPubStore.openComposer({
    replyTo: getOriginalPostId(post),
    content: `${mentionText} `
  });
  router.push('/social/home');
};

// Handlers take the full TimelinePost: PostsContainer forwards `posts[index]`
// for these chains. MonyPost handles favorite/reblog/bookmark internally and
// fires these only as a pass-through for consumers needing the post object.
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
  debug.log(`#Navigating to hashtag: #${tag}`);
  router.push({ name: 'HashtagView', params: { tag } });
};

const showConversation = (postId: string) => {
  debug.log(`Showing conversation for post: ${postId}`);
  router.push({ name: 'PostDetail', params: { postId } });
};

// Handle comes from props or route params and is always URI-decoded; callers
// using encodeURIComponent send it as "user%40domain".
const currentHandle = computed(() => {
  const raw = props.profileHandle || (route.params.handle as string);
  if (!raw) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
});

// Guards against duplicate loads of the same handle.
let currentLoadingHandle: string | null = null;

// Single watcher for handle changes. Additional watchers on the same handle
// trigger the profile load three times.
watch(currentHandle, async (newHandle, oldHandle) => {
  // Skip unchanged handles and loads already in flight.
  if (!newHandle || typeof newHandle !== 'string') return;
  if (newHandle === currentLoadingHandle) {
    debug.log(`Skipping duplicate load for handle: ${newHandle}`);
    return;
  }
  
  debug.log(`Profile handle changed from ${oldHandle} to ${newHandle}`);
  currentLoadingHandle = newHandle;
  
  try {
    await loadUserProfile(newHandle);
  } finally {
    if (currentLoadingHandle === newHandle) {
      currentLoadingHandle = null;
    }
  }
}, { immediate: true });

onMounted(async () => {
  debug.log(`UserProfileView mounted with handle: ${currentHandle.value}`);
  
  await activityPubStore.initialize();
});

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
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}

/* ===== MAIN CONTENT ===== */

/* Stable gutter, like the feed scroller: the profile column sits on the timeline's axis
   whether or not the active tab overflows. */
.user-profile-view {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
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
  border-radius: var(--radius-md);
  color: var(--text-on-primary);
  padding: 0.75rem 1.5rem;
  cursor: pointer;
  margin-top: 1rem;
  transition: all 0.2s ease;
}

.back-btn:hover {
  background: var(--harmony-primary-hover);
}

.profile-content {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  min-height: 100%;
}

/* The profile column draws the only pair of side rules; columns nested in it draw none. */
@media (min-width: 769px) {
  .profile-content {
    border-left: 1px solid var(--border-color);
    border-right: 1px solid var(--border-color);
  }
}

.profile-header {
  position: relative;
  flex-shrink: 0;
}

.profile-banner {
  position: relative;
  overflow: hidden;
  aspect-ratio: 3 / 1;
  width: 100%;
  background-color: var(--background-tertiary);
}

.profile-info-container {
  position: relative;
  padding: 0 var(--space-4) var(--space-4);
}

/* --avatar-overlap: how far the avatar reaches up into the banner. */
.avatar-row {
  --avatar-overlap: 40px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: calc(-1 * var(--avatar-overlap));
  margin-bottom: var(--space-3);
}

.avatar-wrapper {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}

.profile-avatar {
  border: 4px solid var(--background-primary);
  border-radius: var(--radius-full);
  background: var(--background-secondary);
}

.federation-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  border: 2px solid var(--background-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-primary);
}

/* Below the banner's bottom edge; only the avatar overlaps it. */
.profile-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: calc(var(--avatar-overlap) + var(--space-3));
}

.profile-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.profile-icon-btn:hover {
  background: var(--background-modifier-hover);
}

.follow-btn,
.edit-profile-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.follow-btn {
  border: 1px solid var(--harmony-primary);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.follow-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
  border-color: var(--harmony-primary-hover);
}

.follow-btn.is-following {
  border-color: var(--border-primary);
  background: transparent;
  color: var(--text-primary);
}

.follow-btn.is-following:hover:not(:disabled),
.follow-btn.is-following:focus-visible {
  border-color: var(--error);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
}

.follow-label-hover {
  display: none;
}

.follow-btn.is-following:hover:not(:disabled) .follow-label,
.follow-btn.is-following:focus-visible .follow-label {
  display: none;
}

.follow-btn.is-following:hover:not(:disabled) .follow-label-hover,
.follow-btn.is-following:focus-visible .follow-label-hover {
  display: inline;
}

.follow-btn:disabled {
  cursor: progress;
}

.edit-profile-btn {
  width: auto;
  padding: 0 var(--space-4);
  border: 1px solid var(--border-primary);
  background: transparent;
  color: var(--text-primary);
  text-decoration: none;
}

.edit-profile-btn:hover {
  background: var(--background-modifier-hover);
}

.profile-icon-btn:focus-visible,
.follow-btn:focus-visible,
.edit-profile-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.profile-main-content {
  flex: 1;
}

.profile-top-row {
  margin-bottom: var(--space-3);
}

.name-handle-section {
  min-width: 0;
}

.display-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.6875rem;
  font-weight: var(--font-weight-semibold);
  padding: 0.125rem 0.4rem;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
}

.instance-badge.admin {
  background: color-mix(in srgb, var(--harmony-accent) 20%, transparent);
}

.instance-badge.mod {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
}

.display-name {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.verified-icon {
  color: var(--harmony-primary);
  flex-shrink: 0;
}

.user-handle {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

.locked-badge {
  display: inline-flex;
  vertical-align: -2px;
  margin-left: 4px;
  color: var(--text-muted);
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
  border-radius: var(--radius-md);
  min-width: 120px;
  flex: 1;
  max-width: 280px;
}

.profile-field-item .field-label {
  font-size: 0.75rem;
  font-weight: var(--font-weight-semibold);
  color: var(--text-muted);
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
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: 0.5rem;
  z-index: 100;
  box-shadow: var(--shadow-large);
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
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
  font-size: 0.9rem;
}

.action-item:hover {
  background: var(--background-modifier-hover);
}

.action-item.active {
  color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light);
}

.action-item.danger {
  color: var(--error);
}

.action-item.danger:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
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
  flex: 1 1 0;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: none;
  border: none;
  color: var(--text-tertiary);
  padding: 1rem 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.tab-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}

.tab-count {
  background: var(--background-modifier-active);
  color: var(--text-tertiary);
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-lg);
  font-size: 0.75rem;
  font-weight: var(--font-weight-semibold);
}

.tab-btn.active .tab-count {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--harmony-primary);
}

.tab-count-hidden {
  cursor: help;
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

/* .user-profile-view scrolls the feed; PostsContainer's own scroller never overflows
   here, so its reserved gutter would only narrow the list inside the profile column. */
.posts-tab :deep(.posts-container) {
  scrollbar-gutter: auto;
}

@media (min-width: 769px) {
  .posts-tab :deep(.feed-column) {
    border-left: none;
    border-right: none;
  }
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

.moved-notice {
  margin: 0 1rem 1rem;
}

/* Blocked User Banner */
.blocked-user-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
  background: var(--background-secondary);
  border-radius: var(--radius-lg);
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
  border: 1px solid var(--harmony-primary);
  color: var(--harmony-primary);
  border-radius: var(--radius-full);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.unblock-btn:hover {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.load-more-container {
  margin-top: 1rem;
  text-align: center;
}

.load-more-btn {
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
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
  background: var(--background-modifier-hover);
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
  .profile-info-container {
    padding: 0 var(--space-3) var(--space-3);
  }

  .profile-icon-btn {
    width: 40px;
    height: 40px;
  }

  .follow-btn,
  .edit-profile-btn {
    height: 40px;
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
    padding: 0.75rem 0.25rem;
    font-size: 0.9rem;
    text-align: center;
    flex-direction: column;
    gap: 0.25rem;
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
