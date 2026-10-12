<!-- UserCard - Display federated user information with actions -->
<template>
  <div class="user-card" :class="{ compact: isCompact, 'has-corner-badge': showRemoteInstanceBadge, 'has-banner': hasBanner }">
    <div v-if="hasBanner" class="card-banner" :style="bannerStyle" aria-hidden="true">
      <img v-if="bannerSrc" :src="bannerSrc" alt="" loading="lazy" @error="bannerFailed = true" />
    </div>
    <!-- The name button is the keyboard and screen-reader way in; the rest of the
         block is a larger pointer target for the same action. Bio links stay
         outside any interactive role. -->
    <div class="user-info" @click="handleUserClick">
      <Avatar 
        :src="user.avatar_url" 
        alt=""
        class="user-avatar"
      />
      
      <div class="user-details">
        <div class="user-name-row">
          <button type="button" class="user-name-btn" data-testid="user-card-open" @click.stop="handleUserClick">
            <DisplayName class="user-name" :userId="user.id" :fallback="user.display_name || user.username" />
          </button>
          <span v-if="user.is_admin" class="instance-badge admin" :title="t('activitypub.instanceAdmin')">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
            {{ t('activitypub.adminBadge') }}
          </span>
          <span v-else-if="user.is_moderator" class="instance-badge mod" :title="t('activitypub.instanceModerator')">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
            {{ t('activitypub.modBadge') }}
          </span>
          <SupporterBadge v-if="user.id" :user-id="user.id" />
        </div>
        <div class="user-handle">@{{ handle }}</div>
        
        <!-- Bio (for non-compact view) -->
        <div v-if="!isCompact && user.bio" class="user-bio" v-html="bioHtml"></div>
        <!-- Stats (for non-compact view) -->
        <div class="user-stats">
          <span class="stat">
            <strong>{{ formatCount(profileCount(user, 'followers')) }}</strong> {{ $t('activitypub.followers') }}
          </span>
          <span class="stat">
            <strong>{{ formatCount(profileCount(user, 'following')) }}</strong> {{ $t('activitypub.following') }}
          </span>
          <span class="stat">
            <strong>{{ formatCount(profileCount(user, 'posts')) }}</strong> {{ $t('activitypub.monies') }}
          </span>
        </div>
      </div>
        
    </div>

    <!-- Actions -->
    <div v-if="showActions" class="user-actions">
      <!-- Follow/Unfollow Button -->
      <button
        v-if="showFollowBtn && !isCurrentUser"
        type="button"
        @click="handleFollowToggle"
        :disabled="getLoadingState().follow"
        :aria-label="followButtonLabel"
        :class="['follow-btn', { following: isFollowing || followRequested, loading: getLoadingState().follow }]"
      >
        <Icon v-if="getLoadingState().follow" name="loader" class="spinning" />
        <Icon v-else-if="isFollowing || followRequested" name="user-check" />
        <Icon v-else name="user-plus" />
        <span>{{ followButtonText }}</span>
      </button>

      <!-- More Actions Menu -->
      <div v-if="showMoreActions" class="more-actions">
        <button
          ref="moreBtnRef"
          type="button"
          class="more-btn"
          :aria-label="t('activitypub.followA11y.moreFor', { name: personName })"
          :title="t('activitypub.moreOptions')"
          aria-haspopup="menu"
          :aria-expanded="showActionsMenu"
          :aria-controls="showActionsMenu ? menuId : undefined"
          @click="showActionsMenu = !showActionsMenu"
          @keydown="onMenuTriggerKeydown"
        >
          <Icon name="more-horizontal" />
        </button>

        <SocialMenu
          v-if="showActionsMenu"
          :id="menuId"
          :anchor="moreBtnRef"
          :label="t('activitypub.followA11y.moreFor', { name: personName })"
          :initial-focus="menuInitialFocus"
          @close="showActionsMenu = false"
        >
          <button type="button" role="menuitem" class="social-menu-item" @click="handleMention">
            <Icon name="at-sign" />
            <span>{{ t('activitypub.profileA11y.mention') }}</span>
          </button>
          <button type="button" role="menuitem" class="social-menu-item" @click="handleMute">
            <Icon name="volume-x" />
            <span>{{ isMuted ? t('activitypub.profileA11y.unmute') : t('activitypub.profileA11y.mute') }}</span>
          </button>
          <button type="button" role="menuitem" class="social-menu-item danger" @click="handleBlock">
            <Icon name="user-x" />
            <span>{{ isBlocked ? t('activitypub.profileA11y.unblock') : t('activitypub.profileA11y.block') }}</span>
          </button>
          <button type="button" role="menuitem" class="social-menu-item danger" @click="handleReport">
            <Icon name="flag" />
            <span>{{ t('activitypub.profileA11y.report') }}</span>
          </button>
        </SocialMenu>
      </div>
    </div>

    <RemoteInstanceBadge
      v-if="showRemoteInstanceBadge"
      :domain="user.domain || ''"
      variant="corner"
      :compact="isCompact"
    />

    <!-- Report Modal -->
    <ReportModal
      v-if="showReportModal"
      report-type="user"
      :target-user-id="user.id"
      :target-user="{ username: user.username, display_name: user.display_name, avatar_url: user.avatar_url, domain: user.domain, is_local: user.is_local }"
      @close="showReportModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useAuthStore } from '@/stores/auth';
