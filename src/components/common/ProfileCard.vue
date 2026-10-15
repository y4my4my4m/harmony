<template>
  <div 
    class="profile-card" 
    :class="{ 
      compact: isCompact, 
      interactive: isInteractive,
      'no-actions': !showActions,
      'menu-open': showActionsMenu,
      'has-corner-badge': showRemoteInstanceBadge && instanceBadgeVariant === 'corner',
      'has-banner': hasBanner,
    }" 
    @click="handleClick"
  >
    <div v-if="hasBanner" class="card-banner" :style="bannerStyle" aria-hidden="true">
      <img v-if="bannerSrc" :src="bannerSrc" alt="" loading="lazy" @error="bannerFailed = true" />
    </div>
    <!-- Avatar Section -->
    <div class="avatar-section">
      <div class="avatar-wrapper">
        <Avatar
          :src="user.avatar_url"
          alt=""
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
        <!-- The name button opens the profile for keyboard and screen readers; the
             card around it is a larger pointer target for the same action. -->
        <h3 class="display-name" :style="{ color: user.color || undefined }">
          <button
            v-if="isInteractive"
            type="button"
            class="card-name-btn"
            data-testid="profile-card-open"
            @click.stop="handleClick"
          >
            <DisplayName v-if="user.id" :userId="user.id" :fallback="displayName" :truncate="true" />
            <template v-else>{{ displayName }}</template>
          </button>
          <template v-else>
            <DisplayName v-if="user.id" :userId="user.id" :fallback="displayName" :truncate="true" />
            <template v-else>{{ displayName }}</template>
          </template>
          <Icon v-if="isVerified" name="verified" class="verified-badge" />
          <SupporterBadge v-if="user.id" :user-id="user.id" />
        </h3>
        <p class="user-handle">
          {{ displayHandle }}
          <span v-if="isMoved" class="moved-pill">{{ t('accountMigration.profile.movedBadge') }}</span>
        </p>
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
        <div v-if="user.is_admin" class="role-badge instance-admin-badge">{{ t('activitypub.followA11y.instanceOwner') }}</div>
        <div v-else-if="user.is_moderator" class="role-badge instance-mod-badge">{{ t('activitypub.followA11y.instanceMod') }}</div>
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
          <strong>{{ formatCount(profileCount(user, 'followers')) }}</strong> {{ t('activitypub.followers') }}
        </span>
        <span class="stat">
          <strong>{{ formatCount(profileCount(user, 'following')) }}</strong> {{ t('activitypub.following') }}
        </span>
        <span class="stat">
          <strong>{{ formatCount(profileCount(user, 'posts')) }}</strong> {{ t('activitypub.monies') }}
        </span>
      </div>
    </div>

    <!-- Actions Section -->
    <div v-if="showActions" class="actions-section">
      <!-- Follow/Unfollow (federated users only) -->
      <button
        v-if="isFederatedUser && !isCurrentUser && showFollowBtn && (!isMoved || isFollowing)"
        type="button"
        @click.stop="handleFollowToggle"
        :disabled="isFollowLoading"
        :title="followButtonText"
        :aria-label="followButtonLabel"
        class="action-btn follow-btn"
        :class="{ following: isFollowing || followRequested, loading: isFollowLoading }"
      >
        <Icon v-if="isFollowLoading" name="loader" class="spinning" :size="actionIconSize" />
        <Icon v-else-if="isFollowing || followRequested" name="user-check" :size="actionIconSize" />
        <Icon v-else name="user-plus" :size="actionIconSize" />
        <span class="action-label">{{ followButtonText }}</span>
      </button>

      <!-- Message (local users only) -->
      <button
        v-if="!isFederatedUser && !isCurrentUser"
        type="button"
        @click.stop="handleMessage"
        :title="t('activitypub.followA11y.message')"
        :aria-label="t('activitypub.followA11y.messageNamed', { name: displayName })"
        class="action-btn message-btn"
      >
        <Icon name="message-circle" :size="actionIconSize" />
        <span class="action-label">{{ t('activitypub.followA11y.message') }}</span>
      </button>

      <!-- Mention (federated users only) -->
      <button
        v-if="isFederatedUser && !isCurrentUser"
        type="button"
        @click.stop="handleMention"
        :title="t('activitypub.profileA11y.mention')"
        :aria-label="t('activitypub.mentionUser', { handle: plainHandle })"
        class="action-btn mention-btn"
      >
        <Icon name="at-sign" :size="actionIconSize" />
        <span class="action-label">{{ t('activitypub.profileA11y.mention') }}</span>
      </button>

      <!-- More Actions Menu -->
      <div v-if="showMoreActions && !isCurrentUser" class="more-actions" @click.stop>
        <button
          ref="moreBtnRef"
          type="button"
          @click.stop="showActionsMenu = !showActionsMenu"
          @keydown="onMenuTriggerKeydown"
          class="action-btn more-btn"
          :class="{ active: showActionsMenu }"
          :title="t('activitypub.moreOptions')"
          :aria-label="t('activitypub.followA11y.moreFor', { name: displayName })"
          aria-haspopup="menu"
          :aria-expanded="showActionsMenu"
          :aria-controls="showActionsMenu ? menuId : undefined"
        >
          <Icon name="more-horizontal" :size="actionIconSize" />
        </button>

        <SocialMenu
          v-if="showActionsMenu"
          :id="menuId"
          :anchor="moreBtnRef"
          :label="t('activitypub.followA11y.moreFor', { name: displayName })"
          :initial-focus="menuInitialFocus"
          @close="closeActionsMenu"
        >
          <button type="button" role="menuitem" class="social-menu-item" @click.stop="handleViewProfile">
            <Icon name="user" />
            <span>{{ t('activitypub.followA11y.viewProfile') }}</span>
          </button>
          <button type="button" role="menuitem" class="social-menu-item" @click.stop="handleMute">
            <Icon name="volume-x" />
            <span>{{ isMuted ? t('activitypub.profileA11y.unmute') : t('activitypub.profileA11y.mute') }}</span>
          </button>
          <button type="button" role="menuitem" class="social-menu-item danger" @click.stop="handleBlock">
            <Icon name="user-x" />
            <span>{{ isBlocked ? t('activitypub.profileA11y.unblock') : t('activitypub.profileA11y.block') }}</span>
          </button>
        </SocialMenu>
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
import { FOLLOW_ACTION_KEYS, useFollowAction } from '@/composables/useFollowAction'
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
import SocialMenu from '@/components/activitypub/SocialMenu.vue'
import { useMenuButton } from '@/composables/useMenu'
import { plainDisplayName } from '@/utils/plainDisplayName'
import type { User, FederatedUser } from '@/types'
import { profileCount } from '@/utils/profileCounts'
import { getBannerUrl } from '@/utils/bannerUtils'

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
  /** Header strip: the profile banner, else the profile colour. Not in the compact layout. */
  showBanner?: boolean
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
  maxBioLength: 120,
  showBanner: false
})

