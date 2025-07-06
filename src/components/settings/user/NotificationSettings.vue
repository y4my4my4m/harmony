<template>
  <div class="notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">Notifications</h2>
      <p class="settings-description">
        Control when and how you receive notifications.
      </p>
    </div>

    <!-- Do Not Disturb -->
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

    <!-- Desktop Notifications -->
    <div class="settings-section">
      <h3 class="section-title">Desktop Notifications</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Desktop Notifications</h4>
          <p class="setting-description">Get notified when you receive messages.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.desktop_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <template v-if="preferences.desktop_notifications">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Mentions</h4>
            <p class="setting-description">When someone mentions you</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.desktop_mentions"
              @change="updatePreferences"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Direct Messages</h4>
            <p class="setting-description">When you receive a DM</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.desktop_dms"
              @change="updatePreferences"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Replies</h4>
            <p class="setting-description">When someone replies to your message</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.desktop_replies"
              @change="updatePreferences"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Reactions</h4>
            <p class="setting-description">When someone reacts to your message</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.desktop_reactions"
              @change="updatePreferences"
            />
          </div>
        </div>
      </template>

      <div class="permission-check">
        <button 
          v-if="!hasNotificationPermission" 
          @click="requestNotificationPermission"
          class="permission-btn"
        >
          Enable Browser Notifications
        </button>
        <div v-else class="permission-status granted">
          ✓ Browser notifications enabled
        </div>
      </div>
    </div>

    <!-- Sound Notifications -->
    <div class="settings-section">
      <h3 class="section-title">Sound Notifications</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Sound Notifications</h4>
          <p class="setting-description">Play sounds for notifications</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.sound_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <template v-if="preferences.sound_notifications">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Mentions</h4>
            <p class="setting-description">Play sound for mentions</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.sound_mentions"
              @change="updatePreferences"
            />
            <button @click="testSound('mention')" class="test-sound-btn">
              🔊
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Direct Messages</h4>
            <p class="setting-description">Play sound for DMs</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.sound_dms"
              @change="updatePreferences"
            />
            <button @click="testSound('dm')" class="test-sound-btn">
              🔊
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Voice Activity</h4>
            <p class="setting-description">Play sounds for voice channel activity</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.sound_voice_activity"
              @change="updatePreferences"
            />
            <button @click="testSound('voice_channel_activity')" class="test-sound-btn">
              🔊
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Reactions</h4>
            <p class="setting-description">Play sound for reactions</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.sound_reactions"
              @change="updatePreferences"
            />
            <button @click="testSound('reaction')" class="test-sound-btn">
              🔊
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- Push Notifications -->
    <div class="settings-section">
      <h3 class="section-title">Push Notifications</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Push Notifications</h4>
          <p class="setting-description">Receive notifications when app is closed</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.push_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <template v-if="preferences.push_notifications">
        <div class="setting-item">
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

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Mentions</h4>
            <p class="setting-description">Push notifications for mentions</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.push_mentions"
              @change="updatePreferences"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Direct Messages</h4>
            <p class="setting-description">Push notifications for DMs</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.push_dms"
              @change="updatePreferences"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Email Notifications -->
    <div class="settings-section">
      <h3 class="section-title">Email Notifications</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Email Notifications</h4>
          <p class="setting-description">Receive email summaries of activity</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.email_notifications"
            @change="updatePreferences"
          />
        </div>
      </div>

      <template v-if="preferences.email_notifications">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Email Digest</h4>
            <p class="setting-description">Periodic summary of missed activity</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="preferences.email_digest"
              @change="updatePreferences"
            />
          </div>
        </div>

        <div v-if="preferences.email_digest" class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Digest Frequency</h4>
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
      </template>
    </div>

    <!-- Test Notifications -->
    <div class="settings-section">
      <h3 class="section-title">Test Notifications</h3>
      
      <div class="test-buttons">
        <button @click="testNotification('mention')" class="test-btn mention">
          Test Mention
        </button>
        <button @click="testNotification('dm')" class="test-btn dm">
          Test DM
        </button>
        <button @click="testNotification('reaction')" class="test-btn reaction">
          Test Reaction
        </button>
        <button @click="testNotification('reply')" class="test-btn reply">
          Test Reply
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useNotificationStore } from '@/stores/useNotification'
import { useAuthStore } from '@/stores/auth'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import type { NotificationPreferences, NotificationType } from '@/types'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()

// Reactive preferences object
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
  created_at: '',
  updated_at: ''
})

// Computed
const isDndActive = computed(() => notificationStore.isDndActive)

const hasNotificationPermission = computed(() => 
  typeof Notification !== 'undefined' && Notification.permission === 'granted'
)

// Methods
const updatePreferences = async () => {
  try {
    await notificationStore.updatePreferences(preferences)
  } catch (error) {
    console.error('Failed to update notification preferences:', error)
  }
}

