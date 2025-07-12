<template>
  <div class="unified-notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">Notifications</h2>
      <p class="settings-description">
        Configure how you receive notifications from chat and federated networks.
      </p>
    </div>

    <!-- Do Not Disturb Section -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">Do Not Disturb</h3>
        <div class="dnd-status" :class="{ active: isDndActive }">
          {{ isDndActive ? 'Active' : 'Inactive' }}
        </div>
      </div>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Do Not Disturb</h4>
          <p class="setting-description">Suppress notifications during specified hours</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.dnd_enabled"
            @change="updatePreferences"
          />
        </div>
      </div>

      <div v-if="preferences.dnd_enabled" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Quiet Hours</h4>
          <p class="setting-description">Set your do not disturb schedule</p>
        </div>
        <div class="setting-control time-range">
          <input 
            type="time" 
            v-model="preferences.dnd_start_time"
            @change="updatePreferences"
            class="time-input"
          />
          <span class="time-separator">to</span>
          <input 
            type="time" 
            v-model="preferences.dnd_end_time"
            @change="updatePreferences"
            class="time-input"
          />
        </div>
      </div>
    </div>

    <!-- Desktop Notifications Section -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">Desktop Notifications</h3>
        <div class="permission-status">
          <div class="permission-info">
            <Icon :name="permissionIcon" :class="permissionClass" />
            <span class="permission-text">{{ permissionText }}</span>
          </div>
          <button 
            v-if="!hasNotificationPermission" 
            @click="requestPermission"
            class="permission-btn"
            :disabled="isRequestingPermission"
          >
            <Icon v-if="isRequestingPermission" name="loader" class="spinning" />
            <span>{{ isRequestingPermission ? 'Requesting...' : 'Grant Permission' }}</span>
          </button>
        </div>
      </div>
      
      <div class="notification-categories">
        <!-- Chat Notifications -->
        <div class="notification-category">
          <div class="category-header">
            <Icon name="message-circle" class="category-icon chat" />
            <div class="category-info">
              <h4 class="category-title">Chat & Messages</h4>
              <p class="category-description">Notifications from servers and direct messages</p>
            </div>
            <ToggleSwitch 
              v-model="preferences.desktop_notifications"
              @change="updatePreferences"
            />
          </div>
          
          <div v-if="preferences.desktop_notifications" class="category-settings">
            <div class="notification-type-grid">
              <div class="notification-type" v-for="type in chatNotificationTypes" :key="type.key">
                <div class="type-header">
                  <Icon :name="type.icon" class="type-icon" />
                  <div class="type-info">
                    <span class="type-label">{{ type.label }}</span>
                    <span class="type-description">{{ type.description }}</span>
                  </div>
                </div>
                <div class="type-controls">
                  <div class="control-group">
                    <Icon name="monitor" class="control-icon" />
                    <ToggleSwitch 
                      v-model="(preferences as any)[type.desktopKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <div class="control-group">
                    <Icon name="volume-2" class="control-icon" />
                    <ToggleSwitch 
                      v-model="(preferences as any)[type.soundKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <button 
                    class="test-btn" 
                    @click="testNotification(type.testType as NotificationType)"
                    :disabled="isTestingType === type.testType"
                  >
                    <Icon v-if="isTestingType === type.testType" name="loader" class="spinning" />
                    <Icon v-else name="play" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ActivityPub Notifications -->
        <div class="notification-category">
          <div class="category-header">
            <Icon name="globe" class="category-icon activitypub" />
            <div class="category-info">
              <h4 class="category-title">ActivityPub & Federation</h4>
              <p class="category-description">Notifications from the federated network</p>
            </div>
            <ToggleSwitch 
              v-model="preferences.activitypub_notifications"
              @change="updatePreferences"
            />
          </div>
          
          <div v-if="preferences.activitypub_notifications" class="category-settings">
            <div class="notification-type-grid">
              <div class="notification-type" v-for="type in activityPubNotificationTypes" :key="type.key">
                <div class="type-header">
                  <Icon :name="type.icon" class="type-icon" />
                  <div class="type-info">
                    <span class="type-label">{{ type.label }}</span>
                    <span class="type-description">{{ type.description }}</span>
                  </div>
                </div>
                <div class="type-controls">
                  <div class="control-group">
                    <Icon name="monitor" class="control-icon" />
                    <ToggleSwitch 
                      v-model="(preferences as any)[type.desktopKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <div class="control-group">
                    <Icon name="volume-2" class="control-icon" />
                    <ToggleSwitch 
                      v-model="(preferences as any)[type.soundKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <button 
                    class="test-btn" 
                    @click="testNotification(type.testType as NotificationType)"
                    :disabled="isTestingType === type.testType"
                  >
                    <Icon v-if="isTestingType === type.testType" name="loader" class="spinning" />
                    <Icon v-else name="play" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sound Settings Section -->
    <div class="settings-section">
      <h3 class="section-title">Sound Settings</h3>
      <p class="section-description">Configure sound notification behavior</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Master Volume</h4>
          <p class="setting-description">Adjust the volume for all notification sounds</p>
        </div>
        <div class="setting-control">
          <div class="volume-control">
            <Icon name="volume-1" />
            <input 
              type="range" 
              min="0" 
              max="100" 
              v-model.number="soundVolume"
              class="volume-slider"
              @input="onVolumeChange"
            />
            <Icon name="volume-2" />
            <span class="volume-value">{{ soundVolume }}%</span>
          </div>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Voice Activity Sounds</h4>
          <p class="setting-description">Play sounds for voice channel activity</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.sound_voice_activity"
            @change="updatePreferences"
          />
        </div>
      </div>
    </div>

    <!-- Email & Push Notifications Section -->
    <div class="settings-section">
      <h3 class="section-title">Email & Push Notifications</h3>
      <p class="section-description">Configure email digests and push notifications</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Email Notifications</h4>
          <p class="setting-description">Receive email summaries of activity</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.email_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <div v-if="preferences.email_notifications" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Email Digest Frequency</h4>
          <p class="setting-description">How often to send email summaries</p>
        </div>
        <div class="setting-control">
          <select 
            v-model="preferences.email_digest_frequency"
            @change="updatePreferences"
            class="select-input"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="never">Never</option>
          </select>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Push Notifications</h4>
          <p class="setting-description">Receive notifications when app is closed</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.push_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <div v-if="preferences.push_notifications" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Only When Offline</h4>
          <p class="setting-description">Only send push notifications when you're away</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.push_offline_only"
            @change="updatePreferences"
          />
        </div>
      </div>
    </div>

    <!-- Test All Section -->
    <div class="settings-section">
      <h3 class="section-title">Test Notifications</h3>
      <p class="section-description">Test your notification settings</p>
      
      <div class="test-actions">
        <button 
          @click="testAllNotifications"
          class="test-all-btn"
          :disabled="isTesting"
        >
          <Icon v-if="isTesting" name="loader" class="spinning" />
          <Icon v-else name="zap" />
          <span>{{ isTesting ? 'Testing...' : 'Test All Notifications' }}</span>
        </button>
        
        <button 
          @click="resetToDefaults"
          class="reset-btn"
          :disabled="!hasChanges"
        >
          <Icon name="rotate-ccw" />
          <span>Reset to Defaults</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, reactive } from 'vue'
