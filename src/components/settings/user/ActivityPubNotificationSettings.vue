<template>
  <div class="activitypub-notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">ActivityPub Notifications</h2>
      <p class="settings-description">
        Configure how you receive notifications from the federated network (ActivityPub/Mastodon/etc.)
      </p>
    </div>

    <!-- Master Toggle -->
    <div class="settings-section">
      <div class="setting-item master-toggle">
        <div class="setting-info">
          <h3 class="setting-label">
            <Icon name="globe" class="setting-icon" />
            Enable ActivityPub Notifications
          </h3>
          <p class="setting-description">
            Receive notifications from federated social networks (follows, mentions, boosts, etc.)
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.activitypub_notifications"
            @change="onPreferenceChange"
            size="large"
          />
        </div>
      </div>
    </div>

    <!-- Notification Types -->
    <div class="settings-section" :class="{ disabled: !preferences.activitypub_notifications }">
      <h3 class="section-title">Notification Types</h3>
      <p class="section-description">Choose which ActivityPub activities should create notifications</p>
      
      <div class="notification-types-grid">
        <div class="notification-type-card" v-for="type in notificationTypes" :key="type.key">
          <div class="card-header">
            <div class="type-icon">
              <Icon :name="type.icon" />
            </div>
            <div class="type-info">
              <h4 class="type-label">{{ type.label }}</h4>
              <p class="type-description">{{ type.description }}</p>
            </div>
            <div class="type-toggle">
              <ToggleSwitch 
                v-model="preferences[type.key]"
                @change="onPreferenceChange"
                :disabled="!preferences.activitypub_notifications"
              />
            </div>
          </div>
          
          <!-- Sub-settings for each type -->
          <div v-if="preferences[type.key] && preferences.activitypub_notifications" class="card-content">
            <div class="sub-settings">
              <!-- Desktop notifications -->
              <div class="sub-setting">
                <Icon name="monitor" class="sub-icon" />
                <span class="sub-label">Desktop</span>
                <ToggleSwitch 
                  v-model="preferences[type.desktopKey]"
                  @change="onPreferenceChange"
                  size="small"
                />
              </div>
              
              <!-- Sound notifications -->
              <div class="sub-setting">
                <Icon name="volume-2" class="sub-icon" />
                <span class="sub-label">Sound</span>
                <ToggleSwitch 
                  v-model="preferences[type.soundKey]"
                  @change="onPreferenceChange"
                  size="small"
                />
              </div>
              
              <!-- Test button -->
              <button 
                class="test-btn" 
                @click="testNotification(type.testType)"
                :disabled="isTestingType === type.testType"
              >
                <Icon v-if="isTestingType === type.testType" name="loader" class="spinning" />
                <Icon v-else name="play" />
                Test
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Desktop Notification Settings -->
    <div class="settings-section" :class="{ disabled: !preferences.activitypub_notifications }">
      <h3 class="section-title">Desktop Notifications</h3>
      <p class="section-description">Configure desktop notification behavior for ActivityPub</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Desktop Notifications</h4>
          <p class="setting-description">
            Show desktop notifications for ActivityPub activities when the app is not focused
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.activitypub_desktop_notifications"
            @change="onPreferenceChange"
            :disabled="!preferences.activitypub_notifications"
          />
        </div>
      </div>

      <!-- Permission Status -->
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

    <!-- Sound Settings -->
    <div class="settings-section" :class="{ disabled: !preferences.activitypub_notifications }">
      <h3 class="section-title">Sound Notifications</h3>
      <p class="section-description">Configure sound notification behavior for ActivityPub</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Sound Notifications</h4>
          <p class="setting-description">
            Play notification sounds for ActivityPub activities
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.activitypub_sound_notifications"
            @change="onPreferenceChange"
            :disabled="!preferences.activitypub_notifications"
          />
        </div>
      </div>

      <!-- Volume Control -->
      <div class="setting-item" v-if="preferences.activitypub_sound_notifications">
        <div class="setting-info">
          <h4 class="setting-label">Volume</h4>
          <p class="setting-description">
            Adjust the volume for ActivityPub notification sounds
          </p>
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
    </div>

    <!-- Privacy Settings -->
    <div class="settings-section" :class="{ disabled: !preferences.activitypub_notifications }">
      <h3 class="section-title">Privacy & Filtering</h3>
      <p class="section-description">Control who can send you notifications</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Only from People I Follow</h4>
          <p class="setting-description">
            Only receive notifications from users you follow
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.activitypub_followers_only"
            @change="onPreferenceChange"
            :disabled="!preferences.activitypub_notifications"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Filter by Instance</h4>
          <p class="setting-description">
            Only receive notifications from specific instances
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="preferences.activitypub_instance_filter"
            @change="onPreferenceChange"
            :disabled="!preferences.activitypub_notifications"
          />
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="!hasChanges || isSaving"
      >
        <Icon v-if="isSaving" name="loader" class="spinning" />
        <span>{{ isSaving ? 'Saving...' : 'Save Changes' }}</span>
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="!hasChanges || isSaving"
      >
        Reset
      </button>
      <button 
        class="btn btn-outline" 
        @click="testAllNotifications"
        :disabled="!preferences.activitypub_notifications || isTesting"
      >
        <Icon v-if="isTesting" name="loader" class="spinning" />
        <span>{{ isTesting ? 'Testing...' : 'Test All' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useNotificationStore } from '@/stores/useNotification';
import { useToast } from 'vue-toastification';
import type { NotificationPreferences, NotificationType } from '@/types';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface Props {
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false
});

