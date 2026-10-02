<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="wizard-modal">
      <!-- Header -->
      <div class="wizard-header">
        <h2>Set up message encryption</h2>
        <button class="close-btn" @click="$emit('close')" :disabled="isProcessing" aria-label="Close"><Icon name="x" :size="20" /></button>
      </div>

      <!-- Progress Steps -->
      <div class="progress-steps">
        <div 
          v-for="(step, index) in steps" 
          :key="index"
          class="step"
          :class="{ 
            active: currentStep === index, 
            completed: currentStep > index 
          }"
        >
          <div class="step-indicator">
            <Icon v-if="currentStep > index" name="check" :size="14" />
            <span v-else>{{ index + 1 }}</span>
          </div>
          <span class="step-label">{{ step }}</span>
        </div>
      </div>

      <!-- Step Content -->
      <div class="wizard-content">
        <!-- Step 1: Introduction -->
        <div v-if="currentStep === 0" class="step-content">
          <div class="intro-card">
            <div class="intro-icon"><Icon name="shield" :size="40" /></div>
            <h3>End-to-end encryption</h3>
            <p>
              Your messages will be encrypted so only you and your recipients can read them.
              Not even Harmony's servers can access your message content.
            </p>
          </div>

          <div class="feature-grid">
            <div class="feature-card">
              <span class="feature-icon"><Icon name="key" :size="18" /></span>
              <h4>Recovery key</h4>
              <p>A 12-word phrase that protects all your encryption keys</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon"><Icon name="database" :size="18" /></span>
              <h4>Encrypted backup</h4>
              <p>Your keys are backed up to the server, encrypted with your recovery key</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon"><Icon name="smartphone" :size="18" /></span>
              <h4>Multi-device</h4>
              <p>Link a new device by scanning a QR code from this one; your recovery key is the fallback</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon"><Icon name="refresh-cw" :size="18" /></span>
              <h4>Recovery</h4>
              <p>If you clear your cache, just enter your recovery key to restore access</p>
            </div>
          </div>

          <div class="warning-box">
            <span class="warning-icon"><Icon name="alert-triangle" :size="18" /></span>
            <p>
              <strong>Important:</strong> Write down your recovery key and store it safely.
              If you lose it and your devices, you won't be able to read your encrypted messages.
            </p>
          </div>
        </div>

        <!-- Step 2: Generate Recovery Key -->
        <div v-if="currentStep === 1" class="step-content">
          <div class="recovery-key-section">
            <h3>Your recovery key</h3>
            <p class="instruction">
              Write down these 12 words in order. Store them somewhere safe - you'll need them to recover your encryption keys.
            </p>

            <div v-if="isGenerating" class="generating">
              <LoadingSpinner :size="40" />
              <p>Generating your recovery key...</p>
            </div>

            <div v-else-if="recoveryWords.length > 0" class="recovery-words">
              <div 
                v-for="(word, index) in recoveryWords" 
                :key="index"
                class="word-card"
              >
                <span class="word-number">{{ index + 1 }}</span>
                <span class="word">{{ word }}</span>
              </div>
            </div>

            <div class="action-buttons">
              <button
                class="btn btn-secondary"
                @click="copyRecoveryKey"
                :disabled="recoveryWords.length === 0"
              >
                Copy
              </button>
              <button
                class="btn btn-secondary"
                @click="downloadRecoveryKey"
                :disabled="recoveryWords.length === 0"
              >
                Download
              </button>
            </div>

            <button
              type="button"
              class="qr-toggle"
              :aria-expanded="showQRCode"
              :disabled="recoveryWords.length === 0"
              @click="toggleQRCode"
            >
              <Icon :name="showQRCode ? 'chevron-down' : 'chevron-right'" :size="14" />
              {{ showQRCode ? 'Hide the recovery key QR code' : 'Show the recovery key as a QR code' }}
            </button>

            <div v-if="showQRCode && qrCodeDataUrl" class="qr-code-panel">
              <img :src="qrCodeDataUrl" alt="Recovery key QR code" class="qr-code-image" />
              <p class="hint">
                Anyone who sees this code can read your encrypted messages; don't screenshot it.
                To set up another device, link it instead: sign in there and scan the code it
                shows from this device.
              </p>
            </div>

            <div class="verification-code" v-if="verificationCode">
              <p>Verification code: <strong>{{ verificationCode }}</strong></p>
              <p class="hint">Save this code to verify you have the correct phrase later</p>
            </div>
          </div>
        </div>

        <!-- Step 3: Verify Recovery Key -->
        <div v-if="currentStep === 2" class="step-content">
          <div class="verify-section">
            <h3>Verify your recovery key</h3>
            <p class="instruction">
              To make sure you've saved your recovery key correctly, please enter the words at these positions:
            </p>

            <div class="verification-inputs">
              <div 
                v-for="pos in verifyPositions" 
                :key="pos"
                class="verify-input"
              >
                <label>Word #{{ pos + 1 }}</label>
                <input 
                  type="text" 
                  v-model="verifyInputs[pos]"
                  :placeholder="`Enter word ${pos + 1}`"
                  @input="checkVerification"
                />
                <span 
                  v-if="verifyInputs[pos]"
                  class="verify-status"
                  :class="{ correct: verifyInputs[pos].toLowerCase() === recoveryWords[pos]?.toLowerCase() }"
                >
                  <Icon :name="verifyInputs[pos].toLowerCase() === recoveryWords[pos]?.toLowerCase() ? 'check' : 'x'" :size="16" />
                </span>
              </div>
            </div>

            <div v-if="verificationError" class="error-message">
              {{ verificationError }}
            </div>
          </div>
        </div>

        <!-- Step 4: Complete -->
        <div v-if="currentStep === 3" class="step-content">
          <div class="complete-section">
            <div class="success-icon"><Icon name="check-circle" :size="40" /></div>
            <h3>Encryption is set up</h3>
            <p>
              Your end-to-end encryption is now active. Your messages will be encrypted
              and backed up securely to the server.
            </p>

            <div class="summary-card">
              <h4>What's set up</h4>
              <ul>
                <li>Recovery key generated and verified</li>
                <li>Encryption keys created</li>
                <li>Encrypted backup stored on the server</li>
                <li>Ready to send encrypted messages</li>
              </ul>
            </div>

            <div class="reminder-box">
              <span class="reminder-icon"><Icon name="smartphone" :size="16" /></span>
              <p>
                <strong>New device?</strong> Sign in there and choose <em>Another device</em>,
                then scan its code from this device. Your messages unlock without typing the
                recovery key.
              </p>
            </div>

            <div class="reminder-box">
              <span class="reminder-icon"><Icon name="pin" :size="16" /></span>
              <p>
                <strong>Remember:</strong> Keep your 12-word recovery key safe.
                You'll need it if you lose access to all your signed-in devices or clear your browser data.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer Navigation -->
      <div class="wizard-footer">
        <button 
          v-if="currentStep > 0 && currentStep < 3"
          class="btn btn-secondary"
          @click="previousStep"
          :disabled="isProcessing"
        >
          ← Back
        </button>
        <div class="spacer"></div>
        <button 
          v-if="currentStep < 3"
          class="btn btn-primary"
          @click="nextStep"
          :disabled="!canProceed || isProcessing"
        >
          <span v-if="isProcessing">
            <span class="btn-spinner"></span>
            Processing...
          </span>
          <span v-else>
            {{ currentStep === 2 ? 'Complete setup' : 'Continue' }} →
          </span>
        </button>
        <button 
          v-if="currentStep === 3"
          class="btn btn-primary"
          @click="$emit('complete')"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { ref, computed, onMounted } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'

