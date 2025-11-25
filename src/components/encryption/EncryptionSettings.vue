<template>
  <div class="user-encryption-settings">
    <div v-if="!isInitialized" class="loading-state">
      <div class="spinner"></div>
      <p>Loading encryption status...</p>
    </div>
    
    <div v-else>
      <!-- Encryption Status -->
      <div class="subsection">
        <h4 class="subsection-title">Status</h4>
        <p class="subsection-description">
          Manage your end-to-end encryption preferences
        </p>
        
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
            class="btn btn-primary btn-sm"
          >
            Enable E2EE
          </button>
        </div>
      </div>
      
      <!-- Key Statistics -->
      <div v-if="encryptionStatus.hasKeys" class="subsection">
        <h4 class="subsection-title">Key Management</h4>
        
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
      <div v-if="encryptionStatus.hasKeys" class="subsection">
        <h4 class="subsection-title">Backup & Recovery</h4>
        
        <div class="backup-options">
          <div class="option-card">
            <div class="option-icon">💾</div>
            <div class="option-info">
              <strong>Export Encrypted Backup</strong>
              <p>Download your encryption keys as an encrypted file</p>
            </div>
            <button @click="showBackupExportModal = true" class="btn btn-secondary">Export</button>
          </div>
          
          <div class="option-card">
            <div class="option-icon">🔄</div>
            <div class="option-info">
              <strong>Restore from Backup</strong>
              <p>Import encryption keys from a backup file</p>
            </div>
            <button @click="showBackupImportModal = true" class="btn btn-secondary">Import</button>
          </div>
          
          <div class="option-card warning">
            <div class="option-icon">⚠️</div>
            <div class="option-info">
              <strong>Reset Encryption</strong>
              <p>Delete all keys and start fresh (irreversible)</p>
            </div>
            <button @click="confirmReset = true" class="btn btn-danger">Reset</button>
          </div>
        </div>
      </div>
      
      <!-- Recovery option when encryption is NOT set up -->
      <div v-if="!encryptionStatus.hasKeys" class="subsection">
        <h4 class="subsection-title">Recovery</h4>
        <div class="backup-options">
          <div class="option-card">
            <div class="option-icon">🔄</div>
            <div class="option-info">
              <strong>Restore from Backup</strong>
              <p>Have a backup file? Restore your encryption keys</p>
            </div>
            <button @click="showBackupImportModal = true" class="btn btn-secondary">Import Backup</button>
          </div>
        </div>
      </div>
      
      <!-- Advanced Options -->
      <div v-if="encryptionStatus.hasKeys" class="subsection">
        <h4 class="subsection-title">Advanced</h4>
        
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
            <button @click="confirmReset = false" class="btn btn-secondary">Cancel</button>
            <button @click="handleResetEncryption" class="btn btn-danger">Reset Encryption</button>
          </div>
        </div>
      </div>
    </Teleport>
    
    <!-- Backup Export Modal -->
    <Teleport to="body">
      <div v-if="showBackupExportModal" class="modal-overlay" @click.self="showBackupExportModal = false">
        <div class="modal">
          <h2>💾 Export Encrypted Backup</h2>
          <p>
            Create a password to protect your backup file. This can be different from your main encryption password.
          </p>
          <div class="form-group">
            <label>Backup Password</label>
            <input 
              v-model="backupPassword" 
              type="password" 
              placeholder="Enter a strong password for your backup"
            />
          </div>
          <div class="form-group">
            <label>Confirm Password</label>
            <input 
              v-model="backupPasswordConfirm" 
              type="password" 
              placeholder="Confirm your backup password"
            />
          </div>
          <p class="warning-text" v-if="backupPassword && backupPasswordConfirm && backupPassword !== backupPasswordConfirm">
            Passwords do not match
          </p>
          <div class="modal-actions">
            <button @click="showBackupExportModal = false; backupPassword = ''; backupPasswordConfirm = ''" class="btn-secondary">Cancel</button>
            <button 
              @click="handleExportBackup" 
              :disabled="!backupPassword || backupPassword !== backupPasswordConfirm || isExporting"
              class="btn btn-primary"
            >
              <span v-if="isExporting">Exporting...</span>
              <span v-else>Export Backup</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    
    <!-- Backup Import Modal -->
    <Teleport to="body">
      <div v-if="showBackupImportModal" class="modal-overlay" @click.self="showBackupImportModal = false">
        <div class="modal">
          <h2>🔄 Restore from Backup</h2>
          <p>
            Select your backup file and enter the passwords to restore your encryption keys.
          </p>
          <div class="form-group">
            <label>Backup File</label>
            <input 
              type="file" 
              accept=".harmony-backup,.txt"
              @change="handleBackupFileSelect"
            />
            <p v-if="selectedBackupFile" class="file-selected">
              Selected: {{ selectedBackupFile.name }}
            </p>
          </div>
          <div class="form-group">
            <label>Backup Password</label>
            <input 
              v-model="importBackupPassword" 
              type="password" 
              placeholder="Password used when creating the backup"
            />
          </div>
          <div class="form-group">
            <label>Main Encryption Password</label>
            <input 
              v-model="importMainPassword" 
              type="password" 
              placeholder="Your main encryption password"
            />
            <p class="form-hint">This is the password you use to unlock your encryption</p>
          </div>
          <p v-if="importError" class="warning-text">{{ importError }}</p>
          <div class="modal-actions">
            <button @click="closeImportModal" class="btn-secondary">Cancel</button>
            <button 
              @click="handleImportBackup" 
              :disabled="!selectedBackupFile || !importBackupPassword || !importMainPassword || isImporting"
              class="btn btn-primary"
            >
              <span v-if="isImporting">Restoring...</span>
              <span v-else>Restore Backup</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useToast } from 'vue-toastification'
