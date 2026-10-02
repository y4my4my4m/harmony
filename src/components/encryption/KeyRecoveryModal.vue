<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="recovery-modal">
      <div class="modal-header">
        <h2 class="modal-title">
          <span class="title-icon"><Icon name="key" :size="20" /></span>
          Restore encryption
        </h2>
        <button class="close-btn" @click="$emit('close')" :disabled="isRestoring" aria-label="Close">
          <Icon name="x" :size="18" />
        </button>
      </div>

      <div class="modal-content">
        <!-- Tab Selection -->
        <div class="recovery-tabs" role="tablist">
          <button
            class="tab-btn"
            role="tab"
            :aria-selected="activeTab === 'device'"
            :class="{ active: activeTab === 'device' }"
            data-testid="recovery-tab-device"
            @click="activeTab = 'device'"
          >
            <Icon name="smartphone" :size="16" class="tab-icon" />
            {{ $t('encryption.recovery.anotherDevice') }}
            <span class="tab-badge">{{ $t('encryption.recovery.recommended') }}</span>
          </button>
          <button
            class="tab-btn"
            role="tab"
            :aria-selected="activeTab === 'phrase'"
            :class="{ active: activeTab === 'phrase' }"
            data-testid="recovery-tab-phrase"
            @click="activeTab = 'phrase'"
          >
            <Icon name="file" :size="16" class="tab-icon" />
            Recovery phrase
          </button>
        </div>

        <!-- Another device: QR pairing -->
        <div v-if="activeTab === 'device'" class="tab-content">
          <DevicePairingPanel @restored="emit('restored')" />
        </div>

        <!-- Recovery Phrase Tab -->
        <div v-if="activeTab === 'phrase'" class="tab-content">
          <p class="description">
            Enter your 12-word recovery phrase to restore access to your encrypted messages.
          </p>

          <div class="phrase-input-wrap" :class="{ valid: isValid }">
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
          </div>

          <div class="quick-actions">
            <button 
              class="btn btn-secondary btn-sm"
              @click="pasteFromClipboard"
            >
              Paste
            </button>
            <button 
              class="btn btn-secondary btn-sm"
              @click="clearWords"
            >
              Clear
            </button>
          </div>

          <div v-if="validationMessage" class="validation-message" :class="{ error: !isValid }">
            {{ validationMessage }}
          </div>

          <div class="recovery-qr">
            <button
              type="button"
              class="recovery-qr-toggle"
              :aria-expanded="showRecoveryQrScanner"
              @click="showRecoveryQrScanner = !showRecoveryQrScanner"
            >
              <Icon :name="showRecoveryQrScanner ? 'chevron-down' : 'chevron-right'" :size="14" />
              {{ $t('encryption.recovery.qrToggle') }}
            </button>
            <div v-if="showRecoveryQrScanner" class="recovery-qr-body">
              <QrScanner
                :hint="$t('encryption.recovery.qrHint')"
                :paste-label="$t('encryption.recovery.qrPasteLabel')"
                @decoded="onRecoveryQr"
              />
            </div>
          </div>
        </div>

        <!-- Verification Code (Optional) -->
        <div v-if="activeTab === 'phrase' && recoveryWords.every(w => w)" class="verification-section">
          <label>Verification code (optional)</label>
          <input 
            type="text"
            v-model="verificationCode"
            placeholder="6-character code"
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
          v-if="activeTab === 'phrase'"
          class="btn btn-primary"
          @click="restoreEncryption"
          :disabled="!canRestore || isRestoring"
        >
          <span v-if="isRestoring">
            <span class="btn-spinner"></span>
            Restoring...
          </span>
          <span v-else>
            Restore encryption
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import DevicePairingPanel from './DevicePairingPanel.vue'
import QrScanner from './QrScanner.vue'

const props = withDefaults(defineProps<{ initialTab?: 'device' | 'phrase' }>(), { initialTab: 'device' })

const toast = useToast()
const { t } = useI18n()
const emit = defineEmits(['close', 'restored'])

// State
const activeTab = ref<'device' | 'phrase'>(props.initialTab)
const recoveryWords = ref<string[]>(Array(12).fill(''))
const verificationCode = ref('')
const isRestoring = ref(false)
const showRecoveryQrScanner = ref(false)
const validationMessage = ref('')
const isValid = ref(false)

// Can restore?
const canRestore = computed(() => {
  return recoveryWords.value.every(w => w.trim().length > 0) && isValid.value
})

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
      validationMessage.value = 'Valid recovery phrase'
      isValid.value = true
    } else {
      validationMessage.value = 'Invalid recovery phrase. Check for typos.'
      isValid.value = false
    }
  } catch {
    validationMessage.value = 'Validation failed'
    isValid.value = false
  }
}

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