import { usePostInteractions } from '@/composables/usePostInteractions';
import type { FederatedUser } from '@/types';
import { profileCount } from '@/utils/profileCounts';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import DisplayName from '@/components/DisplayName.vue';
import RemoteInstanceBadge from '@/components/common/RemoteInstanceBadge.vue';
import { parseDisplayNameOrBioForDisplay } from '@/utils/mentionUtils';
import { plainDisplayName } from '@/utils/plainDisplayName';
import { useMenuButton } from '@/composables/useMenu';
import SocialMenu from './SocialMenu.vue';
import { getBannerUrl } from '@/utils/bannerUtils';

const { t } = useI18n();
// Props
interface Props {
  user: FederatedUser;
  isCompact?: boolean;
  showFollowBtn?: boolean;
  showMoreActions?: boolean;
  showInstanceBadge?: boolean;
  showActions?: boolean;
  /** Header strip: the profile banner, else the profile colour. Not in the compact layout. */
  showBanner?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isCompact: false,
  showFollowBtn: true,
  showMoreActions: true,
  showInstanceBadge: true,
  showActions: true,
  showBanner: false
});

const bannerFailed = ref(false);
const hasBanner = computed(() => props.showBanner && !props.isCompact);
const bannerSrc = computed(() => bannerFailed.value ? null : getBannerUrl(props.user.banner_url, { width: 640, height: 112 }));
const bannerStyle = computed(() => (props.user.color ? { backgroundColor: props.user.color } : {}));

// Emits
const emit = defineEmits<{
  'follow': [userId: string];
  'unfollow': [userId: string];
  'mention': [user: FederatedUser];
  'block': [userId: string];
  'unblock': [userId: string];
  'mute': [userId: string];
  'unmute': [userId: string];
  'report': [userId: string];
  'user-click': [user: FederatedUser];
}>();

// Stores
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();

// Composables for clean interaction handling  
const { toggleFollow, getLoadingState } = usePostInteractions();

// State
const showActionsMenu = ref(false);
const moreBtnRef = ref<HTMLElement | null>(null);
const { menuId, onTriggerKeydown: onMenuTriggerKeydown, initialFocus: menuInitialFocus } = useMenuButton(showActionsMenu);
const followInProgress = ref(false);
// Pending request to a locked or remote account, set from the answer to a follow sent here.
const followRequested = ref(false);

// Computed

const handle = computed(() => {
  return props.user.is_local ? `${props.user.username}` : `${props.user.username}@${props.user.domain}`;
});

const isCurrentUser = computed(() => {
  return authStore.session?.user?.id === props.user.id;
});

const isFollowing = computed(() => {
  return activityPubStore.followedUsers.has(props.user.id);
});

const isMuted = computed(() => {
  return activityPubStore.isMuted(props.user.id);
});

const isBlocked = computed(() => {
  return activityPubStore.isBlocked(props.user.id);
});

const followButtonText = computed(() => {
  if (getLoadingState().follow) return t('common.loading');
  if (isFollowing.value) return t('activitypub.following');
  return followRequested.value ? t('activitypub.requested') : t('activitypub.follow');
});

const personName = computed(() => plainDisplayName(props.user.display_name, props.user.username));

// Starts with the visible label, then names the account and what activating does.
const followButtonLabel = computed(() => {
  if (getLoadingState().follow) return t('common.loading');
  if (isFollowing.value) return t('activitypub.profileA11y.followingUnfollow', { handle: handle.value });
  if (followRequested.value) return t('activitypub.profileA11y.requestedCancel', { handle: handle.value });
  return t('activitypub.followUser', { handle: handle.value });
});

const bioHtml = computed(() => parseDisplayNameOrBioForDisplay(props.user.bio, ''));

const showRemoteInstanceBadge = computed(() => {
  return props.showInstanceBadge && !props.user.is_local && !!props.user.domain;
});

// Methods
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

// null: the account's server withholds the figure.
const formatCount = (num: number | null): string => (num === null ? '–' : formatNumber(num));

const handleUserClick = () => {
  emit('user-click', props.user);
};

