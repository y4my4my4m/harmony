<template>
  <BaseModal 
    :show="show" 
    @close="$emit('close')"
    :show-header="false"
    :compact="false"
  >
    <div class="profile-modal-content">
      <!-- Cover Banner -->
      <div class="profile-banner" :style="bannerStyle">
        <div class="banner-gradient" :style="bannerStyle"></div>
        <div class="banner-actions">
          <button 
            v-if="!isCurrentUser" 
            @click.stop="showActionsMenu = !showActionsMenu"
            class="action-button"
            :class="{ active: showActionsMenu }"
            aria-label="More actions"
          >
            <Icon name="dots-vertical" :size="16" class="action-icon" />
          </button>
          <button @click="$emit('close')" class="close-button" aria-label="Close">
            <Icon name="close" :size="16" class="close-icon" />
          </button>
        </div>
      </div>

      <!-- Actions Dropdown -->
      <div
        v-if="showActionsMenu"
        class="actions-dropdown"
        v-click-outside="() => (showActionsMenu = false)"
      >
        <div class="action-item" @click="copyUserId">
          <Icon name="copy" class="action-item-icon" />
          Copy User ID
        </div>
        <div v-if="isInServerContext && canInvite" class="action-item" @click="openInviteModal">
          <Icon name="share" class="action-item-icon" />
          Send Server Invite
        </div>
        <div class="action-divider"></div>
        <div class="action-item" @click="toggleMute">
          <Icon :name="isMuted ? 'volume-2' : 'volume-x'" class="action-item-icon" />
          {{ isMuted ? 'Unmute User' : 'Mute User' }}
        </div>
        <div class="action-item" :class="{ danger: !isBlocked }" @click="toggleBlock">
          <Icon :name="isBlocked ? 'user-check' : 'ban'" class="action-item-icon" />
          {{ isBlocked ? 'Unblock User' : 'Block User' }}
        </div>
        <template v-if="isInServerContext && !isCurrentUser && (canKick || canBan)">
          <div class="action-divider"></div>
          <div v-if="canKick" class="action-item danger" @click="openKickModal">
            <Icon name="door-open" class="action-item-icon" :size="16" />
            Kick from Server
          </div>
          <div v-if="canBan" class="action-item danger" @click="openBanModal">
            <Icon name="user-x" class="action-item-icon" :size="16" />
            Ban from Server
          </div>
        </template>
      </div>

      <!-- Main Profile Content -->
      <div class="profile-content">
        <!-- Avatar and Basic Info -->
        <div class="profile-header">
          <div class="avatar-container">
            <div class="avatar-wrapper">
              <Avatar 
                :src="avatarUrl" 
                :alt="`${displayName}'s avatar`"
                class="profile-avatar"
                @error="handleAvatarError"
              />
              <div class="status-indicator" :class="userStatus"></div>
            </div>
          </div>
          
          <div class="profile-info">
            <div class="name-section">
              <h1 class="display-name" :style="{ color: userColor }">
                <DisplayName :userId="user!.id" :fallback="displayName" :color="userColor" />
                <span v-if="getUserVerified(user)" class="verified-badge">
                  <Icon name="check-circle" class="verified-icon" />
                </span>
              </h1>
              <p class="username">{{ displayHandle }}</p>
            </div>
            
            <div v-if="isInstanceAdmin(user)" class="role-badge instance-admin-badge">INSTANCE OWNER</div>
            <div v-else-if="isInstanceModerator(user)" class="role-badge instance-mod-badge">INSTANCE MOD</div>
            <SupporterBadge v-if="user?.id" :user-id="user.id" />

            <div class="user-badges">
              <div class="roles-container">
                <div 
                  v-for="role in getUserRoles(user)" 
                  :key="role.id"
                  class="role-badge"
                  :style="{ 
                    backgroundColor: role.color,
                    borderColor: role.color + '33'
                  }"
                >
                  {{ role.name }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- User Stats -->
        <div class="user-stats">
          <div class="stat-item">
            <span class="stat-value">{{ formatJoinDate(user?.created_at) }}</span>
            <span class="stat-label">Member Since</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ userStatusText }}</span>
            <span class="stat-label">Status</span>
          </div>
          
          <!-- ActivityPub/Federated User Stats (clickable to navigate to profile) -->
          <div v-if="socialStats" class="stat-item clickable" @click="navigateToProfile" title="View all posts">
            <span class="stat-value">{{ formatSocialCount(socialStats.posts) }}</span>
            <span class="stat-label">Posts</span>
          </div>
          <div v-if="socialStats" class="stat-item clickable" @click="navigateToProfile" title="View following">
            <span class="stat-value">{{ formatSocialCount(socialStats.following) }}</span>
            <span class="stat-label">{{ t('activitypub.following') }}</span>
          </div>
          <div v-if="socialStats" class="stat-item clickable" @click="navigateToProfile" title="View followers">
            <span class="stat-value">{{ formatSocialCount(socialStats.followers) }}</span>
            <span class="stat-label">{{ t('activitypub.followers') }}</span>
          </div>
          
          <!-- Chat User Stats -->
          <div v-else class="stat-item">
            <span class="stat-value">{{ getUserRoles(user).length || 0 }}</span>
            <span class="stat-label">Roles</span>
          </div>
        </div>

        <!-- Custom Status (global, for any user with one set) -->
        <div v-if="customStatusDisplay" class="custom-status-section">
          <span class="custom-status-label">Status</span>
          <span class="custom-status-text">{{ customStatusDisplay }}</span>
        </div>

        <!-- Federation Info (for remote users) -->
        <div v-if="isFederatedUser(user)" class="federation-section">
          <h3 class="section-title">
            <Icon name="link" class="section-icon" />
            Federation Info
          </h3>
          <div class="federation-info">
            <div class="federation-item">
              <span class="federation-label">Instance:</span>
              <span class="federation-value">{{ user.domain || currentDomain }}</span>
              <div v-if="instanceInfo" class="instance-badge" :class="instanceInfo.status">
                {{ instanceInfo.software || 'Unknown' }}
              </div>
              <div v-else-if="isLoadingInstanceInfo" class="instance-badge loading">
                Loading...
              </div>
            </div>
            <div class="federation-item">
              <span class="federation-label">Profile URL:</span>
              <a :href="getProfileUrl(user)" 
                 target="_blank" 
                 rel="noopener noreferrer" 
                 class="federation-link">
                View on {{ user.domain || currentDomain }}
              </a>
            </div>
            <div v-if="user.last_status_at" class="federation-item">
              <span class="federation-label">Last active:</span>
              <span class="federation-value">{{ formatLastSeen(user.last_status_at) }}</span>
            </div>
          </div>
        </div>

        <!-- About Section -->
        <div v-if="displayAbout" class="about-section">
          <h3 class="section-title">About</h3>
          <div class="about-content">
            <p class="about-text">{{ displayAbout }}</p>
          </div>
        </div>

        <!-- Custom Fields (for federated users) -->
        <div v-if="isFederatedUser(user) && user.fields?.length" class="fields-section">
          <h3 class="section-title">Profile Fields</h3>
          <div class="profile-fields">
            <div v-for="field in user.fields" :key="field.name" class="profile-field">
              <div class="field-name">{{ field.name }}</div>
              <div class="field-value" v-html="formatFieldValue(field.value)"></div>
              <div v-if="field.verified_at" class="field-verified" title="Verified">
                <Icon name="check-circle" class="verified-icon" />
              </div>
            </div>
          </div>
        </div>

        <!-- User Activities -->
        <div class="activities-section">
          <h3 class="section-title">Activity</h3>
          <div class="activity-grid">
            <!-- Chat User Activities -->
            <template v-if="!isFederatedUser(user)">
              <div class="activity-card">
                <div class="activity-icon">
                  <Icon name="message" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Messages</span>
                  <span class="activity-value">{{ isLoadingActivity ? '-' : getUserMessageCount(user) }}</span>
                </div>
              </div>
              
              <div class="activity-card">
                <div class="activity-icon">
                  <Icon name="microphone" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Voice Time</span>
                  <span class="activity-value">{{ isLoadingActivity ? '-' : formatVoiceTime(getUserVoiceTime(user)) }}</span>
                </div>
              </div>
            </template>
            
            <!-- Federated User Activities -->
            <template v-else>
              <div class="activity-card clickable" @click="navigateToProfile" title="View all posts">
                <div class="activity-icon">
                  <Icon name="post" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Posts</span>
                  <span class="activity-value">{{ formatSocialCount(socialStats?.posts || 0) }}</span>
                </div>
              </div>
              
              <div class="activity-card clickable" @click="navigateToProfile" title="View profile">
                <div class="activity-icon">
                  <Icon name="interaction" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Interactions</span>
                  <span class="activity-value">{{ formatSocialCount((socialStats?.followers || 0) + (socialStats?.following || 0)) }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!--
          Note Section temporarily hidden - the localStorage-based note flow
          isn't wired up to anything yet (no sync, no surfacing elsewhere) so
          we don't want to expose a half-finished feature. Keep the markup
          around so we can flip it back on once notes are persisted server-
          side and shown in the right places.

        <div v-if="!isCurrentUser" class="note-section">
          <h3 class="section-title">Note</h3>
          <div class="note-input-container">
            <textarea
              v-model="userNote"
              class="note-input"
              placeholder="Click to add a note about this user..."
              rows="3"
              maxlength="256"
              @input="debouncedSaveNote"
            ></textarea>
            <div class="note-counter">{{ userNote.length }}/256</div>
          </div>
        </div>
        -->


        <!-- Action Buttons -->
        <div class="profile-actions">
          <!-- Current User Actions -->
          <template v-if="isCurrentUser">
            <button 
              @click="openSettings"
              class="primary-action-btn single-action-btn"
            >
              <Icon name="pencil" :size="16" />
              Edit Profile
            </button>
          </template>

          <!-- Other User Actions -->
          <template v-else>
            <!-- Local Users: Send DM (local users can DM each other, hide if blocked) -->
            <button 
              v-if="getUserIsLocal(user) && !isBlocked"
              @click="sendDirectMessage"
              class="primary-action-btn"
            >
              <Icon name="message" :size="16" />
              Send Message
            </button>
            
            <!-- All Users: Follow/Unfollow (both local and remote) -->
            <button 
              @click="handleFollowToggle"
              class="primary-action-btn"
              :class="{ 'following': getUserIsFollowing(user) }"
            >
              <Icon :name="getUserIsFollowing(user) ? 'unfollow' : 'follow'" :size="16" />
              {{ getUserIsFollowing(user) ? t('activitypub.unfollow') : t('activitypub.follow') }}
            </button>
            
            <!-- All Users: Mention -->
            <button 
              @click="mentionUser"
              class="secondary-action-btn"
            >
              <Icon name="mention" :size="16"/>
              Mention
            </button>

            <!-- Invite to Server -->
            <div class="invite-btn-wrapper">
              <button 
                v-if="isInServerContext && canInvite"
                @click="openInviteModal"
                class="secondary-action-btn"
              >
                <Icon name="share" :size="16" />
                Invite to Server
              </button>
              <button 
                v-else-if="availableServers.length > 0"
                @click="showServerPicker = !showServerPicker"
                class="secondary-action-btn"
              >
                <Icon name="share" :size="16" />
                Invite to Server
              </button>
              <div v-if="showServerPicker && !isInServerContext" class="server-picker-dropdown" @click.stop>
                <p class="picker-label">Choose a server:</p>
                <button
                  v-for="server in availableServers"
                  :key="server.id"
                  class="server-picker-item"
                  @click="inviteToServer(server)"
                >
                  <img
                    v-if="(server as any).icon_url || server.icon"
                    :src="((server as any).icon_url || server.icon)"
                    :alt="server.name"
                    class="picker-server-icon"
                  />
                  <div v-else class="picker-server-initial">{{ server.name?.charAt(0) || '?' }}</div>
                  <span class="picker-server-name">{{ server.name }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </BaseModal>

  <KickBanModal
    v-if="user && isInServerContext"
    :show="showKickBanModal"
    :mode="kickBanMode"
    :user="{ id: user.id, username: user.username || '', display_name: (user as any).display_name || user.username || '', avatar_url: (user as any).avatar_url || null }"
    :server-id="serverChannelStore.currentServerId!"
    @close="showKickBanModal = false"
    @done="handleKickBanDone"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { escapeHtml } from '@/utils/sanitize'
import DOMPurify from 'dompurify'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { supabase } from '@/supabase'
import { useActivityPubStore } from '../stores/useActivityPub'
import { useServerChannelStore } from '../stores/useServerChannel'
import { useUserData } from '@/composables/useUserData'
import { useLayoutState } from '@/composables/useLayoutState'
import { getBannerUrl } from '@/utils/bannerUtils'
import { formatCustomStatusDisplay } from '@/utils/customStatusDisplay'
import { coreProfileService } from '@/services/core/CoreProfileService'
import { roleService, type ServerRole, Permission } from '@/services/RoleService'
import BaseModal from './common/BaseModal.vue'
import Icon from './common/Icon.vue'
import KickBanModal from './moderation/KickBanModal.vue'
import type { User, FederatedUser } from '../types'
import Avatar from './common/Avatar.vue'
import SupporterBadge from './common/SupporterBadge.vue'
import DisplayName from './DisplayName.vue'

const { t } = useI18n()

interface Props {
  show: boolean
  user: User | FederatedUser | null
}

const props = defineProps<Props>()
const emit = defineEmits(['close', 'invite', 'follow', 'unfollow', 'mention'])

const router = useRouter()
const route = useRoute()
const activityPubStore = useActivityPubStore()
const serverChannelStore = useServerChannelStore()
const { closeMobileSidebars, isMobile } = useLayoutState()

const isInServerContext = computed(() => {
  return route.path.startsWith('/chat/') && !route.path.startsWith('/dm')
    && !!serverChannelStore.currentServerId
})

// Reactive computed to track blocked/muted user counts for change detection
const blockedUsersCount = computed(() => activityPubStore.blockedUsers.size)
const mutedUsersCount = computed(() => activityPubStore.mutedUsers.size)

// Watch for changes to blocked/muted users counts
watch(blockedUsersCount, (newVal) => {
  debug.log('👁️ UserProfileModal: blockedUsers changed, size:', newVal)
}, { immediate: true })

watch(mutedUsersCount, (newVal) => {
  debug.log('👁️ UserProfileModal: mutedUsers changed, size:', newVal)
}, { immediate: true })

// Use professional presence system
const { 
  getUser,
  getUserStatusText,
  getUserDisplayName,
  getUserAvatarUrl,
  getUserColor,
  getUserBannerUrl,
  getUserCustomStatus,
  subscribeToProfilePresence,
  unsubscribeFromProfilePresence,
  getPresenceAwareStatus,
  getCurrentUser
} = useUserData()

// Reactive state
const showActionsMenu = ref(false)
const userNote = ref('')
const instanceInfo = ref<{ status: string; software?: string } | null>(null)
const isLoadingInstanceInfo = ref(false)
const fetchedUserStats = ref<{ posts: number; following: number; followers: number } | null>(null)
const fetchedCreatedAt = ref<string | null>(null)
const fetchedActivity = ref<{ message_count: number; voice_minutes: number } | null>(null)
const isLoadingUserStats = ref(false)
const isLoadingActivity = ref(false)

// Server roles for the user (from current server context)
const fetchedUserRoles = ref<ServerRole[]>([])
const isLoadingRoles = ref(false)

// Moderation state
const showKickBanModal = ref(false)
const kickBanMode = ref<'kick' | 'ban'>('kick')
const canKick = ref(false)
const canBan = ref(false)
const canInvite = ref(false)

// Server invite picker state
const showServerPicker = ref(false)

const availableServers = computed(() => {
  return serverChannelStore.servers || []
})

// Get the current instance domain
const currentDomain = import.meta.env.VITE_DOMAIN as string

/**
 * Fetch user stats and profile data via CoreProfileService
 */
function applyActivityFromStats(stats: { message_count?: number; voice_minutes?: number } | null | undefined) {
  if (stats == null) return
  if (stats.message_count === undefined && stats.voice_minutes === undefined) return
  fetchedActivity.value = {
    message_count: Number(stats.message_count ?? 0),
    voice_minutes: Number(stats.voice_minutes ?? 0),
  }
}

async function loadUserStats(userId: string) {
  if (isLoadingUserStats.value) {
    // Stats load already in flight - still fetch activity (cheap PK read).
    void loadUserActivity(userId)
    return
  }

  isLoadingUserStats.value = true
  try {
    // Use CoreProfileService for proper stats fetching
    const stats = await coreProfileService.getUserStats(userId)
    if (stats) {
      fetchedUserStats.value = {
        posts: stats.posts_count || 0,
        following: stats.following_count || 0,
        followers: stats.followers_count || 0
      }
      applyActivityFromStats(stats)
      debug.log('👤 Loaded user stats:', fetchedUserStats.value)
    }

    // Also fetch created_at if not on user object
    const { profileService } = await import('@/services/ProfileService')
    const profile = await profileService.fetchProfile(userId)
    if (profile?.created_at) {
      fetchedCreatedAt.value = profile.created_at
      debug.log('👤 Loaded user created_at:', fetchedCreatedAt.value)
    }
  } catch (error) {
    debug.error('Failed to load user stats:', error)
  } finally {
    isLoadingUserStats.value = false
    // Always load activity even if social stats / created_at failed.
    await loadUserActivity(userId)
  }
}

/**
 * Activity counters (denormalized columns on `profiles`, maintained by
 * triggers - see migrations/20260524_bot_grants_and_activity_counters.sql).
 * One tiny SELECT on PK; no count(*) scans. Separate function so we can
 * also call it when the rest of `loadUserStats` is skipped because the
 * caller already had post/follow counts.
 */
async function loadUserActivity(userId: string) {
  if (!userId) return
  isLoadingActivity.value = true
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('message_count, voice_minutes')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      // PGRST204 = column not in schema cache (migration not applied / not reloaded)
      debug.error('Failed to load user activity counters:', error.code, error.message, error)
      return
    }
    if (data) {
      fetchedActivity.value = {
        message_count: Number(data.message_count ?? 0),
        voice_minutes: Number(data.voice_minutes ?? 0),
      }
      debug.log('👤 Loaded user activity:', fetchedActivity.value)
    }
  } catch (err) {
    debug.error('Failed to load user activity counters:', err)
  } finally {
    isLoadingActivity.value = false
  }
}

