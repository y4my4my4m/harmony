<template>
  <div 
    class="profile-card" 
    :class="{ 
      compact: isCompact, 
      interactive: isInteractive,
      'no-actions': !showActions,
      'menu-open': showActionsMenu,
      'has-corner-badge': showRemoteInstanceBadge && instanceBadgeVariant === 'corner',
    }" 
    @click="handleClick"
  >
    <!-- Avatar Section -->
    <div class="avatar-section">
      <div class="avatar-wrapper">
        <Avatar
          :src="user.avatar_url"
          :alt="displayName"
          :size="avatarSize"
          :status="userPresenceStatus"
          :interactive="isInteractive"
        />
        <div v-if="hasStatusBadge" class="status-badge">
          <Icon :name="statusBadgeIcon" class="status-icon" />
        </div>
      </div>
    </div>

    <!-- User Information -->
    <div class="user-info">
      <div class="name-section">
        <h3 class="display-name" :style="{ color: user.color || undefined }">
          <DisplayName v-if="user.id" :userId="user.id" :fallback="displayName" :truncate="true" />
          <template v-else>{{ displayName }}</template>
          <Icon v-if="isVerified" name="verified" class="verified-badge" />
          <SupporterBadge v-if="user.id" :user-id="user.id" />
        </h3>
        <p class="user-handle">{{ displayHandle }}</p>
        <RemoteInstanceBadge
          v-if="showRemoteInstanceBadge && instanceBadgeVariant === 'inline'"
          :domain="user.domain!"
          variant="inline"
        />
      </div>

      <!-- Bio (non-compact only) -->
      <div v-if="!isCompact && displayBio" class="bio-section">
        <p class="bio-text">{{ truncatedBio }}</p>
      </div>

      <!-- Roles/Badges (non-compact only) -->
      <div v-if="!isCompact && (user.is_admin || user.is_moderator || userRoles.length > 0)" class="roles-section">
        <div v-if="user.is_admin" class="role-badge instance-admin-badge">INSTANCE OWNER</div>
        <div v-else-if="user.is_moderator" class="role-badge instance-mod-badge">INSTANCE MOD</div>
        <div
          v-for="role in userRoles"
          :key="role.id"
          class="role-badge"
          :style="{ backgroundColor: role.color, borderColor: role.color + '33' }"
        >
          {{ role.name }}
        </div>
      </div>

      <!-- Stats (always show) -->
      <div v-if="hasStats" class="stats-section">
        <!-- Standard Social Stats (for all users) -->
        <span class="stat">
          <strong>{{ formatNumber(user.followers_count || 0) }}</strong> {{ t('activitypub.followers') }}
        </span>
        <span class="stat">
          <strong>{{ formatNumber(user.following_count || 0) }}</strong> {{ t('activitypub.following') }}
        </span>
        <span class="stat">
          <strong>{{ formatNumber(user.posts_count || 0) }}</strong> {{ t('activitypub.monies') }}
        </span>
      </div>
    </div>

    <!-- Actions Section -->
    <div v-if="showActions" class="actions-section">
      <!-- Follow/Unfollow (federated users only) -->
      <button
        v-if="isFederatedUser && !isCurrentUser && showFollowBtn"
        @click.stop="handleFollowToggle"
        :disabled="isFollowLoading"
        :title="followButtonText"
        class="action-btn follow-btn"
        :class="{ following: isFollowing, loading: isFollowLoading }"
      >
        <Icon v-if="isFollowLoading" name="loader" class="spinning" :size="actionIconSize" />
        <Icon v-else-if="isFollowing" name="user-check" :size="actionIconSize" />
        <Icon v-else name="user-plus" :size="actionIconSize" />
        <span class="action-label">{{ followButtonText }}</span>
      </button>

      <!-- Message (local users only) -->
      <button
        v-if="!isFederatedUser && !isCurrentUser"
        @click.stop="handleMessage"
        title="Message"
        class="action-btn message-btn"
      >
        <Icon name="message-circle" :size="actionIconSize" />
        <span class="action-label">Message</span>
      </button>

      <!-- Mention (federated users only) -->
      <button
        v-if="isFederatedUser && !isCurrentUser"
        @click.stop="handleMention"
        title="Mention"
        class="action-btn mention-btn"
      >
        <Icon name="at-sign" :size="actionIconSize" />
        <span class="action-label">Mention</span>
      </button>

      <!-- More Actions Menu -->
      <div v-if="showMoreActions && !isCurrentUser" class="more-actions">
        <button
          @click.stop="showActionsMenu = !showActionsMenu"
          class="action-btn more-btn"
          :class="{ active: showActionsMenu }"
          title="More actions"
        >
          <Icon name="more-horizontal" :size="actionIconSize" />
        </button>
        
        <div v-if="showActionsMenu" class="actions-menu" v-click-outside="closeActionsMenu">
          <button @click="handleViewProfile" class="action-item">
            <Icon name="user" />
            <span>View Profile</span>
          </button>
          
          <button @click="handleMute" class="action-item">
            <Icon name="volume-x" />
            <span>{{ isMuted ? 'Unmute' : 'Mute' }}</span>
          </button>
          
          <button @click="handleBlock" class="action-item danger">
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
import { useAuthStore } from '@/stores/auth'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useUserData } from '@/composables/useUserData'
import { usePostInteractions } from '@/composables/usePostInteractions'
import Avatar from './Avatar.vue'
import DisplayName from '../DisplayName.vue'
import Icon from './Icon.vue'
import SupporterBadge from './SupporterBadge.vue'
import RemoteInstanceBadge from './RemoteInstanceBadge.vue'
import type { User, FederatedUser } from '@/types'