// Emits
const emit = defineEmits<{
  'update-preferences': [preferences: Partial<NotificationPreferences>];
}>();

// Stores
const notificationStore = useNotificationStore();
const toast = useToast();

// State
const preferences = ref<Partial<NotificationPreferences>>({});
const originalPreferences = ref<Partial<NotificationPreferences>>({});
const hasNotificationPermission = ref(false);
const isRequestingPermission = ref(false);
const isSaving = ref(false);
const isTesting = ref(false);
const isTestingType = ref<string | null>(null);
const soundVolume = ref(50);

// Notification type configuration
const notificationTypes = [
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
];

// Computed properties
const hasChanges = computed(() => {
  return JSON.stringify(preferences.value) !== JSON.stringify(originalPreferences.value);
});

const permissionIcon = computed(() => {
  return hasNotificationPermission.value ? 'check-circle' : 'alert-circle';
});

const permissionClass = computed(() => {
  return hasNotificationPermission.value ? 'permission-granted' : 'permission-denied';
});

const permissionText = computed(() => {
  if (hasNotificationPermission.value) {
    return 'Desktop notifications are enabled';
  }
  return 'Desktop notifications require permission';
});

// Methods
const loadPreferences = () => {
  const currentPreferences = notificationStore.preferences;
  if (currentPreferences) {
    preferences.value = { ...currentPreferences };
    originalPreferences.value = { ...currentPreferences };
  }
};

const onPreferenceChange = () => {
  // Emit changes to parent
  emit('update-preferences', preferences.value);
};

const onVolumeChange = () => {
  // Update volume in theme store if needed
  console.log('Volume changed:', soundVolume.value);
};

const saveSettings = async () => {
  if (!hasChanges.value) return;
  
  try {
    isSaving.value = true;
    await notificationStore.updatePreferences(preferences.value);
    originalPreferences.value = { ...preferences.value };
    toast.success('ActivityPub notification preferences saved');
  } catch (error) {
    console.error('Failed to save preferences:', error);
    toast.error('Failed to save preferences');
  } finally {
    isSaving.value = false;
  }
};

const resetSettings = () => {
  preferences.value = { ...originalPreferences.value };
  emit('update-preferences', preferences.value);
};

const requestPermission = async () => {
  if (typeof Notification === 'undefined') {
    toast.error('Desktop notifications are not supported in this browser');
    return;
  }
  
  try {
    isRequestingPermission.value = true;
    const permission = await Notification.requestPermission();
    hasNotificationPermission.value = permission === 'granted';
    
    if (hasNotificationPermission.value) {
      toast.success('Desktop notification permission granted');
    } else {
      toast.error('Desktop notification permission denied');
    }
  } catch (error) {
    console.error('Failed to request permission:', error);
    toast.error('Failed to request permission');
  } finally {
    isRequestingPermission.value = false;
  }
};