/**
 * Fetch user roles for the current server context
 */
async function loadUserRoles(userId: string) {
  if (!isInServerContext.value || isLoadingRoles.value) return
  const serverId = serverChannelStore.currentServerId!
  
  isLoadingRoles.value = true
  try {
    const roles = await roleService.getUserRoles(userId, serverId)
    fetchedUserRoles.value = roles.filter(r => !r.is_default) // Exclude @everyone
    debug.log('🎭 Loaded user roles:', fetchedUserRoles.value.length)
  } catch (error) {
    debug.error('Failed to load user roles:', error)
    fetchedUserRoles.value = []
  } finally {
    isLoadingRoles.value = false
  }
}

/**
 * Fetch instance info for a domain via nodeinfo.
 * Skips when domain is the current instance (we already know it) or when the fetch
 * would be cross-origin (causes CORS errors, e.g. app on https://har.mony.local
 * fetching from http://localhost).
 */
async function loadInstanceInfo(domain: string) {
  if (!domain || isLoadingInstanceInfo.value) return

  // Skip for current instance - no need to fetch our own nodeinfo
  const currentHost = typeof window !== 'undefined' ? window.location.host : currentDomain
  const domainNorm = domain.split(':')[0].toLowerCase()
  const currentHostNorm = (currentHost?.split(':')[0] || currentDomain || '').toLowerCase()
  if (domainNorm === currentHostNorm || domainNorm === (currentDomain || '').toLowerCase()) {
    instanceInfo.value = { status: 'active', software: 'Harmony' }
    return
  }

  // Skip when cross-origin would fail (e.g. HTTPS page fetching HTTP localhost)
  if (typeof window !== 'undefined') {
    const pageProtocol = window.location.protocol
    const targetProtocol = (domain === 'localhost' || domain.startsWith('localhost:')) ? 'http:' : 'https:'
    if (pageProtocol === 'https:' && targetProtocol === 'http:') {
      instanceInfo.value = { status: 'unknown', software: undefined }
      return
    }
  }

  isLoadingInstanceInfo.value = true
  try {
    // Proxy through federation backend to avoid browser CORS blocking
    const probeRes = await fetch(`/api/federation/instances/probe?domain=${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (probeRes.ok) {
      const info = await probeRes.json()
      instanceInfo.value = {
        status: 'active',
        software: info.software || 'Unknown'
      }
      return
    }

    instanceInfo.value = { status: 'unknown', software: undefined }
  } catch (error) {
    debug.error('Failed to load instance info:', JSON.stringify(error))
    instanceInfo.value = { status: 'unknown', software: undefined }
  } finally {
    isLoadingInstanceInfo.value = false
  }
}

// Type guard: only truly remote/federated users, not local users with a domain field
const isFederatedUser = (user: User | FederatedUser | null): user is FederatedUser => {
  if (!user) return false;
  const u = user as any;
  // Explicitly remote (is_local === false) is the strongest signal
  if (u.is_local === false) return true;
  // Has a handle like @user@remote.server
  if (u.handle && u.handle.includes('@') && u.handle.split('@').filter(Boolean).length >= 2) return true;
  // Has a federated_id (ActivityPub canonical URL)
  if (u.federated_id || u.ap_id) return true;
  // Has a domain that differs from the current instance
  if (u.domain && u.domain !== currentDomain && u.domain !== 'localhost') return true;
  return false;
}

/**
 * Get the appropriate profile URL for viewing on the user's instance
 * For remote users: use federated_id (their canonical ActivityPub URL)
 * For local users: link to our profile page
 */
function getProfileUrl(user: FederatedUser | User | null): string {
  if (!user) return '#'
  
  const fed = user as FederatedUser
  
  // For local users, link to our frontend profile page
  if (fed.is_local || fed.domain === currentDomain || !fed.domain) {
    return `https://${currentDomain}/social/profile/${fed.username || (user as User).username}`
  }
  
  // For remote users, prefer the human-readable 'url' field from the AP actor
  if ((fed as any).url) {
    return (fed as any).url
  }
  
  // federated_id is the AP actor ID (e.g. /users/name) - not always a viewable page
  if (fed.federated_id) {
    return fed.federated_id
  }
  
  // Fallback: construct typical Mastodon-style URL
  return `https://${fed.domain}/@${fed.username}`
}

// Computed properties
//
// `props.user.id` is a PROFILE id, but `authStore.session.user.id` is the
// Supabase AUTH user id - the two are different UUIDs in this codebase
// (BUGS.md Pattern A). Comparing them used to always return false, which
// caused two regressions:
//   1. Looking at your OWN profile would show "Send Message" / "Follow" /
//      "Invite to Server" instead of "Edit Profile".
//   2. The DM button on your own card would call create_or_get_direct_
//      conversation with self as both participants → RPC accepted it and
//      silently swallowed the click.
// Compare against the cached current-user profile id from userDataService
// (kept in sync by useUserData) so the check is reactive and id-correct.
const isCurrentUser = computed(() => {
  if (!props.user?.id) return false
  return props.user.id === getCurrentUser.value?.id
})

const displayHandle = computed(() => {
  if (!props.user) return '@unknown'
  const u = props.user as any

  // Remote federated users: @username@domain
  if (isFederatedUser(props.user)) {
    if (u.handle) return u.handle
    const username = u.username || getUser(props.user.id).value?.username
    const domain = u.domain
    if (username && domain) return `@${username}@${domain}`
  }

  // Local users: @username
  const username = u.username || getUser(props.user.id).value?.username
  if (username && username !== 'Unknown' && username !== 'unknown') return `@${username}`
  return '@unknown'
})

const displayAbout = computed(() => {
  if (!props.user) return null
  
  return getUserBio(props.user)
})

const socialStats = computed(() => {
  if (!props.user) return null;
  
  // Check if user has any social stats (works for both federated and local users with AP integration)
  const user = props.user as any;
  const hasSocialStats = user.posts_count !== undefined || 
                         user.following_count !== undefined || 
                         user.followers_count !== undefined;
  
  // Use fetched stats as fallback if user object doesn't have them
  if (!hasSocialStats && fetchedUserStats.value) {
    return fetchedUserStats.value;
  }
  
  if (!hasSocialStats) return null;
  
  return {
    posts: user.posts_count || fetchedUserStats.value?.posts || 0,
    following: user.following_count || fetchedUserStats.value?.following || 0,
    followers: user.followers_count || fetchedUserStats.value?.followers || 0
  }
})

const userStatus = computed(() => {
  if (!props.user) return 'offline'
  
  const fed = props.user as FederatedUser
  
  // Remote federated users (is_local explicitly false) don't have real-time presence
  if (fed.is_local === false) {
    const lastStatus = fed.last_status_at
    if (lastStatus) {
      const lastStatusDate = new Date(lastStatus)
      const now = new Date()
      const hoursDiff = (now.getTime() - lastStatusDate.getTime()) / (1000 * 60 * 60)
      if (hoursDiff < 24) return 'online'
      if (hoursDiff < 72) return 'away'
    }
    return 'offline'
  }
  
  // Local users - use presence-aware status for real-time accuracy
  const status = getPresenceAwareStatus(props.user.id).value
  return status || 'offline'
})

const userStatusText = computed(() => {
  if (!props.user) return 'Offline'
  
  const fed = props.user as FederatedUser
  
  // Remote federated users (is_local explicitly false)
  if (fed.is_local === false) {
    const lastStatus = fed.last_status_at
    if (lastStatus) {
      const lastStatusDate = new Date(lastStatus)
      const now = new Date()
      const hoursDiff = (now.getTime() - lastStatusDate.getTime()) / (1000 * 60 * 60)
      if (hoursDiff < 1) return 'Recently Active'
      if (hoursDiff < 24) return 'Active Today'
      if (hoursDiff < 72) return 'Active Recently'
    }
    return 'Unknown'
  }
  
  // Local users - use real-time status text
  const statusText = getUserStatusText(props.user.id).value
  return statusText || 'Offline'
})

// Custom status (global, stored on profile)
const customStatusDisplay = computed(() => {
  if (!props.user) return ''
  const status = getUserCustomStatus(props.user.id).value
  return formatCustomStatusDisplay(status)
})

// Reactive computed properties using useUserData
const displayName = computed(() => {
  if (!props.user) return 'Unknown User'
  return getUserDisplayName(props.user.id).value || props.user.display_name || 'Unknown User'
})

const avatarUrl = computed(() => {
  if (!props.user) return '/default_avatar.webp'
  return getUserAvatarUrl(props.user.id).value || props.user.avatar_url || '/default_avatar.webp'
})

const userColor = computed(() => {
  if (!props.user) return '#ffffff'
  return getUserColor(props.user.id).value || '#ffffff'
})

const bannerUrl = computed(() => {
  if (!props.user) return null
  return getUserBannerUrl(props.user.id).value || (props.user as any).banner_url || null
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

// Methods
const handleAvatarError = (event: Event) => {
  const target = event.target as HTMLImageElement
  target.src = '/default_avatar.webp'
}

const formatJoinDate = (dateString: string | undefined) => {
  // Use fetched created_at as fallback if user object doesn't have it
  const effectiveDate = dateString || fetchedCreatedAt.value
  if (!effectiveDate) return 'Unknown'
  const date = new Date(effectiveDate)
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

const formatSocialCount = (count: number) => {
  if (count === 0) return '0'
  if (count < 1000) return count.toString()
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

const formatLastSeen = (dateString: string) => {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  })
}

const formatFieldValue = (value: any) => {
  // Profile fields can come from a federated server (ActivityPub
  // `PropertyValue`) as HTML (e.g. `<a href="..." rel="me">...</a>`), or
  // from a local profile as a plain string. We run BOTH cases through
  // DOMPurify with the same allowlist as `UserProfileView.vue` so the
  // profile modal and the standalone profile page render identically,
  // and so a malicious federated PropertyValue can't smuggle a
  // `<style>` / `<img onerror>` / `javascript:` href past the modal.
  // The newline -> <br> conversion preserves how local multi-line
  // plain-text values used to render (the previous `escapeHtml +
  // replace(/\n/g, '<br>')` flow).
  if (value == null) return ''
  const text = typeof value === 'string' ? value : String(value)
  // If the value doesn't already look like HTML, escape it so newlines
  // can be turned into <br>s without corrupting embedded `<a>` tags
  // produced by the storage encoder.
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(text)
  const html = looksLikeHtml ? text : escapeHtml(text).replace(/\n/g, '<br>')
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'br', 'span', 'em', 'strong', 'b', 'i'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
  }).replace(/<a\b(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer nofollow"')
}

const copyUserId = async () => {
  if (!props.user?.id) return
  
  try {
    await navigator.clipboard.writeText(props.user.id)
    // Show toast notification
    showActionsMenu.value = false
  } catch (error) {
    debug.error('Failed to copy user ID:', error)
  }
}

const sendDirectMessage = async () => {
  if (!props.user) return

  if (isBlocked.value) {
    debug.warn('Cannot send DM to blocked user')
    return
  }

  // Capture user data BEFORE emit('close'). The parent sets
  // `selectedUser = null` synchronously on close, which makes `props.user`
  // null. Any subsequent `props.user.id` access after an `await` here would
  // throw and get silently swallowed by the try/catch below - leaving the
  // user staring at no navigation. (Symptom of the closed-prop access issue
  // we hit in UnifiedProfileCard too.)
  const targetUserId = props.user.id

  emit('close')

  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const currentProfileId = await authContextService.getCurrentProfileId()
    if (!currentProfileId) {
      debug.error('Cannot send DM: no profile ID')
      return
    }

    const { useDMStore } = await import('@/stores/useDM')
    const dmStore = useDMStore()

    // Quick check: if conversations are already loaded, look for an existing one
    const existing = dmStore.conversations.find(c => c.other_user?.id === targetUserId)
    if (existing) {
      router.push(`/dm/${existing.id}`)
      return
    }

    // RPC handles find-or-create; store now navigates first, refreshes in background
    const conversationId = await dmStore.createOrGetConversation(currentProfileId, targetUserId)
    if (conversationId) {
      router.push(`/dm/${conversationId}`)
    } else {
      debug.error('Failed to create DM conversation: RPC returned null')
    }
  } catch (error) {
    debug.error('Failed to open DM:', error)
  }
}

const openSettings = () => {
  router.push('/settings/profile')
  emit('close')
}

const handleFollowToggle = async () => {
  if (!props.user) return
  
  try {
    const isCurrentlyFollowing = activityPubStore.isFollowing(props.user.id) || (props.user as any).is_following
    
    if (isCurrentlyFollowing) {
      await activityPubStore.unfollowUser(props.user.id)
      emit('unfollow', props.user.id)
    } else {
      await activityPubStore.followUser(props.user.id)
      emit('follow', props.user.id)
    }
  } catch (error) {
    debug.error('Failed to toggle follow:', error)
  }
}

const mentionUser = () => {
  if (!props.user) return

  const username = props.user.username || getUser(props.user.id).value?.username
  if (!username) return

  // Build the mention handle (with domain suffix for remote users)
  let mentionHandle: string
  if (isFederatedUser(props.user)) {
    const handle = props.user.handle || `@${username}${props.user.domain ? '@' + props.user.domain : ''}`
    mentionHandle = handle.startsWith('@') ? handle : `@${handle}`
  } else {
    mentionHandle = `@${username}`
  }

  // Context-aware behavior:
  //   - In chat/DM/server view → just emit('mention') so the parent inserts
  //     the mention into its message input. Don't touch the AP composer and
  //     don't navigate away.
  //   - In ActivityPub/social view (or anywhere else) → open the AP composer
  //     with the mention prefilled and navigate to the social home.
  const inChatContext = route.path.startsWith('/chat/') || route.path.startsWith('/dm')

  if (inChatContext) {
    emit('mention', mentionHandle.replace(/^@/, ''))
    emit('close')
    return
  }

  activityPubStore.openComposer({ content: `${mentionHandle} ` })
  router.push('/social/home')
  emit('close')
  if (!isFederatedUser(props.user)) {
    emit('mention', username)
  }
}

const navigateToProfile = () => {
  if (!props.user) return
  
  emit('close')
  
  const user = props.user as any
  const username = user.username || getUser(user.id).value?.username
  const domain = user.domain
  const instanceDomain = import.meta.env.VITE_DOMAIN as string
  const isRemote = user.is_local === false || (domain && domain !== instanceDomain)

  let handle = user.handle
  if (!handle) {
    handle = isRemote && domain
      ? `@${username || 'unknown'}@${domain}`
      : `@${username || 'unknown'}`
  }
  
  handle = handle.replace(/^@/, '')
  
  if (handle.endsWith(`@${instanceDomain}`)) {
    handle = handle.replace(`@${instanceDomain}`, '')
  }
  
  router.push({ 
    name: 'UserProfile', 
    params: { handle }
  })
}

const openInviteModal = () => {
  emit('invite')
  showActionsMenu.value = false
}

const inviteToServer = async (server: any) => {
  showServerPicker.value = false
  emit('close')
  serverChannelStore.pendingInviteOpen = true
  await serverChannelStore.setCurrentServer(server.id)
  await serverChannelStore.fetchCategoriesAndChannels(server.id)
  const firstChannel = serverChannelStore.channels[0]
  if (firstChannel) {
    router.push(`/chat/${server.id}/${firstChannel.id}`)
  } else {
    router.push(`/chat/${server.id}`)
  }
}

// Check if the current user has blocked this user (uses store getter for reactivity)
const isBlocked = computed(() => {
  if (!props.user) return false
  // Access the count to ensure reactivity when blocked users change
  blockedUsersCount.value
  // Use store getter for reliable check
  const blocked = activityPubStore.isBlocked(props.user.id)
  debug.log(`🔍 isBlocked check: userId=${props.user.id}, blocked=${blocked}, blockedUsers size=${activityPubStore.blockedUsers.size}`)
  return blocked
})

const toggleBlock = async () => {
  if (!props.user) return
  
  try {
    if (isBlocked.value) {
      await activityPubStore.unblockUser(props.user.id)
      debug.log('User unblocked successfully:', props.user.id)
    } else {
      await activityPubStore.blockUser(props.user.id)
      debug.log('User blocked successfully:', props.user.id)
    }
    showActionsMenu.value = false
  } catch (error) {
    debug.error('Failed to toggle block:', error)
  }
}

// Check if the current user has muted this user (uses store getter for reactivity)
const isMuted = computed(() => {
  if (!props.user) return false
  // Access the count to ensure reactivity when muted users change
  mutedUsersCount.value
  // Use store getter for reliable check
  const muted = activityPubStore.isMuted(props.user.id)
  debug.log(`🔍 isMuted check: userId=${props.user.id}, muted=${muted}, mutedUsers size=${activityPubStore.mutedUsers.size}`)
  return muted
})

const toggleMute = async () => {
  if (!props.user) return
  
  try {
    if (isMuted.value) {
      await activityPubStore.unmuteUser(props.user.id)
      debug.log('User unmuted successfully:', props.user.id)
    } else {
      await activityPubStore.muteUser(props.user.id)
      debug.log('User muted successfully:', props.user.id)
    }
    showActionsMenu.value = false
  } catch (error) {
    debug.error('Failed to toggle mute:', error)
  }
}

const openKickModal = () => {
  kickBanMode.value = 'kick'
  showKickBanModal.value = true
  showActionsMenu.value = false
}

const openBanModal = () => {
  kickBanMode.value = 'ban'
  showKickBanModal.value = true
  showActionsMenu.value = false
}

const handleKickBanDone = (result: { success: boolean; messagesDeleted?: number }) => {
  showKickBanModal.value = false
  if (result.success) {
    emit('close')
  }
}

async function loadModerationPermissions() {
  if (!isInServerContext.value || !props.user) {
    canKick.value = false
    canBan.value = false
    canInvite.value = false
    return
  }
  const serverId = serverChannelStore.currentServerId
  if (!serverId) return

  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) return

    const [kick, ban, invite] = await Promise.all([
      isCurrentUser.value ? Promise.resolve(false) : roleService.hasPermission(profileId, serverId, Permission.KICK_MEMBERS),
      isCurrentUser.value ? Promise.resolve(false) : roleService.hasPermission(profileId, serverId, Permission.BAN_MEMBERS),
      isCurrentUser.value ? Promise.resolve(false) : roleService.hasPermission(profileId, serverId, Permission.CREATE_INVITE),
    ])
    canKick.value = kick
    canBan.value = ban
    canInvite.value = invite
  } catch {
    canKick.value = false
    canBan.value = false
    canInvite.value = false
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
const debouncedSaveNote = (() => {
  let timeout: any
  return () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      saveUserNote()
    }, 1000)
  }
})()

