<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="recovery-modal">
      <div class="modal-header">
        <h2>🔑 Restore Encryption</h2>
        <button class="close-btn" @click="$emit('close')" :disabled="isRestoring">×</button>
      </div>

      <div class="modal-content">
        <!-- Tab Selection -->
        <div class="recovery-tabs">
          <button 
            class="tab-btn"
            :class="{ active: activeTab === 'phrase' }"
            @click="activeTab = 'phrase'"
          >
            📝 Recovery Phrase
          </button>
          <button 
            class="tab-btn"
            :class="{ active: activeTab === 'qr' }"
            @click="activeTab = 'qr'"
          >
            📱 QR Code
          </button>
        </div>

        <!-- Recovery Phrase Tab -->
        <div v-if="activeTab === 'phrase'" class="tab-content">
          <p class="description">
            Enter your 12-word recovery phrase to restore access to your encrypted messages.
          </p>

          <div class="phrase-input-grid">
            <div 
              v-for="i in 12" 
              :key="i"
              class="word-input"
            >
              <label>{{ i }}</label>
              <input 
                type="text"
                v-model="recoveryWords[i - 1]"
                :placeholder="`Word ${i}`"
                @input="validateWords"
                @paste.prevent="handlePaste($event)"
              />
            </div>
          </div>

          <div class="quick-actions">
            <button 
              class="btn btn-secondary btn-sm"
              @click="pasteFromClipboard"
            >
              📋 Paste from Clipboard
            </button>
            <button 
              class="btn btn-secondary btn-sm"
              @click="clearWords"
            >
              🗑️ Clear
            </button>
          </div>

          <div v-if="validationMessage" class="validation-message" :class="{ error: !isValid }">
            {{ validationMessage }}
          </div>
        </div>

        <!-- QR Code Tab -->
        <div v-if="activeTab === 'qr'" class="tab-content">
          <div class="qr-section">
            <p class="description">
              Scan a QR code from another device to restore your encryption keys.
            </p>

            <div class="qr-scanner-placeholder">
              <div class="scanner-icon">📷</div>
              <p>QR Scanner</p>
              <p class="hint">This feature requires camera access</p>
              <button class="btn btn-secondary" @click="startQRScanner" :disabled="isScanning">
                {{ isScanning ? 'Scanning...' : 'Start Scanner' }}
              </button>
            </div>

            <div class="divider">
              <span>or</span>
            </div>

            <div class="qr-input">
              <label>Paste QR Code Data</label>
              <textarea 
                v-model="qrData"
                placeholder="Paste the QR code data here..."
                rows="3"
              ></textarea>
              <button 
                class="btn btn-secondary btn-sm"
                @click="parseQRData"
                :disabled="!qrData"
              >
                Parse QR Data
              </button>
            </div>
          </div>
        </div>

        <!-- Verification Code (Optional) -->
        <div v-if="activeTab === 'phrase' && recoveryWords.every(w => w)" class="verification-section">
          <label>Verification Code (Optional)</label>
          <input 
            type="text"
            v-model="verificationCode"
            placeholder="Enter verification code to verify"
            maxlength="6"
          />
          <p class="hint">
            If you saved a verification code, enter it here to confirm you have the correct phrase
          </p>
        </div>
      </div>

      <div class="modal-footer">
        <button 
          class="btn btn-secondary"
          @click="$emit('close')"
          :disabled="isRestoring"
        >
          Cancel
        </button>
        <button 
          class="btn btn-primary"
          @click="restoreEncryption"
          :disabled="!canRestore || isRestoring"
        >
          <span v-if="isRestoring">
            <span class="btn-spinner"></span>
            Restoring...
          </span>
          <span v-else>
            Restore Encryption
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useToast } from 'vue-toastification'

const toast = useToast()
const emit = defineEmits(['close', 'restored'])

// State
const activeTab = ref<'phrase' | 'qr'>('phrase')
const recoveryWords = ref<string[]>(Array(12).fill(''))
const qrData = ref('')
const verificationCode = ref('')
const isRestoring = ref(false)
const isScanning = ref(false)
const validationMessage = ref('')
const isValid = ref(false)

// Import validation wordlist from recovery service
let WORDLIST: string[] = []
import('@/services/encryption/RecoveryKeyService').then(module => {
  // The wordlist is embedded in the service
  // We'll validate by trying to derive keys
})

// Can restore?
const canRestore = computed(() => {
  return recoveryWords.value.every(w => w.trim().length > 0) && isValid.value
})

// Validate words
async function validateWords() {
  const words = recoveryWords.value.map(w => w.trim().toLowerCase())
  
  if (!words.every(w => w.length > 0)) {
    validationMessage.value = ''
    isValid.value = false
    return
  }

  try {
    const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
    
    if (recoveryKeyService.validateMnemonic(words)) {
      validationMessage.value = '✓ Valid recovery phrase'
      isValid.value = true
    } else {
      validationMessage.value = '✗ Invalid recovery phrase - check for typos'
      isValid.value = false
    }
  } catch {
    validationMessage.value = '✗ Validation failed'
    isValid.value = false
  }
}

// Handle paste into any input
async function handlePaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')
  if (!text) return

  const words = text.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0)
  
  if (words.length === 12) {
    recoveryWords.value = words
    await validateWords()
    toast.info('Pasted 12-word recovery phrase')
  }
}

// Paste from clipboard button
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    const words = text.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0)
    
    if (words.length === 12) {
      recoveryWords.value = words
      await validateWords()
      toast.success('Recovery phrase pasted')
    } else {
      toast.error(`Expected 12 words, got ${words.length}`)
    }
  } catch {
    toast.error('Failed to read clipboard')
  }
}