import KeySetupWizard from './KeySetupWizard.vue'

const toast = useToast()

let encryptionService: any = null
async function getEncryptionService() {
  if (!encryptionService) {
    try {
      const module = await import('@/services/encryption/MessageEncryptionService')
      encryptionService = module.messageEncryptionService
    } catch (error) {
      console.warn('Encryption service unavailable:', error)
      encryptionService = null
    }
  }
  return encryptionService
}

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

// Backup export state
const showBackupExportModal = ref(false)
const backupPassword = ref('')
const backupPasswordConfirm = ref('')
const isExporting = ref(false)

// Backup import state
const showBackupImportModal = ref(false)
const selectedBackupFile = ref<File | null>(null)
const selectedBackupData = ref<string>('')
const importBackupPassword = ref('')
const importMainPassword = ref('')
const isImporting = ref(false)
const importError = ref<string | null>(null)

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
  const service = await getEncryptionService()
  if (!service) {
    toast.error('Encryption service is not available in this environment')
    isInitialized.value = true
    return
  }

  try {
    const status = await service.getEncryptionStatus()
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
  const service = await getEncryptionService()
  if (!service) {
    toast.error('Encryption service is not available')
    return
  }

  isRotating.value = true
  try {
    await service.rotatePrekeys()
    await loadEncryptionStatus()
    toast.success('Pre-keys rotated successfully')
  } catch (error: any) {
    console.error('Failed to rotate keys:', error)
    toast.error(error.message || 'Failed to rotate keys')
  } finally {
    isRotating.value = false
  }
}

async function handleExportBackup() {
  const service = await getEncryptionService()
  if (!service) {
    toast.error('Encryption service is not available')
    return
  }

  isExporting.value = true
  try {
    const encryptedBackup = await service.exportBackup(backupPassword.value)
    
    // Download the backup file
    const blob = new Blob([encryptedBackup], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `harmony-e2ee-backup-${new Date().toISOString().split('T')[0]}.harmony-backup`
    a.click()
    URL.revokeObjectURL(url)
    
    toast.success('Backup exported successfully! Keep this file safe.')
    showBackupExportModal.value = false
    backupPassword.value = ''
    backupPasswordConfirm.value = ''
  } catch (error: any) {
    console.error('Failed to export backup:', error)
    toast.error(error.message || 'Failed to export backup')
  } finally {
    isExporting.value = false
  }
}

function handleBackupFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  
  selectedBackupFile.value = file
  importError.value = null
  
  // Read file content
  const reader = new FileReader()
  reader.onload = (e) => {
    selectedBackupData.value = e.target?.result as string
  }
  reader.onerror = () => {
    importError.value = 'Failed to read backup file'
    selectedBackupFile.value = null
  }
  reader.readAsText(file)
}

async function handleImportBackup() {
  if (!selectedBackupData.value || !importBackupPassword.value || !importMainPassword.value) {
    importError.value = 'Please fill in all fields'
    return
  }

  const service = await getEncryptionService()
  if (!service) {
    toast.error('Encryption service is not available')
    return
  }

  isImporting.value = true
  importError.value = null
  
  try {
    await service.importBackup(selectedBackupData.value, importBackupPassword.value, importMainPassword.value)
    
    toast.success('Backup restored successfully! Your encryption keys have been recovered.')
    closeImportModal()
    await loadEncryptionStatus()
  } catch (error: any) {
    console.error('Failed to import backup:', error)
    importError.value = error.message || 'Failed to restore backup. Check your passwords.'
  } finally {
    isImporting.value = false
  }
}

function closeImportModal() {
  showBackupImportModal.value = false
  selectedBackupFile.value = null
  selectedBackupData.value = ''
  importBackupPassword.value = ''
  importMainPassword.value = ''
  importError.value = null
}

async function handleResetEncryption() {
  const service = await getEncryptionService()
  if (!service) {
    toast.error('Encryption service is not available')
    return
  }

  try {
    // TODO: Implement reset in messageEncryptionService
    await service.cleanup()
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

.subsection {
  margin-bottom: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid var(--h-chat-light);
}

.subsection:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.subsection-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.subsection-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.loading-state {
  text-align: center;
  padding: 48px 0;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--h-chat-light);
  border-top-color: #5865f2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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

.status-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
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

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-group input[type="text"],
.form-group input[type="password"] {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color, #40444b);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
}

.form-group input[type="file"] {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color, #40444b);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}

.form-group input:focus {
  outline: none;
  border-color: var(--primary, #5865f2);
}

.form-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.file-selected {
  font-size: 12px;
  color: var(--success, #27ae60);
  margin-top: 4px;
}
</style>