const testNotification = async (type: NotificationType) => {
  if (isTestingType.value) return;
  
  try {
    isTestingType.value = type;
    
    // Create test notification data
    const testData = {
      id: 'test-notification',
      user_id: 'current-user',
      type,
      title: getTestNotificationTitle(type),
      message: getTestNotificationMessage(type),
      data: getTestNotificationData(type),
      is_read: false,
      is_clicked: false,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
    
    // Show toast
    notificationStore.showToast(
      type,
      testData.title,
      testData.message,
      3000,
      testData.data.avatar_url
    );
    
    // Play sound
    if (preferences.value.activitypub_sound_notifications) {
      await notificationStore.playNotificationSound(type);
    }
    
    // Show desktop notification
    if (preferences.value.activitypub_desktop_notifications && hasNotificationPermission.value) {
      new Notification(testData.title, {
        body: testData.message,
        icon: testData.data.avatar_url,
        badge: '/img/app_icon_square.png'
      });
    }
    
    toast.success(`Test notification sent for ${type}`);
  } catch (error) {
    console.error('Failed to test notification:', error);
    toast.error('Failed to test notification');
  } finally {
    setTimeout(() => {
      isTestingType.value = null;
    }, 1000);
  }
};

const testAllNotifications = async () => {
  if (isTesting.value) return;
  
  try {
    isTesting.value = true;
    
    for (const type of notificationTypes) {
      if (preferences.value[type.key]) {
        await testNotification(type.testType as NotificationType);
        await new Promise(resolve => setTimeout(resolve, 500)); // Delay between tests
      }
    }
    
    toast.success('All enabled notifications tested');
  } catch (error) {
    console.error('Failed to test all notifications:', error);
    toast.error('Failed to test all notifications');
  } finally {
    isTesting.value = false;
  }
};

const getTestNotificationTitle = (type: NotificationType): string => {
  switch (type) {
    case 'activitypub_follow':
      return 'New Follower';
    case 'activitypub_mention':
      return 'You were mentioned';
    case 'activitypub_reply':
      return 'New Reply';
    case 'activitypub_favorite':
      return 'Post Favorited';
    case 'activitypub_reblog':
      return 'Post Reblogged';
    case 'activitypub_follow_request':
      return 'Follow Request';
    default:
      return 'Test Notification';
  }
};

const getTestNotificationMessage = (type: NotificationType): string => {
  switch (type) {
    case 'activitypub_follow':
      return 'TestUser started following you';
    case 'activitypub_mention':
      return 'TestUser mentioned you in a post';
    case 'activitypub_reply':
      return 'TestUser replied to your post';
    case 'activitypub_favorite':
      return 'TestUser favorited your post';
    case 'activitypub_reblog':
      return 'TestUser reblogged your post';
    case 'activitypub_follow_request':
      return 'TestUser requested to follow you';
    default:
      return 'This is a test notification';
  }
};

const getTestNotificationData = (type: NotificationType) => {
  return {
    follower_username: 'TestUser',
    follower_display_name: 'Test User',
    follower_avatar_url: '/default_avatar.png',
    follower_domain: 'example.com',
    post_content: 'This is a test post for notification testing',
    timestamp: new Date().toISOString()
  };
};

// Check notification permission
const checkNotificationPermission = () => {
  if (typeof Notification !== 'undefined') {
    hasNotificationPermission.value = Notification.permission === 'granted';
  }
};

// Lifecycle
onMounted(() => {
  loadPreferences();
  checkNotificationPermission();
});

// Watch for changes in notification store preferences
watch(() => notificationStore.preferences, (newPreferences) => {
  if (newPreferences) {
    preferences.value = { ...newPreferences };
    originalPreferences.value = { ...newPreferences };
  }
}, { deep: true });
</script>

<style scoped>
.activitypub-notification-settings {
  max-width: 800px;
  margin: 0 auto;
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
  transition: all 0.3s ease;
}

.settings-section.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-item.master-toggle {
  padding: 20px;
  background: rgba(88, 101, 242, 0.1);
  border-radius: 8px;
  border: 1px solid rgba(88, 101, 242, 0.2);
  margin-bottom: 16px;
}

.setting-info {
  flex: 1;
}

.setting-label {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.5;
}

.setting-control {
  flex-shrink: 0;
}

.notification-types-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.notification-type-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  overflow: hidden;
  transition: all 0.2s ease;
}

.notification-type-card:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}

.type-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: rgba(88, 101, 242, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--h-brand);
  flex-shrink: 0;
}

.type-info {
  flex: 1;
}

.type-label {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 2px 0;
}

.type-description {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.4;
}

.type-toggle {
  flex-shrink: 0;
}

.card-content {
  padding: 0 16px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.sub-settings {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
}

.sub-setting {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #b9bbbe;
}

.sub-icon {
  width: 14px;
  height: 14px;
}

.sub-label {
  font-weight: 500;
}

.test-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(67, 181, 129, 0.1);
  border: 1px solid rgba(67, 181, 129, 0.2);
  border-radius: 4px;
  color: #43b581;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-left: auto;
}

.test-btn:hover:not(:disabled) {
  background: rgba(67, 181, 129, 0.2);
}

.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.permission-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  margin-top: 12px;
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.permission-granted {
  color: #43b581;
}

.permission-denied {
  color: #f04747;
}

.permission-btn {
  padding: 6px 12px;
  background: rgba(88, 101, 242, 0.1);
  border: 1px solid rgba(88, 101, 242, 0.2);
  border-radius: 4px;
  color: var(--h-brand);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.permission-btn:hover:not(:disabled) {
  background: rgba(88, 101, 242, 0.2);
}

.permission-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.volume-slider {
  flex: 1;
  max-width: 120px;
}

.volume-value {
  font-size: 12px;
  color: #b9bbbe;
  font-weight: 500;
  min-width: 35px;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--h-brand);
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background: #4752c4;
}

.btn-secondary {
  background: rgba(79, 84, 92, 0.3);
  color: #dcddde;
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(79, 84, 92, 0.5);
}

.btn-outline {
  background: transparent;
  color: #b9bbbe;
  border-color: rgba(255, 255, 255, 0.2);
}

.btn-outline:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.btn:disabled {
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

/* Responsive Design */
@media (max-width: 768px) {
  .notification-types-grid {
    grid-template-columns: 1fr;
  }
  
  .settings-section {
    padding: 16px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .permission-status {
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  
  .sub-settings {
    flex-wrap: wrap;
    gap: 12px;
  }
  
  .settings-actions {
    flex-direction: column;
  }
}
</style>