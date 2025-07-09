<template>
  <BaseModal 
    :show="show" 
    @close="$emit('close')"
    :show-header="false"
    :compact="false"
  >
    <div class="profile-modal-content">
      <!-- Cover Banner -->
      <div class="profile-banner" :style="{ background: user?.color || '#5865f2' }">
        <div class="banner-gradient"></div>
        <div class="banner-actions">
          <button 
            v-if="canManageUser" 
            @click="showActionsMenu = !showActionsMenu"
            class="action-button"
            :class="{ active: showActionsMenu }"
          >
            <svg viewBox="0 0 24 24" class="action-icon">
              <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
            </svg>
          </button>
          <button @click="$emit('close')" class="close-button">
            <svg viewBox="0 0 24 24" class="close-icon">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Actions Dropdown -->
      <div v-if="showActionsMenu" class="actions-dropdown" @click.stop>
        <div class="action-item" @click="copyUserId">
          <svg viewBox="0 0 24 24" class="action-item-icon">
            <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
          </svg>
          Copy User ID
        </div>
        <div class="action-item" @click="openInviteModal">
          <svg viewBox="0 0 24 24" class="action-item-icon">
            <path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.6 20.92,19A2.84,2.84 0 0,0 18,16.08Z" fill="currentColor"/>
          </svg>
          Send Server Invite
        </div>
        <div class="action-divider"></div>
        <div class="action-item danger" @click="blockUser">
          <svg viewBox="0 0 24 24" class="action-item-icon">
            <path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12C4,13.85 4.63,15.55 5.68,16.91L16.91,5.68C15.55,4.63 13.85,4 12,4M12,20A8,8 0 0,0 20,12C20,10.15 19.37,8.45 18.32,7.09L7.09,18.32C8.45,19.37 10.15,20 12,20Z" fill="currentColor"/>
          </svg>
          Block User
        </div>
      </div>

      <!-- Main Profile Content -->
      <div class="profile-content">
        <!-- Avatar and Basic Info -->
        <div class="profile-header">
          <div class="avatar-container">
            <div class="avatar-wrapper">
              <Avatar 
                :src="user?.avatar_url || '/default_avatar.png'" 
                :alt="`${user?.display_name || 'User'}'s avatar`"
                class="profile-avatar"
                @error="handleAvatarError"
              />
              <div class="status-indicator" :class="userStatus"></div>
            </div>
          </div>
          
          <div class="profile-info">
            <div class="name-section">
              <h1 class="display-name" :style="{ color: user?.color || '#ffffff' }">
                {{ user?.display_name || 'Unknown User' }}
                <span v-if="user?.verified" class="verified-badge">
                  <svg viewBox="0 0 24 24" class="verified-icon">
                    <path d="M12,2L15.09,8.26L22,9L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9L8.91,8.26L12,2Z" fill="currentColor"/>
                  </svg>
                </span>
              </h1>
              <p class="username">{{ displayHandle }}</p>
            </div>

            <div class="user-badges">
              <div v-if="user?.roles?.length" class="roles-container">
                <div 
                  v-for="role in user.roles" 
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
            <span class="stat-value">{{ userStatus === 'online' ? 'Active' : 'Offline' }}</span>
            <span class="stat-label">Status</span>
          </div>
          
          <!-- ActivityPub/Federated User Stats -->
          <div v-if="socialStats" class="stat-item">
            <span class="stat-value">{{ formatSocialCount(socialStats.posts) }}</span>
            <span class="stat-label">Posts</span>
          </div>
          <div v-if="socialStats" class="stat-item">
            <span class="stat-value">{{ formatSocialCount(socialStats.following) }}</span>
            <span class="stat-label">Following</span>
          </div>
          <div v-if="socialStats" class="stat-item">
            <span class="stat-value">{{ formatSocialCount(socialStats.followers) }}</span>
            <span class="stat-label">Followers</span>
          </div>
          
          <!-- Chat User Stats -->
          <div v-else class="stat-item">
            <span class="stat-value">{{ user?.roles?.length || 0 }}</span>
            <span class="stat-label">Roles</span>
          </div>
        </div>

        <!-- Federation Info (for federated users) -->
        <div v-if="isFederatedUser(user) && !user.is_local" class="federation-section">
          <h3 class="section-title">
            <svg viewBox="0 0 24 24" class="section-icon">
              <path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M11,16.5L6.5,12L7.91,10.59L11,13.67L16.59,8.09L18,9.5L11,16.5Z" fill="currentColor"/>
            </svg>
            Federation Info
          </h3>
          <div class="federation-info">
            <div class="federation-item">
              <span class="federation-label">Instance:</span>
              <span class="federation-value">{{ user.domain }}</span>
              <div v-if="instanceInfo" class="instance-badge" :class="instanceInfo.status">
                {{ instanceInfo.software || 'Unknown' }}
              </div>
            </div>
            <div class="federation-item">
              <span class="federation-label">Profile URL:</span>
              <a :href="user.instance_url || `https://${user.domain}/@${user.username}`" 
                 target="_blank" 
                 rel="noopener noreferrer" 
                 class="federation-link">
                View on {{ user.domain }}
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
                <svg viewBox="0 0 24 24" class="verified-icon">
                  <path d="M12,2L15.09,8.26L22,9L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9L8.91,8.26L12,2Z" fill="currentColor"/>
                </svg>
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
                  <svg viewBox="0 0 24 24">
                    <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4C22,2.89 21.1,2 20,2Z" fill="currentColor"/>
                  </svg>
                </div>
                <div class="activity-info">
                  <span class="activity-title">Messages</span>
                  <span class="activity-value">{{ user?.message_count || 0 }}</span>
                </div>
              </div>
              
              <div class="activity-card">
                <div class="activity-icon">
                  <svg viewBox="0 0 24 24">
                    <path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M12,6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6M12,8A4,4 0 0,0 8,12A4,4 0 0,0 12,16A4,4 0 0,0 16,12A4,4 0 0,0 12,8Z" fill="currentColor"/>
                  </svg>
                </div>
                <div class="activity-info">
                  <span class="activity-title">Voice Time</span>
                  <span class="activity-value">{{ formatVoiceTime(user?.voice_time) }}</span>
                </div>
              </div>
            </template>
            
            <!-- Federated User Activities -->
            <template v-else>
              <div class="activity-card">
                <div class="activity-icon">
                  <svg viewBox="0 0 24 24">
                    <path d="M17,12V3A1,1 0 0,0 16,2H3A1,1 0 0,0 2,3V17L6,13H16A1,1 0 0,0 17,12M21,6H19V15H6V17A1,1 0 0,0 7,18H18L22,22V7A1,1 0 0,0 21,6Z" fill="currentColor"/>
                  </svg>
                </div>
                <div class="activity-info">
                  <span class="activity-title">Posts</span>
                  <span class="activity-value">{{ formatSocialCount(socialStats?.posts || 0) }}</span>
                </div>
              </div>
              
              <div class="activity-card">
                <div class="activity-icon">
                  <svg viewBox="0 0 24 24">
                    <path d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,6A2,2 0 0,0 10,8A2,2 0 0,0 12,10A2,2 0 0,0 14,8A2,2 0 0,0 12,6M12,13C14.67,13 20,14.33 20,17V20H4V17C4,14.33 9.33,13 12,13M12,14.9C9.03,14.9 5.9,16.36 5.9,17V18.1H18.1V17C18.1,16.36 14.97,14.9 12,14.9Z" fill="currentColor"/>
                  </svg>
                </div>
                <div class="activity-info">
                  <span class="activity-title">Interactions</span>
                  <span class="activity-value">{{ formatSocialCount((socialStats?.followers || 0) + (socialStats?.following || 0)) }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Note Section (for current user to add notes about this user) -->
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

        <!-- Action Buttons -->
        <div class="profile-actions">
          <!-- Chat user actions -->
          <template v-if="!isFederatedUser(user)">
            <button 
              v-if="!isCurrentUser" 
              @click="sendDirectMessage"
              class="primary-action-btn"
            >
              <svg viewBox="0 0 24 24" class="btn-icon">
                <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4C22,2.89 21.1,2 20,2Z" fill="currentColor"/>
              </svg>
              Send Message
            </button>
            
            <button 
              v-if="isCurrentUser" 
              @click="openSettings"
              class="primary-action-btn"
            >
              <svg viewBox="0 0 24 24" class="btn-icon">
                <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.22,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.22,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" fill="currentColor"/>
              </svg>
              Edit Profile
            </button>
          </template>

          <!-- Federated user actions -->
          <template v-else-if="!isCurrentUser">
            <button 
              @click="handleFollowToggle"
              class="primary-action-btn"
              :class="{ 'following': user.is_following }"
            >
              <svg viewBox="0 0 24 24" class="btn-icon">
                <path v-if="!user.is_following" d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z" fill="currentColor"/>
                <path v-else d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z" fill="currentColor"/>
              </svg>
              {{ user.is_following ? 'Unfollow' : 'Follow' }}
            </button>
            
            <button 
              @click="mentionUser"
              class="secondary-action-btn"
            >
              <svg viewBox="0 0 24 24" class="btn-icon">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.54 0 3-.36 4.31-1.01L21 22l-1.01-4.69C20.64 15 21 13.54 21 12c0-5.52-4.48-10-10-10zm0 2c4.41 0 8 3.59 8 8 0 1.18-.26 2.29-.74 3.3L18.43 17l-1.7-.83C15.71 16.74 14.18 17 12 17c-4.41 0-8-3.59-8-8s3.59-8 8-8z" fill="currentColor"/>
              </svg>
              Mention
            </button>
          </template>

          <button 
            v-if="!isCurrentUser && canManageUser" 
            @click="openInviteModal"
            class="secondary-action-btn"
          >
            <svg viewBox="0 0 24 24" class="btn-icon">
              <path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.6 20.92,19A2.84,2.84 0 0,0 18,16.08Z" fill="currentColor"/>
            </svg>
            Share Invite
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useActivityPubStore } from '@/stores/useActivityPub'
import BaseModal from '@/components/common/BaseModal.vue'
import type { User, FederatedUser } from '@/types'
import Avatar from './common/Avatar.vue'

