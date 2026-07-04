<template>
  <div
    class="unified-profile-card"
    :class="{ compact: isCompact, interactive: isInteractive, 'has-corner-badge': showRemoteInstanceBadge && instanceBadgeVariant === 'corner' }"
    @click="handleClick"
  >
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
        <div v-if="hasSpecialBadge" class="badge-overlay">
          <Icon v-if="hasSpecialBadge" :name="specialBadgeIcon" class="special-badge-icon" />
        </div>
      </div>
    </div>

    <!-- User Information -->
    <div class="profile-info">
      <div class="name-section">
        <h3 class="user-name" :style="{ color: user.color || undefined }">
          <DisplayName v-if="user.id" :user-id="user.id" :fallback="displayName" :color="user.color || undefined" />
          <template v-else>{{ displayName }}</template>
        </h3>
        <p class="user-handle">{{ displayHandle }}</p>
        <RemoteInstanceBadge
          v-if="showRemoteInstanceBadge && instanceBadgeVariant === 'inline'"
          :domain="user.domain!"
          variant="inline"
        />
      </div>

      <!-- Bio/About (for non-compact view) -->
      <div v-if="!isCompact && displayBio" class="user-bio">
        <p class="bio-text">{{ truncatedBio }}</p>
      </div>

      <!-- Instance & Server Badges -->
      <div v-if="!isCompact && (hasInstanceBadge || userRoles.length > 0)" class="user-roles">
        <div v-if="user.is_admin" class="role-badge instance-admin-badge">INSTANCE OWNER</div>
        <div v-else-if="user.is_moderator" class="role-badge instance-mod-badge">INSTANCE MOD</div>
        <SupporterBadge v-if="user.id" :user-id="user.id" />
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
            <span class="stat-label">{{ $t('activitypub.followers') }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ formatNumber(user.following_count || 0) }}</span>
            <span class="stat-label">{{ t('activitypub.following') }}</span>
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
          <button @click.stop="handleViewProfile" class="action-item">
            <Icon name="user" />
            <span>View Profile</span>
          </button>
          
          <button v-if="!isCurrentUser" @click.stop="handleMute" class="action-item">
            <Icon name="volume-x" />
            <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
          </button>
          
          <button v-if="!isCurrentUser" @click.stop="handleBlock" class="action-item danger">
            <Icon name="user-x" />
            <span>{{ isBlocked ? 'Unblock' : 'Block' }}</span>
          </button>
        </div>
      </div>
    </div>

    <RemoteInstanceBadge
      v-if="showRemoteInstanceBadge && instanceBadgeVariant === 'corner'"
      :domain="user.domain!"
      variant="corner"
      :compact="isCompact"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useUserData } from '@/composables/useUserData'
import { services } from '@/services'
import Avatar from './Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import Icon from './Icon.vue'
import SupporterBadge from './SupporterBadge.vue'
import RemoteInstanceBadge from './RemoteInstanceBadge.vue'
import type { User, FederatedUser } from '@/types'

const { t } = useI18n()

