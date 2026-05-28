<template>
  <div class="server-privacy-settings">
    <div class="settings-section">
      <h2 class="section-title">{{ $t('server.privacySettings') }}</h2>
      <p class="section-description">
        {{ permissions.canChangePrivacySettings ? $t('server.privacySettings') : $t('server.privacySettings') }}
      </p>
    </div>

    <!-- Permission Notice for Read-Only Users -->
    <div v-if="!permissions.canChangePrivacySettings" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h4>{{ $t('server.viewOnlyAccess') }}</h4>
          <p>{{ $t('server.viewOnlyMessage') }}</p>
        </div>
      </div>
    </div>

    <!-- Federation Settings (only show if instance-level federation is enabled) -->
    <div class="settings-card" v-if="permissions.canChangePrivacySettings && instanceFederationEnabled">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="form-label">{{ $t('server.federationEnabled', 'Enable Federation') }}</label>
            <div class="form-hint">
              {{ $t('server.federationEnabledDesc', 'Allow users from other Harmony instances to join and interact with this server. Required for cross-instance communication.') }}
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                :checked="federationEnabled"
                @change="handleFederationToggle"
                :disabled="loading"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div v-if="federationEnabled" class="federation-info">
        <div class="info-card federation">
          <div class="info-header">
            <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#0EA5E9" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M12,6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6Z"/>
            </svg>
            <h4 class="info-title">{{ $t('server.federationActive', 'Federation Active') }}</h4>
          </div>
          <ul class="info-list">
            <li>{{ $t('server.federationBenefit1', 'Users from other instances can join via invite links') }}</li>
            <li>{{ $t('server.federationBenefit2', 'Messages are shared with federated members in real-time') }}</li>
            <li>{{ $t('server.federationBenefit3', 'Server appears in federated server discovery') }}</li>
          </ul>
          <div v-if="federatedMemberCount > 0" class="federated-member-count">
            {{ federatedMemberCount }} federated member{{ federatedMemberCount !== 1 ? 's' : '' }} currently in this server
          </div>
        </div>
      </div>

      <!-- Warning dialog when disabling federation with existing members -->
      <div v-if="showDisableWarning" class="disable-federation-warning-overlay" @click.self="cancelDisableFederation">
        <div class="disable-federation-warning">
          <div class="warning-header">
            <svg class="warning-icon" width="24" height="24" viewBox="0 0 24 24">
              <path fill="#ed4245" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
            </svg>
            <h3>Disable Federation?</h3>
          </div>
          <p class="warning-body">
            This server currently has <strong>{{ federatedMemberCount }}</strong> federated member{{ federatedMemberCount !== 1 ? 's' : '' }}
            from other instances. Disabling federation will:
          </p>
          <ul class="warning-consequences">
            <li>Block all new join requests from remote users</li>
            <li>Stop delivering messages to and from remote members</li>
            <li>Prevent reactions and voice participation from remote users</li>
            <li>Existing federated members will remain in the member list but will be unable to interact</li>
          </ul>
          <div class="warning-actions">
            <button class="btn-cancel" @click="cancelDisableFederation">Cancel</button>
            <button class="btn-confirm-danger" @click="confirmDisableFederation">Disable Federation</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="form-label">{{ $t('server.publicServer') }}</label>
            <div class="form-hint">
              {{ permissions.canChangePrivacySettings 
                ? $t('server.publicServerDesc')
                : $t('server.publicServerDesc')
              }}
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                :checked="isPublic"
                @change="handlePublicToggle"
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
            <h4 class="info-title">{{ $t('server.publicServerBenefits') }}</h4>
          </div>
          <ul class="info-list">
            <li>{{ $t('server.publicServerBenefit1') }}</li>
            <li>{{ $t('server.publicServerBenefit2') }}</li>
            <li>{{ $t('server.publicServerBenefit3') }}</li>
            <li>{{ $t('server.publicServerBenefit4') }}</li>
          </ul>
        </div>

        <div class="warning-card">
          <div class="warning-header">
            <svg class="warning-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
            </svg>
            <h4 class="warning-title">{{ $t('server.importantConsiderations') }}</h4>
          </div>
          <ul class="warning-list">
            <li>{{ $t('server.consideration1') }}</li>
            <li>{{ $t('server.consideration2') }}</li>
            <li>{{ $t('server.consideration3') }}</li>
            <li>{{ $t('server.consideration4') }}</li>
          </ul>
        </div>
      </div>

      <div v-else class="private-server-info">
        <div class="info-card private">
          <div class="info-header">
            <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#0EA5E9" d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/>
            </svg>
            <h4 class="info-title">{{ $t('server.privateServer') }}</h4>
          </div>
          <p class="info-text">
            {{ $t('server.privateServerInfo') }}
          </p>
        </div>
      </div>
    </div>

    <div class="settings-card" v-if="permissions.canChangePrivacySettings">
      <div class="form-group">
        <label class="form-label">{{ $t('server.serverDiscovery') }}</label>
        <div class="discovery-options">
          <div class="discovery-option">
            <div class="option-content">
              <div class="option-title">{{ $t('server.inviteOnly') }}</div>
              <div class="option-description">
                {{ $t('server.inviteOnlyDesc') }}
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
              <div class="option-title">{{ $t('server.publicDirectory') }}</div>
              <div class="option-description">
                {{ $t('server.publicDirectoryDesc') }}
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
import { ref, onMounted, watch } from 'vue'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { supabase } from '@/supabase'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const instanceSettings = useInstanceSettingsStore()
const instanceFederationEnabled = instanceSettings.isFederationEnabled