const { t } = useI18n()

// ===== INTERFACE =====
interface Props {
  user: User | FederatedUser
  isCompact?: boolean
  isInteractive?: boolean
  showActions?: boolean
  showFollowBtn?: boolean
  showMoreActions?: boolean
  showInstanceBadge?: boolean
  /** corner = top-right pill (default); inline = compact chip under handle (sidebar suggested follows) */
  instanceBadgeVariant?: 'corner' | 'inline'
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

// ===== DEPENDENCIES =====
const router = useRouter()
const authStore = useAuthStore()
const activityPubStore = useActivityPubStore()
const { getPresenceAwareStatus } = useUserData()
const { toggleFollow, getLoadingState } = usePostInteractions()

// ===== STATE =====
const showActionsMenu = ref(false)
const followInProgress = ref(false)

// ===== TYPE GUARDS =====
const isFederatedUser = computed(() => {
  const handle = (props.user as FederatedUser).handle
  return typeof handle === 'string' && handle.length > 0
})

const showRemoteInstanceBadge = computed(() => {
  return (
    props.showInstanceBadge &&
    isFederatedUser.value &&
    !props.user.is_local &&
    !!props.user.domain
  )
})

const actionIconSize = computed(() => (props.isCompact ? 'sm' : 'md'))

// ===== COMPUTED PROPERTIES =====
const isCurrentUser = computed(() => {
  return props.user.id === authStore.session?.user?.id
})

const displayName = computed(() => {
  return props.user.display_name || props.user.username || 'Unknown User'
})

const displayHandle = computed(() => {
  if (isFederatedUser.value) {
    return (props.user as FederatedUser).handle
  }
  return `@${props.user.username || 'unknown'}`
})

const displayBio = computed(() => {
  return props.user.bio || ''
})

const truncatedBio = computed(() => {
  if (!displayBio.value) return ''
  return displayBio.value.length > props.maxBioLength 
    ? displayBio.value.substring(0, props.maxBioLength) + '...' 
    : displayBio.value
})

const userRoles = computed(() => {
  // `roles` is only on the chat-side `User`; federated users don't carry
  // server-side roles. Cast so the union accessor type-checks.
  return (props.user as any).roles || []
})

const isVerified = computed(() => {
  return (props.user as any).verified || false
})

const hasStatusBadge = computed(() => {
  // Add logic for special status badges (bot, moderator, etc.)
  return false
})

const statusBadgeIcon = computed(() => {
  return 'bot'
})

const avatarSize = computed(() => {
  return props.isCompact ? 'md' : 'lg'
})

const userPresenceStatus = computed(() => {
  if (isFederatedUser.value) return undefined
  return getPresenceAwareStatus(props.user.id).value
})

const isFollowLoading = computed(() => {
  return getLoadingState().follow
})

const isFollowing = computed(() => {
  if (!isFederatedUser.value) return false
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

// ===== METHODS =====
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// eslint-disable-next-line unused-imports/no-unused-vars
const formatJoinDate = (dateString: string | undefined) => {
  if (!dateString) return 'Unknown'
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short',
    day: 'numeric' 
  })
}

// eslint-disable-next-line unused-imports/no-unused-vars
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
  if (!isFederatedUser.value || isFollowLoading.value || followInProgress.value) return
  
  followInProgress.value = true;
  try {
    const result = await toggleFollow(props.user.id)
    
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
    followInProgress.value = false;
  }
}

