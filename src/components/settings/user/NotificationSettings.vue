<template>
  <div class="unified-notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.notifications.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.notifications.description') }}
      </p>
    </div>

    <!-- Do Not Disturb Section -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ $t('user.dnd') }}</h3>
        <div class="dnd-status" :class="{ active: isDndActive }">
          {{ isDndActive ? $t('activitypub.online') : $t('user.offline') }}
        </div>
      </div>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('user.dnd') }}</h4>
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
          <p class="setting-description">Set your do not disturb schedule (shown in your local time)</p>
        </div>
        <div class="setting-control time-range">
          <input 
            type="time" 
            :value="dndStartTimeLocal"
            @change="onDndStartChange"
            class="time-input"
          />
          <span class="time-separator">to</span>
          <input 
            type="time" 
            :value="dndEndTimeLocal"
            @change="onDndEndChange"
            class="time-input"
          />
        </div>
      </div>
    </div>

    <!-- Desktop Notifications Section -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ $t('settings.notifications.enableDesktop') }}</h3>
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
            <span>{{ isRequestingPermission ? $t('common.loading') : 'Grant Permission' }}</span>
          </button>
        </div>
      </div>
      
      <div class="notification-categories">
        <!-- Chat Notifications -->
        <div class="notification-category">
          <div class="category-header">
            <Icon name="message-circle" class="category-icon chat" :size="20" />
            <div class="category-info">
              <h4 class="category-title">{{ $t('navigation.chat') }} & {{ $t('activitypub.messages') }}</h4>
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

    <!-- Push Notifications Section (Native PWA) -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">
          <Icon name="smartphone" class="section-icon" />
          Push Notifications
        </h3>
        <div class="push-status-badge" :class="pushStatusClass">
          <Icon :name="pushStatusIcon" />
          <span>{{ pushStatusBadgeText }}</span>
        </div>
      </div>
      <p class="section-description">
        Receive notifications on your device even when the app is closed. 
        Works on Android, iOS (PWA required), and desktop browsers.
      </p>

      <!-- iOS PWA Warning -->
      <div v-if="pushNotifications.requiresPWA.value" class="push-warning">
        <Icon name="info" />
        <div>
          <strong>iOS requires installing the app</strong>
          <p>To receive push notifications on iOS, add Harmony to your home screen first (Share → Add to Home Screen).</p>
        </div>
      </div>

      <!-- Not Supported Warning -->
      <div v-if="!pushNotifications.isSupported.value" class="push-warning error">
        <Icon name="alert-triangle" />
        <div>
          <strong>Push notifications not supported</strong>
          <p>Your browser doesn't support push notifications. Try using Chrome, Firefox, Edge, or Safari.</p>
        </div>
      </div>

      <!-- Permission Denied Warning -->
      <div v-else-if="pushNotifications.permission.value === 'denied'" class="push-warning error">
        <Icon name="x-circle" />
        <div>
          <strong>Notification permission blocked</strong>
          <p>You've blocked notifications for this site. Please enable them in your browser settings.</p>
        </div>
      </div>

      <!-- Push error (e.g. 429) with Retry -->
      <div v-else-if="pushNotifications.error.value" class="push-warning error push-error-with-retry">
        <Icon name="alert-triangle" />
        <div>
          <strong>Push notification error</strong>
          <p>{{ pushNotifications.error.value }}</p>
          <button
            class="retry-btn"
            :disabled="pushNotifications.isLoading.value"
            @click="pushNotifications.retryInitialize"
          >
            <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" />
            <Icon v-else name="refresh-cw" />
            Retry
          </button>
        </div>
      </div>

      <!-- Subscribe/Unsubscribe Buttons -->
      <div v-if="pushNotifications.isSupported.value" class="push-actions">
        <button 
          v-if="!pushNotifications.isSubscribed.value"
          @click="handlePushSubscribe"
          class="push-subscribe-btn"
          :disabled="pushNotifications.isLoading.value || !pushNotifications.canSubscribe.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" />
          <Icon v-else name="bell" />
          <span>Enable Push Notifications</span>
        </button>

        <button 
          v-else
          @click="handlePushUnsubscribe"
          class="push-unsubscribe-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" />
          <Icon v-else name="bell-off" />
          <span>Disable Push Notifications</span>
        </button>

        <button 
          v-if="pushNotifications.isSubscribed.value"
          @click="handleTestPush"
          class="push-test-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="isTestingPush" name="loader" class="spinning" />
          <Icon v-else name="send" />
          <span>Test Push</span>
        </button>
      </div>

      <!-- Push Preferences (only shown when subscribed) -->
      <div v-if="preferences.push_notifications && pushNotifications.isSubscribed.value" class="push-preferences">
      <div class="setting-item">
        <div class="setting-info">
            <h4 class="setting-label">Only When Offline</h4>
            <p class="setting-description">Only send push notifications when you're not actively using the app</p>
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
            <p class="setting-description">Receive push notifications when you're mentioned</p>
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
            <p class="setting-description">Receive push notifications for new DMs</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
              v-model="preferences.push_dms"
            @change="updatePreferences"
          />
          </div>
        </div>
      </div>

      <!-- Subscribed Devices List -->
      <div v-if="pushNotifications.subscriptions.value.length > 0" class="subscribed-devices">
        <h4 class="devices-title">
          <Icon name="devices" />
          Subscribed Devices ({{ pushNotifications.subscriptions.value.length }})
        </h4>
        <div class="device-list">
          <div 
            v-for="sub in pushNotifications.subscriptions.value" 
            :key="sub.id" 
            class="device-item"
          >
            <div class="device-info">
              <Icon :name="getDeviceIcon(sub.user_agent)" class="device-icon" />
              <div class="device-details">
                <span class="device-name">{{ sub.device_name || getDeviceName(sub.user_agent) }}</span>
                <span class="device-date">Added {{ formatDate(sub.created_at) }}</span>
              </div>
            </div>
            <button 
              @click="handleRemoveDevice(sub)"
              class="device-remove-btn"
              title="Remove this device"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Email Notifications Section -->
    <div class="settings-section">
      <h3 class="section-title">
        Email Notifications
        <span class="coming-soon-badge">Coming soon</span>
      </h3>
      <p class="section-description">Configure email digests and summaries</p>

      <div class="setting-item disabled-option">
        <div class="setting-info">
          <h4 class="setting-label">Email Notifications</h4>
          <p class="setting-description">Receive email summaries of activity</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="preferences.email_notifications"
            disabled
          />
        </div>
      </div>

      <div v-if="false" class="setting-item">
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
    </div>

    <!-- Haptic Feedback Section -->
    <div class="settings-section" v-if="hapticSettings.isSupported">
      <div class="section-header">
        <h3 class="section-title">Haptic Feedback</h3>
        <div class="haptic-status" :class="{ active: hapticSettings.isEnabled.value }">
          {{ hapticSettings.isEnabled.value ? 'Enabled' : 'Disabled' }}
        </div>
      </div>
      <p class="section-description">Vibration feedback for interactions (mobile devices)</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Haptic Feedback</h4>
          <p class="setting-description">Feel vibrations when interacting with the app</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="hapticSettings.isEnabled.value"
          />
        </div>
      </div>

      <div v-if="hapticSettings.isEnabled.value" class="haptic-categories">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Sending Messages</h4>
            <p class="setting-description">When sending a message</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.messages"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Reactions</h4>
            <p class="setting-description">When adding or removing reactions</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.reactions"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Navigation</h4>
            <p class="setting-description">When switching tabs or opening menus</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.navigation"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Voice & Calls</h4>
            <p class="setting-description">When joining/leaving voice channels</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.voice"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Interactions</h4>
            <p class="setting-description">Long press, pull to refresh, etc.</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.interactions"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Toggle Switches</h4>
            <p class="setting-description">When toggling settings on/off</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.toggles"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label">Destructive Actions</h4>
            <p class="setting-description">When deleting messages or leaving servers</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch 
              v-model="hapticSettings.hapticTriggers.value.destructive"
              size="small"
            />
          </div>
        </div>

        <div class="haptic-test">
          <button @click="testHaptic" class="test-haptic-btn">
            <Icon name="zap" />
            <span>Test Haptic Feedback</span>
          </button>
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
import { debug } from '@/utils/debug'
import { useNotificationStore } from '@/stores/useNotification'
import { useToast } from 'vue-toastification'
import type { NotificationPreferences, NotificationType } from '@/types'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import { useUserData } from '@/composables/useUserData'
import { usePushNotifications } from '@/composables/usePushNotifications'
import { useHapticSettings } from '@/composables/useHapticSettings'