// Helper methods for safe property access
const getUserVerified = (user: any) => {
  return user?.verified || user?.profile?.verified
}

const getUserRoles = (_user: any) => {
  if (!isInServerContext.value) {
    return []
  }
  return fetchedUserRoles.value
}

const isInstanceAdmin = (user: any) => {
  return user?.is_admin || user?.isAdmin || user?.profile?.is_admin || false
}

const isInstanceModerator = (user: any) => {
  return user?.is_moderator || user?.isModerator || user?.profile?.is_moderator || false
}

const getUserBio = (user: any) => {
  return user?.bio || user?.profile?.bio || user?.about
}

const getUserMessageCount = (user: any) => {
  return (
    fetchedActivity.value?.message_count
    ?? user?.message_count
    ?? user?.profile?.message_count
    ?? 0
  )
}

const getUserVoiceTime = (user: any) => {
  // DB stores minutes; older code used `voice_time` so we keep both as fallbacks.
  return (
    fetchedActivity.value?.voice_minutes
    ?? user?.voice_minutes
    ?? user?.voice_time
    ?? user?.profile?.voice_minutes
    ?? user?.profile?.voice_time
    ?? 0
  )
}

const getUserIsLocal = (user: any) => {
  return user?.is_local ?? true // Default to local if not specified
}