import { useNotificationStore } from '@/stores/useNotification'
import { useToast } from 'vue-toastification'
import type { NotificationPreferences, NotificationType } from '@/types'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import { useUserData } from '@/composables/useUserData'

// Stores
const notificationStore = useNotificationStore()
const toast = useToast()
const userData = useUserData()

// State
const preferences = reactive<NotificationPreferences>({
  id: '',
  user_id: '',
  desktop_notifications: true,
  desktop_mentions: true,
  desktop_dms: true,
  desktop_reactions: false,
  desktop_replies: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: false,
  sound_voice_activity: true,
  push_notifications: true,
  push_mentions: true,
  push_dms: true,
  push_offline_only: true,
  email_notifications: false,
  email_digest: false,
  email_digest_frequency: 'weekly',
  dnd_enabled: false,
  dnd_start_time: '22:00:00',
  dnd_end_time: '08:00:00',
  // ActivityPub preferences
  activitypub_notifications: true,
  activitypub_follows: true,
  activitypub_favorites: true,
  activitypub_reblogs: true,
  activitypub_mentions: true,
  activitypub_replies: true,
  activitypub_follow_requests: true,
  activitypub_desktop_notifications: true,
  activitypub_desktop_follows: true,
  activitypub_desktop_favorites: false,
  activitypub_desktop_reblogs: false,
  activitypub_desktop_mentions: true,
  activitypub_desktop_replies: true,
  activitypub_sound_notifications: true,
  activitypub_sound_follows: true,
  activitypub_sound_favorites: false,
  activitypub_sound_reblogs: false,
  activitypub_sound_mentions: true,
  activitypub_sound_replies: true,
  created_at: '',
  updated_at: ''
})