interface ServerPermissions {
  canChangePrivacySettings: boolean
}

interface Props {
  serverId: string
  isPublic: boolean
  federationEnabled: boolean
  loading: boolean
  permissions: ServerPermissions
}

interface Emits {
  (e: 'update:isPublic', value: boolean): void
  (e: 'update:federationEnabled', value: boolean): void
}

const props = withDefaults(defineProps<Props>(), {
  federationEnabled: false
})
const emit = defineEmits<Emits>()

const federatedMemberCount = ref(0)
const showDisableWarning = ref(false)

async function fetchFederatedMemberCount() {
  if (!props.serverId) return
  const { count, error } = await supabase
    .from('user_servers')
    .select('id', { count: 'exact', head: true })
    .eq('server_id', props.serverId)
    .eq('status', 'accepted')
    .not('member_instance', 'is', null)
    .neq('member_instance', window.location.hostname)

  if (!error && count !== null) {
    federatedMemberCount.value = count
  }
}

onMounted(() => {
  fetchFederatedMemberCount()
})

watch(() => props.serverId, () => {
  fetchFederatedMemberCount()
})

const handlePublicToggle = (event: Event) => {
  if (!props.permissions.canChangePrivacySettings) return
  const target = event.target as HTMLInputElement
  emit('update:isPublic', target.checked)
}

const handleFederationToggle = (event: Event) => {
  if (!props.permissions.canChangePrivacySettings) return
  const target = event.target as HTMLInputElement
  const newValue = target.checked

  if (!newValue && federatedMemberCount.value > 0) {
    showDisableWarning.value = true
    target.checked = true
    return
  }

  emit('update:federationEnabled', newValue)
}

function confirmDisableFederation() {
  showDisableWarning.value = false
  emit('update:federationEnabled', false)
}

function cancelDisableFederation() {
  showDisableWarning.value = false
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
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-hint {
  font-size: 12px;
  color: var(--text-muted);
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
  background-color: var(--text-muted);
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
  background-color: var(--text-primary);
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: var(--harmony-primary);
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

.info-card.private,
.info-card.federation {
  border-left-color: #0EA5E9;
}

.federation-info {
  margin-top: 16px;
}

.federated-member-count {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(14, 165, 233, 0.1);
  border-radius: 6px;
  font-size: 13px;
  color: #8b9dff;
}

.disable-federation-warning-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}

.disable-federation-warning {
  background: var(--bg-secondary, #2b2d31);
  border-radius: 12px;
  padding: 28px;
  max-width: 480px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.disable-federation-warning .warning-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.disable-federation-warning .warning-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.disable-federation-warning .warning-body {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 12px;
}

.warning-consequences {
  margin: 0 0 20px;
  padding-left: 20px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.warning-consequences li {
  margin-bottom: 4px;
}

.warning-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.btn-cancel {
  padding: 10px 20px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.btn-confirm-danger {
  padding: 10px 20px;
  background: #ed4245;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-confirm-danger:hover {
  background: #d63638;
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
  color: var(--text-primary);
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
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.info-list li,
.warning-list li {
  margin-bottom: 4px;
}

.info-text {
  color: var(--text-secondary);
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
  color: var(--text-primary);
  margin-bottom: 4px;
}

.option-description {
  font-size: 12px;
  color: var(--text-muted);
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
  border: 2px solid var(--text-muted);
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
  background-color: var(--harmony-primary);
  opacity: 0;
  transition: opacity 0.15s ease;
}

input[type="radio"]:checked + .radio-label {
  border-color: #0EA5E9;
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