<template>
  <div class="unified-profile-card" :class="{ compact: isCompact, interactive: isInteractive }" @click="handleClick">
    <!-- Avatar and Basic Info -->
    <div class="profile-avatar-section">
      <div class="avatar-wrapper">
        <Avatar
          :src="user.avatar_url"
          :alt="displayName"
          :size="isCompact ? 'md' : 'lg'"
          :status="chatUserStatus"
          :interactive="isInteractive"
        />
        <div v-if="user.verified || hasSpecialBadge" class="badge-overlay">
          <Icon v-if="user.verified" name="verified" class="verified-icon" />
          <Icon v-if="hasSpecialBadge" :name="specialBadgeIcon" class="special-badge-icon" />
        </div>
      </div>
    </div>

    <!-- User Information -->
    <div class="profile-info">
      <div class="name-section">
        <h3 class="user-name" :style="{ color: user.color || undefined }">
          {{ displayName }}
        </h3>
        <p class="user-handle">{{ displayHandle }}</p>
      </div>

      <!-- Bio/About (for non-compact view) -->
      <div v-if="!isCompact && displayBio" class="user-bio">
        <p class="bio-text">{{ truncatedBio }}</p>
      </div>

      <!-- Roles/Badges -->
      <div v-if="!isCompact && userRoles.length > 0" class="user-roles">
        <div
          v-for="role in userRoles"
          :key="role.id"
          class="role-badge"
          :style="{ backgroundColor: role.color, borderColor: role.color + '33' }"
        >
          {{ role.name }}
        </div>
      </div>

      <!-- Stats -->
      <div v-if="!isCompact && hasStats" class="user-stats">
        <!-- Social Stats (ActivityPub) -->
        <template v-if="isFederatedUser(user)">
          <div class="stat-item">
            <span class="stat-value">{{ formatNumber(user.followers_count || 0) }}</span>
            <span class="stat-label">Followers</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ formatNumber(user.following_count || 0) }}</span>
            <span class="stat-label">Following</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ formatNumber(user.posts_count || 0) }}</span>
            <span class="stat-label">Posts</span>
          </div>
        </template>
        
        <!-- Chat Stats -->
        <template v-else>
          <div class="stat-item">
            <span class="stat-value">{{ formatJoinDate(user.created_at) }}</span>
            <span class="stat-label">Joined</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ user.message_count || 0 }}</span>
            <span class="stat-label">Messages</span>
          </div>
          <div v-if="user.voice_time" class="stat-item">
            <span class="stat-value">{{ formatVoiceTime(user.voice_time) }}</span>
            <span class="stat-label">Voice Time</span>
          </div>
        </template>
      </div>
    </div>

    <!-- Actions -->
    <div v-if="showActions && !isCompact" class="profile-actions">
      <!-- Follow/Unfollow (for federated users) -->
      <button
        v-if="isFederatedUser(user) && !isCurrentUser && showFollowBtn"
        @click.stop="handleFollowToggle"
        :disabled="isFollowLoading"
        class="action-btn follow-btn"
        :class="{ following: isFollowing, loading: isFollowLoading }"
      >
        <Icon v-if="isFollowLoading" name="loader" class="spinning" />
        <Icon v-else-if="isFollowing" name="user-check" />
        <Icon v-else name="user-plus" />
        <span>{{ followButtonText }}</span>
      </button>

      <!-- Send Message (for chat users) -->
      <button
        v-if="!isFederatedUser(user) && !isCurrentUser"
        @click.stop="handleMessage"
        class="action-btn message-btn"
      >
        <Icon name="message-circle" />
        <span>Message</span>
      </button>

      <!-- Mention (for federated users) -->
      <button
        v-if="isFederatedUser(user) && !isCurrentUser"
        @click.stop="handleMention"
        class="action-btn mention-btn"
      >
        <Icon name="at-sign" />
        <span>Mention</span>
      </button>

      <!-- More Actions -->
      <div v-if="showMoreActions" class="more-actions">
        <button
          @click.stop="showActionsMenu = !showActionsMenu"
          class="action-btn more-btn"
          :class="{ active: showActionsMenu }"
        >
          <Icon name="more-horizontal" />
        </button>
        
        <div v-if="showActionsMenu" class="actions-menu" v-click-outside="closeActionsMenu">
          <button @click="handleViewProfile" class="action-item">
            <Icon name="user" />
            <span>View Profile</span>
          </button>
          
          <button v-if="!isCurrentUser" @click="handleMute" class="action-item">
            <Icon name="volume-x" />
            <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
          </button>
          
          <button v-if="!isCurrentUser" @click="handleBlock" class="action-item danger">
            <Icon name="user-x" />
            <span>{{ isBlocked ? 'Unblock' : 'Block' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Instance Badge (for federated users) -->
    <div v-if="isFederatedUser(user) && !user.is_local && showInstanceBadge" class="instance-badge">
      <Icon name="federation" />
      <span>{{ user.domain }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useCleanUserStatus } from '@/composables/useCleanUserStatus'
import Avatar from './Avatar.vue'
import Icon from './Icon.vue'
import type { User, FederatedUser } from '@/types'

interface Props {
  user: User | FederatedUser
  isCompact?: boolean
  isInteractive?: boolean
  showActions?: boolean
  showFollowBtn?: boolean
  showMoreActions?: boolean
  showInstanceBadge?: boolean
  hasStats?: boolean
  maxBioLength?: number
}

const props = withDefaults(defineProps<Props>(), {
  isCompact: false,
  isInteractive: true,
  showActions: true,
  showFollowBtn: true,
  showMoreActions: true,
  showInstanceBadge: true,
  hasStats: true,
  maxBioLength: 120
})

const emit = defineEmits<{
  click: [user: User | FederatedUser]
  follow: [userId: string]
  unfollow: [userId: string]
  message: [user: User | FederatedUser]
  mention: [user: FederatedUser]
  mute: [userId: string]
  unmute: [userId: string]
  block: [userId: string]
  unblock: [userId: string]
}>()

// Stores
const router = useRouter()
const authStore = useAuthStore()
const activityPubStore = useActivityPubStore()

// Clean status system
const { getStatusForAvatar, isUserOnline } = useCleanUserStatus()

// State
const isFollowLoading = ref(false)
const showActionsMenu = ref(false)

// Type guards
const isFederatedUser = (user: User | FederatedUser): user is FederatedUser => {
  return 'handle' in user
}

// Computed properties
const isCurrentUser = computed(() => {
  return props.user.id === authStore.session?.user?.id
})

const displayName = computed(() => {
  return props.user.display_name || props.user.username || 'Unknown User'
})

const displayHandle = computed(() => {
  if (isFederatedUser(props.user)) {
    return props.user.handle
  }
  return `@${props.user.username || 'unknown'}`
})

const displayBio = computed(() => {
  if (isFederatedUser(props.user)) {
    return props.user.bio || props.user.bio
  }
  return props.user.bio
})

const truncatedBio = computed(() => {
  if (!displayBio.value) return ''
  return displayBio.value.length > props.maxBioLength 
    ? displayBio.value.substring(0, props.maxBioLength) + '...' 
    : displayBio.value
})

const userRoles = computed(() => {
  return props.user.roles || []
})

const hasSpecialBadge = computed(() => {
  // Add logic for special badges (bot, moderator, etc.)
  return false
})

const specialBadgeIcon = computed(() => {
  // Return appropriate icon based on special status
  return 'bot'
})

const chatUserStatus = computed(() => {
  if (isFederatedUser(props.user)) return undefined
  // Use clean status system for chat users
  return getStatusForAvatar(props.user.id).value
})

const isFollowing = computed(() => {
  if (!isFederatedUser(props.user)) return false
  return activityPubStore.isFollowing(props.user.id)
})

const isMuted = computed(() => {
  return activityPubStore.isMuted(props.user.id)
})

const isBlocked = computed(() => {
  return activityPubStore.isBlocked(props.user.id)
})

const followButtonText = computed(() => {
  if (isFollowLoading.value) return 'Loading...'
  return isFollowing.value ? 'Following' : 'Follow'
})

// Methods
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

const formatJoinDate = (dateString: string | undefined) => {
  if (!dateString) return 'Unknown'
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short',
    day: 'numeric' 
  })
}

