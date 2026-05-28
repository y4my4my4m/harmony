<template>
  <div class="invite-settings">
    <div class="settings-header">
      <h2 class="settings-title">Invite Settings</h2>
      <p class="settings-description">
        Control who can create invites and set default invite parameters for your server
      </p>
    </div>

    <div class="settings-section">
      <div class="setting-group">
        <h3 class="setting-title">Who Can Create Invites</h3>
        <p class="setting-description">
          Choose who has permission to create invite links for this server
        </p>
        
        <div class="radio-group">
          <label class="radio-option">
            <input 
              type="radio" 
              v-model="settings.invite_permissions.who_can_create" 
              value="everyone"
              @change="handleSettingsChange"
            />
            <div class="radio-content">
              <div class="radio-header">
                <span class="radio-title">Everyone</span>
                <span class="radio-badge recommended">Recommended</span>
              </div>
              <p class="radio-description">All server members can create invites</p>
            </div>
          </label>

          <label class="radio-option">
            <input 
              type="radio" 
              v-model="settings.invite_permissions.who_can_create" 
              value="roles"
              @change="handleSettingsChange"
            />
            <div class="radio-content">
              <div class="radio-header">
                <span class="radio-title">Specific Roles</span>
              </div>
              <p class="radio-description">Only members with selected roles can create invites</p>
            </div>
          </label>

          <label class="radio-option">
            <input 
              type="radio" 
              v-model="settings.invite_permissions.who_can_create" 
              value="administrators"
              @change="handleSettingsChange"
            />
            <div class="radio-content">
              <div class="radio-header">
                <span class="radio-title">Administrators Only</span>
                <span class="radio-badge secure">Secure</span>
              </div>
              <p class="radio-description">Only server administrators can create invites</p>
            </div>
          </label>
        </div>

        <!-- Role Selection (only show when 'roles' is selected) -->
        <div v-if="settings.invite_permissions.who_can_create === 'roles'" class="role-selection">
          <h4 class="subsetting-title">Allowed Roles</h4>
          <div class="role-list">
            <label 
              v-for="role in serverRoles" 
              :key="role.id" 
              class="role-checkbox"
            >
              <input 
                type="checkbox" 
                :value="role.id"
                v-model="settings.invite_permissions.allowed_roles"
                @change="handleSettingsChange"
              />
              <div class="role-info">
                <div 
                  class="role-color" 
                  :style="{ backgroundColor: role.color }"
                ></div>
                <span class="role-name">{{ role.name }}</span>
                <span class="role-member-count">{{ role.member_count || 0 }} members</span>
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="setting-group">
        <h3 class="setting-title">Default Invite Settings</h3>
        <p class="setting-description">
          Set default parameters for new invites created by members
        </p>

        <div class="settings-grid">
          <div class="setting-item">
            <label class="setting-label">Default Expiration</label>
            <select 
              v-model="settings.invite_permissions.default_expiration" 
              class="setting-select"
              @change="handleSettingsChange"
            >
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="360">6 hours</option>
              <option value="720">12 hours</option>
              <option value="1440">1 day</option>
              <option value="4320">3 days</option>
              <option value="10080">7 days</option>
              <option value="43200">30 days</option>
              <option value="0">Never expires</option>
            </select>
            <p class="setting-hint">
              How long new invites will be valid by default
            </p>
          </div>

          <div class="setting-item">
            <label class="setting-label">Maximum Expiration</label>
            <select 
              v-model="settings.invite_permissions.max_expiration" 
              class="setting-select"
              @change="handleSettingsChange"
            >
              <option value="1440">1 day</option>
              <option value="4320">3 days</option>
              <option value="10080">7 days</option>
              <option value="43200">30 days</option>
              <option value="0">No limit</option>
            </select>
            <p class="setting-hint">
              Maximum expiration time members can set (admins bypass this)
            </p>
          </div>

          <div class="setting-item">
            <label class="setting-label">Maximum Uses Limit</label>
            <select 
              v-model="settings.invite_permissions.max_uses_limit" 
              class="setting-select"
              @change="handleSettingsChange"
            >
              <option value="1">1 use</option>
              <option value="5">5 uses</option>
              <option value="10">10 uses</option>
              <option value="25">25 uses</option>
              <option value="50">50 uses</option>
              <option value="100">100 uses</option>
              <option value="0">No limit</option>
            </select>
            <p class="setting-hint">
              Maximum number of uses members can set (admins bypass this)
            </p>
          </div>
        </div>

        <div class="setting-item">
          <div class="toggle-setting">
            <div class="toggle-info">
              <label class="setting-label">Allow Temporary Membership</label>
              <p class="setting-hint">
                Allow members to create invites that grant temporary access
              </p>
            </div>
            <label class="toggle-switch">
              <input 
                type="checkbox" 
                v-model="settings.invite_permissions.allow_temporary"
                @change="handleSettingsChange"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Save actions handled by parent ServerSettings save button -->

    <!-- Success/Error Messages -->
    <div v-if="saveMessage" class="save-message" :class="saveMessage.type">
      <svg v-if="saveMessage.type === 'success'" viewBox="0 0 24 24" class="message-icon">
        <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" class="message-icon">
        <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
      </svg>
      <span>{{ saveMessage.text }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { 
  getServerSettings, 
  updateServerSettings, 
  getDefaultServerSettings,
  type ServerSettings 
} from '@/services/permissionsService'

interface Props {
  serverId: string
}

interface ServerRole {
  id: string
  name: string
  color: string
  member_count?: number
}

const props = defineProps<Props>()
const toast = useToast()

// Reactive state
const settings = ref<ServerSettings>(getDefaultServerSettings(props.serverId))
const originalSettings = ref<ServerSettings>(getDefaultServerSettings(props.serverId))
const serverRoles = ref<ServerRole[]>([])
const isSaving = ref(false)
const isLoading = ref(true)
const saveMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null)