const originalPreferences = ref<NotificationPreferences>({} as NotificationPreferences)
const hasNotificationPermission = ref(false)
const isRequestingPermission = ref(false)
const isTesting = ref(false)
const isTestingType = ref<string | null>(null)
const soundVolume = ref(70)

// Notification type configurations
const chatNotificationTypes = [
  {
    key: 'desktop_mentions',
    label: 'Mentions',
    description: 'When someone mentions you',
    icon: 'at-sign',
    desktopKey: 'desktop_mentions',
    soundKey: 'sound_mentions',
    testType: 'mention'
  },
  {
    key: 'desktop_dms',
    label: 'Direct Messages',
    description: 'When you receive a DM',
    icon: 'message-circle',
    desktopKey: 'desktop_dms',
    soundKey: 'sound_dms',
    testType: 'dm'
  },
  {
    key: 'desktop_replies',
    label: 'Replies',
    description: 'When someone replies to your message',
    icon: 'corner-down-left',
    desktopKey: 'desktop_replies',
    soundKey: 'sound_replies',
    testType: 'reply'
  },
  {
    key: 'desktop_reactions',
    label: 'Reactions',
    description: 'When someone reacts to your message',
    icon: 'smile',
    desktopKey: 'desktop_reactions',
    soundKey: 'sound_reactions',
    testType: 'reaction'
  }
]

const activityPubNotificationTypes = [
  {
    key: 'activitypub_follows',
    label: 'Follows',
    description: 'When someone follows you',
    icon: 'user-plus',
    desktopKey: 'activitypub_desktop_follows',
    soundKey: 'activitypub_sound_follows',
    testType: 'activitypub_follow'
  },
  {
    key: 'activitypub_mentions',
    label: 'Mentions',
    description: 'When someone mentions you in a post',
    icon: 'at-sign',
    desktopKey: 'activitypub_desktop_mentions',
    soundKey: 'activitypub_sound_mentions',
    testType: 'activitypub_mention'
  },
  {
    key: 'activitypub_replies',
    label: 'Replies',
    description: 'When someone replies to your post',
    icon: 'message-circle',
    desktopKey: 'activitypub_desktop_replies',
    soundKey: 'activitypub_sound_replies',
    testType: 'activitypub_reply'
  },
  {
    key: 'activitypub_favorites',
    label: 'Favorites',
    description: 'When someone favorites your post',
    icon: 'heart',
    desktopKey: 'activitypub_desktop_favorites',
    soundKey: 'activitypub_sound_favorites',
    testType: 'activitypub_favorite'
  },
  {
    key: 'activitypub_reblogs',
    label: 'Reblogs',
    description: 'When someone reblogs your post',
    icon: 'repeat',
    desktopKey: 'activitypub_desktop_reblogs',
    soundKey: 'activitypub_sound_reblogs',
    testType: 'activitypub_reblog'
  },
  {
    key: 'activitypub_follow_requests',
    label: 'Follow Requests',
    description: 'When someone requests to follow you',
    icon: 'user-check',
    desktopKey: 'activitypub_desktop_follows',
    soundKey: 'activitypub_sound_follows',
    testType: 'activitypub_follow_request'
  }
]

// Computed properties
const isDndActive = computed(() => notificationStore.isDndActive)

const hasChanges = computed(() => {
  return JSON.stringify(preferences) !== JSON.stringify(originalPreferences.value)
})

const permissionIcon = computed(() => {
  return hasNotificationPermission.value ? 'check-circle' : 'alert-circle'
})

const permissionClass = computed(() => {
  return hasNotificationPermission.value ? 'permission-granted' : 'permission-denied'
})