interface Props {
  user: User | FederatedUser
  isCompact?: boolean
  isInteractive?: boolean
  showActions?: boolean
  showFollowBtn?: boolean
  showMoreActions?: boolean
  showInstanceBadge?: boolean
  instanceBadgeVariant?: 'corner' | 'inline'
  showRoles?: boolean
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
  instanceBadgeVariant: 'corner',
  showRoles: false,
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
const activityPubStore = useActivityPubStore()

// Professional presence system
const { getPresenceAwareStatus, getCurrentUser } = useUserData()

// State
const isFollowLoading = ref(false)
const showActionsMenu = ref(false)
const followInProgress = ref(false)

// Type guards
const isFederatedUser = (user: User | FederatedUser): user is FederatedUser => {
  return 'handle' in user
}

// Computed properties
//
// props.user.id is a profile id but authStore.session.user.id is the
// Supabase auth user id - they are different UUIDs (BUGS.md Pattern A).
// Compare against the cached current-user profile id so cards on your
// own profile correctly hide "Send Message" / "Follow" actions.
const isCurrentUser = computed(() => {
  if (!props.user.id) return false
  return props.user.id === getCurrentUser.value?.id
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
  if (!props.showRoles) return []
  // `roles` is only present on the chat-side `User` shape; federated users
  // don't carry server-roles. Cast through `any` so the union access is OK.
  return (props.user as any).roles || []
})

const hasInstanceBadge = computed(() => {
  return props.user.is_admin || props.user.is_moderator || false
})

const showRemoteInstanceBadge = computed(() => {
  return (
    props.showInstanceBadge &&
    isFederatedUser(props.user) &&
    !props.user.is_local &&
    !!props.user.domain
  )
})

const hasSpecialBadge = computed(() => {
  // Add logic for special badges (bot, moderator, etc.)
  return false
})

const specialBadgeIcon = computed(() => {
  return 'bot'
})

const chatUserStatus = computed(() => {
  if (isFederatedUser(props.user)) return undefined
  // Use presence-aware status for real-time accuracy
  return getPresenceAwareStatus(props.user.id).value
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
  if (isFollowLoading.value) return t('common.loading')
  return isFollowing.value ? t('activitypub.following') : t('activitypub.follow')
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
  if (!isFederatedUser(props.user) || isFollowLoading.value || followInProgress.value) return
  
  followInProgress.value = true;
  isFollowLoading.value = true
  try {
    // Just call toggleFollow - let it handle the logic
    const result = await services.interactions.toggleFollow(props.user.id)
    
    if (result.following) {
      activityPubStore.followedUsers.add(props.user.id)
      emit('follow', props.user.id)
    } else {
      activityPubStore.followedUsers.delete(props.user.id)
      emit('unfollow', props.user.id)
    }
  } catch (error) {
    debug.error('Failed to toggle follow:', error)
  } finally {
    isFollowLoading.value = false
    followInProgress.value = false;
  }
}

const handleMessage = async () => {
  emit('message', props.user)

  try {
    // create_or_get_direct_conversation expects PROFILE IDs on both sides.
    // Using authStore.session.user.id here previously passed the auth UUID,
    // which fails the RPC's participant check and silently dropped users on
    // the DM landing page instead of the new conversation (BUGS.md Pattern A).
    const { authContextService } = await import('@/services/AuthContextService')
    const currentProfileId = await authContextService.getCurrentProfileId()
    if (!currentProfileId) {
      router.push('/dm')
      return
    }

    const { useDMStore } = await import('@/stores/useDM')
    const dmStore = useDMStore()

    const existing = dmStore.conversations.find(c => c.other_user?.id === props.user.id)
    if (existing) {
      router.push(`/dm/${existing.id}`)
      return
    }

    const conversationId = await dmStore.createOrGetConversation(currentProfileId, props.user.id)
    if (conversationId) {
      router.push(`/dm/${conversationId}`)
    } else {
      router.push('/dm')
    }
  } catch (error) {
    debug.error('Failed to open DM:', error)
    router.push('/dm')
  }
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
    debug.error('Failed to toggle mute:', error)
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
    debug.error('Failed to toggle block:', error)
  }
  closeActionsMenu()
}

const handleViewProfile = () => {
  if (isFederatedUser(props.user)) {
    const handle = (props.user.handle || '').replace(/^@/, '')
    router.push({ name: 'UserProfile', params: { handle } })
  } else {
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
    el._clickOutsideHandler = (event: MouseEvent) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value()
      }
    }
    document.addEventListener('click', el._clickOutsideHandler)
  },
  unmounted(el: HTMLElement) {
    if (el._clickOutsideHandler) {
      document.removeEventListener('click', el._clickOutsideHandler)
    }
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

.unified-profile-card.has-corner-badge {
  padding-top: calc(var(--space-4) + 2px);
}

.unified-profile-card.compact.has-corner-badge {
  flex-direction: column;
  align-items: stretch;
  padding-top: calc(var(--space-3) + 2px);
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
  color: var(--harmony-primary);
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
  padding: 0 2px;
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid rgba(14, 165, 233, 0.3);
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.instance-admin-badge {
  background: linear-gradient(135deg, rgba(212, 160, 23, 0.3), rgba(184, 134, 11, 0.3));
  border-color: rgba(212, 160, 23, 0.5);
  color: #f0d060;
}

.instance-mod-badge {
  background: linear-gradient(135deg, rgba(43, 158, 143, 0.3), rgba(26, 122, 109, 0.3));
  border-color: rgba(43, 158, 143, 0.5);
  color: #5ed4c4;
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
  color: var(--text-primary);
}

.follow-btn.following:hover {
  background: var(--error-primary);
  border-color: var(--error-primary);
}

.message-btn {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.message-btn:hover {
  background: var(--harmony-primary-hover);
  border-color: var(--harmony-primary-hover);
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
  z-index: 9999;
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

.user-roles .instance-admin-badge {
  background: linear-gradient(135deg, rgba(212, 160, 23, 0.3), rgba(184, 134, 11, 0.3));
  border-color: rgba(212, 160, 23, 0.5);
  color: #f0d060;
}

.user-roles .instance-mod-badge {
  background: linear-gradient(135deg, rgba(43, 158, 143, 0.3), rgba(26, 122, 109, 0.3));
  border-color: rgba(43, 158, 143, 0.5);
  color: #5ed4c4;
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