// Computed
const hasUnsavedChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

// Methods
const loadSettings = async () => {
  try {
    isLoading.value = true
    
    const [serverSettings, roles] = await Promise.all([
      getServerSettings(props.serverId),
      loadServerRoles()
    ])
    
    if (serverSettings) {
      settings.value = { ...serverSettings }
      originalSettings.value = { ...serverSettings }
    } else {
      // Use defaults
      const defaults = getDefaultServerSettings(props.serverId)
      settings.value = defaults
      originalSettings.value = { ...defaults }
    }
    
    serverRoles.value = roles
  } catch (error) {
    debug.error('Error loading invite settings:', error)
    toast.error('Failed to load invite settings')
  } finally {
    isLoading.value = false
  }
}

const loadServerRoles = async (): Promise<ServerRole[]> => {
  // This would typically fetch from your roles API
  // For now, return mock data
  return [
    { id: '1', name: 'Moderator', color: '#0EA5E9', member_count: 5 },
    { id: '2', name: 'Trusted Member', color: '#57f287', member_count: 12 },
    { id: '3', name: 'Member', color: '#b5bac1', member_count: 48 }
  ]
}

const handleSettingsChange = () => {
  // Clear any existing save messages when settings change
  saveMessage.value = null
}

const saveSettings = async () => {
  try {
    isSaving.value = true
    saveMessage.value = null
    
    const success = await updateServerSettings(props.serverId, settings.value)
    
    if (success) {
      originalSettings.value = { ...settings.value }
      saveMessage.value = {
        type: 'success',
        text: 'Invite settings saved successfully!'
      }
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        saveMessage.value = null
      }, 3000)
    } else {
      throw new Error('Failed to save settings')
    }
  } catch (error) {
    debug.error('Error saving invite settings:', error)
    saveMessage.value = {
      type: 'error',
      text: 'Failed to save invite settings. Please try again.'
    }
  } finally {
    isSaving.value = false
  }
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
  saveMessage.value = null
}

// Expose for parent component
defineExpose({
  hasChanges: hasUnsavedChanges,
  saveSettings,
  resetSettings
})

// Lifecycle
onMounted(() => {
  loadSettings()
})

// Watch for server ID changes
watch(() => props.serverId, () => {
  loadSettings()
})
</script>

<style scoped>
.invite-settings {
  display: flex;
  flex-direction: column;
  gap: 32px;
  max-width: 800px;
}

.settings-header {
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.settings-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.settings-description {
  font-size: 16px;
  color: #b5bac1;
  margin: 0;
  line-height: 1.5;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.setting-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.setting-description {
  font-size: 14px;
  color: #b5bac1;
  margin: 0;
  line-height: 1.4;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.radio-option {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.radio-option:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.radio-option input[type="radio"] {
  width: 20px;
  height: 20px;
  margin: 2px 0 0 0;
  accent-color: #0EA5E9;
}

.radio-content {
  flex: 1;
}

.radio-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.radio-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.radio-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.radio-badge.recommended {
  background: rgba(87, 242, 135, 0.2);
  color: #57f287;
}

.radio-badge.secure {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

.radio-description {
  font-size: 14px;
  color: #b5bac1;
  margin: 0;
}

.role-selection {
  margin-top: 16px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
}

.subsetting-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.role-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.role-checkbox {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.role-checkbox:hover {
  background: rgba(255, 255, 255, 0.04);
}

.role-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #0EA5E9;
}

.role-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.role-color {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.role-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.role-member-count {
  font-size: 12px;
  color: #b5bac1;
  margin-left: auto;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
}

.setting-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.setting-select {
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.setting-select:focus {
  outline: none;
  border-color: #0EA5E9;
  background: rgba(255, 255, 255, 0.06);
}

.setting-hint {
  font-size: 12px;
  color: #b5bac1;
  margin: 0;
  line-height: 1.3;
}

.toggle-setting {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
}

.toggle-info {
  flex: 1;
}

.toggle-switch {
  position: relative;
  width: 44px;
  height: 24px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  transition: all 0.2s ease;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  top: 3px;
  background: #ffffff;
  border-radius: 50%;
  transition: all 0.2s ease;
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--harmony-primary);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.action-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-button.secondary {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.action-button.secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.action-button.primary {
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
}

.action-button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.button-icon {
  width: 16px;
  height: 16px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.save-message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
}

.save-message.success {
  background: rgba(87, 242, 135, 0.1);
  border: 1px solid rgba(87, 242, 135, 0.2);
  color: #57f287;
}

.save-message.error {
  background: rgba(237, 66, 69, 0.1);
  border: 1px solid rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

.message-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  
  .toggle-setting {
    flex-direction: column;
    align-items: flex-start;
  }
  
  .settings-actions {
    flex-direction: column;
  }
}
</style>