const permissionText = computed(() => {
  if (hasNotificationPermission.value) {
    return 'Desktop notifications are enabled'
  }
  return 'Desktop notifications require permission'
})

// Methods
const loadPreferences = () => {
  const currentPreferences = notificationStore.preferences
  if (currentPreferences) {
    Object.assign(preferences, currentPreferences)
    originalPreferences.value = { ...currentPreferences }
  }
}

const updatePreferences = async () => {
  try {
    await notificationStore.updatePreferences(preferences)
    toast.success('Notification preferences updated')
  } catch (error) {
    console.error('Failed to update preferences:', error)
    toast.error('Failed to update preferences')
  }
}

const requestPermission = async () => {
  if (typeof Notification === 'undefined') {
    toast.error('Desktop notifications are not supported in this browser')
    return
  }
  
  try {
    isRequestingPermission.value = true
    const permission = await Notification.requestPermission()
    hasNotificationPermission.value = permission === 'granted'
    
    if (hasNotificationPermission.value) {
      toast.success('Desktop notification permission granted')
    } else {
      toast.error('Desktop notification permission denied')
    }
  } catch (error) {
    console.error('Failed to request permission:', error)
    toast.error('Failed to request permission')
  } finally {
    isRequestingPermission.value = false
  }
}

const testNotification = async (type: NotificationType) => {
  if (isTestingType.value) return
  
  try {
    isTestingType.value = type
    
    // Create test notification data locally
    const testData = createTestNotificationData(type)
    
    // Show toast using the unified system
    notificationStore.showToast(
      type,
      testData.title,
      testData.message,
      3000,
      testData.avatar
    )
    
    // Play sound
    await notificationStore.playNotificationSound(type)
    
    // Show desktop notification
    if (hasNotificationPermission.value) {
      new Notification(testData.title, {
        body: testData.message,
        icon: testData.avatar || '/harmony_icon1.png',
        badge: '/harmony_icon1.png'
      })
    }
    
    // toast.success(`Test notification sent for ${type}`)
  } catch (error) {
    console.error('Failed to test notification:', error)
    toast.error('Failed to test notification')
  } finally {
    setTimeout(() => {
      isTestingType.value = null
    }, 1000)
  }
}

