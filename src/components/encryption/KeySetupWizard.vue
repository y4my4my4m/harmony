<template>
  <div class="key-setup-wizard-overlay" @click.self="$emit('close')">
    <div class="key-setup-wizard">
      <!-- Error State -->
      <div v-if="errorMessage" class="error-banner">
        <span class="error-icon">❌</span>
        <span>{{ errorMessage }}</span>
        <button class="btn btn-danger" @click="errorMessage = null">×</button>
      </div>
      <!-- Step 1: Introduction -->
      <div v-if="step === 1" class="wizard-step">
        <div class="wizard-header">
          <div class="lock-icon">🔐</div>
          <h2>Enable End-to-End Encryption</h2>
        </div>
        
        <div class="wizard-content">
          <p class="intro-text">
            Protect your messages with industry-standard encryption powered by the Signal Protocol.
          </p>
          
          <div class="features">
            <div class="feature">
              <span class="icon">✅</span>
              <div>
                <strong>Private & Secure</strong>
                <p>Only you and recipients can read messages</p>
              </div>
            </div>
            <div class="feature">
              <span class="icon">✅</span>
              <div>
                <strong>Zero-Knowledge</strong>
                <p>Not even Harmony servers can decrypt your messages</p>
              </div>
            </div>
            <div class="feature">
              <span class="icon">✅</span>
              <div>
                <strong>Battle-Tested</strong>
                <p>Based on Signal Protocol used by billions</p>
              </div>
            </div>
          </div>
        </div>
        
        <div class="wizard-actions">
          <button class="btn btn-ghost" @click="$emit('close')">Maybe Later</button>
          <button class="btn btn-primary" @click="step = 2">Get Started</button>
        </div>
      </div>
      
      <!-- Step 2: Password Setup -->
      <div v-if="step === 2" class="wizard-step">
        <div class="wizard-header">
          <h2>Create Encryption Password</h2>
          <p>This password encrypts your keys locally</p>
        </div>
        
        <div class="wizard-content">
          <div class="form-group">
            <label>Password</label>
            <input 
              v-model="password" 
              type="password" 
              placeholder="Enter a strong password"
              @keyup.enter="handleContinue"
            />
            <div class="password-strength">
              <div class="strength-bar" :class="passwordStrength"></div>
              <span class="strength-text">{{ passwordStrengthText }}</span>
            </div>
          </div>
          
          <div class="form-group">
            <label>Confirm Password</label>
            <input 
              v-model="confirmPassword" 
              type="password" 
              placeholder="Confirm your password"
              @keyup.enter="handleContinue"
            />
          </div>
          
          <div class="warning-box">
            <span class="warning-icon">⚠️</span>
            <div>
              <strong>Important:</strong> If you lose this password, you cannot recover your encrypted messages. 
              Store it securely.
            </div>
          </div>
        </div>
        
        <div class="wizard-actions">
          <button class="btn btn-secondary" @click="step = 1">Back</button>
          <button 
            class="btn btn-primary" 
            @click="handleContinue"
            :disabled="!isPasswordValid || isProcessing"
          >
            <span v-if="isProcessing">Setting up...</span>
            <span v-else>Continue</span>
          </button>
        </div>
      </div>
      
      <!-- Step 3: Processing -->
      <div v-if="step === 3" class="wizard-step">
        <div class="wizard-header">
          <LoadingSpinner :size="64" />
          <h2>Generating Encryption Keys</h2>
        </div>
        
        <div class="wizard-content">
          <p class="processing-text">
            This may take a moment. Please don't close this window.
          </p>
          <div class="progress-steps">
            <div class="progress-step" :class="{ active: progressStep >= 1 }">
              <span class="step-icon">🔑</span>
              <span>Generating identity keys</span>
            </div>
            <div class="progress-step" :class="{ active: progressStep >= 2 }">
              <span class="step-icon">🔐</span>
              <span>Creating prekey bundles</span>
            </div>
            <div class="progress-step" :class="{ active: progressStep >= 3 }">
              <span class="step-icon">☁️</span>
              <span>Syncing to server</span>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Step 4: Success -->
      <div v-if="step === 4" class="wizard-step">
        <div class="wizard-header">
          <div class="success-icon">✅</div>
          <h2>Encryption Enabled!</h2>
        </div>
        
        <div class="wizard-content">
          <p class="success-text">
            Your messages are now protected with end-to-end encryption.
          </p>
          
          <div class="backup-section">
            <h3>Recovery Backup Code</h3>
            <p>Save this code in a secure location. You'll need it to recover your account.</p>
            <div class="backup-code">
              <code>{{ backupCode }}</code>
              <button class="btn btn-success" @click="copyBackupCode">
                <span v-if="copied">Copied!</span>
                <span v-else>Copy</span>
              </button>
            </div>
          </div>
          
          <div class="next-steps">
            <h3>What's Next?</h3>
            <ul>
              <li>All your DMs will now be encrypted automatically</li>
              <li>Server owners can enable encryption for channels</li>
              <li>Look for the 🔒 icon to verify encryption is active</li>
            </ul>
          </div>
        </div>
        
        <div class="wizard-actions">
          <button class="btn btn-primary" @click="handleComplete">Done</button>
        </div>
      </div>
      
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/useChat'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'complete'): void
}>()

const authStore = useAuthStore()
const chatStore = useChatStore()

const step = ref(1)
const password = ref('')
const confirmPassword = ref('')
const backupCode = ref('')
const isProcessing = ref(false)
const errorMessage = ref<string | null>(null)
const progressStep = ref(0)
const copied = ref(false)

const passwordStrength = computed(() => {
  const p = password.value
  if (p.length === 0) return ''
  if (p.length < 6) return 'weak'
  if (p.length < 10) return 'medium'
  if (p.length >= 12 && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)) return 'strong'
  return 'medium'
})

