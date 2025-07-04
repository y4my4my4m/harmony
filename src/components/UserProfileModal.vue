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
              <img 
                :src="user?.avatar_url || '/default-avatar.png'" 
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
              <p class="username">{{ user?.username || '@unknown' }}</p>
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
          <div class="stat-item">
            <span class="stat-value">{{ user?.roles?.length || 0 }}</span>
            <span class="stat-label">Roles</span>
          </div>
        </div>

        <!-- About Section -->
        <div v-if="user?.about" class="about-section">
          <h3 class="section-title">About</h3>
          <div class="about-content">
            <p class="about-text">{{ user.about }}</p>
          </div>
        </div>

        <!-- User Activities -->
        <div class="activities-section">
          <h3 class="section-title">Activity</h3>
          <div class="activity-grid">
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
import BaseModal from '@/components/common/BaseModal.vue'
import type { User } from '@/types'

interface Props {
  show: boolean
  user: User | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  invite: []
}>()

const router = useRouter()
const authStore = useAuthStore()

// Reactive state
const showActionsMenu = ref(false)
const userNote = ref('')

// Computed properties
const isCurrentUser = computed(() => {
  return props.user?.id === authStore.session?.user?.id
})

const canManageUser = computed(() => {
  // Add logic based on user permissions/roles
  return !isCurrentUser.value
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

// Close actions menu when clicking outside
const handleClickOutside = () => {
  showActionsMenu.value = false
}
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

.primary-action-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.4);
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