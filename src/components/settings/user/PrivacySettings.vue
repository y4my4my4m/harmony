<template>
  <div class="privacy-settings">
    <div class="settings-header">
      <h2 class="settings-title">Privacy & Safety</h2>
      <p class="settings-description">
        Control who can interact with you and how your data is used.
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Direct Messages</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Allow direct messages from server members</h4>
          <p class="setting-description">
            This setting is applied to all servers. You can override this for individual servers.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowDMFromServerMembers"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Allow direct messages from friends</h4>
          <p class="setting-description">
            Allow friends to send you direct messages.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowDMFromFriends"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Friend Requests</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Allow friend requests</h4>
          <p class="setting-description">
            If disabled, no one will be able to send you friend requests.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowFriendRequests"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Allow friend requests from server members</h4>
          <p class="setting-description">
            Allow members of servers you're in to send friend requests.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowFriendRequestsFromServerMembers"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Who Can Add You As A Friend</h3>
      
      <div class="radio-group">
        <label class="radio-option">
          <input
            v-model="settings.friendRequestSetting"
            type="radio"
            value="everyone"
            @change="onSettingChange"
          />
          <span class="radio-label">Everyone</span>
        </label>
        
        <label class="radio-option">
          <input
            v-model="settings.friendRequestSetting"
            type="radio"
            value="friends-of-friends"
            @change="onSettingChange"
          />
          <span class="radio-label">Friends of Friends</span>
        </label>
        
        <label class="radio-option">
          <input
            v-model="settings.friendRequestSetting"
            type="radio"
            value="server-members"
            @change="onSettingChange"
          />
          <span class="radio-label">Server Members</span>
        </label>
        
        <label class="radio-option">
          <input
            v-model="settings.friendRequestSetting"
            type="radio"
            value="no-one"
            @change="onSettingChange"
          />
          <span class="radio-label">No One</span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data & Privacy</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Use data to improve Harmony</h4>
          <p class="setting-description">
            Allow Harmony to use your data to improve the service.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowDataCollection"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Use data for personalization</h4>
          <p class="setting-description">
            Allow Harmony to personalize your experience based on your activity.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.allowPersonalization"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Blocked Users</h3>
      
      <div v-if="blockedUsers.length === 0" class="empty-state">
        <p>You haven't blocked anyone yet.</p>
      </div>
      
      <div v-else class="blocked-users-list">
        <div 
          v-for="user in blockedUsers" 
          :key="user.id"
          class="blocked-user-item"
        >
          <div class="user-info">
            <img :src="user.avatar_url || '/default_avatar.png'" class="user-avatar" />
            <div class="user-details">
              <span class="user-name">{{ user.display_name }}</span>
              <span class="user-username">{{ user.username }}</span>
            </div>
          </div>
          <button 
            class="unblock-btn"
            @click="unblockUser(user.id)"
          >
            Unblock
          </button>
        </div>
      </div>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        Save Changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { User } from '@/types'

// Components
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-privacy': [settings: any]
}>()

// State
const settings = ref({
  allowDMFromServerMembers: true,
  allowDMFromFriends: true,
  allowFriendRequests: true,
  allowFriendRequestsFromServerMembers: true,
  friendRequestSetting: 'everyone' as 'everyone' | 'friends-of-friends' | 'server-members' | 'no-one',
  allowDataCollection: false,
  allowPersonalization: false,
})

const originalSettings = ref({ ...settings.value })
const blockedUsers = ref<User[]>([])

// Computed
const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

// Methods
const onSettingChange = () => {
  // Settings changed, enable save button
}

const saveSettings = () => {
  emit('update-privacy', settings.value)
  originalSettings.value = { ...settings.value }
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
}

const unblockUser = (userId: string) => {
  blockedUsers.value = blockedUsers.value.filter(user => user.id !== userId)
  // TODO: Implement actual unblock logic
}

// Initialize
onMounted(() => {
  // Load privacy settings from server
  // TODO: Implement actual loading logic
})
</script>

<style scoped>
.privacy-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
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
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--h-chat-light);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
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
  flex-shrink: 0;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 8px 0;
}

.radio-option input[type="radio"] {
  width: 20px;
  height: 20px;
  border: 2px solid #4f545c;
  border-radius: 50%;
  background-color: transparent;
  cursor: pointer;
}

.radio-option input[type="radio"]:checked {
  border-color: #5865f2;
  background-color: #5865f2;
}

.radio-label {
  font-size: 14px;
  color: #ffffff;
  cursor: pointer;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #b9bbbe;
}

.blocked-users-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.blocked-user-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background-color: var(--h-chat-darker);
  border-radius: 4px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.user-details {
  display: flex;
  flex-direction: column;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
}

.user-username {
  font-size: 12px;
  color: #b9bbbe;
}

.unblock-btn {
  padding: 6px 12px;
  background-color: #ed4245;
  border: none;
  border-radius: 4px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.unblock-btn:hover {
  background-color: #c73e41;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #5865f2;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .setting-info {
    margin-right: 0;
  }
}
</style>