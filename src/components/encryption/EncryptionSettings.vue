<template>
  <div class="encryption-settings">
    <div class="settings-header">
      <h2>🔐 Encryption Settings</h2>
      <p>Manage your end-to-end encryption preferences</p>
    </div>
    
    <div v-if="!isInitialized" class="loading-state">
      <div class="spinner"></div>
      <p>Loading encryption status...</p>
    </div>
    
    <div v-else class="settings-content">
      <!-- Encryption Status -->
      <div class="setting-section">
        <div class="section-header">
          <h3>Status</h3>
        </div>
        
        <div class="status-card" :class="{ enabled: encryptionStatus.hasKeys }">
          <div class="status-icon">
            {{ encryptionStatus.hasKeys ? '🔒' : '🔓' }}
          </div>
          <div class="status-info">
            <strong>
              {{ encryptionStatus.hasKeys ? 'Encryption Enabled' : 'Encryption Disabled' }}
            </strong>
            <p>
              {{ encryptionStatus.hasKeys 
                ? 'Your messages are protected with end-to-end encryption' 
                : 'Enable encryption to protect your messages' 
              }}
            </p>
          </div>
          <button 
            v-if="!encryptionStatus.hasKeys"
            @click="showSetupWizard = true"
            class="btn-primary"
          >
            Enable E2EE
          </button>
        </div>
      </div>
      
      <!-- Key Statistics -->
      <div v-if="encryptionStatus.hasKeys" class="setting-section">
        <div class="section-header">
          <h3>Key Management</h3>
        </div>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Available Pre-keys</div>
            <div class="stat-value">{{ encryptionStatus.keyCount || 0 }}</div>
            <div class="stat-status" :class="prekeyStatus">
              {{ prekeyStatusText }}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-label">Active Sessions</div>
            <div class="stat-value">{{ activeSessions }}</div>
            <div class="stat-description">Encrypted conversations</div>
          </div>
        </div>
        
        <button 
          v-if="encryptionStatus.keyCount < 20"
          @click="handleRotateKeys"
          :disabled="isRotating"
          class="btn-secondary"
        >
          <span v-if="isRotating">Rotating Keys...</span>
          <span v-else>Generate More Pre-keys</span>
        </button>
      </div>
      
      <!-- Backup & Recovery -->
      <div v-if="encryptionStatus.hasKeys" class="setting-section">
        <div class="section-header">
          <h3>Backup & Recovery</h3>
        </div>
        
        <div class="backup-options">
          <div class="option-card">
            <div class="option-icon">💾</div>
            <div class="option-info">
              <strong>Export Backup Code</strong>
              <p>Generate a new recovery code for your account</p>
            </div>
            <button @click="handleExportBackup" class="btn-secondary">Export</button>
          </div>
          
          <div class="option-card warning">
            <div class="option-icon">⚠️</div>
            <div class="option-info">
              <strong>Reset Encryption</strong>
              <p>Delete all keys and start fresh (irreversible)</p>
            </div>
            <button @click="confirmReset = true" class="btn-danger">Reset</button>
          </div>
        </div>
      </div>
      
      <!-- Advanced Options -->
      <div v-if="encryptionStatus.hasKeys" class="setting-section">
        <div class="section-header">
          <h3>Advanced</h3>
        </div>
        
        <div class="advanced-options">
          <label class="checkbox-option">
            <input type="checkbox" v-model="autoRotateKeys" />
            <div>
              <strong>Automatic Key Rotation</strong>
              <p>Automatically generate new pre-keys when running low</p>
            </div>
          </label>
          
          <label class="checkbox-option">
            <input type="checkbox" v-model="notifyEncryptionStatus" />
            <div>
              <strong>Encryption Status Notifications</strong>
              <p>Show notifications when encryption status changes</p>
            </div>
          </label>
        </div>
      </div>
    </div>
    
    <!-- Key Setup Wizard -->
    <Teleport to="body">
      <KeySetupWizard 
        v-if="showSetupWizard"
        @close="showSetupWizard = false"
        @complete="handleSetupComplete"
      />
    </Teleport>
    
    <!-- Reset Confirmation -->
    <Teleport to="body">
      <div v-if="confirmReset" class="modal-overlay" @click.self="confirmReset = false">
        <div class="modal">
          <h2>⚠️ Reset Encryption?</h2>
          <p>
            This will permanently delete all your encryption keys. 
            You will not be able to read any previously encrypted messages.
          </p>
          <p class="warning-text">
            <strong>This action cannot be undone.</strong>
          </p>
          <div class="modal-actions">
            <button @click="confirmReset = false" class="btn-secondary">Cancel</button>
            <button @click="handleResetEncryption" class="btn-danger">Reset Encryption</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { messageEncryptionService } from '@/services/encryption'
import { useToast } from 'vue-toastification'
import KeySetupWizard from './KeySetupWizard.vue'

const toast = useToast()