const toast = useToast()
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits(['close', 'complete'])

// Wizard state
const currentStep = ref(0)
const isProcessing = ref(false)
const isGenerating = ref(false)

// Recovery key state
const recoveryWords = ref<string[]>([])
const verificationCode = ref('')

// QR code display (same payload format KeyRecoveryModal's parseQRData reads)
const showQRCode = ref(false)
const qrCodeDataUrl = ref('')

const toggleQRCode = async () => {
  if (showQRCode.value) {
    showQRCode.value = false
    return
  }
  if (!qrCodeDataUrl.value) {
    try {
      const QRCode = (await import('qrcode')).default
      const payload = btoa(JSON.stringify({ v: 1, m: recoveryWords.value.join(' '), t: Date.now() }))
      qrCodeDataUrl.value = await QRCode.toDataURL(payload, { width: 220, margin: 1 })
    } catch (err) {
      debug.error('Failed to generate recovery QR code:', err)
      toast.error('Could not generate QR code')
      return
    }
  }
  showQRCode.value = true
}

// Verification state
const verifyPositions = ref<number[]>([])
const verifyInputs = ref<Record<number, string>>({})
const verificationError = ref('')
const isVerified = ref(false)

// Steps
const steps = ['Introduction', 'Recovery Key', 'Verify', 'Complete']