// Computed property for reactive follow state
const isFollowingUser = computed(() => {
  if (!props.user) return false
  
  // First check the ActivityPub store's reactive state (for real-time updates)
  if (activityPubStore.isFollowing(props.user.id)) {
    return true
  }
  
  // Fall back to user object property
  return (props.user as any)?.is_following || false
})

// Keep helper for backwards compatibility with template
const getUserIsFollowing = (_user: any) => {
  return isFollowingUser.value
}

const saveUserNote = () => {
  if (!props.user) return
  
  // Save note about this user to local storage or database
  const notes = JSON.parse(localStorage.getItem('userNotes') || '{}')
  notes[props.user.id] = userNote.value
  localStorage.setItem('userNotes', JSON.stringify(notes))
}

const loadUserNote = () => {
  if (!props.user) return
  
  const notes = JSON.parse(localStorage.getItem('userNotes') || '{}')
  userNote.value = notes[props.user.id] || ''
}

// Professional presence management for profile modal
let profileContextId: string | null = null

const initializeProfilePresence = async () => {
  if (props.user?.id && props.show && !profileContextId) {
    try {
      profileContextId = await subscribeToProfilePresence(props.user.id)
      debug.log(`👤 ProfileModal: Tracking presence for user ${props.user.id}`)
    } catch (error) {
      debug.error('Failed to subscribe to profile presence:', error)
    }
  }
}