const formatVoiceTime = (minutes: number | undefined) => {
  if (!minutes) return '0m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

const handleClick = () => {
  if (props.isInteractive) {
    emit('click', props.user)
  }
}

const handleFollowToggle = async () => {
  if (!isFederatedUser(props.user) || isFollowLoading.value) return
  
  isFollowLoading.value = true
  try {
    if (isFollowing.value) {
      await activityPubStore.unfollowUser(props.user.id)
      emit('unfollow', props.user.id)
    } else {
      await activityPubStore.followUser(props.user.id)
      emit('follow', props.user.id)
    }
  } catch (error) {
    console.error('Failed to toggle follow:', error)
  } finally {
    isFollowLoading.value = false
  }
}

const handleMessage = () => {
  emit('message', props.user)
  router.push(`/dm/${props.user.id}`)
}

const handleMention = () => {
  if (isFederatedUser(props.user)) {
    emit('mention', props.user)
  }
}

const handleMute = async () => {
  try {
    if (isMuted.value) {
      await activityPubStore.unmuteUser(props.user.id)
      emit('unmute', props.user.id)
    } else {
      await activityPubStore.muteUser(props.user.id)
      emit('mute', props.user.id)
    }
  } catch (error) {
    console.error('Failed to toggle mute:', error)
  }
  closeActionsMenu()
}

const handleBlock = async () => {
  try {
    if (isBlocked.value) {
      await activityPubStore.unblockUser(props.user.id)
      emit('unblock', props.user.id)
    } else {
      await activityPubStore.blockUser(props.user.id)
      emit('block', props.user.id)
    }
  } catch (error) {
    console.error('Failed to toggle block:', error)
  }
  closeActionsMenu()
}

const handleViewProfile = () => {
  if (isFederatedUser(props.user)) {
    router.push(`/profile/${props.user.handle}`)
  } else {
    // Open profile modal for chat users
    emit('click', props.user)
  }
  closeActionsMenu()
}

const closeActionsMenu = () => {
  showActionsMenu.value = false
}

// Click outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    el._clickOutsideHandler = (event: Event) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value()
      }
    }
    document.addEventListener('click', el._clickOutsideHandler)
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', el._clickOutsideHandler)
  }
}
</script>

