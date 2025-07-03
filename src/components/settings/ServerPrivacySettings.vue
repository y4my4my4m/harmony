<template>
  <div class="server-privacy-settings">
    <div class="settings-section">
      <h2 class="section-title">Privacy Settings</h2>
      <p class="section-description">
        {{ permissions.canChangePrivacySettings ? 'Control who can discover and join your server' : 'View server privacy settings' }}
      </p>
    </div>

    <!-- Permission Notice for Read-Only Users -->
    <div v-if="!permissions.canChangePrivacySettings" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h4>View Only Access</h4>
          <p>You can view privacy settings but cannot change them. Only the server owner can modify privacy settings.</p>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="form-label">Public Server</label>
            <div class="form-hint">
              {{ permissions.canChangePrivacySettings 
                ? 'Allow your server to be discovered in the public server directory' 
                : 'Whether this server can be discovered publicly' 
              }}
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                :checked="isPublic"
                @change="permissions.canChangePrivacySettings ? handlePublicToggle : null"
                :disabled="loading || !permissions.canChangePrivacySettings"
              />
              <span class="toggle-slider" :class="{ 'disabled': !permissions.canChangePrivacySettings }"></span>
            </label>
          </div>
        </div>
      </div>

      <div v-if="isPublic" class="public-server-info">
        <div class="info-card">
          <div class="info-header">
            <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#57f287" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M11,16.5L18,9.5L16.59,8.09L11,13.67L7.41,10.09L6,11.5L11,16.5Z"/>
            </svg>
            <h4 class="info-title">Public Server Benefits</h4>
          </div>
          <ul class="info-list">
            <li>Your server will appear in the public server directory</li>
            <li>New members can discover and join your community</li>
            <li>Increased visibility for your server's content and activities</li>
            <li>Server statistics will be visible to potential members</li>
          </ul>
        </div>

        <div class="warning-card">
          <div class="warning-header">
            <svg class="warning-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
            </svg>
            <h4 class="warning-title">Important Considerations</h4>
          </div>
          <ul class="warning-list">
            <li>Anyone can see your server name, description, and member count</li>
            <li>Server icon and basic information will be publicly visible</li>
            <li>Consider reviewing your server rules and moderation settings</li>
            <li>You can change this setting back to private at any time</li>
          </ul>
        </div>
      </div>

      <div v-else class="private-server-info">
        <div class="info-card private">
          <div class="info-header">
            <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#5865f2" d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/>
            </svg>
            <h4 class="info-title">Private Server</h4>
          </div>
          <p class="info-text">
            Your server is currently private. Only members with an invite link can join.
            This provides better control over who can access your community.
          </p>
        </div>
      </div>
    </div>

    <div class="settings-card" v-if="permissions.canChangePrivacySettings">
      <div class="form-group">
        <label class="form-label">Server Discovery</label>
        <div class="discovery-options">
          <div class="discovery-option">
            <div class="option-content">
              <div class="option-title">Invite Only</div>
              <div class="option-description">
                Members can only join through invite links created by server moderators
              </div>
            </div>
            <div class="option-control">
              <input
                type="radio"
                id="invite-only"
                name="discovery"
                value="invite-only"
                :checked="!isPublic"
                @change="setDiscoveryMode('invite-only')"
                :disabled="loading"
              />
              <label for="invite-only" class="radio-label"></label>
            </div>
          </div>

          <div class="discovery-option">
            <div class="option-content">
              <div class="option-title">Public Directory</div>
              <div class="option-description">
                Anyone can discover and join your server through the public server list
              </div>
            </div>
            <div class="option-control">
              <input
                type="radio"
                id="public-directory"
                name="discovery"
                value="public-directory"
                :checked="isPublic"
                @change="setDiscoveryMode('public-directory')"
                :disabled="loading"
              />
              <label for="public-directory" class="radio-label"></label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface ServerPermissions {
  canChangePrivacySettings: boolean
}

interface Props {
  isPublic: boolean
  loading: boolean
  permissions: ServerPermissions
}

interface Emits {
  (e: 'update:isPublic', value: boolean): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const handlePublicToggle = (event: Event) => {
  if (!props.permissions.canChangePrivacySettings) return
  const target = event.target as HTMLInputElement
  emit('update:isPublic', target.checked)
}

const setDiscoveryMode = (mode: 'invite-only' | 'public-directory') => {
  if (!props.permissions.canChangePrivacySettings) return
  const newPublicState = mode === 'public-directory'
  emit('update:isPublic', newPublicState)
}
</script>

<style scoped>
.server-privacy-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.permission-notice {
  padding: 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #faa61a;
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: #faa61a;
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
}

.settings-card {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  border: 1px solid var(--h-chat-light);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-hint {
  font-size: 12px;
  color: #72767d;
  margin-top: 4px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.setting-info {
  flex: 1;
}

.setting-control {
  flex-shrink: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #72767d;
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: #5865f2;
}

input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.public-server-info,
.private-server-info {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-card {
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  padding: 16px;
  border-left: 4px solid #57f287;
}

.info-card.private {
  border-left-color: #5865f2;
}

.warning-card {
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  padding: 16px;
  border-left: 4px solid #faa61a;
}

.info-header,
.warning-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.info-title,
.warning-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.info-icon,
.warning-icon {
  flex-shrink: 0;
}

.info-list,
.warning-list {
  margin: 0;
  padding-left: 16px;
  color: #b9bbbe;
  font-size: 13px;
  line-height: 1.5;
}

.info-list li,
.warning-list li {
  margin-bottom: 4px;
}

.info-text {
  color: #b9bbbe;
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}

.discovery-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.discovery-option {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  border: 1px solid var(--h-chat-light);
  cursor: pointer;
  transition: all 0.15s ease;
}

.discovery-option:hover {
  background-color: var(--h-chat-light);
}

.option-content {
  flex: 1;
}

.option-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin-bottom: 4px;
}

.option-description {
  font-size: 12px;
  color: #72767d;
  line-height: 1.4;
}

.option-control {
  flex-shrink: 0;
}

.option-control input[type="radio"] {
  display: none;
}

.radio-label {
  display: block;
  width: 20px;
  height: 20px;
  border: 2px solid #72767d;
  border-radius: 50%;
  background-color: transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.radio-label:before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: #5865f2;
  opacity: 0;
  transition: opacity 0.15s ease;
}

input[type="radio"]:checked + .radio-label {
  border-color: #5865f2;
}

input[type="radio"]:checked + .radio-label:before {
  opacity: 1;
}

input[type="radio"]:disabled + .radio-label {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .discovery-option {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>