const cleanupProfilePresence = async () => {
  if (props.user?.id && profileContextId) {
    try {
      await unsubscribeFromProfilePresence(props.user.id)
      profileContextId = null
      debug.log(`👤 ProfileModal: Stopped tracking presence for user ${props.user.id}`)
    } catch (error) {
      debug.error('Failed to unsubscribe from profile presence:', error)
    }
  }
}

// Watch for modal show/hide and user changes
watch(() => ({ show: props.show, userId: props.user?.id }), async (newVal, oldVal) => {
  if (!newVal.show || !newVal.userId) {
    // Modal closed or no user - cleanup. Reset the dropdown too so the next
    // open of the modal doesn't restore a stale "..." menu state.
    showActionsMenu.value = false
    await cleanupProfilePresence()
    instanceInfo.value = null
    fetchedUserStats.value = null
    fetchedCreatedAt.value = null
    fetchedActivity.value = null
    isLoadingActivity.value = false
    fetchedUserRoles.value = []
  } else if (newVal.show && newVal.userId && (newVal.userId !== oldVal?.userId || !oldVal?.show)) {
    // Modal opened or user switched - ensure the dropdown isn't carried over.
    showActionsMenu.value = false
    // Modal opened with user or user changed - cleanup old and setup new
    await cleanupProfilePresence()
    await initializeProfilePresence()
    
    // Auto-close mobile profile/status menu when profile modal opens
    if (isMobile.value) {
      closeMobileSidebars()
    }
    
    // Load user stats if not already available on user object
    // Load for ALL users, not just federated - local users have stats too
    if (props.user) {
      const user = props.user as any
      const hasStats = user.posts_count !== undefined || user.following_count !== undefined
      // Activity counters always need a profile-row fetch (never on chat user blobs).
      void loadUserActivity(props.user.id)
      if (!hasStats) {
        void loadUserStats(props.user.id)
      }
      
      // Load user roles for current server context
      // This shows the user's roles in the server where the modal was opened
      loadUserRoles(props.user.id)

      loadModerationPermissions()
      
      // Ensure followed users are loaded in the store for accurate follow button state
      if (!activityPubStore.followsLoaded) {
        activityPubStore.loadFollowedUsers()
      }

      // Ensure blocked/muted users are loaded for accurate mute/block button state
      if (activityPubStore.blockedUsers.size === 0 && activityPubStore.mutedUsers.size === 0) {
        activityPubStore.loadBlockingData()
      }
    }
    
    // Load instance info for federation section (only for federated users)
    if (props.user && isFederatedUser(props.user)) {
      const domain = (props.user as FederatedUser).domain || currentDomain
      loadInstanceInfo(domain)
    }
  }
}, { immediate: true })