<style scoped>
.unified-profile-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  transition: all var(--transition-base);
  position: relative;
}

.unified-profile-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.unified-profile-card.interactive {
  cursor: pointer;
}

.unified-profile-card.compact {
  padding: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.profile-avatar-section {
  position: relative;
  flex-shrink: 0;
}

.avatar-wrapper {
  position: relative;
}

.badge-overlay {
  position: absolute;
  bottom: -2px;
  right: -2px;
  display: flex;
  gap: 2px;
}

.verified-icon {
  width: 16px;
  height: 16px;
  color: var(--success-primary);
  background: var(--background-primary);
  border-radius: 50%;
  padding: 2px;
}

.special-badge-icon {
  width: 16px;
  height: 16px;
  color: var(--brand-primary);
  background: var(--background-primary);
  border-radius: 50%;
  padding: 2px;
}

.profile-info {
  flex: 1;
  min-width: 0;
}

.compact .profile-info {
  margin-bottom: 0;
}

.name-section {
  margin-bottom: var(--space-2);
}

.compact .name-section {
  margin-bottom: 0;
}

.user-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1) 0;
  line-height: 1.2;
}

.compact .user-name {
  font-size: var(--font-size-sm);
  margin-bottom: 2px;
}

.user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
  font-weight: var(--font-weight-medium);
}

.compact .user-handle {
  font-size: var(--font-size-xs);
}

.user-bio {
  margin-bottom: var(--space-3);
}

.bio-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}

.user-roles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.role-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  background: rgba(88, 101, 242, 0.1);
  border: 1px solid rgba(88, 101, 242, 0.2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.user-stats {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-value {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 2px;
}

.stat-label {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.025em;
  font-weight: var(--font-weight-medium);
}

.profile-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-3);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-primary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all var(--transition-base);
}

.action-btn:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.follow-btn.following {
  background: var(--success-primary);
  border-color: var(--success-primary);
  color: white;
}

.follow-btn.following:hover {
  background: var(--error-primary);
  border-color: var(--error-primary);
}

.message-btn {
  background: var(--brand-primary);
  border-color: var(--brand-primary);
  color: white;
}

.message-btn:hover {
  background: var(--brand-primary-hover);
  border-color: var(--brand-primary-hover);
}

.more-actions {
  position: relative;
}

.more-btn.active {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.actions-menu {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: var(--space-2);
  min-width: 160px;
  z-index: 10;
}

.action-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-base);
  text-align: left;
}

.action-item:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.action-item.danger {
  color: var(--error-primary);
}

.action-item.danger:hover {
  background: var(--error-secondary);
  color: var(--error-primary);
}

.instance-badge {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsive */
@media (max-width: 768px) {
  .user-stats {
    gap: var(--space-3);
  }
  
  .profile-actions {
    flex-wrap: wrap;
  }
  
  .action-btn {
    flex: 1;
    min-width: 0;
    justify-content: center;
  }
}
</style>