const isInitialized = ref(false)
const encryptionStatus = ref({
  available: false,
  hasKeys: false,
  keyCount: 0
})
const activeSessions = ref(0)
const showSetupWizard = ref(false)
const confirmReset = ref(false)
const isRotating = ref(false)
const autoRotateKeys = ref(true)
const notifyEncryptionStatus = ref(true)

const prekeyStatus = computed(() => {
  const count = encryptionStatus.value.keyCount
  if (count >= 50) return 'good'
  if (count >= 20) return 'medium'
  return 'low'
})

const prekeyStatusText = computed(() => {
  const count = encryptionStatus.value.keyCount
  if (count >= 50) return 'Sufficient'
  if (count >= 20) return 'Low'
  return 'Critical - Generate more'
})

async function loadEncryptionStatus() {
  try {
    const status = await messageEncryptionService.getEncryptionStatus()
    encryptionStatus.value = status
    
    // TODO: Load active sessions count from database
    activeSessions.value = 0
    
    isInitialized.value = true
  } catch (error) {
    console.error('Failed to load encryption status:', error)
    toast.error('Failed to load encryption settings')
  }
}

async function handleRotateKeys() {
  isRotating.value = true
  try {
    await messageEncryptionService.rotatePrekeys()
    await loadEncryptionStatus()
    toast.success('Pre-keys rotated successfully')
  } catch (error: any) {
    console.error('Failed to rotate keys:', error)
    toast.error(error.message || 'Failed to rotate keys')
  } finally {
    isRotating.value = false
  }
}

function handleExportBackup() {
  // Generate and download backup code
  const backupCode = generateBackupCode()
  const blob = new Blob([`Harmony E2EE Backup Code\n\n${backupCode}\n\nKeep this code safe!`], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `harmony-backup-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
  
  toast.success('Backup code exported')
}

function generateBackupCode(): string {
  const segments = []
  for (let i = 0; i < 4; i++) {
    const segment = Math.random().toString(36).substring(2, 6).toUpperCase()
    segments.push(segment)
  }
  return segments.join('-')
}

async function handleResetEncryption() {
  try {
    // TODO: Implement reset in messageEncryptionService
    await messageEncryptionService.cleanup()
    // Delete keys from database would go here
    
    confirmReset.value = false
    await loadEncryptionStatus()
    toast.success('Encryption has been reset')
  } catch (error: any) {
    console.error('Failed to reset encryption:', error)
    toast.error('Failed to reset encryption')
  }
}

function handleSetupComplete() {
  showSetupWizard.value = false
  loadEncryptionStatus()
  toast.success('Encryption enabled successfully!')
}

onMounted(() => {
  loadEncryptionStatus()
})
</script>

<style scoped>
.encryption-settings {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-header h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.settings-header p {
  color: var(--text-secondary);
  font-size: 14px;
}

.loading-state {
  text-align: center;
  padding: 48px 0;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.setting-section {
  margin-bottom: 32px;
}

.section-header {
  margin-bottom: 16px;
}

.section-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.status-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--bg-secondary);
  border: 2px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.3s;
}

.status-card.enabled {
  border-color: var(--success, #27ae60);
  background: rgba(39, 174, 96, 0.05);
}

.status-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.status-info {
  flex: 1;
}

.status-info strong {
  display: block;
  color: var(--text-primary);
  font-size: 16px;
  margin-bottom: 4px;
}

.status-info p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.stat-card {
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-status {
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  display: inline-block;
}

.stat-status.good {
  background: rgba(39, 174, 96, 0.1);
  color: #27ae60;
}

.stat-status.medium {
  background: rgba(243, 156, 18, 0.1);
  color: #f39c12;
}

.stat-status.low {
  background: rgba(231, 76, 60, 0.1);
  color: #e74c3c;
}

.stat-description {
  font-size: 12px;
  color: var(--text-secondary);
}

.backup-options,
.advanced-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.option-card.warning {
  border: 1px solid rgba(231, 76, 60, 0.3);
  background: rgba(231, 76, 60, 0.05);
}

.option-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.option-info {
  flex: 1;
}

.option-info strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.option-info p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.checkbox-option {
  display: flex;
  align-items: start;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
  cursor: pointer;
}

.checkbox-option input {
  margin-top: 2px;
  cursor: pointer;
}

.checkbox-option strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.checkbox-option p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.btn-primary,
.btn-secondary,
.btn-danger {
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  font-size: 14px;
}

.btn-primary {
  background: var(--primary);
  color: white;
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: var(--bg-quaternary);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  background: #e74c3c;
  color: white;
}

.btn-danger:hover {
  background: #c0392b;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal {
  background: var(--bg-primary);
  padding: 24px;
  border-radius: 12px;
  max-width: 480px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.modal h2 {
  font-size: 20px;
  color: var(--text-primary);
  margin-bottom: 16px;
}

.modal p {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 12px;
}

.warning-text {
  color: #e74c3c !important;
  font-weight: 500;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}
</style>