interface Props {
  show: boolean
  user: User | FederatedUser | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  invite: []
  follow?: [userId: string]
  unfollow?: [userId: string]
}>()

const router = useRouter()
const authStore = useAuthStore()
const activityPubStore = useActivityPubStore()

// Reactive state
const showActionsMenu = ref(false)
const userNote = ref('')

// Type guards
const isFederatedUser = (user: User | FederatedUser | null): user is FederatedUser => {
  return user !== null && 'handle' in user
}

// Computed properties
const isCurrentUser = computed(() => {
  return props.user?.id === authStore.session?.user?.id
})

const canManageUser = computed(() => {
  // Add logic based on user permissions/roles
  return !isCurrentUser.value
})

const displayHandle = computed(() => {
  if (!props.user) return '@unknown'
  
  if (isFederatedUser(props.user)) {
    return props.user.handle
  }
  
  // For chat users, show @username
  return `@${props.user.username || 'unknown'}`
})

const displayAbout = computed(() => {
  if (!props.user) return null
  
  if (isFederatedUser(props.user)) {
    return props.user.bio || props.user.about
  }
  
  return props.user.about
})

const socialStats = computed(() => {
  if (!props.user || !isFederatedUser(props.user)) return null
  
  return {
    posts: props.user.posts_count || 0,
    following: props.user.following_count || 0,
    followers: props.user.followers_count || 0
  }
})

