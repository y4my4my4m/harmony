<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="wizard-modal">
      <!-- Header -->
      <div class="wizard-header">
        <h2>🔐 Set Up Message Encryption</h2>
        <button class="close-btn" @click="$emit('close')" :disabled="isProcessing">×</button>
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
            <span v-if="currentStep > index">✓</span>
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
            <div class="intro-icon">🛡️</div>
            <h3>End-to-End Encryption</h3>
            <p>
              Your messages will be encrypted so only you and your recipients can read them.
              Not even Harmony's servers can access your message content.
            </p>
          </div>

          <div class="feature-grid">
            <div class="feature-card">
              <span class="feature-icon">🔑</span>
              <h4>Recovery Key</h4>
              <p>A 12-word phrase that protects all your encryption keys</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon">☁️</span>
              <h4>Encrypted Backup</h4>
              <p>Your keys are backed up to the server, encrypted with your recovery key</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon">📱</span>
              <h4>Multi-Device</h4>
              <p>Use your recovery key to access messages on any device</p>
            </div>
            <div class="feature-card">
              <span class="feature-icon">🔄</span>
              <h4>Recovery</h4>
              <p>If you clear your cache, just enter your recovery key to restore access</p>
            </div>
          </div>

          <div class="warning-box">
            <span class="warning-icon">⚠️</span>
            <p>
              <strong>Important:</strong> Write down your recovery key and store it safely.
              If you lose it and your devices, you won't be able to read your encrypted messages.
            </p>
          </div>
        </div>

        <!-- Step 2: Generate Recovery Key -->
        <div v-if="currentStep === 1" class="step-content">
          <div class="recovery-key-section">
            <h3>📝 Your Recovery Key</h3>
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
                📋 Copy to Clipboard
              </button>
              <button
                class="btn btn-secondary"
                @click="downloadRecoveryKey"
                :disabled="recoveryWords.length === 0"
              >
                💾 Download as File
              </button>
              <button
                class="btn btn-secondary"
                @click="toggleQRCode"
                :disabled="recoveryWords.length === 0"
              >
                {{ showQRCode ? '🙈 Hide QR Code' : '🔳 Show QR Code' }}
              </button>
            </div>

            <div v-if="showQRCode && qrCodeDataUrl" class="qr-code-panel">
              <img :src="qrCodeDataUrl" alt="Recovery key QR code" class="qr-code-image" />
              <p class="hint">
                Scan this from another device's recovery screen. Anyone who sees
                this code can read your encrypted messages - don't screenshot it.
              </p>
            </div>

            <div class="verification-code" v-if="verificationCode">
              <p>Verification Code: <strong>{{ verificationCode }}</strong></p>
              <p class="hint">Save this code to verify you have the correct phrase later</p>
            </div>
          </div>
        </div>

        <!-- Step 3: Verify Recovery Key -->
        <div v-if="currentStep === 2" class="step-content">
          <div class="verify-section">
            <h3>✅ Verify Your Recovery Key</h3>
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
                  {{ verifyInputs[pos].toLowerCase() === recoveryWords[pos]?.toLowerCase() ? '✓' : '✗' }}
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
            <div class="success-icon">🎉</div>
            <h3>Encryption Setup Complete!</h3>
            <p>
              Your end-to-end encryption is now active. Your messages will be encrypted
              and backed up securely to the server.
            </p>

            <div class="summary-card">
              <h4>What's Set Up:</h4>
              <ul>
                <li>✅ Recovery key generated and verified</li>
                <li>✅ Encryption keys created</li>
                <li>✅ Encrypted backup stored on server</li>
                <li>✅ Ready to send encrypted messages</li>
              </ul>
            </div>

            <div class="reminder-box">
              <span class="reminder-icon">📌</span>
              <p>
                <strong>Remember:</strong> Keep your 12-word recovery key safe.
                You'll need it to restore access on new devices or after clearing your browser data.
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
            {{ currentStep === 2 ? 'Complete Setup' : 'Continue' }} →
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

// Generate random verification positions (3 random words to verify)
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

// Check if verification inputs are correct
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
    toast.success('Recovery key copied to clipboard')
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

⚠️ IMPORTANT: Keep this file safe and private!
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

  // Generate recovery key on step 1
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