// Helper function to create test notification data
const createTestNotificationData = (type: NotificationType) => {
  const testMessages = {
    mention: {
      title: 'Test Mention',
      message: 'You were mentioned in a test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    dm: {
      title: 'Test Direct Message',
      message: 'This is a test direct message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    reply: {
      title: 'Test Reply',
      message: 'Someone replied to your test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    reaction: {
      title: 'Test Reaction',
      message: 'Someone reacted to your test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    voice_channel_activity: {
      title: 'Test Voice Activity',
      message: 'Someone joined a voice channel',
      avatar: userData.getUserAvatarUrlCurrent
    },
    server_invite: {
      title: 'Test Server Invite',
      message: 'You were invited to join a server',
      avatar: '/default_server_icon.png'
    },
    friend_request: {
      title: 'Test Friend Request',
      message: 'Someone sent you a friend request',
      avatar: userData.getUserAvatarUrlCurrent
    },
    server_update: {
      title: 'Test Server Update',
      message: 'A server has been updated',
      avatar: '/default_server_icon.png'
    },
    emoji_added: {
      title: 'Test Emoji Added',
      message: 'A new emoji was added to the server',
      avatar: '/default_server_icon.png'
    },
    activitypub_follow: {
      title: 'Test ActivityPub Follow',
      message: 'Someone followed you from the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_favorite: {
      title: 'Test ActivityPub Favorite',
      message: 'Someone favorited your post on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_reblog: {
      title: 'Test ActivityPub Reblog',
      message: 'Someone reblogged your post on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_mention: {
      title: 'Test ActivityPub Mention',
      message: 'You were mentioned in a fediverse post',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_reply: {
      title: 'Test ActivityPub Reply',
      message: 'Someone replied to your fediverse post',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_follow_request: {
      title: 'Test ActivityPub Follow Request',
      message: 'Someone requested to follow you on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    }
  }
  
  return testMessages[type] || {
    title: 'Test Notification',
    message: 'This is a test notification',
    avatar: userData.getUserAvatarUrlCurrent
  }
}

const testAllNotifications = async () => {
  if (isTesting.value) return
  
  try {
    isTesting.value = true
    
    const allTypes = [...chatNotificationTypes, ...activityPubNotificationTypes]
    
    for (const type of allTypes) {
      // Type-safe access to preferences
      const isEnabled = (preferences as any)[type.key]
      if (isEnabled) {
        await testNotification(type.testType as NotificationType)
        await new Promise(resolve => setTimeout(resolve, 500)) // Delay between tests
      }
    }
    
    toast.success('All enabled notifications tested')
  } catch (error) {
    console.error('Failed to test all notifications:', error)
    toast.error('Failed to test all notifications')
  } finally {
    isTesting.value = false
  }
}

const resetToDefaults = () => {
  Object.assign(preferences, originalPreferences.value)
  updatePreferences()
  toast.success('Notification preferences reset to defaults')
}

const onVolumeChange = () => {
  // Update volume in the notification store
  notificationStore.setVolume(soundVolume.value / 100)
}

// Check notification permission on mount
onMounted(() => {
  hasNotificationPermission.value = typeof Notification !== 'undefined' && Notification.permission === 'granted'
  loadPreferences()
})

// Watch for changes in the store
watch(() => notificationStore.preferences, (newPreferences) => {
  if (newPreferences) {
    Object.assign(preferences, newPreferences)
    originalPreferences.value = { ...newPreferences }
  }
}, { deep: true })
</script>

<style scoped>
.unified-notification-settings {
  max-width: 800px;
  margin: 0 auto;
  padding: 0 16px;
}

.settings-header {
  margin-bottom: 32px;
  text-align: center;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.settings-description {
  font-size: 16px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.5;
}

.settings-section {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.dnd-status {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
}

.dnd-status.active {
  background: rgba(250, 166, 26, 0.1);
  color: #faa61a;
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.time-range {
  align-items: center;
  gap: 12px;
}

.time-input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 12px;
  color: #ffffff;
  font-size: 14px;
  width: 120px;
}

.time-input:focus {
  outline: none;
  border-color: #5865f2;
}

.time-separator {
  color: #b9bbbe;
  font-size: 14px;
}

.select-input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 12px;
  color: #ffffff;
  font-size: 14px;
  min-width: 120px;
}

.select-input:focus {
  outline: none;
  border-color: #5865f2;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.volume-slider {
  flex: 1;
  min-width: 120px;
}

.volume-value {
  font-size: 12px;
  color: #b9bbbe;
  min-width: 40px;
}

.permission-status {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.permission-granted {
  color: #43b581;
}

.permission-denied {
  color: #f04747;
}

.permission-text {
  font-size: 14px;
  color: #dcddde;
}

.permission-btn {
  background: #5865f2;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-btn:hover {
  background: #4752c4;
}

.permission-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.notification-categories {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.notification-category {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  overflow: hidden;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.category-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-size: 18px;
  padding: 8px;
}

.category-icon.chat {
  background: linear-gradient(135deg, #5865f2, #4752c4);
}

.category-icon.activitypub {
  background: linear-gradient(135deg, #43b581, #3ba55d);
}

.category-info {
  flex: 1;
}

.category-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.category-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.category-settings {
  padding: 20px;
}

.notification-type-grid {
  display: grid;
  gap: 16px;
}

.notification-type {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.type-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.type-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  font-size: 14px;
  padding: 6px;
}

.type-info {
  flex: 1;
}

.type-label {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  display: block;
  margin-bottom: 2px;
}

.type-description {
  font-size: 12px;
  color: #b9bbbe;
  display: block;
}

.type-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.control-icon {
  font-size: 12px;
  color: #b9bbbe;
}

.test-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 6px 8px;
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.test-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}

.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.test-actions {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: center;
}

.test-all-btn, .reset-btn {
  background: #5865f2;
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-all-btn:hover {
  background: #4752c4;
}

.reset-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #b9bbbe;
}

.reset-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.test-all-btn:disabled, .reset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-type {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .type-controls {
    width: 100%;
    justify-content: space-between;
  }
  
  .test-actions {
    flex-direction: column;
    gap: 12px;
  }
  
  .test-all-btn, .reset-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>