const userStatus = computed(() => {
  // This would typically come from a real-time presence system
  return 'online' // 'online', 'idle', 'dnd', 'offline'
})

// Methods
const handleAvatarError = (event: Event) => {
  const target = event.target as HTMLImageElement
  target.src = '/default-avatar.png'
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
  if (typeof value === 'string') {
    return value.replace(/\n/g, '<br>')
  }
  return value
}

const copyUserId = async () => {
  if (!props.user?.id) return
  
  try {
    await navigator.clipboard.writeText(props.user.id)
    // Show toast notification
    showActionsMenu.value = false
  } catch (error) {
    console.error('Failed to copy user ID:', error)
  }
}

const sendDirectMessage = () => {
  if (!props.user) return
  
  // Navigate to DM with this user
  router.push(`/dm/${props.user.id}`)
  emit('close')
}

const openSettings = () => {
  router.push('/settings/profile')
  emit('close')
}

const handleFollowToggle = async () => {
  if (!props.user || !isFederatedUser(props.user)) return
  
  try {
    if (props.user.is_following) {
      await activityPubStore.unfollowUser(props.user.id)
      emit('unfollow', props.user.id)
    } else {
      await activityPubStore.followUser(props.user.id)
      emit('follow', props.user.id)
    }
  } catch (error) {
    console.error('Failed to toggle follow:', error)
  }
}

