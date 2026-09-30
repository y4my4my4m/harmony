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
          {{ isDndActive ? 'Active' : 'Inactive' }}
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
          <h4 class="setting-label">Quiet hours</h4>
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

    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ isMobileClient ? 'Enable notifications' : $t('settings.notifications.enableDesktop') }}</h3>
        <div class="permission-status">
          <div v-if="!systemNotificationsAvailable" class="permission-info">
            <Icon name="alert-circle" class="permission-denied" />
            <span class="permission-text">Not supported in this browser{{ isMobileClient ? ' — install the app to get notifications' : '' }}</span>
          </div>
          <template v-else>
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
              <span>{{ isRequestingPermission ? $t('common.loading') : 'Grant permission' }}</span>
            </button>
          </template>
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
              <h4 class="category-title">ActivityPub & federation</h4>
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
      <h3 class="section-title">Sound settings</h3>
      <p class="section-description">Configure sound notification behavior</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Master volume</h4>
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
          <h4 class="setting-label">Voice activity sounds</h4>
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

    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">
          <Icon name="smartphone" class="section-icon" />
          {{ isNativeClient ? 'Push to other devices' : 'Push notifications' }}
        </h3>
        <div class="push-status-badge" :class="isNativeClient ? 'available' : pushStatusClass">
          <Icon :name="isNativeClient ? 'info' : pushStatusIcon" />
          <span>{{ pushStatusBadgeText }}</span>
        </div>
      </div>
      <p class="section-description">
        {{ pushSectionDescription }}
      </p>

      <!-- Native mobile app: background push requires FCM, which is not integrated -->
      <div v-if="isNativeMobile" class="push-warning">
        <Icon name="info" />
        <div>
          <strong>Background push coming to the app</strong>
          <p>This device shows notifications while Harmony is open (including backgrounded). Push while the app is fully closed needs native push (FCM), which isn't wired up yet.</p>
        </div>
      </div>

      <!-- iOS PWA Warning -->
      <div v-if="!isNativeClient && pushNotifications.requiresPWA.value" class="push-warning">
        <Icon name="info" />
        <div>
          <strong>iOS requires installing the app</strong>
          <p>To receive push notifications on iOS, add Harmony to your home screen first (Share → Add to Home Screen).</p>
        </div>
      </div>

      <!-- Not Supported Warning -->
      <div v-if="!isNativeClient && !pushNotifications.isSupported.value" class="push-warning error">
        <Icon name="alert-triangle" />
        <div>
          <strong>Push notifications not supported</strong>
          <p>Your browser doesn't support push notifications. Try using Chrome, Firefox, Edge, or Safari.</p>
        </div>
      </div>

      <!-- Permission Denied Warning -->
      <div v-else-if="!isNativeClient && pushNotifications.permission.value === 'denied'" class="push-warning error">
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

      <!-- Subscribe/Unsubscribe Buttons (web push - browser only) -->
      <div v-if="!isNativeClient && pushNotifications.isSupported.value" class="push-actions">
        <button 
          v-if="!pushNotifications.isSubscribed.value"
          @click="handlePushSubscribe"
          class="push-subscribe-btn"
          :disabled="pushNotifications.isLoading.value || !pushNotifications.canSubscribe.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" />
          <Icon v-else name="bell" />
          <span>Enable push notifications</span>
        </button>

        <button 
          v-else
          @click="handlePushUnsubscribe"
          class="push-unsubscribe-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" />
          <Icon v-else name="bell-off" />
          <span>Disable push notifications</span>
        </button>

        <button 
          v-if="pushNotifications.isSubscribed.value"
          @click="handleTestPush"
          class="push-test-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="isTestingPush" name="loader" class="spinning" />
          <Icon v-else name="send" />
          <span>Test push</span>
        </button>
      </div>

      <!-- Push preferences: account-wide, shown when subscribed on any device -->
      <div v-if="preferences.push_notifications && (pushNotifications.isSubscribed.value || pushNotifications.subscriptions.value.length > 0)" class="push-preferences">
      <div class="setting-item">
        <div class="setting-info">
            <h4 class="setting-label">Only when offline</h4>
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
            <h4 class="setting-label">Direct messages</h4>
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

      <!-- Native client with nothing to manage -->
      <p
        v-if="isNativeClient && !pushNotifications.isSubscribed.value && pushNotifications.subscriptions.value.length === 0"
        class="push-empty-note"
      >
        No devices are subscribed to push yet. Enable push notifications on your phone or in a browser, then manage those devices here.
      </p>

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


    <!-- Haptic Feedback Section (mobile devices only) -->
    <div class="settings-section" v-if="hapticsAvailable">
      <div class="section-header">
        <h3 class="section-title">Haptic feedback</h3>
        <div class="haptic-status" :class="{ active: hapticSettings.isEnabled.value }">
          {{ hapticSettings.isEnabled.value ? 'Enabled' : 'Disabled' }}
        </div>
      </div>
      <p class="section-description">Vibration feedback for interactions</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable haptic feedback</h4>
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
            <h4 class="setting-label">Sending messages</h4>
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
            <h4 class="setting-label">Voice & calls</h4>
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
            <h4 class="setting-label">Toggle switches</h4>
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
            <h4 class="setting-label">Destructive actions</h4>
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
            <span>Test haptic feedback</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Test All Section -->
    <div class="settings-section">
      <h3 class="section-title">Test notifications</h3>
      <p class="section-description">Test your notification settings</p>
      
      <div class="test-actions">
        <button 
          @click="testAllNotifications"
          class="test-all-btn"
          :disabled="isTesting"
        >
          <Icon v-if="isTesting" name="loader" class="spinning" />
          <Icon v-else name="zap" />
          <span>{{ isTesting ? 'Testing...' : 'Test all notifications' }}</span>
        </button>
        
        <button 
          @click="resetToDefaults"
          class="reset-btn"
          :disabled="isAtDefaults"
        >
          <Icon name="rotate-ccw" />
          <span>Reset to defaults</span>
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
import { isTauri, isTauriMobile, isMobileDevice, supportsHaptics } from '@/utils/platform'
import { useHapticSettings } from '@/composables/useHapticSettings'