const handleMessage = async () => {
  emit('message', props.user)

  const currentUserId = authStore.session?.user?.id
  if (!currentUserId) {
    router.push('/dm')
    return
  }

  try {
    const { useDMStore } = await import('@/stores/useDM')
    const dmStore = useDMStore()

    const existing = dmStore.conversations.find(c => c.other_user?.id === props.user.id)
    if (existing) {
      router.push(`/dm/${existing.id}`)
      return
    }

    const conversationId = await dmStore.createOrGetConversation(currentUserId, props.user.id)
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
  if (isFederatedUser.value) {
    const fed = props.user as FederatedUser
    const handle = fed.handle || `@${fed.username}${fed.domain ? '@' + fed.domain : ''}`
    const mentionText = handle.startsWith('@') ? handle : `@${handle}`
    activityPubStore.openComposer({ content: `${mentionText} ` })
    router.push('/social/home')
    emit('mention', fed)
  }
}

const handleViewProfile = () => {
  if (isFederatedUser.value) {
    const federatedUser = props.user as FederatedUser
    const handle = (federatedUser.handle || '').replace(/^@/, '')
    router.push({ name: 'UserProfile', params: { handle } })
  } else {
    emit('click', props.user)
  }
  closeActionsMenu()
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

const closeActionsMenu = () => {
  showActionsMenu.value = false
}

// ===== DIRECTIVES =====
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
/* ===== BASE STYLES ===== */
.profile-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  transition: all var(--transition-base);
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.profile-card.interactive {
  cursor: pointer;
}

.profile-card.interactive:hover {
  border-color: var(--border-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.profile-card.compact {
  padding: var(--space-3);
  flex-direction: column;
  gap: var(--space-3);
  align-items: stretch;
  min-height: 0;
}

.compact .avatar-section {
  align-self: center;
}

.compact .user-info {
  text-align: center;
  margin-bottom: 0;
}

.compact .name-section {
  margin-bottom: var(--space-2);
}

.compact .display-name {
  font-size: var(--font-size-sm);
  margin-bottom: 2px;
  justify-content: center;
}

.compact .user-handle {
  font-size: var(--font-size-xs);
}

.compact .stats-section {
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.compact .actions-section {
  justify-content: stretch;
  flex-wrap: nowrap;
  gap: var(--space-1);
  width: 100%;
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-color);
}

.profile-card.no-actions .actions-section {
  display: none;
}

/* ===== AVATAR SECTION ===== */
.avatar-section {
  flex-shrink: 0;
}

.avatar-wrapper {
  position: relative;
}

.status-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  background: var(--background-primary);
  border-radius: 50%;
  padding: 2px;
}

.status-icon {
  width: 12px;
  height: 12px;
  color: var(--harmony-primary);
}

/* ===== USER INFO ===== */
.user-info {
  flex: 1;
  min-width: 0;
}

.name-section {
  margin-bottom: var(--space-2);
}

.display-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1) 0;
  line-height: 1.2;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.verified-badge {
  width: 16px;
  height: 16px;
  color: var(--success-primary);
  flex-shrink: 0;
}

.user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
  font-weight: var(--font-weight-medium);
}

/* ===== BIO SECTION ===== */
.bio-section {
  margin-bottom: var(--space-2);
}

.bio-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}

/* ===== ROLES SECTION ===== */
.roles-section {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
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

/* ===== STATS SECTION ===== */
.stats-section {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.stat {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.stat strong {
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
}

.compact .stats-section {
  font-size: var(--font-size-xs);
  gap: var(--space-2);
}

.compact .stat {
  text-align: center;
  flex-direction: column;
  gap: 1px;
}

.compact .stat strong {
  font-size: var(--font-size-sm);
  line-height: 1;
}

/* ===== ACTIONS SECTION ===== */
.actions-section {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-primary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all var(--transition-base);
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  justify-content: center;
}

.compact .action-btn {
  flex: 1 1 0;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-xs);
  gap: 4px;
}

.compact .action-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact .more-actions {
  flex: 0 0 auto;
}

.compact .more-actions .more-btn {
  flex: 0 0 auto;
  min-width: 32px;
  width: 32px;
  padding: var(--space-1);
}

.action-btn:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.follow-btn {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

/* Keep primary follow styling when pixel-art skin flattens .action-btn */
.profile-card.compact .action-btn.follow-btn {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.profile-card.compact .action-btn.follow-btn.following {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.follow-btn:hover {
  background: var(--harmony-primary-hover, #4f46e5);
  border-color: var(--harmony-primary-hover, #4f46e5);
}

.follow-btn.following {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.follow-btn.following:hover {
  background: var(--background-tertiary);
  border-color: var(--border-hover);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ===== MORE ACTIONS ===== */
.more-actions {
  position: relative;
}

.more-btn.active {
  background: var(--background-tertiary);
  border-color: var(--border-hover);
}

.actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: var(--space-2);
  min-width: 150px;
  z-index: 9999;
}

.profile-card.menu-open {
  z-index: 100;
}

.action-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-base);
}

.action-item:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.action-item.danger {
  color: var(--error-primary);
}

.action-item.danger:hover {
  background: rgba(248, 113, 113, 0.1);
}

.profile-card.has-corner-badge {
  /* room for the absolute badge without clipping action menus */
  padding-top: calc(var(--space-4) + 2px);
}

.profile-card.compact.has-corner-badge {
  padding-top: calc(var(--space-3) + 2px);
}

/* ===== RESPONSIVE ===== */
@media (max-width: 768px) {
  .profile-card:not(.compact) {
    padding: var(--space-3);
  }
  
  .stats-section {
    gap: var(--space-2);
    justify-content: center;
  }
  
  .actions-section {
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  
  .compact .action-btn {
    min-width: 40px;
    padding: var(--space-2);
  }
  
  .compact .stats-section {
    gap: var(--space-1);
  }
}
</style>