function clearWords() {
  recoveryWords.value = Array(12).fill('')
  validationMessage.value = ''
  isValid.value = false
}

// Recovery-key QR: base64 JSON {v, m, t} from RecoveryKeySetupWizard.
async function onRecoveryQr(text: string) {
  try {
    const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
    const words = recoveryKeyService.parseQRData(text)
    if (words) {
      recoveryWords.value = words
      showRecoveryQrScanner.value = false
      await validateWords()
      toast.success('QR code read')
    } else if (text.startsWith('HMP:')) {
      toast.error(t('encryption.recovery.pairingCodeScanned'))
    } else {
      toast.error(t('encryption.recovery.notRecoveryKey'))
    }
  } catch {
    toast.error(t('encryption.recovery.qrReadFailed'))
  }
}

// Restore encryption
async function restoreEncryption() {
  if (!canRestore.value) return

  isRestoring.value = true

  try {
    const words = recoveryWords.value.map(w => w.trim().toLowerCase())
    
    if (verificationCode.value) {
      const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
      const isCorrect = await recoveryKeyService.verifyRecoveryPhrase(words, verificationCode.value)
      
      if (!isCorrect) {
        toast.error('Verification code does not match')
        isRestoring.value = false
        return
      }
    }

    const { supabase } = await import('@/supabase')
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      throw new Error('Not logged in')
    }

    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    
    await megolmMessageEncryptionService.initialize(user.id)
    await megolmMessageEncryptionService.initializeWithRecoveryKey(words)

    // Toast is shown by the parent (EncryptionSettings.handleRecoveryComplete).
    emit('restored')
  } catch (error: any) {
    debug.error('Failed to restore encryption:', error)
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
  z-index: 1000;
  padding: 20px;
}

.recovery-modal {
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  max-width: 560px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-modal);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.title-icon {
  font-size: 22px;
  line-height: 1;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  transition: color 0.2s, background 0.2s;
}

.close-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.close-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Tabs */
.recovery-tabs {
  display: flex;
  padding: 16px 24px 0;
  gap: 8px;
}

.tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  transition: all 0.2s ease;
}

.tab-btn .tab-icon {
  flex-shrink: 0;
}

.tab-badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}

.tab-btn.active .tab-badge {
  background: color-mix(in srgb, #fff 22%, transparent);
  color: inherit;
}

.tab-btn:hover {
  border-color: var(--harmony-primary-alpha, color-mix(in srgb, var(--harmony-primary) 50%, transparent));
  color: var(--text-primary);
}

.tab-btn.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

/* Tab Content */
.modal-content {
  padding: 24px;
}

@media (prefers-reduced-motion: no-preference) {
  .tab-content {
    animation: fadeIn 0.2s ease;
  }
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
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.55;
  margin: 20px 0;
}

/* Phrase Input */
.phrase-input-wrap {
  padding: 18px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  margin-bottom: 16px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.phrase-input-wrap.valid {
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
}

.phrase-input-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px 16px;
  margin-bottom: 14px;
}

.word-input {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.word-input label {
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  padding-left: 2px;
}

.word-input input {
  padding: 8px 12px;
  background: var(--background-senary-alpha);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  text-align: center;
  transition: border-color 0.2s, background 0.2s;
}

.word-input input:hover {
  border-color: var(--border-hover);
}

.word-input input:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
}

/* Quick Actions */
.quick-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.quick-actions .btn-secondary.btn-sm {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.quick-actions .btn-secondary.btn-sm:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

/* Validation Message */
.validation-message {
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
}

.validation-message:not(.error) {
  background: color-mix(in srgb, var(--success) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 25%, transparent);
  color: var(--success);
}

.validation-message.error {
  background: color-mix(in srgb, var(--error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 25%, transparent);
  color: var(--error);
}

/* Recovery-key QR (secondary) */
.recovery-qr {
  margin-top: 18px;
}

.recovery-qr-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.recovery-qr-toggle:hover {
  color: var(--text-primary);
}

.recovery-qr-body {
  margin-top: 10px;
}

.hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin-top: 8px;
}

/* Verification Section */
.verification-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--border-color);
}

.verification-section label {
  display: block;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.verification-section input {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: var(--font-size-base);
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
  border-top: 1px solid var(--border-color);
}

/* Buttons */
.btn {
  padding: 12px 24px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
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
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Responsive */
@media (max-width: 600px) {
  /* 2-up, not 3: three mono inputs overflow narrow viewports */
  .phrase-input-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px 10px;
  }

  .word-input input {
    min-width: 0;
    width: 100%;
  }

  .recovery-tabs {
    flex-direction: column;
  }
}
</style>

