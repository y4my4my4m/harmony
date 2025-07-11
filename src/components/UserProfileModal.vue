<template>
  <BaseModal 
    :show="show" 
    @close="$emit('close')"
    :show-header="false"
    :compact="false"
  >
    <div class="profile-modal-content">
      <!-- Cover Banner -->
      <div class="profile-banner" :style="{ background: getUserColor(user) || '#5865f2' }">
        <div class="banner-gradient"></div>
        <div class="banner-actions">
          <button 
            v-if="!isCurrentUser" 
            @click="showActionsMenu = !showActionsMenu"
            class="action-button"
            :class="{ active: showActionsMenu }"
          >
            <Icon name="dots-vertical" class="action-icon" />
          </button>
          <button @click="$emit('close')" class="close-button">
            <Icon name="x" class="close-icon" />
          </button>
        </div>
      </div>

      <!-- Actions Dropdown -->
      <div v-if="showActionsMenu" class="actions-dropdown" @click.stop>
        <div class="action-item" @click="copyUserId">
          <Icon name="copy" class="action-item-icon" />
          Copy User ID
        </div>
        <div class="action-item" @click="openInviteModal">
          <Icon name="share" class="action-item-icon" />
          Send Server Invite
        </div>
        <div class="action-divider"></div>
        <div class="action-item danger" @click="blockUser">
          <Icon name="ban" class="action-item-icon" />
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
              <h1 class="display-name" :style="{ color: getUserColor(user) || '#ffffff' }">
                {{ user?.display_name || 'Unknown User' }}
                <span v-if="getUserVerified(user)" class="verified-badge">
                  <Icon name="check-circle" class="verified-icon" />
                </span>
              </h1>
              <p class="username">{{ displayHandle }}</p>
            </div>

            <div class="user-badges">
              <div v-if="getUserRoles(user).length" class="roles-container">
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
            <span class="stat-value">{{ getUserRoles(user).length || 0 }}</span>
            <span class="stat-label">Roles</span>
          </div>
        </div>

        <!-- Federation Info (for remote users) -->
        <div v-if="isFederatedUser(user) && !user?.is_local" class="federation-section">
          <h3 class="section-title">
            <Icon name="link" class="section-icon" />
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
                  <span class="activity-value">{{ getUserMessageCount(user) }}</span>
                </div>
              </div>
              
              <div class="activity-card">
                <div class="activity-icon">
                  <Icon name="microphone" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Voice Time</span>
                  <span class="activity-value">{{ formatVoiceTime(getUserVoiceTime(user)) }}</span>
                </div>
              </div>
            </template>
            
            <!-- Federated User Activities -->
            <template v-else>
              <div class="activity-card">
                <div class="activity-icon">
                  <Icon name="post" class="activity-icon-svg" />
                </div>
                <div class="activity-info">
                  <span class="activity-title">Posts</span>
                  <span class="activity-value">{{ formatSocialCount(socialStats?.posts || 0) }}</span>
                </div>
              </div>
              
              <div class="activity-card">
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
          <!-- Current User Actions -->
          <template v-if="isCurrentUser">
            <button 
              @click="openSettings"
              class="primary-action-btn"
            >
              <Icon name="pencil" :size="16" />
              Edit Profile
            </button>
          </template>

          <!-- Other User Actions -->
          <template v-else>
            <!-- Local Users: Send DM (local users can DM each other) -->
            <button 
              v-if="getUserIsLocal(user)"
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
              {{ getUserIsFollowing(user) ? 'Unfollow' : 'Follow' }}
            </button>
            
            <!-- All Users: Mention -->
            <button 
              @click="mentionUser"
              class="secondary-action-btn"
            >
              <Icon name="mention" :size="16"/>
              Mention
            </button>

            <!-- Share Invite (always available for non-current users) -->
            <button 
              @click="openInviteModal"
              class="secondary-action-btn"
            >
              <Icon name="share" :size="16" />
              Share Invite
            </button>
          </template>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useActivityPubStore } from '../stores/useActivityPub'  
import BaseModal from './common/BaseModal.vue'
import Icon from './common/Icon.vue'
import type { User, FederatedUser } from '../types'
import Avatar from './common/Avatar.vue'

interface Props {
  show: boolean
  user: User | FederatedUser | null
}

const props = defineProps<Props>()
const emit = defineEmits(['close', 'invite', 'follow', 'unfollow'])

const router = useRouter()
const authStore = useAuthStore()
const activityPubStore = useActivityPubStore()

// Reactive state
const showActionsMenu = ref(false)
const userNote = ref('')
const instanceInfo = ref<{ status: string; software?: string } | null>(null)

// Type guards
const isFederatedUser = (user: User | FederatedUser | null): user is FederatedUser => {
  return user !== null && 'handle' in user
}

// Computed properties
const isCurrentUser = computed(() => {
  return props.user?.id === authStore.session?.user?.id
})

const canManageUser = computed(() => {
  // Show management options for all non-current users
  return !isCurrentUser.value && props.user !== null
})

const displayHandle = computed(() => {
  if (!props.user) return '@unknown'
  
  if (isFederatedUser(props.user)) {
    return props.user.handle
  }
  
  // For chat users, show @username
  return `${props.user.username || 'unknown'}`
})

const displayAbout = computed(() => {
  if (!props.user) return null
  
  return getUserBio(props.user)
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

const blockUser = async () => {
  if (!props.user) return
  
  try {
    await activityPubStore.blockUser(props.user.id)
    console.log('User blocked successfully:', props.user.id)
    // Show success toast
    showActionsMenu.value = false
    emit('close')
  } catch (error) {
    console.error('Failed to block user:', error)
    // Show error toast
  }
}

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
const getUserColor = (user: any) => {
  return user?.color || user?.profile?.color
}

const getUserVerified = (user: any) => {
  return user?.verified || user?.profile?.verified
}

const getUserRoles = (user: any) => {
  return user?.roles || user?.profile?.roles || []
}

const getUserBio = (user: any) => {
  return user?.bio || user?.profile?.bio || user?.about
}

const getUserMessageCount = (user: any) => {
  return user?.message_count || user?.profile?.message_count || 0
}

const getUserVoiceTime = (user: any) => {
  return user?.voice_time || user?.profile?.voice_time || 0
}

const getUserIsLocal = (user: any) => {
  return user?.is_local ?? true // Default to local if not specified
}

const getUserIsFollowing = (user: any) => {
  return user?.is_following || false
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