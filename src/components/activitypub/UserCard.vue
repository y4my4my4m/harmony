<!-- UserCard - Display federated user information with actions -->
<template>
  <div class="user-card" :class="{ compact: isCompact, 'has-corner-badge': showRemoteInstanceBadge }">
    <!-- User Avatar and Basic Info -->
    <div class="user-info" @click="handleUserClick">
      <Avatar 
        :src="user.avatar_url" 
        :alt="user.display_name"
        class="user-avatar"
      />
      
      <div class="user-details">
        <div class="user-name-row">
          <DisplayName class="user-name" :userId="user.id" :fallback="user.display_name || user.username" />
          <span v-if="user.is_admin" class="instance-badge admin" title="Instance Admin">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
            ADMIN
          </span>
          <span v-else-if="user.is_moderator" class="instance-badge mod" title="Instance Moderator">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
            MOD
          </span>
          <SupporterBadge v-if="user.id" :user-id="user.id" />
        </div>
        <div class="user-handle">@{{ handle }}</div>
        
        <!-- Bio (for non-compact view) -->
        <div v-if="!isCompact && user.bio" class="user-bio" v-html="bioHtml"></div>
        <!-- Stats (for non-compact view) -->
        <div class="user-stats">
          <span class="stat">
            <strong>{{ formatNumber(user.followers_count || 0) }}</strong> {{ $t('activitypub.followers') }}
          </span>
          <span class="stat">
            <strong>{{ formatNumber(user.following_count || 0) }}</strong> {{ $t('activitypub.following') }}
          </span>
          <span class="stat">
            <strong>{{ formatNumber(user.posts_count || 0) }}</strong> {{ $t('activitypub.monies') }}
          </span>
        </div>
      </div>
        
    </div>

    <!-- Actions -->
    <div v-if="showActions" class="user-actions">
      <!-- Follow/Unfollow Button -->
      <button
        v-if="showFollowBtn && !isCurrentUser"
        @click="handleFollowToggle"
        :disabled="getLoadingState().follow"
        :class="['follow-btn', { following: isFollowing, loading: getLoadingState().follow }]"
      >
        <Icon v-if="getLoadingState().follow" name="loader" class="spinning" />
        <Icon v-else-if="isFollowing" name="user-check" />
        <Icon v-else name="user-plus" />
        <span>{{ followButtonText }}</span>
      </button>

      <!-- More Actions Menu -->
      <div v-if="showMoreActions" class="more-actions">
        <button
          @click="showActionsMenu = !showActionsMenu"
          class="more-btn"
          title="More actions"
        >
          <Icon name="more-horizontal" />
        </button>
        
        <div v-if="showActionsMenu" class="actions-menu">
          <button
            @click="handleMention"
            class="action-item"
          >
            <Icon name="at-sign" />
            <span>Mention</span>
          </button>
          
          <button
            @click="handleMute"
            class="action-item"
            :class="{ active: isMuted }"
          >
            <Icon name="volume-x" />
            <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
          </button>
          
          <button
            @click="handleBlock"
            class="action-item danger"
            :class="{ active: isBlocked }"
          >
            <Icon name="user-x" />
            <span>{{ isBlocked ? 'Unblock' : 'Block' }}</span>
          </button>
          
          <button
            @click="handleReport"
            class="action-item danger"
          >
            <Icon name="flag" />
            <span>Report</span>
          </button>
        </div>
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
      :target-user="{ username: user.username, display_name: user.display_name, avatar_url: user.avatar_url }"
      @close="showReportModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useAuthStore } from '@/stores/auth';
import { usePostInteractions } from '@/composables/usePostInteractions';
import type { FederatedUser } from '@/types';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import DisplayName from '@/components/DisplayName.vue';
import RemoteInstanceBadge from '@/components/common/RemoteInstanceBadge.vue';
import { parseDisplayNameOrBioForDisplay } from '@/utils/mentionUtils';

const { t } = useI18n();
// Props
interface Props {
  user: FederatedUser;
  isCompact?: boolean;
  showFollowBtn?: boolean;
  showMoreActions?: boolean;
  showInstanceBadge?: boolean;
  showActions?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isCompact: false,
  showFollowBtn: true,
  showMoreActions: true,
  showInstanceBadge: true,
  showActions: true
});

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
const followInProgress = ref(false);

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
  return isFollowing.value ? t('activitypub.following') : t('activitypub.follow');
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

const handleUserClick = () => {
  // Emit event for parent to handle (show modal or navigate)
  emit('user-click', props.user);
};

const handleFollowToggle = async () => {
  if (getLoadingState().follow || followInProgress.value) return;
  
  followInProgress.value = true;
  try {
    const result = await toggleFollow(props.user.id);
    
    if (result.following) {
      activityPubStore.followedUsers.add(props.user.id);
      emit('follow', props.user.id);
    } else {
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

// Close actions menu when clicking outside
const handleClickOutside = (event: Event) => {
  if (showActionsMenu.value) {
    const target = event.target as Element;
    if (!target.closest('.more-actions')) {
      showActionsMenu.value = false;
    }
  }
};

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside);
});

</script>

<style scoped>
.user-card {
  background: var(--background-tertiary, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 1rem;
  transition: all 0.2s;
  position: relative;
  z-index: 1;
}

/* When menu is open, raise the card above others */
.user-card:has(.actions-menu) {
  z-index: 100;
}

.user-card:hover {
  border-color: rgba(255, 255, 255, 0.16);
  transform: translateY(-1px);
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
  transition: transform 0.2s;
}

.user-card.compact .user-avatar {
  width: 40px;
  height: 40px;
}

.user-info:hover .user-avatar {
  transform: scale(1.05);
}

.user-details {
  flex: 1;
  min-width: 0;
}

.user-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
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
  color: #1d9bf0;
  flex-shrink: 0;
}

.user-handle {
  color: #80848e;
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
  color: #80848e;
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
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.user-card.compact .user-actions {
  padding-top: 0;
  border-top: none;
}

.follow-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--h-brand, #0EA5E9);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.5rem 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  flex: 1;
  justify-content: center;
}

.follow-btn:hover:not(:disabled) {
  background: #0284C7;
}

.follow-btn.following {
  background: transparent;
  border: 1px solid var(--h-brand, #0EA5E9);
  color: var(--h-brand, #0EA5E9);
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

.more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #80848e;
  cursor: pointer;
  transition: all 0.2s;
}

.more-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

:deep(.actions-menu) {
  position: absolute;
  top: 100%;
  right: 0;
  width: 180px;
  background: var(--background-tertiary, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.5rem;
  z-index: 9999;
  margin-top: 0.5rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  width: 180px;
  background: var(--background-tertiary, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.5rem;
  z-index: 9999;
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
  color: var(--text-primary);
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
  color: var(--h-brand, #0EA5E9);
}

.action-item.danger {
  color: #f23f42;
}

.action-item.danger:hover {
  background: rgba(242, 63, 66, 0.1);
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
  font-weight: 600;
  padding: 0.125rem 0.3rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
}

.instance-badge.admin {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--harmony-accent) 20%, transparent),
    color-mix(in srgb, var(--harmony-accent-hover) 20%, transparent)
  );
  color: var(--text-primary);
}

.instance-badge.mod {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--harmony-primary) 20%, transparent),
    color-mix(in srgb, var(--harmony-primary-hover) 20%, transparent)
  );
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
  
  .user-avatar {
    width: 40px;
    height: 40px;
  }
  
  .user-stats {
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .actions-menu {
    width: 160px;
  }
}
</style>
