<!-- UserCard - Display federated user information with actions -->
<template>
  <div class="user-card" :class="{ compact: isCompact }">
    <!-- User Avatar and Basic Info -->
    <div class="user-info" @click="handleUserClick">
      <img 
        :src="user.avatar_url || '/default_avatar.png'" 
        :alt="user.display_name"
        class="user-avatar"
        loading="lazy"
      />
      
      <div class="user-details">
        <div class="user-name">
          {{ user.display_name || user.username }}
          <Icon v-if="user.verified" name="verified" class="verified-icon" />
        </div>
        <div class="user-handle">{{ user.handle }}</div>
        
        <!-- Bio (for non-compact view) -->
        <div v-if="!isCompact && user.bio" class="user-bio">
          {{ truncatedBio }}
        </div>
        
        <!-- Stats (for non-compact view) -->
        <div v-if="!isCompact" class="user-stats">
          <span class="stat">
            <strong>{{ formatNumber(user.followers_count || 0) }}</strong> followers
          </span>
          <span class="stat">
            <strong>{{ formatNumber(user.following_count || 0) }}</strong> following
          </span>
          <span class="stat">
            <strong>{{ formatNumber(user.posts_count || 0) }}</strong> monies
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
        :disabled="isFollowLoading"
        :class="['follow-btn', { following: isFollowing, loading: isFollowLoading }]"
      >
        <Icon v-if="isFollowLoading" name="loader" class="spinning" />
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
            v-if="!user.is_local"
            @click="handleReport"
            class="action-item danger"
          >
            <Icon name="flag" />
            <span>Report</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Instance Badge (for federated users) -->
    <div v-if="!user.is_local && showInstanceBadge" class="instance-badge" :title="`From ${user.domain}`">
      <Icon name="federation" />
      <span>{{ user.domain }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/activitypub';
import { useAuthStore } from '@/stores/auth';
import type { FederatedUser } from '@/types';
import Icon from '@/components/common/Icon.vue';

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
const router = useRouter();

// State
const isFollowLoading = ref(false);
const showActionsMenu = ref(false);

// Computed
const isCurrentUser = computed(() => {
  return authStore.session?.user?.id === props.user.id;
});

const isFollowing = computed(() => {
  return activityPubStore.isFollowing(props.user.id);
});

const isMuted = computed(() => {
  return activityPubStore.isMuted(props.user.id);
});

const isBlocked = computed(() => {
  return activityPubStore.isBlocked(props.user.id);
});

const followButtonText = computed(() => {
  if (isFollowLoading.value) return 'Loading...';
  return isFollowing.value ? 'Following' : 'Follow';
});

const truncatedBio = computed(() => {
  if (!props.user.bio) return '';
  return props.user.bio.length > 120 
    ? props.user.bio.substring(0, 120) + '...' 
    : props.user.bio;
});

// Methods
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const handleUserClick = () => {
  emit('user-click', props.user);
  router.push(`/u/${props.user.handle}`);
};

const handleFollowToggle = async () => {
  if (isFollowLoading.value) return;
  
  isFollowLoading.value = true;
  try {
    if (isFollowing.value) {
      await activityPubStore.unfollowUser(props.user.id);
      emit('unfollow', props.user.id);
    } else {
      await activityPubStore.followUser(props.user.id);
      emit('follow', props.user.id);
    }
  } catch (error) {
    console.error('Failed to toggle follow:', error);
  } finally {
    isFollowLoading.value = false;
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
    console.error('Failed to toggle mute:', error);
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
    console.error('Failed to toggle block:', error);
  }
  showActionsMenu.value = false;
};

const handleReport = () => {
  emit('report', props.user.id);
  showActionsMenu.value = false;
  // TODO: Open report modal
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

document.addEventListener('click', handleClickOutside);
</script>

<style scoped>
.user-card {
  background: var(--h-sidebar, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 1rem;
  transition: all 0.2s;
  position: relative;
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
  color: white;
  margin-bottom: 0.25rem;
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
  color: #b9bbbe;
  font-size: 0.875rem;
  line-height: 1.4;
  margin-bottom: 0.5rem;
}

.user-stats {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: #80848e;
}

.stat strong {
  color: white;
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
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: white;
  padding: 0.5rem 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  flex: 1;
  justify-content: center;
}

.follow-btn:hover:not(:disabled) {
  background: #4752c4;
}

.follow-btn.following {
  background: transparent;
  border: 1px solid var(--h-brand, #5865f2);
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
  color: white;
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

.instance-badge {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: rgba(114, 137, 218, 0.1);
  color: #7289da;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
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