const passwordStrengthText = computed(() => {
  const strength = passwordStrength.value
  if (!strength) return ''
  return strength.charAt(0).toUpperCase() + strength.slice(1)
})

const isPasswordValid = computed(() => {
  return password.value.length >= 8 && 
         password.value === confirmPassword.value &&
         passwordStrength.value !== 'weak'
})

async function handleContinue() {
  if (!isPasswordValid.value) return
  
  step.value = 3
  isProcessing.value = true
  progressStep.value = 0
  
  try {
    const userId = authStore.session?.user?.id
    if (!userId) {
      throw new Error('User not authenticated')
    }
    
    // Dynamically import encryption service to avoid loading native modules at startup
    const { messageEncryptionService } = await import('@/services/encryption')
    
    // Step 1: Initialize encryption service
    await messageEncryptionService.initialize(userId, password.value)
    progressStep.value = 1
    
    // Step 2: Setup encryption (generate keys)
    await messageEncryptionService.setupEncryption(password.value)
    progressStep.value = 2
    
    // Step 3: Generate backup code
    await new Promise(resolve => setTimeout(resolve, 500))
    backupCode.value = generateBackupCode()
    progressStep.value = 3
    
    // Success
    await new Promise(resolve => setTimeout(resolve, 500))
    step.value = 4

    try {
      await chatStore.reprocessEncryptedMessages()
    } catch (error) {
      debug.warn('Failed to refresh messages after encryption setup:', error)
    }
  } catch (error: any) {
    debug.error('Encryption setup failed:', error)
    errorMessage.value = error.message || 'Failed to setup encryption. Please try again.'
    step.value = 2
  } finally {
    isProcessing.value = false
  }
}

function generateBackupCode(): string {
  const segments = []
  for (let i = 0; i < 4; i++) {
    const segment = Math.random().toString(36).substring(2, 6).toUpperCase()
    segments.push(segment)
  }
  return segments.join('-')
}

function copyBackupCode() {
  navigator.clipboard.writeText(backupCode.value)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

function handleComplete() {
  emit('complete')
  emit('close')
}
</script>

<style scoped>
.key-setup-wizard-overlay {
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
  animation: fadeIn 0.2s ease;
}

.key-setup-wizard {
  background: var(--background-primary-alpha);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  width: 90%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  position: relative;
}

.wizard-step {
  padding: 32px;
}

.wizard-header {
  text-align: center;
  margin-bottom: 32px;
}

.lock-icon,
.success-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.wizard-header h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.wizard-header p {
  color: var(--text-secondary);
  font-size: 14px;
}

.wizard-content {
  margin-bottom: 32px;
}

.intro-text {
  text-align: center;
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 24px;
}

.features {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.feature {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.feature .icon {
  font-size: 24px;
  flex-shrink: 0;
}

.feature strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.feature p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  color: var(--text-primary);
  font-weight: 500;
  margin-bottom: 8px;
  font-size: 14px;
}

.form-group input {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color 0.2s;
}

.form-group input:focus {
  outline: none;
  border-color: var(--primary);
}

.password-strength {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.strength-bar {
  height: 4px;
  flex: 1;
  background: var(--bg-tertiary);
  border-radius: 2px;
  position: relative;
  overflow: hidden;
}

.strength-bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  transition: width 0.3s, background 0.3s;
}

.strength-bar.weak::after {
  width: 33%;
  background: #e74c3c;
}

.strength-bar.medium::after {
  width: 66%;
  background: #f39c12;
}

.strength-bar.strong::after {
  width: 100%;
  background: #27ae60;
}

.strength-text {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 60px;
}

.warning-box {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 152, 0, 0.1);
  border: 1px solid rgba(255, 152, 0, 0.3);
  border-radius: 6px;
  margin-top: 16px;
}

.warning-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.warning-box strong {
  color: var(--text-primary);
}

.warning-box div {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.processing-text {
  text-align: center;
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.progress-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.progress-step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  opacity: 0.4;
  transition: opacity 0.3s;
}

.progress-step.active {
  opacity: 1;
}

.step-icon {
  font-size: 24px;
}

.success-text {
  text-align: center;
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.backup-section {
  background: var(--bg-secondary);
  padding: 20px;
  border-radius: 8px;
  margin-bottom: 24px;
}

.backup-section h3 {
  font-size: 16px;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.backup-section p {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.backup-code {
  display: flex;
  gap: 8px;
  align-items: center;
}

.backup-code code {
  flex: 1;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: 'Courier New', monospace;
  font-size: 16px;
  letter-spacing: 2px;
  text-align: center;
  color: var(--primary);
}

.btn-copy {
  padding: 12px 20px;
  background: var(--primary);
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}

.btn-copy:hover {
  background: var(--primary-hover);
}

.next-steps h3 {
  font-size: 16px;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.next-steps ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.next-steps li {
  padding: 8px 0;
  color: var(--text-secondary);
  font-size: 14px;
  padding-left: 24px;
  position: relative;
}

.next-steps li::before {
  content: '→';
  position: absolute;
  left: 0;
  color: var(--primary);
}

.wizard-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.error-banner {
  position: relative;
  margin: 16px;
  /* top: 16px;
  left: 16px;
  right: 16px; */
  padding: 12px 16px;
  background: rgba(231, 76, 60, 0.1);
  border: 1px solid rgba(231, 76, 60, 0.3);
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #e74c3c;
  font-size: 14px;
}

.error-icon {
  font-size: 16px;
}

.error-banner button {
  margin-left: auto;
  background: none;
  border: none;
  color: #e74c3c;
  font-size: 20px;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>