// Generate the recovery key
async function generateRecoveryKey() {
  isGenerating.value = true
  
  try {
    // Import the recovery key service
    const { recoveryKeyService } = await import('@/services/encryption/RecoveryKeyService')
    
    // Generate 12-word mnemonic (async: real BIP39 SHA-256 checksum)
    recoveryWords.value = await recoveryKeyService.generateMnemonic(12)
    
    // Derive keys to get verification code
    await recoveryKeyService.deriveKeysFromMnemonic(recoveryWords.value)
    verificationCode.value = await recoveryKeyService.generateVerificationCode()
    
    debug.log('✅ Recovery key generated')
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
    // Import the encryption service
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    
    // Get current user
    const { supabase } = await import('@/supabase')
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      throw new Error('Not logged in')
    }

    // Initialize the main service (converts auth_user_id to profile_id)
    await megolmMessageEncryptionService.initialize(user.id)

    // Complete setup with the words we've already generated
    // This does everything: initializes Megolm, creates identity key, registers metadata, creates backup
    await megolmMessageEncryptionService.completeSetupWithWords(recoveryWords.value)

    currentStep.value = 3
    toast.success('Encryption setup complete!')
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
  background: var(--bg-primary, #1a1a2e);
  border-radius: 16px;
  border: 1px solid var(--border-color, #333);
  max-width: 700px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.wizard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px;
  border-bottom: 1px solid var(--border-color, #333);
}

.wizard-header h2 {
  margin: 0;
  font-size: 24px;
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

/* Progress Steps */
.progress-steps {
  display: flex;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid var(--border-color, #333);
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
  background: var(--bg-secondary, #2a2a3e);
  border: 2px solid var(--border-color, #444);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: var(--text-secondary, #888);
}

.step.active .step-indicator {
  background: var(--primary, #0EA5E9);
  border-color: var(--primary, #0EA5E9);
  color: var(--text-primary);
}

.step.completed .step-indicator {
  background: var(--success, #27ae60);
  border-color: var(--success, #27ae60);
  color: var(--text-primary);
}

.step-label {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.step.active .step-label {
  color: var(--text-primary, #fff);
  font-weight: 500;
}

/* Wizard Content */
.wizard-content {
  padding: 32px;
  min-height: 400px;
}

.step-content {
  animation: fadeIn 0.3s ease;
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
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.1) 0%, rgba(14, 165, 233, 0.05) 100%);
  border-radius: 12px;
  margin-bottom: 24px;
}

.intro-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.intro-card h3 {
  margin: 0 0 12px 0;
  color: var(--text-primary, #fff);
}

.intro-card p {
  margin: 0;
  color: var(--text-secondary, #888);
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
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 12px;
  text-align: center;
}

.feature-icon {
  font-size: 28px;
  display: block;
  margin-bottom: 12px;
}

.feature-card h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: var(--text-primary, #fff);
}

.feature-card p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary, #888);
  line-height: 1.5;
}

/* Warning Box */
.warning-box {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: rgba(241, 196, 15, 0.1);
  border: 1px solid rgba(241, 196, 15, 0.3);
  border-radius: 8px;
}

.warning-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.warning-box p {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary, #fff);
  line-height: 1.5;
}

/* Recovery Key Section */
.recovery-key-section {
  text-align: center;
}

.recovery-key-section h3 {
  margin: 0 0 8px 0;
  color: var(--text-primary, #fff);
}

.instruction {
  color: var(--text-secondary, #888);
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
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 8px;
  border: 1px solid var(--border-color, #444);
  min-width: 0;
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
  border-radius: 8px;
  background: #fff;
  padding: 8px;
}

.qr-code-panel .hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  text-align: center;
  max-width: 320px;
}

.word-number {
  font-size: 12px;
  color: var(--text-secondary, #888);
  min-width: 20px;
}

.word {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  color: var(--text-primary, #fff);
  font-weight: 500;
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
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 8px;
}

.verification-code p {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary, #fff);
}

.verification-code .hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
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
  font-size: 14px;
  color: var(--text-secondary, #888);
}

.verify-input input {
  padding: 12px 16px;
  background: var(--bg-secondary, #2a2a3e);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px;
  color: var(--text-primary, #fff);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  width: 150px;
}

.verify-input input:focus {
  outline: none;
  border-color: var(--primary, #0EA5E9);
}

.verify-status {
  position: absolute;
  right: 12px;
  top: 50%;
  font-size: 18px;
  color: var(--danger, #e74c3c);
}

.verify-status.correct {
  color: var(--success, #27ae60);
}

.error-message {
  color: var(--danger, #e74c3c);
  font-size: 14px;
  margin-top: 16px;
}

/* Complete Section */
.complete-section {
  text-align: center;
}

.success-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.complete-section h3 {
  margin: 0 0 12px 0;
  color: var(--text-primary, #fff);
  font-size: 24px;
}

.complete-section > p {
  color: var(--text-secondary, #888);
  margin-bottom: 32px;
  line-height: 1.6;
}

.summary-card {
  padding: 24px;
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 12px;
  text-align: left;
  margin-bottom: 24px;
}

.summary-card h4 {
  margin: 0 0 16px 0;
  color: var(--text-primary, #fff);
}

.summary-card ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.summary-card li {
  padding: 8px 0;
  color: var(--success, #27ae60);
  font-size: 14px;
}

.reminder-box {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: rgba(14, 165, 233, 0.1);
  border: 1px solid rgba(14, 165, 233, 0.3);
  border-radius: 8px;
  text-align: left;
}

.reminder-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.reminder-box p {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary, #fff);
  line-height: 1.5;
}

/* Footer */
.wizard-footer {
  display: flex;
  align-items: center;
  padding: 20px 24px;
  border-top: 1px solid var(--border-color, #333);
}

.spacer {
  flex: 1;
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
  background: var(--primary, #0EA5E9);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, #0284C7);
}

.btn-secondary {
  background: var(--bg-secondary, #2a2a3e);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-tertiary, #3a3a4e);
}

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-primary);
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

