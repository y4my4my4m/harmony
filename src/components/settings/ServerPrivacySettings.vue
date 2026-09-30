<template>
  <div class="server-privacy-settings">
    <div class="settings-section">
      <h2 class="section-title">{{ $t('server.privacySettings') }}</h2>
      <p class="section-description">
        {{ permissions.canChangePrivacySettings ? $t('server.privacySettingsDesc') : $t('server.privacySettingsViewDesc') }}
      </p>
    </div>

    <!-- Permission Notice for Read-Only Users -->
    <div v-if="!permissions.canChangePrivacySettings" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="currentColor" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
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
              <path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M12,6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6Z"/>
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

        <!-- Federation handle: how people on other instances discover this server -->
        <div v-if="serverHandle" class="server-handle-card">
          <label class="form-label">{{ $t('server.federationHandle', 'Server handle') }}</label>
          <div class="form-hint">
            {{ $t('server.federationHandleDesc', 'Share this handle so people on other instances can find and join this server.') }}
          </div>
          <div class="handle-row">
            <code class="handle-value">{{ serverHandle }}</code>
            <button type="button" class="handle-copy-btn" @click="copyHandle">
              {{ copied ? $t('common.copied', 'Copied') : $t('common.copy', 'Copy') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Warning dialog when disabling federation with existing members -->
      <div v-if="showDisableWarning" class="disable-federation-warning-overlay" @click.self="cancelDisableFederation">
        <div class="disable-federation-warning">
          <div class="warning-header">
            <svg class="warning-icon" width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
            </svg>
            <h3>Disable federation?</h3>
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
            <button class="btn-confirm-danger" @click="confirmDisableFederation">Disable federation</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-card">
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
                :disabled="loading || !permissions.canChangePrivacySettings"
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
                :disabled="loading || !permissions.canChangePrivacySettings"
              />
              <label for="public-directory" class="radio-label"></label>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isPublic" class="public-server-info">
        <div class="info-card">
          <div class="info-header">
            <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M11,16.5L18,9.5L16.59,8.09L11,13.67L7.41,10.09L6,11.5L11,16.5Z"/>
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
              <path fill="currentColor" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
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
              <path fill="currentColor" d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/>
            </svg>
            <h4 class="info-title">{{ $t('server.privateServer') }}</h4>
          </div>
          <p class="info-text">
            {{ $t('server.privateServerInfo') }}
          </p>
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

useI18n();
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
const serverHandle = ref('')
const copied = ref(false)

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

// The server's WebFinger handle ({slug}@{instance}) used for federated discovery.
async function fetchServerHandle() {
  serverHandle.value = ''
  if (!props.serverId) return
  const { data, error } = await supabase
    .from('servers')
    .select('slug')
    .eq('id', props.serverId)
    .maybeSingle()

  if (!error && data?.slug) {
    serverHandle.value = `${data.slug}@${window.location.hostname}`
  }
}

async function copyHandle() {
  if (!serverHandle.value) return
  try {
    await navigator.clipboard.writeText(serverHandle.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Clipboard may be unavailable (e.g. insecure context); ignore.
  }
}

onMounted(() => {
  fetchFederatedMemberCount()
  fetchServerHandle()
})

watch(() => props.serverId, () => {
  fetchFederatedMemberCount()
  fetchServerHandle()
})

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
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.permission-notice {
  padding: 16px;
  background-color: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--warning);
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid var(--background-quaternary);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-hint {
  font-size: var(--font-size-xs);
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
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  padding: 16px;
  border-left: 4px solid var(--success);
}

.info-card.private,
.info-card.federation {
  border-left-color: var(--harmony-primary);
}

.federation-info {
  margin-top: 16px;
}

.federated-member-count {
  margin-top: 12px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-radius: var(--radius-base);
  font-size: 13px;
  color: var(--harmony-primary);
}

.server-handle-card {
  margin-top: 16px;
}

.handle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.handle-value {
  flex: 1;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-base);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  color: var(--text-primary);
  user-select: all;
  overflow-x: auto;
  white-space: nowrap;
}

.handle-copy-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 40%, transparent);
  border-radius: var(--radius-base);
  color: var(--harmony-primary);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background 0.15s ease;
}

.handle-copy-btn:hover {
  background: color-mix(in srgb, var(--harmony-primary) 25%, transparent);
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
  background: var(--background-primary);
  border-radius: var(--radius-lg);
  padding: 28px;
  max-width: 480px;
  width: 100%;
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-large);
}

.disable-federation-warning .warning-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.disable-federation-warning .warning-header h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}

.disable-federation-warning .warning-body {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
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
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-cancel:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.btn-confirm-danger {
  padding: 10px 20px;
  background: var(--error);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background 0.2s;
}

.btn-confirm-danger:hover {
  background: var(--error-hover);
}

.warning-card {
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  padding: 16px;
  border-left: 4px solid var(--warning);
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
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.info-icon,
.warning-icon {
  flex-shrink: 0;
}

.info-icon {
  color: var(--success);
}

.info-card.private .info-icon,
.info-card.federation .info-icon {
  color: var(--harmony-primary);
}

.warning-card .warning-icon {
  color: var(--warning);
}

.disable-federation-warning .warning-icon {
  color: var(--error);
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
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  border: 1px solid var(--background-quaternary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.discovery-option:hover {
  background-color: var(--background-quaternary);
}

.option-content {
  flex: 1;
}

.option-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 4px;
}

.option-description {
  font-size: var(--font-size-xs);
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
  border-color: var(--harmony-primary);
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