// Clear words
function clearWords() {
  recoveryWords.value = Array(12).fill('')
  validationMessage.value = ''
  isValid.value = false
}

// Start QR scanner
function startQRScanner() {
  // This would integrate with a QR scanning library
  toast.info('QR scanning coming soon - please paste your recovery phrase for now')
  isScanning.value = false
}

// Parse QR data
async function parseQRData() {
  if (!qrData.value) return

  try {
    const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
    const words = recoveryKeyService.parseQRData(qrData.value)
    
    if (words) {
      recoveryWords.value = words
      activeTab.value = 'phrase'
      await validateWords()
      toast.success('QR code parsed successfully')
    } else {
      toast.error('Invalid QR code data')
    }
  } catch {
    toast.error('Failed to parse QR code')
  }
}

// Restore encryption
async function restoreEncryption() {
  if (!canRestore.value) return

  isRestoring.value = true

  try {
    const words = recoveryWords.value.map(w => w.trim().toLowerCase())
    
    // Verify with verification code if provided
    if (verificationCode.value) {
      const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
      const isCorrect = await recoveryKeyService.verifyRecoveryPhrase(words, verificationCode.value)
      
      if (!isCorrect) {
        toast.error('Verification code does not match')
        isRestoring.value = false
        return
      }
    }

    // Get current user
    const { supabase } = await import('@/supabase')
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      throw new Error('Not logged in')
    }

    // Initialize the encryption service with recovery key
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    
    await megolmMessageEncryptionService.initialize(user.id)
    await megolmMessageEncryptionService.initializeWithRecoveryKey(words)

    toast.success('Encryption restored successfully!')
    emit('restored')
  } catch (error: any) {
    console.error('Failed to restore encryption:', error)
    toast.error(error.message || 'Failed to restore encryption')
  } finally {
    isRestoring.value = false
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 20px;
}

.recovery-modal {
  background: var(--bg-primary, #1a1a2e);
  border-radius: 16px;
  border: 1px solid var(--border-color, #333);
  max-width: 600px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color, #333);
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
  color: var(--text-primary, #fff);
}

.close-btn {
  background: none;
  border: none;
  font-size: 28px;
  color: var(--text-secondary, #888);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary, #fff);
}

/* Tabs */
.recovery-tabs {
  display: flex;
  padding: 16px 24px 0;
  gap: 8px;
}

.tab-btn {
  flex: 1;
  padding: 12px;
  background: var(--bg-secondary, #2a2a3e);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.tab-btn:hover {
  border-color: var(--primary, #5865f2);
  color: var(--text-primary, #fff);
}

.tab-btn.active {
  background: var(--primary, #5865f2);
  border-color: var(--primary, #5865f2);
  color: #fff;
}

/* Tab Content */
.modal-content {
  padding: 24px;
}

.tab-content {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.description {
  color: var(--text-secondary, #888);
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 20px;
}

/* Phrase Input Grid */
.phrase-input-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.word-input {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.word-input label {
  font-size: 11px;
  color: var(--text-secondary, #888);
  padding-left: 4px;
}

.word-input input {
  padding: 10px 12px;
  background: var(--bg-secondary, #2a2a3e);
  border: 1px solid var(--border-color, #444);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
}

.word-input input:focus {
  outline: none;
  border-color: var(--primary, #5865f2);
}

/* Quick Actions */
.quick-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

/* Validation Message */
.validation-message {
  padding: 12px;
  background: rgba(39, 174, 96, 0.1);
  border: 1px solid rgba(39, 174, 96, 0.3);
  border-radius: 8px;
  color: var(--success, #27ae60);
  font-size: 14px;
}

.validation-message.error {
  background: rgba(231, 76, 60, 0.1);
  border-color: rgba(231, 76, 60, 0.3);
  color: var(--danger, #e74c3c);
}

/* QR Section */
.qr-section {
  text-align: center;
}

.qr-scanner-placeholder {
  padding: 40px;
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 12px;
  border: 2px dashed var(--border-color, #444);
  margin-bottom: 24px;
}

.scanner-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.qr-scanner-placeholder p {
  margin: 0;
  color: var(--text-primary, #fff);
}

.hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-top: 8px;
}

.qr-scanner-placeholder .btn {
  margin-top: 16px;
}

.divider {
  display: flex;
  align-items: center;
  margin: 24px 0;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color, #444);
}

.divider span {
  padding: 0 16px;
  color: var(--text-secondary, #888);
  font-size: 12px;
}

.qr-input {
  text-align: left;
}

.qr-input label {
  display: block;
  font-size: 14px;
  color: var(--text-primary, #fff);
  margin-bottom: 8px;
}

.qr-input textarea {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary, #2a2a3e);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
  color: var(--text-primary, #fff);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  resize: vertical;
  margin-bottom: 8px;
}

.qr-input textarea:focus {
  outline: none;
  border-color: var(--primary, #5865f2);
}

/* Verification Section */
.verification-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--border-color, #333);
}

.verification-section label {
  display: block;
  font-size: 14px;
  color: var(--text-primary, #fff);
  margin-bottom: 8px;
}

.verification-section input {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary, #2a2a3e);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
  color: var(--text-primary, #fff);
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  text-transform: uppercase;
  letter-spacing: 2px;
}

.verification-section .hint {
  margin-top: 8px;
}

/* Footer */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color, #333);
}

/* Buttons */
.btn {
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--primary, #5865f2);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, #4752c4);
}

.btn-secondary {
  background: var(--bg-secondary, #2a2a3e);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-tertiary, #3a3a4e);
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Responsive */
@media (max-width: 600px) {
  .phrase-input-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .recovery-tabs {
    flex-direction: column;
  }
}
</style>