// Stores
const notificationStore = useNotificationStore()
const toast = useToast()
const userData = useUserData()
const pushNotifications = usePushNotifications()
const hapticSettings = useHapticSettings()
const isNativeClient = isTauri()
const isNativeMobile = isTauriMobile()
const isMobileClient = isMobileDevice()
const hapticsAvailable = supportsHaptics()
const systemNotificationsAvailable = isNativeClient || typeof Notification !== 'undefined'

// Test haptic feedback
const testHaptic = () => {
  hapticSettings.hapticManager.trigger({ pattern: 'success' })
  toast.success('Haptic feedback sent')
}

// State (initial values double as the factory defaults for reset)
const DEFAULT_PREFERENCES: Omit<NotificationPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
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
}

const preferences = reactive<NotificationPreferences>({
  id: '',
  user_id: '',
  created_at: '',
  updated_at: '',
  ...DEFAULT_PREFERENCES,
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

const isAtDefaults = computed(() =>
  (Object.keys(DEFAULT_PREFERENCES) as Array<keyof typeof DEFAULT_PREFERENCES>).every(
    (key) => preferences[key] === DEFAULT_PREFERENCES[key]
  )
)

const permissionIcon = computed(() => {
  return hasNotificationPermission.value ? 'check-circle' : 'alert-circle'
})

const permissionClass = computed(() => {
  return hasNotificationPermission.value ? 'permission-granted' : 'permission-denied'
})

const permissionText = computed(() => {
  const label = isNativeClient || isMobileClient ? 'Notifications' : 'Desktop notifications'
  return hasNotificationPermission.value ? `${label} are enabled` : `${label} require permission`
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
  try {
    isRequestingPermission.value = true

    if (isNativeClient) {
      const { isPermissionGranted, requestPermission: requestNativePermission } = await import('@tauri-apps/plugin-notification')
      hasNotificationPermission.value = (await isPermissionGranted())
        || (await requestNativePermission()) === 'granted'
    } else {
      if (typeof Notification === 'undefined') {
        toast.error('Notifications are not supported in this browser')
        return
      }
      const permission = await Notification.requestPermission()
      hasNotificationPermission.value = permission === 'granted'
    }

    if (hasNotificationPermission.value) {
      toast.success('Notification permission granted')
    } else {
      toast.error('Notification permission denied')
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
    
    const testData = createTestNotificationData(type)
    
    notificationStore.showToast(
      type,
      testData.title,
      testData.message,
      3000,
      testData.avatar
    )
    
    // Play sound
    await notificationStore.playNotificationSound(type)
    
    if (hasNotificationPermission.value) {
      const iconUrl = testData.avatar.value || '/img/app_icon_square.webp'

      if (isNativeClient) {
        const { nativeNotify } = await import('@/services/nativeNotify')
        await nativeNotify({
          title: testData.title,
          sender: testData.title,
          conversationTitle: '',
          message: testData.message,
          avatarUrl: testData.avatar.value,
        })
      } else if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
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
      title: 'Test mention',
      message: 'You were mentioned in a test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    dm: {
      title: 'Test direct message',
      message: 'This is a test direct message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    reply: {
      title: 'Test reply',
      message: 'Someone replied to your test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    reaction: {
      title: 'Test reaction',
      message: 'Someone reacted to your test message',
      avatar: userData.getUserAvatarUrlCurrent
    },
    voice_channel_activity: {
      title: 'Test voice activity',
      message: 'Someone joined a voice channel',
      avatar: userData.getUserAvatarUrlCurrent
    },
    server_invite: {
      title: 'Test server invite',
      message: 'You were invited to join a server',
      avatar: '/default_server.webp'
    },
    friend_request: {
      title: 'Test follow request',
      message: 'Someone wants to follow you',
      avatar: userData.getUserAvatarUrlCurrent
    },
    server_update: {
      title: 'Test server update',
      message: 'A server has been updated',
      avatar: '/default_server.webp'
    },
    emoji_added: {
      title: 'Test emoji added',
      message: 'A new emoji was added to the server',
      avatar: '/default_server.webp'
    },
    activitypub_follow: {
      title: 'Test ActivityPub follow',
      message: 'Someone followed you from the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_favorite: {
      title: 'Test ActivityPub favorite',
      message: 'Someone favorited your post on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_reblog: {
      title: 'Test ActivityPub reblog',
      message: 'Someone reblogged your post on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_mention: {
      title: 'Test ActivityPub mention',
      message: 'You were mentioned in a fediverse post',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_reply: {
      title: 'Test ActivityPub reply',
      message: 'Someone replied to your fediverse post',
      avatar: userData.getUserAvatarUrlCurrent
    },
    activitypub_follow_request: {
      title: 'Test ActivityPub follow request',
      message: 'Someone requested to follow you on the fediverse',
      avatar: userData.getUserAvatarUrlCurrent
    }
  }
  
  return (testMessages as any)[type] || {
    title: 'Test notification',
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

// Restores factory defaults, not the last-saved state: toggles save
// immediately, so "last saved" equals the current state.
const resetToDefaults = async () => {
  Object.assign(preferences, DEFAULT_PREFERENCES)
  await updatePreferences()
}

const onVolumeChange = () => {
  notificationStore.setVolume(soundVolume.value / 100)
}

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
  if (isNativeClient) {
    return isNativeMobile ? 'This device: foreground' : 'This device: native notifications'
  }
  if (!pushNotifications.isSupported.value) return 'Not supported'
  if (pushNotifications.permission.value === 'denied') return 'Blocked'
  if (pushNotifications.isSubscribed.value) return 'Enabled'
  return 'Available'
})

const pushSectionDescription = computed(() => {
  if (isNativeClient) {
    return isNativeMobile
      ? 'This device gets notifications while the app is open. Manage push to your other subscribed devices below.'
      : 'The desktop app already shows system notifications while it\'s running. These settings manage push to your other devices (phone, browsers) and which notification types they receive.'
  }
  return 'Receive notifications on your device even when the app is closed. Works on Android, iOS (PWA required), and desktop browsers.'
})

const handlePushSubscribe = async () => {
  const result = await pushNotifications.subscribe()
  if (result.success) {
    preferences.push_notifications = true
    await updatePreferences()
    toast.success('Push notifications enabled')
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
      toast.success('Test push notification sent')
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
  if (!userAgent) return 'Unknown device'
  const ua = userAgent.toLowerCase()
  if (ua.includes('iphone')) return 'iPhone'
  if (ua.includes('ipad')) return 'iPad'
  if (ua.includes('android')) return 'Android device'
  if (ua.includes('windows')) return 'Windows PC'
  if (ua.includes('mac')) return 'Mac'
  if (ua.includes('linux')) return 'Linux PC'
  if (ua.includes('chrome')) return 'Chrome browser'
  if (ua.includes('firefox')) return 'Firefox browser'
  if (ua.includes('safari')) return 'Safari browser'
  return 'Unknown device'
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
onMounted(async () => {
  if (isNativeClient) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
      hasNotificationPermission.value = await isPermissionGranted()
    } catch {
      hasNotificationPermission.value = false
    }
  } else {
    hasNotificationPermission.value = typeof Notification !== 'undefined' && Notification.permission === 'granted'
  }
  loadPreferences()
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
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
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



.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.dnd-status {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
}

.dnd-status.active {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
}

/* Haptic Feedback Section */
.haptic-status {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
}

.haptic-status.active {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--success);
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
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.test-haptic-btn:hover {
  background: var(--harmony-primary-hover);
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-secondary);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: var(--font-size-xs);
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
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  width: 120px;
}

.time-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.time-separator {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.select-input {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  min-width: 120px;
}

.select-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
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
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  min-width: 40px;
}

.permission-status {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--background-primary);
  border-radius: var(--radius-md);
  padding: 12px;
  border: 1px solid var(--border-secondary);
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.permission-granted {
  color: var(--success);
}

.permission-denied {
  color: var(--error);
}

.permission-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.permission-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: var(--radius-base);
  padding: 8px 16px;
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-btn:hover {
  background: var(--harmony-primary-hover);
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
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
  overflow: hidden;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-secondary);
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
  color: var(--text-on-primary);
  font-size: var(--font-size-lg);
  padding: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.category-icon.chat {
  background: var(--harmony-primary);
}

.category-icon.activitypub {
  background: var(--success);
}

.category-info {
  flex: 1;
}

.category-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.category-description {
  font-size: var(--font-size-sm);
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
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
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
  background: var(--background-modifier-active);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  padding: 6px;
}

.type-info {
  flex: 1;
}

.type-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  display: block;
  margin-bottom: 2px;
}

.type-description {
  font-size: var(--font-size-xs);
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
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.test-btn {
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-base);
  padding: 6px 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
}

.test-btn:hover {
  background: var(--background-modifier-active);
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
  border-radius: var(--radius-md);
  padding: 12px 24px;
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-all-btn:hover {
  background: var(--harmony-primary-hover);
}

.reset-btn {
  background: transparent;
  border: 1px solid var(--border-hover);
  color: var(--text-secondary);
}

.reset-btn:hover {
  background: var(--background-modifier-active);
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
  border-radius: var(--radius-lg);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}

.push-status-badge.subscribed {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--success);
}

.push-status-badge.available {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--harmony-primary);
}

.push-status-badge.denied,
.push-status-badge.not-supported {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
}

.push-warning {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
  margin-bottom: 20px;
}

.push-warning.error {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-color: color-mix(in srgb, var(--error) 30%, transparent);
}

.push-warning > svg {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: var(--warning);
}

.push-warning.error > svg {
  color: var(--error);
}

.push-warning strong {
  display: block;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
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
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background 0.2s ease;
  align-self: flex-start;
}

.push-error-with-retry .retry-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
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
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.push-subscribe-btn {
  background: var(--success);
  color: var(--text-on-primary);
}

.push-subscribe-btn:hover:not(:disabled) {
  background: var(--success-hover);
}

.push-unsubscribe-btn {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.push-unsubscribe-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 20%, transparent);
}

.push-test-btn {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--harmony-primary);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.push-test-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
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
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
}

.push-empty-note {
  margin: 0 0 8px 0;
  padding: 12px 16px;
  background: var(--background-primary);
  border: 1px dashed var(--border-hover);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.subscribed-devices {
  margin-top: 20px;
}

.devices-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
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
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
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
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-radius: var(--radius-md);
  color: var(--harmony-primary);
}

.device-details {
  display: flex;
  flex-direction: column;
}

.device-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.device-date {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.device-remove-btn {
  background: transparent;
  border: none;
  padding: 8px;
  border-radius: var(--radius-base);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.device-remove-btn:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
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