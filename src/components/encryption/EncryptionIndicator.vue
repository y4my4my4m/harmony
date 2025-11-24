<template>
  <div class="encryption-indicator" :class="{ active: isEncrypted, checking: isChecking }">
    <svg class="lock-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path 
        v-if="isEncrypted"
        d="M12 2C9.243 2 7 4.243 7 7v3H6c-1.103 0-2 .897-2 2v8c0 1.103.897 2 2 2h12c1.103 0 2-.897 2-2v-8c0-1.103-.897-2-2-2h-1V7c0-2.757-2.243-5-5-5zm3 8H9V7c0-1.654 1.346-3 3-3s3 1.346 3 3v3z" 
        fill="currentColor"
      />
      <path 
        v-else
        d="M12 2C9.243 2 7 4.243 7 7v1H6c-1.103 0-2 .897-2 2v10c0 1.103.897 2 2 2h12c1.103 0 2-.897 2-2V10c0-1.103-.897-2-2-2h-1V7c0-2.757-2.243-5-5-5zm4 8v10H8V10h8zM9 7c0-1.654 1.346-3 3-3s3 1.346 3 3v1H9V7z" 
        fill="currentColor" 
        opacity="0.5"
      />
    </svg>
    
    <Transition name="fade">
      <span v-if="showText" class="indicator-text">
        <template v-if="isChecking">Checking...</template>
        <template v-else-if="isEncrypted">E2EE Active</template>
        <template v-else>Not Encrypted</template>
      </span>
    </Transition>
    
    <div v-if="showTooltip" class="tooltip">
      <template v-if="isEncrypted">
        <strong>🔒 End-to-End Encrypted</strong>
        <p>Only you and recipients can read these messages</p>
      </template>
      <template v-else>
        <strong>🔓 Not Encrypted</strong>
        <p>Messages are visible to the server</p>
        <button v-if="canEnable" @click="handleEnableEncryption" class="enable-btn">
          Enable E2EE
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { messageEncryptionService } from '@/services/encryption'

const props = withDefaults(defineProps<{
  serverId?: string
  conversationId?: string
  showText?: boolean
  showTooltip?: boolean
}>(), {
  showText: true,
  showTooltip: false
})

const emit = defineEmits<{
  (e: 'enableEncryption'): void
}>()

const isEncrypted = ref(false)
const isChecking = ref(true)
const canEnable = ref(false)

const checkEncryptionStatus = async () => {
  isChecking.value = true
  
  try {
    if (props.serverId) {
      const policy = await messageEncryptionService.checkServerEncryptionPolicy(props.serverId)
      isEncrypted.value = policy.enabled
      canEnable.value = !policy.enabled && policy.hasKeys && policy.mode === 'optional'
    } else if (props.conversationId) {
      const status = await messageEncryptionService.checkConversationEncryption(props.conversationId)
      isEncrypted.value = status.enabled
      canEnable.value = status.can Enable_encryption || false
    }
  } catch (error) {
    console.error('Failed to check encryption status:', error)
    isEncrypted.value = false
  } finally {
    isChecking.value = false
  }
}

watch(() => [props.serverId, props.conversationId], checkEncryptionStatus, { immediate: true })

onMounted(() => {
  checkEncryptionStatus()
})

function handleEnableEncryption() {
  emit('enableEncryption')
}
</script>

<style scoped>
.encryption-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
  cursor: default;
  position: relative;
}

.encryption-indicator.active {
  color: var(--success, #27ae60);
}

.encryption-indicator:not(.active) {
  color: var(--text-tertiary);
}

.encryption-indicator.checking {
  opacity: 0.5;
}

.lock-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.indicator-text {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.tooltip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 8px;
  padding: 12px;
  background: var(--bg-tooltip, rgba(0, 0, 0, 0.9));
  color: white;
  border-radius: 6px;
  font-size: 13px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1000;
  min-width: 200px;
}

.encryption-indicator:hover .tooltip {
  opacity: 1;
  pointer-events: all;
}

.tooltip strong {
  display: block;
  margin-bottom: 4px;
}

.tooltip p {
  margin: 0;
  opacity: 0.8;
  font-size: 12px;
}

.enable-btn {
  margin-top: 8px;
  padding: 6px 12px;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  width: 100%;
}

.enable-btn:hover {
  background: var(--primary-hover);
}
</style>