const mentionUser = () => {
  if (!props.user || !isFederatedUser(props.user)) return
  
  // Open the Monyverse composer with a mention
  activityPubStore.openComposer({
    content: `${props.user.handle} `
  })
  
  // Navigate to Monyverse and close modal
  router.push('/monyverse')
  emit('close')
}

const openInviteModal = () => {
  emit('invite')
  showActionsMenu.value = false
}

const blockUser = () => {
  if (!props.user) return
  
  // Implement block user functionality
  console.log('Block user:', props.user.id)
  showActionsMenu.value = false
}

const debouncedSaveNote = (() => {
  let timeout: number
  return () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      saveUserNote()
    }, 1000)
  }
})()

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
  background: linear-gradient(135deg, #5865f2, #7289da);
  border-radius: 12px 12px 0 0;
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
  gap: 8px;
  z-index: 10;
}

.action-button,
.close-button {
  width: 32px;
  height: 32px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.action-button:hover,
.close-button:hover {
  background: rgba(0, 0, 0, 0.7);
  border-color: rgba(255, 255, 255, 0.2);
  transform: scale(1.05);
}

.action-button.active {
  background: rgba(88, 101, 242, 0.8);
  border-color: #5865f2;
}

.action-icon,
.close-icon {
  width: 16px;
  height: 16px;
}

.actions-dropdown {
  position: absolute;
  top: 56px;
  right: 16px;
  background: #2b2d31;
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
  color: #f2f3f5;
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
  background: #2b2d31;
  border-radius: 0 0 12px 12px;
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
  border: 6px solid #2b2d31;
  background: #36393f;
  object-fit: cover;
}

.status-indicator {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 3px solid #2b2d31;
  background: #23a55a;
}

.status-indicator.idle {
  background: #f0b232;
}

.status-indicator.dnd {
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
  color: #f2f3f5;
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
  padding: 4px 8px;
  background: rgba(88, 101, 242, 0.2);
  border: 1px solid rgba(88, 101, 242, 0.3);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  text-transform: uppercase;
  letter-spacing: 0.02em;
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

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-value {
  font-size: 16px;
  font-weight: 700;
  color: #f2f3f5;
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
  color: #f2f3f5;
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
  color: #5865f2;
}

.about-section {
  margin-bottom: 24px;
}

.about-content {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 12px;
}

.about-text {
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
  color: #f2f3f5;
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

.activity-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(88, 101, 242, 0.2);
  border-radius: 8px;
  color: #5865f2;
  flex-shrink: 0;
}

.activity-icon svg {
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
  color: #f2f3f5;
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
  color: #f2f3f5;
  min-width: 60px;
}

.federation-value {
  font-weight: 500;
  color: #f2f3f5;
  flex: 1;
}

.federation-link {
  color: #5865f2;
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
  color: #ffffff;
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
  color: #f2f3f5;
  font-size: 14px;
  resize: vertical;
  min-height: 60px;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.note-input:focus {
  outline: none;
  border-color: #5865f2;
  background: rgba(255, 255, 255, 0.04);
}

.note-input::placeholder {
  color: #72767d;
}

.note-counter {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 10px;
  color: #72767d;
  pointer-events: none;
}

.profile-actions {
  display: flex;
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

.primary-action-btn {
  background: linear-gradient(135deg, #5865f2, #4752c4);
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(88, 101, 242, 0.3);
}

.primary-action-btn.following {
  background: linear-gradient(135deg, #43b581, #369970);
  box-shadow: 0 2px 8px rgba(67, 181, 129, 0.3);
}

.primary-action-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.4);
}

.primary-action-btn.following:hover {
  background: linear-gradient(135deg, #f04747, #d73c3c);
  box-shadow: 0 4px 12px rgba(240, 71, 71, 0.4);
}

.secondary-action-btn {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.secondary-action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.12);
  color: #f2f3f5;
}

.btn-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
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