// Cleanup on unmount
onUnmounted(() => {
  cleanupProfilePresence()
})

// Lifecycle
onMounted(() => {
  loadUserNote()
})
</script>

<style scoped>
.profile-modal-content {
  position: relative;
  margin: -24px -32px;
}

.profile-banner {
  position: relative;
  height: 120px;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  overflow: hidden;
}

.banner-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, transparent 0%, rgba(0, 0, 0, 0.3) 100%);
}

.banner-actions {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 10;
}

.action-button,
.close-button {
  /* `flex: 0 0 32px` keeps both buttons exact 32px squares even when the
     icon inside happens to come in slightly larger/smaller - that's what
     was making the two buttons render at noticeably different widths and
     heights, since the parent flex container would otherwise size each
     button to its own content. */
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.action-button:hover,
.close-button:hover {
  background: rgba(0, 0, 0, 0.7);
  border-color: rgba(255, 255, 255, 0.2);
  transform: scale(1.05);
}

.action-button.active {
  background: rgba(14, 165, 233, 0.8);
  border-color: #0EA5E9;
}

.action-icon,
.close-icon {
  /* The Icon component is given `:size="16"` explicitly so the inner SVG
     is already exactly 16x16 - these rules just guarantee the wrapper
     span doesn't grow/shrink from inherited skin or icon-size classes
     (e.g. .icon-md from Icon.vue's scoped styles) and end up
     visually off-centre. Keep them in sync with the :size prop above. */
  width: 16px !important;
  height: 16px !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.actions-dropdown {
  position: absolute;
  top: 56px;
  right: 16px;
  background:  var(--background-quinary);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 8px;
  min-width: 180px;
  z-index: 20;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.action-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  color: #b5bac1;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.action-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.action-item.danger {
  color: #ed4245;
}

.action-item.danger:hover {
  background: rgba(237, 66, 69, 0.1);
  color: #ff6b6e;
}

.action-item-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.action-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 0;
}

.profile-content {
  padding: 24px 32px 32px;
  background:  var(--background-quinary);
}

.profile-header {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  margin-top: -40px;
  margin-bottom: 24px;
}

.avatar-container {
  flex-shrink: 0;
}

.avatar-wrapper {
  position: relative;
  width: 80px;
  height: 80px;
}

.profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 6px solid  var(--background-quinary);
  background: var(--background-secondary);
  object-fit: cover;
}