// Stores
const notificationStore = useNotificationStore()
const toast = useToast()
const userData = useUserData()
const pushNotifications = usePushNotifications()
const hapticSettings = useHapticSettings()

// Test haptic feedback
const testHaptic = () => {
  hapticSettings.hapticManager.trigger({ pattern: 'success' })
  toast.success('Haptic feedback triggered!')
}

// State
const preferences = reactive<NotificationPreferences>({
  id: '',
  user_id: '',
  desktop_notifications: true,
  desktop_mentions: true,
  desktop_dms: true,
  desktop_reactions: false,
  desktop_replies: true,
  desktop_chat_messages: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: false,
  sound_replies: true,
  sound_chat_messages: true,
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
const isTestingPush = ref(false)

// Notification type configurations
const chatNotificationTypes = [
  {
    key: 'desktop_chat_messages',
    label: 'Chat Messages',
    description: 'When a message is sent in a channel you follow',
    icon: 'message-square',
    desktopKey: 'desktop_chat_messages',
    soundKey: 'sound_chat_messages',
    testType: 'chat_message'
  },
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

// DND timezone helpers: stored as UTC, displayed as local
const utcToLocal = (utcTime: string): string => {
  if (!utcTime) return ''
  const [h, m] = utcTime.split(':').map(Number)
  const now = new Date()
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m))
  return `${String(utcDate.getHours()).padStart(2, '0')}:${String(utcDate.getMinutes()).padStart(2, '0')}`
}

const localToUtc = (localTime: string): string => {
  if (!localTime) return ''
  const [h, m] = localTime.split(':').map(Number)
  const now = new Date()
  now.setHours(h, m, 0, 0)
  return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:00`
}

const dndStartTimeLocal = computed(() => utcToLocal(preferences.dnd_start_time))
const dndEndTimeLocal = computed(() => utcToLocal(preferences.dnd_end_time))

const onDndStartChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  preferences.dnd_start_time = localToUtc(target.value)
  updatePreferences()
}

const onDndEndChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  preferences.dnd_end_time = localToUtc(target.value)
  updatePreferences()
}

const updatePreferences = async () => {
  try {
    await notificationStore.updatePreferences(preferences)
    toast.success('Notification preferences updated')
  } catch (error) {
    debug.error('Failed to update preferences:', error)
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
    debug.error('Failed to request permission:', error)
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
    
    // Show desktop/native notification
    if (hasNotificationPermission.value) {
      const iconUrl = testData.avatar.value || '/img/app_icon_square.webp'
      
      // On mobile PWA, we need to use service worker for notifications
      // Direct `new Notification()` doesn't work on mobile
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const registration = await navigator.serviceWorker.ready
        await registration.showNotification(testData.title, {
          body: testData.message,
          icon: iconUrl,
          badge: '/img/app_icon_badge.png',
          tag: `harmony-test-${type}`,
          requireInteraction: false,
          silent: true // Sound is already played above
        })
      } else {
        // Fallback for desktop browsers without service worker
        new Notification(testData.title, {
          body: testData.message,
          icon: iconUrl,
          badge: iconUrl
        })
      }
    }
    
    // toast.success(`Test notification sent for ${type}`)
  } catch (error) {
    debug.error('Failed to test notification:', error)
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
      avatar: '/default_server.webp'
    },
    friend_request: {
      title: 'Test Follow Request',
      message: 'Someone wants to follow you',
      avatar: userData.getUserAvatarUrlCurrent
    },
    server_update: {
      title: 'Test Server Update',
      message: 'A server has been updated',
      avatar: '/default_server.webp'
    },
    emoji_added: {
      title: 'Test Emoji Added',
      message: 'A new emoji was added to the server',
      avatar: '/default_server.webp'
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
  
  return (testMessages as any)[type] || {
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
    debug.error('Failed to test all notifications:', error)
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

// Push notification computed properties
const pushStatusClass = computed(() => {
  if (!pushNotifications.isSupported.value) return 'not-supported'
  if (pushNotifications.permission.value === 'denied') return 'denied'
  if (pushNotifications.isSubscribed.value) return 'subscribed'
  return 'available'
})

const pushStatusIcon = computed(() => {
  if (!pushNotifications.isSupported.value) return 'x-circle'
  if (pushNotifications.permission.value === 'denied') return 'x-circle'
  if (pushNotifications.isSubscribed.value) return 'check-circle'
  return 'bell'
})

const pushStatusBadgeText = computed(() => {
  if (!pushNotifications.isSupported.value) return 'Not Supported'
  if (pushNotifications.permission.value === 'denied') return 'Blocked'
  if (pushNotifications.isSubscribed.value) return 'Enabled'
  return 'Available'
})

// Push notification handlers
const handlePushSubscribe = async () => {
  const result = await pushNotifications.subscribe()
  if (result.success) {
    preferences.push_notifications = true
    await updatePreferences()
    toast.success('Push notifications enabled!')
  } else {
    toast.error(result.error || 'Failed to enable push notifications')
  }
}

const handlePushUnsubscribe = async () => {
  const result = await pushNotifications.unsubscribe()
  if (result.success) {
    preferences.push_notifications = false
    await updatePreferences()
    toast.success('Push notifications disabled')
  } else {
    toast.error(result.error || 'Failed to disable push notifications')
  }
}

const handleTestPush = async () => {
  isTestingPush.value = true
  try {
    const result = await pushNotifications.sendTestNotification()
    if (result.success) {
      toast.success('Test push notification sent!')
    } else {
      toast.error(result.error || 'Failed to send test notification')
    }
  } finally {
    isTestingPush.value = false
  }
}

const handleRemoveDevice = async (sub: { id: string; endpoint: string }) => {
  const result = await pushNotifications.removeSubscription(sub)
  if (result.success) {
    toast.success('Device removed')
  } else {
    toast.error(result.error || 'Failed to remove device')
  }
}

// Helper functions for device display
const getDeviceIcon = (userAgent?: string): string => {
  if (!userAgent) return 'smartphone'
  const ua = userAgent.toLowerCase()
  if (ua.includes('iphone') || ua.includes('ipad')) return 'smartphone'
  if (ua.includes('android')) return 'smartphone'
  if (ua.includes('windows')) return 'monitor'
  if (ua.includes('mac')) return 'monitor'
  if (ua.includes('linux')) return 'monitor'
  return 'smartphone'
}

const getDeviceName = (userAgent?: string): string => {
  if (!userAgent) return 'Unknown Device'
  const ua = userAgent.toLowerCase()
  if (ua.includes('iphone')) return 'iPhone'
  if (ua.includes('ipad')) return 'iPad'
  if (ua.includes('android')) return 'Android Device'
  if (ua.includes('windows')) return 'Windows PC'
  if (ua.includes('mac')) return 'Mac'
  if (ua.includes('linux')) return 'Linux PC'
  if (ua.includes('chrome')) return 'Chrome Browser'
  if (ua.includes('firefox')) return 'Firefox Browser'
  if (ua.includes('safari')) return 'Safari Browser'
  return 'Unknown Device'
}

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  return date.toLocaleDateString()
}

// Check notification permission on mount
onMounted(() => {
  hasNotificationPermission.value = typeof Notification !== 'undefined' && Notification.permission === 'granted'
  loadPreferences()
  // Initialize push notifications
  pushNotifications.initialize()
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
  max-width: 700px;
  /* margin: 0 auto; */
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  background-color: var(--background-secondary);
  border-radius: 8px;
  padding: 24px;
  margin-bottom: 32px;
  border: 1px solid var(--background-quaternary);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.coming-soon-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  vertical-align: middle;
  margin-left: 6px;
}

.setting-item.disabled-option .setting-label,
.setting-item.disabled-option .setting-description {
  opacity: 0.65;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  margin: 0 0 20px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
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

/* Haptic Feedback Section */
.haptic-status {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
}

.haptic-status.active {
  background: rgba(87, 242, 135, 0.1);
  color: #57f287;
}

.haptic-categories {
  margin-top: 16px;
  padding-top: 16px;
}

.haptic-test {
  margin-top: 16px;
  padding-top: 16px;
}

.test-haptic-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--harmony--primary, #0EA5E9);
  color: var(--text-primary);
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.test-haptic-btn:hover {
  background: var(--harmony--primary-dark, #0284C7);
  transform: translateY(-1px);
}

.test-haptic-btn:active {
  transform: translateY(0);
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
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
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
  color: var(--text-primary);
  font-size: 14px;
  width: 120px;
}

.time-input:focus {
  outline: none;
  border-color: #0EA5E9;
}

.time-separator {
  color: var(--text-secondary);
  font-size: 14px;
}

.select-input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 120px;
}

.select-input:focus {
  outline: none;
  border-color: #0EA5E9;
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
}

.permission-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-btn:hover {
  background: #0284C7;
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
  min-width: 40px;
  min-height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 18px;
  padding: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.category-icon.chat {
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
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
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.category-description {
  font-size: 14px;
  color: var(--text-secondary);
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
  color: var(--text-primary);
  font-size: 14px;
  padding: 6px;
}

.type-info {
  flex: 1;
}

.type-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: block;
  margin-bottom: 2px;
}

.type-description {
  font-size: 12px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
}

.test-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.test-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
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
  background: var(--harmony-primary);
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-all-btn:hover {
  background: #0284C7;
}

.reset-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: var(--text-secondary);
}

.reset-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
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

/* Push Notification Styles */
.section-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
}

.push-status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.push-status-badge.subscribed {
  background: rgba(67, 181, 129, 0.1);
  color: #43b581;
}

.push-status-badge.available {
  background: rgba(14, 165, 233, 0.1);
  color: #0EA5E9;
}

.push-status-badge.denied,
.push-status-badge.not-supported {
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
}

.push-warning {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
  margin-bottom: 20px;
}

.push-warning.error {
  background: rgba(240, 71, 71, 0.1);
  border-color: rgba(240, 71, 71, 0.3);
}

.push-warning > svg {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: #faa61a;
}

.push-warning.error > svg {
  color: #f04747;
}

.push-warning strong {
  display: block;
  color: var(--text-primary);
  font-size: 14px;
  margin-bottom: 4px;
}

.push-warning p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
  line-height: 1.4;
}

.push-error-with-retry > div {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.push-error-with-retry .retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin-top: 4px;
  background: var(--harmony-primary);
  color: var(--text-light, #fff);
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s ease;
  align-self: flex-start;
}

.push-error-with-retry .retry-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover, #0284C7);
}

.push-error-with-retry .retry-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.push-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.push-subscribe-btn,
.push-unsubscribe-btn,
.push-test-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.push-subscribe-btn {
  background: #43b581;
  color: var(--text-primary);
}

.push-subscribe-btn:hover:not(:disabled) {
  background: #3ba55d;
}

.push-unsubscribe-btn {
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
  border: 1px solid rgba(240, 71, 71, 0.3);
}

.push-unsubscribe-btn:hover:not(:disabled) {
  background: rgba(240, 71, 71, 0.2);
}

.push-test-btn {
  background: rgba(14, 165, 233, 0.1);
  color: #0EA5E9;
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.push-test-btn:hover:not(:disabled) {
  background: rgba(14, 165, 233, 0.2);
}

.push-subscribe-btn:disabled,
.push-unsubscribe-btn:disabled,
.push-test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.push-preferences {
  margin-bottom: 20px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.subscribed-devices {
  margin-top: 20px;
}

.devices-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.device-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.device-icon {
  width: 32px;
  height: 32px;
  padding: 6px;
  background: rgba(14, 165, 233, 0.1);
  border-radius: 8px;
  color: #0EA5E9;
}

.device-details {
  display: flex;
  flex-direction: column;
}

.device-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.device-date {
  font-size: 12px;
  color: var(--text-muted);
}

.device-remove-btn {
  background: transparent;
  border: none;
  padding: 8px;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.device-remove-btn:hover {
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
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
  
  .push-actions {
    flex-direction: column;
  }
  
  .push-subscribe-btn,
  .push-unsubscribe-btn,
  .push-test-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>