const handleFollowToggle = async () => {
  if (getLoadingState().follow || followInProgress.value) return;
  
  followInProgress.value = true;
  const wasFollowing = isFollowing.value;
  try {
    const result = await toggleFollow(props.user.id, followRequested.value);
    if (result.error) return;
    followRequested.value = !!result.pending;

    if (result.following) {
      activityPubStore.followedUsers.add(props.user.id);
      emit('follow', props.user.id);
    } else if (wasFollowing) {
      activityPubStore.followedUsers.delete(props.user.id);
      emit('unfollow', props.user.id);
    }
  } catch (error) {
    debug.error('Failed to toggle follow:', error);
  } finally {
    followInProgress.value = false;
  }
};

const handleMention = () => {
  emit('mention', props.user);
  showActionsMenu.value = false;
};

const handleMute = async () => {
  try {
    if (isMuted.value) {
      await activityPubStore.unmuteUser(props.user.id);
      emit('unmute', props.user.id);
    } else {
      await activityPubStore.muteUser(props.user.id);
      emit('mute', props.user.id);
    }
  } catch (error) {
    debug.error('Failed to toggle mute:', error);
  }
  showActionsMenu.value = false;
};

const handleBlock = async () => {
  try {
    if (isBlocked.value) {
      await activityPubStore.unblockUser(props.user.id);
      emit('unblock', props.user.id);
    } else {
      await activityPubStore.blockUser(props.user.id);
      emit('block', props.user.id);
    }
  } catch (error) {
    debug.error('Failed to toggle block:', error);
  }
  showActionsMenu.value = false;
};

const showReportModal = ref(false);
const handleReport = () => {
  emit('report', props.user.id);
  showActionsMenu.value = false;
  showReportModal.value = true;
};

</script>

<style scoped>
.user-card {
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: 1rem;
  transition: border-color var(--transition-fast);
  position: relative;
  z-index: 1;
}

.user-card:hover {
  border-color: var(--border-hover);
}

/* Bleeds to the card's edges; the avatar sits over its lower edge. */
.card-banner {
  height: 56px;
  margin: -1rem -1rem 0.5rem;
  /* The card's top corners. */
  border-radius: inherit;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  overflow: hidden;
  background: var(--background-secondary);
}

.card-banner img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-card.has-banner .user-avatar {
  margin-top: -32px;
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--background-tertiary);
}

.user-card.compact {
  padding: 0.75rem;
}

.user-info {
  display: flex;
  gap: 0.75rem;
  cursor: pointer;
  margin-bottom: 0.75rem;
}

.user-card.compact .user-info {
  margin-bottom: 0;
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.user-card.compact .user-avatar {
  width: 40px;
  height: 40px;
}

.user-details {
  flex: 1;
  min-width: 0;
}

.user-name-btn {
  display: inline-flex;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.user-name-btn:hover .user-name {
  text-decoration: underline;
}

.user-name-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.user-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.user-name :deep(.inline-emoji),
.user-bio :deep(.inline-emoji) {
  height: 1em;
  vertical-align: middle;
  display: inline;
}

.verified-icon {
  color: var(--text-link);
  flex-shrink: 0;
}

.user-handle {
  color: var(--text-tertiary);
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
}

.user-bio {
  color: var(--text-secondary);
  font-size: 0.875rem;
  line-height: 1.4;
  margin-bottom: 0.5rem;
}

.user-stats {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
  margin-bottom: 0.5rem;
}

.stat strong {
  color: var(--text-primary);
}

.user-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-primary);
}

.user-card.compact .user-actions {
  padding-top: 0;
  border-top: none;
}

.follow-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-on-primary);
  padding: 0.5rem 1rem;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;
  flex: 1;
  justify-content: center;
}

.follow-btn:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.follow-btn.following {
  background: transparent;
  border: 1px solid var(--h-brand, var(--harmony-primary));
  color: var(--text-link, var(--harmony-primary));
}

.follow-btn.following:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-color: var(--error);
  color: var(--text-danger);
}

.follow-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.more-actions {
  position: relative;
}

.more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.more-btn:hover {
  background: var(--background-modifier-selected);
  color: var(--text-primary);
}

.user-card.has-corner-badge {
  padding-top: calc(1rem + 2px);
}

.user-card.compact.has-corner-badge {
  padding-top: calc(0.75rem + 2px);
}

.user-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  font-size: 0.625rem;
  font-weight: var(--font-weight-semibold);
  padding: 0.125rem 0.3rem;
  border-radius: var(--radius-sm);
  vertical-align: middle;
}

.instance-badge.admin {
  background: color-mix(in srgb, var(--harmony-accent) 20%, transparent);
  color: var(--text-primary);
}

.instance-badge.mod {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--text-primary);
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
  .user-card {
    padding: 0.75rem;
  }

  .card-banner {
    margin: -0.75rem -0.75rem 0.5rem;
  }
  
  .user-avatar {
    width: 40px;
    height: 40px;
  }
  
  .user-stats {
    flex-direction: column;
    gap: 0.25rem;
  }
}
</style>