.status-indicator {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 3px solid  var(--background-quinary);
  background: #23a55a; /* Default online status */
}

.status-indicator.online {
  background: #23a55a;
}

.status-indicator.away {
  background: #f0b232;
}

.status-indicator.busy {
  background: #ed4245;
}

.status-indicator.offline {
  background: #80848e;
}

.profile-info {
  flex: 1;
  min-width: 0;
  padding-top: 8px;
}

.name-section {
  margin-bottom: 12px;
}

.display-name {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.2;
  /* text-shadow: -1px -1px rgba(0, 0, 0, 0.5), 1px 1px rgba(0, 0, 0, 0.5); */
  position: relative;
  z-index: 10;
}

.verified-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.verified-icon {
  width: 16px;
  height: 16px;
  color: #f0b232;
}

.username {
  font-size: 16px;
  color: #b5bac1;
  margin: 0;
  font-weight: 500;
}

.user-badges {
  margin-top: 12px;
}

.roles-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
  background: rgba(0, 212, 255, 0.2) !important;
  border-color: rgba(0, 212, 255, 0.4) !important;
  color: #00d4ff !important;
}

.instance-mod-badge {
  background: rgba(46, 204, 113, 0.2) !important;
  border-color: rgba(46, 204, 113, 0.4) !important;
  color: #2ecc71 !important;
}