const bannerFailed = ref(false)
const hasBanner = computed(() => props.showBanner && !props.isCompact)
const bannerSrc = computed(() => bannerFailed.value ? null : getBannerUrl(props.user.banner_url, { width: 480, height: 120 }))
const bannerStyle = computed(() => (props.user.color ? { backgroundColor: props.user.color } : {}))

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
const moreBtnRef = ref<HTMLElement | null>(null)
const { menuId, onTriggerKeydown: onMenuTriggerKeydown, initialFocus: menuInitialFocus } = useMenuButton(showActionsMenu)
const followInProgress = ref(false)
// Pending request to a locked or remote account, set from the answer to a follow sent here.
const followRequested = ref(false)
const { action: followAction } = useFollowAction(() => props.user as FederatedUser)

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

const displayName = computed(() => plainDisplayName(props.user.display_name, props.user.username || t('activitypub.unknown')))

/** "user" or "user@domain", without the leading @. */
const plainHandle = computed(() => displayHandle.value.replace(/^@/, ''))

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

const isMoved = computed(() => {
  const user = props.user as { moved_to_id?: string | null; moved_to_uri?: string | null }
  return !!(user.moved_to_id || user.moved_to_uri)
})

const isMuted = computed(() => {
  return activityPubStore.isMuted(props.user.id)
})