// Can proceed to next step?
const canProceed = computed(() => {
  switch (currentStep.value) {
    case 0:
      return true
    case 1:
      return recoveryWords.value.length === 12
    case 2:
      return isVerified.value
    default:
      return true
  }
})

function generateVerifyPositions() {
  const positions: number[] = []
  while (positions.length < 3) {
    const pos = Math.floor(Math.random() * 12)
    if (!positions.includes(pos)) {
      positions.push(pos)
    }
  }
  verifyPositions.value = positions.sort((a, b) => a - b)
}

function checkVerification() {
  verificationError.value = ''
  
  let allCorrect = true
  for (const pos of verifyPositions.value) {
    const input = verifyInputs.value[pos]?.toLowerCase().trim()
    const expected = recoveryWords.value[pos]?.toLowerCase()
    if (!input || input !== expected) {
      allCorrect = false
    }
  }
  
  isVerified.value = allCorrect
}

// Copy recovery key to clipboard
async function copyRecoveryKey() {
  try {
    const text = recoveryWords.value.join(' ')
    await navigator.clipboard.writeText(text)
    toast.success('Recovery key copied')
  } catch (error) {
    toast.error('Failed to copy to clipboard')
  }
}

// Download recovery key as file
function downloadRecoveryKey() {
  const text = `Harmony Recovery Key
====================
Generated: ${new Date().toISOString()}

Your 12-word recovery phrase:
${recoveryWords.value.map((word, i) => `${i + 1}. ${word}`).join('\n')}

Verification Code: ${verificationCode.value}

IMPORTANT: Keep this file safe and private.
Anyone with these words can access your encrypted messages.
`
  
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `harmony-recovery-key-${new Date().toISOString().split('T')[0]}.txt`
  a.click()
  URL.revokeObjectURL(url)
  
  toast.success('Recovery key downloaded')
}

// Navigate steps
async function nextStep() {
  if (!canProceed.value) return

  if (currentStep.value === 0) {
    currentStep.value = 1
    await generateRecoveryKey()
    generateVerifyPositions()
  } else if (currentStep.value === 1) {
    currentStep.value = 2
  } else if (currentStep.value === 2) {
    // Final step - complete setup
    await completeSetup()
  }
}

function previousStep() {
  if (currentStep.value > 0) {
    currentStep.value--
  }
}

async function generateRecoveryKey() {
  isGenerating.value = true
  
  try {
    const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
    
    recoveryWords.value = await recoveryKeyService.generateMnemonic(12)
    
    // Derive keys to get verification code
    await recoveryKeyService.deriveKeysFromMnemonic(recoveryWords.value)
    verificationCode.value = await recoveryKeyService.generateVerificationCode()
    
    debug.log('Recovery key generated')
  } catch (error: any) {
    debug.error('Failed to generate recovery key:', error)
    toast.error('Failed to generate recovery key')
  } finally {
    isGenerating.value = false
  }
}

// Complete the setup
async function completeSetup() {
  if (!isVerified.value) {
    verificationError.value = 'Please verify all words correctly'
    return
  }

  isProcessing.value = true

  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    
    const { supabase } = await import('@/supabase')
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      throw new Error('Not logged in')
    }

    await megolmMessageEncryptionService.initialize(user.id)

    // Complete setup with the words we've already generated
    // This does everything: initializes Megolm, creates identity key, registers metadata, creates backup
    await megolmMessageEncryptionService.completeSetupWithWords(recoveryWords.value)

    currentStep.value = 3
    toast.success('Encryption is set up')
  } catch (error: any) {
    debug.error('Failed to complete setup:', error)
    toast.error(error.message || 'Failed to complete setup')
  } finally {
    isProcessing.value = false
  }
}

onMounted(() => {
  // Nothing to initialize on mount
})
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

.wizard-modal {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  max-width: 700px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-modal);
}

.wizard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}

.wizard-header h2 {
  margin: 0;
  font-size: var(--font-size-2xl);
  color: var(--text-primary);
}

.close-btn {
  display: inline-flex;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary);
}

/* Progress Steps */
.progress-steps {
  display: flex;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid var(--border-color);
}

.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  opacity: 0.5;
  transition: opacity 0.3s;
}

.step.active,
.step.completed {
  opacity: 1;
}