.user-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
}

.custom-status-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 24px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
}

.custom-status-label {
  font-size: 11px;
  color: #b5bac1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.custom-status-text {
  font-size: 14px;
  color: var(--text-primary);
}

.about-content {
  margin-bottom: 12px;
  background: var(--background-quaternary);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}
.about-text {
  color: #b5bac1;
  margin: 0;
  line-height: 1.5;
  word-wrap: break-word;
  user-select: text;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-item.clickable {
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.stat-item.clickable:hover {
  background: rgba(14, 165, 233, 0.15);
  transform: scale(1.05);
}

.stat-item.clickable:hover .stat-value {
  color: #0EA5E9;
}

.stat-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.stat-label {
  font-size: 12px;
  color: #b5bac1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  font-weight: 600;
}

.section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-icon {
  width: 16px;
  height: 16px;
  color: #0EA5E9;
}

.bio-section {
  margin-bottom: 24px;
}

.bio-content {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 12px;
}

.bio-text {
  color: #b5bac1;
  margin: 0;
  line-height: 1.5;
  word-wrap: break-word;
}

.fields-section {
  margin-bottom: 24px;
}

.profile-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.profile-field {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.profile-field:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.field-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 100px;
}

.field-value {
  font-size: 14px;
  color: #b5bac1;
  flex: 1;
  word-break: break-all;
}

.field-verified {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #f0b232;
  flex-shrink: 0;
}

.activities-section {
  margin-bottom: 24px;
}

.activity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.activity-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.activity-card:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.activity-card.clickable {
  cursor: pointer;
}

.activity-card.clickable:hover {
  background: rgba(14, 165, 233, 0.1);
  border-color: rgba(14, 165, 233, 0.3);
  transform: translateY(-1px);
}

.activity-card.clickable:hover .activity-icon {
  background: rgba(14, 165, 233, 0.3);
}

.activity-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(14, 165, 233, 0.2);
  border-radius: 8px;
  color: #0EA5E9;
  flex-shrink: 0;
}

.activity-icon-svg {
  width: 16px;
  height: 16px;
}

.activity-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.activity-title {
  font-size: 12px;
  color: #b5bac1;
  margin-bottom: 2px;
  font-weight: 500;
}

.activity-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}

.federation-section {
  margin-bottom: 24px;
}

.federation-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
}

.federation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: #b5bac1;
}

.federation-label {
  font-weight: 600;
  color: var(--text-primary);
  min-width: 60px;
}

.federation-value {
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
}

.federation-link {
  color: #0EA5E9;
  text-decoration: none;
  font-weight: 600;
}

.federation-link:hover {
  text-decoration: underline;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.instance-badge.online {
  background: rgba(4, 190, 77, 0.2);
  border-color: rgba(4, 190, 77, 0.3);
  color: #23a55a;
}

.instance-badge.idle {
  background: rgba(240, 178, 51, 0.2);
  border-color: rgba(240, 178, 51, 0.3);
  color: #f0b232;
}

.instance-badge.dnd {
  background: rgba(237, 66, 69, 0.2);
  border-color: rgba(237, 66, 69, 0.3);
  color: #ed4245;
}

.instance-badge.offline {
  background: rgba(128, 132, 142, 0.2);
  border-color: rgba(128, 132, 142, 0.3);
  color: #80848e;
}

.note-section {
  margin-bottom: 24px;
}

.note-input-container {
  position: relative;
}

.note-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 12px;
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
  min-height: 60px;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.note-input:focus {
  outline: none;
  border-color: #0EA5E9;
  background: rgba(255, 255, 255, 0.04);
}

.note-input::placeholder {
  color: var(--text-muted);
}

.note-counter {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.profile-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  flex-wrap: wrap;
}

.primary-action-btn,
.secondary-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
  flex: 1;
  min-width: 0;
}

.primary-action-btn svg {
  width: 16px;
  height: 16px;
  overflow: visible;
  padding: 0;
  margin:0;
}

.primary-action-btn {
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
  box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
}


.primary-action-btn.following {
  background: linear-gradient(135deg, #43b581, #369970);
  box-shadow: 0 2px 8px rgba(67, 181, 129, 0.3);
}

.primary-action-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.4);
}

.primary-action-btn.following:hover {
  background: linear-gradient(135deg, #f04747, #d73c3c);
  box-shadow: 0 4px 12px rgba(240, 71, 71, 0.4);
}

.profile-actions:has(.single-action-btn) {
  grid-template-columns: 1fr !important;
  justify-items: center;
}

.single-action-btn {
  width: 100%;
  box-shadow: none;
}

.secondary-action-btn {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.secondary-action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}

.btn-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* Server invite picker */
.invite-btn-wrapper {
  position: relative;
  display: flex;
}

.server-picker-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--background-quinary, #1e1f22);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 8px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 30;
  animation: fadeIn 0.15s ease-out;
}

.picker-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 8px 6px;
  margin: 0;
}

.server-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.server-picker-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.picker-server-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.picker-server-initial {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--harmony-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.picker-server-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .profile-modal-content {
    margin: -20px -24px;
  }
  
  .profile-content {
    padding: 20px 24px 28px;
  }
  
  .profile-header {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
  }
  
  .user-stats {
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  
  .activity-grid {
    grid-template-columns: 1fr;
  }
  
  .profile-actions {
    flex-direction: column;
  }
  
  .display-name {
    font-size: 20px;
  }
  
  .username {
    font-size: 14px;
  }
}
</style>