const isBlocked = computed(() => {
  return activityPubStore.isBlocked(props.user.id)
})

const followButtonText = computed(() => {
  if (isFollowLoading.value) return t('common.loading')
  if (isFollowing.value) return t('activitypub.following')
  return followRequested.value ? t('activitypub.requested') : t(FOLLOW_ACTION_KEYS[followAction.value].text)
})

// Starts with the visible label, then names the account and what activating does.
const followButtonLabel = computed(() => {
  if (isFollowLoading.value) return t('common.loading')
  if (isFollowing.value) return t('activitypub.profileA11y.followingUnfollow', { handle: plainHandle.value })
  if (followRequested.value) return t('activitypub.profileA11y.requestedCancel', { handle: plainHandle.value })
  return t(FOLLOW_ACTION_KEYS[followAction.value].label, { handle: plainHandle.value })
})

// ===== METHODS =====
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// null: the account's server withholds the figure.
const formatCount = (num: number | null): string => (num === null ? '–' : formatNumber(num))

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
  const wasFollowing = isFollowing.value
  try {
    const result = await toggleFollow(props.user.id, followRequested.value)
    if (result.error) return
    followRequested.value = !!result.pending

    if (result.following) {
      activityPubStore.followedUsers.add(props.user.id)
      emit('follow', props.user.id)
    } else if (wasFollowing) {
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

/* Bleeds to the card's edges; the avatar sits over its lower edge. */
.card-banner {
  height: 72px;
  margin: calc(-1 * var(--space-4)) calc(-1 * var(--space-4)) 0;
  /* The card's top corners. */
  border-radius: inherit;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  overflow: hidden;
  background: var(--background-tertiary);
}

.card-banner img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile-card.has-banner .avatar-section {
  margin-top: calc(-1 * var(--space-3) - 32px);
}

.profile-card.has-banner .avatar-wrapper {
  width: fit-content;
  border-radius: 50%;
  box-shadow: 0 0 0 4px var(--background-secondary);
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
  color: var(--text-link);
}

/* ===== USER INFO ===== */
.user-info {
  flex: 1;
  min-width: 0;
}

.name-section {
  margin-bottom: var(--space-2);
}

.card-name-btn {
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

.card-name-btn:hover {
  text-decoration: underline;
}

.card-name-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
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
  color: var(--text-success);
  flex-shrink: 0;
}

.user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
  font-weight: var(--font-weight-medium);
}

.moved-pill {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  font-size: 11px;
  line-height: 18px;
  color: var(--text-link);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 45%, transparent);
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
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
  border-radius: var(--radius-base);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}

.instance-admin-badge {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  border-color: color-mix(in srgb, var(--warning) 40%, transparent);
}

.instance-mod-badge {
  background: color-mix(in srgb, var(--info) 15%, transparent);
  border-color: color-mix(in srgb, var(--info) 40%, transparent);
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
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

/* Keep primary follow styling when pixel-art skin flattens .action-btn */
.profile-card.compact .action-btn.follow-btn {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.profile-card.compact .action-btn.follow-btn.following {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.follow-btn:hover {
  background: var(--harmony-primary-fill-hover);
  border-color: var(--harmony-primary-hover);
  color: var(--text-on-primary);
}

.follow-btn.following {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.follow-btn.following:hover {
  background: var(--background-tertiary);
  border-color: var(--border-hover);
  color: var(--text-primary);
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