.step-indicator {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: 2px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.step.active .step-indicator {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.step.completed .step-indicator {
  background: var(--success);
  border-color: var(--success);
  color: var(--text-on-primary);
}

.step-label {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.step.active .step-label {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

/* Wizard Content */
.wizard-content {
  padding: 32px;
  min-height: 400px;
}

@media (prefers-reduced-motion: no-preference) {
  .step-content {
    animation: fadeIn 0.3s ease;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Intro Card */
.intro-card {
  text-align: center;
  padding: 32px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  margin-bottom: 24px;
}

.intro-icon {
  font-size: 48px;
  margin-bottom: 16px;
  color: var(--harmony-primary);
}

.intro-card h3 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.intro-card p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.6;
}

/* Feature Grid */
.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.feature-card {
  padding: 20px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  text-align: center;
}

.feature-icon {
  font-size: 28px;
  display: block;
  margin-bottom: 12px;
}

.feature-card h4 {
  margin: 0 0 8px 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.feature-card p {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}

/* Warning Box */
.warning-box {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
}

.warning-icon {
  font-size: var(--font-size-2xl);
  flex-shrink: 0;
  color: var(--warning);
}

.warning-box p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  line-height: 1.5;
}

/* Recovery Key Section */
.recovery-key-section {
  text-align: center;
}

.recovery-key-section h3 {
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.instruction {
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.generating {
  padding: 40px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Recovery Words Grid */
.recovery-words {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.word-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  min-width: 0;
}

.qr-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.qr-toggle:hover:not(:disabled) {
  color: var(--text-primary);
}

.qr-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qr-code-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
}

.qr-code-image {
  width: 220px;
  height: 220px;
  border-radius: var(--radius-md);
  background: #fff;
  padding: 8px;
}

.qr-code-panel .hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-align: center;
  max-width: 320px;
}

.word-number {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  min-width: 20px;
}

.word {
  font-family: 'JetBrains Mono', monospace;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

/* Action Buttons */
.action-buttons {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 24px;
}

/* Verification Code */
.verification-code {
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.verification-code p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.verification-code .hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin-top: 4px;
}

/* Verify Section */
.verify-section {
  text-align: center;
}

.verification-inputs {
  display: flex;
  justify-content: center;
  gap: 20px;
  margin: 32px 0;
}

.verify-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
}

.verify-input label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.verify-input input {
  padding: 12px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: var(--font-size-sm);
  width: 150px;
}

.verify-input input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.verify-status {
  position: absolute;
  right: 12px;
  top: 50%;
  display: inline-flex;
  font-size: var(--font-size-lg);
  color: var(--error);
}

.verify-status.correct {
  color: var(--success);
}

.error-message {
  color: var(--error);
  font-size: var(--font-size-sm);
  margin-top: 16px;
}

/* Complete Section */
.complete-section {
  text-align: center;
}

.success-icon {
  font-size: 64px;
  margin-bottom: 16px;
  color: var(--success);
}

.complete-section h3 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
  font-size: var(--font-size-2xl);
}

.complete-section > p {
  color: var(--text-secondary);
  margin-bottom: 32px;
  line-height: 1.6;
}

.summary-card {
  padding: 24px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  text-align: left;
  margin-bottom: 24px;
}

.summary-card h4 {
  margin: 0 0 16px 0;
  color: var(--text-primary);
}

.summary-card ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.summary-card li {
  padding: 8px 0;
  color: var(--success);
  font-size: var(--font-size-sm);
}

.reminder-box {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
  border-radius: var(--radius-md);
  text-align: left;
}

.reminder-icon {
  font-size: var(--font-size-2xl);
  flex-shrink: 0;
}

.reminder-box + .reminder-box {
  margin-top: 12px;
}

.reminder-box p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  line-height: 1.5;
}

/* Footer */
.wizard-footer {
  display: flex;
  align-items: center;
  padding: 20px 24px;
  border-top: 1px solid var(--border-color);
}

.spacer {
  flex: 1;
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

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* Responsive */
@media (max-width: 600px) {
  .wizard-modal {
    max-height: 100vh;
    border-radius: 0;
  }

  /* 2-up on phones: 3 columns of mono words overflow narrow viewports */
  .recovery-words {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }

  .word-card {
    padding: 10px 12px;
  }

  .word {
    overflow-wrap: anywhere;
  }

  .feature-grid {
    grid-template-columns: 1fr;
  }

  .verification-inputs {
    flex-direction: column;
    align-items: center;
  }

  .progress-steps {
    padding: 16px;
    overflow-x: auto;
  }

  .step-label {
    display: none;
  }
}
</style>