const requestNotificationPermission = async () => {
  if (typeof Notification === 'undefined') {
    alert('Your browser does not support notifications')
    return
  }

  try {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      // Show a test notification
      new Notification('Notifications Enabled!', {
        body: 'You will now receive desktop notifications from Harmony.',
        icon: '/harmony_icon1.png'
      })
    }
  } catch (error) {
    console.error('Failed to request notification permission:', error)
  }
}

const testSound = (type: NotificationType) => {
  notificationStore.playNotificationSound(type)
}

const testNotification = async (type: NotificationType) => {
  const userId = authStore.session?.user?.id
  if (!userId) return

  const testData = {
    mention: {
      title: 'Test Mention',
      message: 'Someone mentioned you in #general',
      data: { 
        username: 'TestUser',
        avatar_url: '/default_avatar.png',
        server_name: 'Test Server',
        channel_name: 'general'
      }
    },
    dm: {
      title: 'Test Direct Message',
      message: 'You have a new direct message',
      data: { 
        username: 'TestUser',
        avatar_url: '/default_avatar.png'
      }
    },
    reaction: {
      title: 'Test Reaction',
      message: 'Someone reacted to your message with 👍',
      data: { 
        username: 'TestUser',
        avatar_url: '/default_avatar.png',
        server_name: 'Test Server',
        channel_name: 'general'
      }
    },
    reply: {
      title: 'Test Reply',
      message: 'Someone replied to your message',
      data: { 
        username: 'TestUser',
        avatar_url: '/default_avatar.png',
        server_name: 'Test Server',
        channel_name: 'general'
      }
    }
  }

  const test = testData[type]
  if (test) {
    // Show toast notification
    notificationStore.showToast(type, test.title, test.message, 4000, test.data.avatar_url)
    
    // Play sound
    notificationStore.playNotificationSound(type)
    
    // Show desktop notification if enabled
    if (preferences.desktop_notifications) {
      const shouldShow = (() => {
        switch (type) {
          case 'mention': return preferences.desktop_mentions
          case 'dm': return preferences.desktop_dms
          case 'reaction': return preferences.desktop_reactions
          case 'reply': return preferences.desktop_replies
          default: return true
        }
      })()

      if (shouldShow && hasNotificationPermission.value) {
        new Notification(test.title, {
          body: test.message,
          icon: test.data.avatar_url,
          badge: '/harmony_icon1.png'
        })
      }
    }
  }
}

// Load preferences on mount
onMounted(() => {
  const userPreferences = notificationStore.preferences
  if (userPreferences) {
    Object.assign(preferences, userPreferences)
  }
})

// Watch for changes in the store
watch(() => notificationStore.preferences, (newPreferences) => {
  if (newPreferences) {
    Object.assign(preferences, newPreferences)
  }
}, { deep: true })
</script>

<style scoped>
.notification-settings {
  max-width: 740px;
  margin: 0 auto;
  padding: 0 16px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.settings-section {
  background: var(--h-chat-darker);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
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
  border-bottom: 1px solid var(--h-chat-light);
}

.setting-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
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
  background: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 8px 12px;
  color: #ffffff;
  font-size: 14px;
  width: 120px;
}

.time-input:focus {
  outline: none;
  border-color: var(--h-brand);
}

.time-separator {
  color: #b9bbbe;
  font-size: 14px;
}

.select-input {
  background: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 8px 12px;
  color: #ffffff;
  font-size: 14px;
  min-width: 120px;
}

.select-input:focus {
  outline: none;
  border-color: var(--h-brand);
}

.test-sound-btn {
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.test-sound-btn:hover {
  background: rgba(79, 84, 92, 0.16);
  border-color: var(--h-brand);
}

.permission-check {
  margin-top: 16px;
}

.permission-btn {
  background: var(--h-brand);
  border: none;
  border-radius: 4px;
  padding: 10px 16px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.permission-btn:hover {
  background: #677bc4;
}

.permission-status {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: #43b581;
  font-weight: 500;
}

.test-buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.test-btn {
  background: transparent;
  border: 1px solid;
  border-radius: 6px;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.test-btn.mention {
  border-color: #f04747;
  color: #f04747;
}

.test-btn.mention:hover {
  background: rgba(240, 71, 71, 0.1);
}

.test-btn.dm {
  border-color: #7289da;
  color: #7289da;
}

.test-btn.dm:hover {
  background: rgba(114, 137, 218, 0.1);
}

.test-btn.reaction {
  border-color: #faa61a;
  color: #faa61a;
}

.test-btn.reaction:hover {
  background: rgba(250, 166, 26, 0.1);
}

.test-btn.reply {
  border-color: #43b581;
  color: #43b581;
}

.test-btn.reply:hover {
  background: rgba(67, 181, 129, 0.1);
}

/* Responsive design */
@media (max-width: 768px) {
  .setting-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .setting-control {
    width: 100%;
    justify-content: flex-end;
  }
  
  .time-range {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  
  .time-input {
    width: 100%;
  }
}
</style>