<template>
  <Teleport to="body">
    <!-- Full-screen ringing modal; clicking the backdrop minimizes instead of blocking -->
    <div v-if="show && !isMinimized" class="incoming-call-overlay" @click.self="isMinimized = true">
      <div class="incoming-call-modal" :class="{ 'video-call': callType === 'video' }">
        <button class="minimize-btn" title="Minimize" @click="isMinimized = true">
          <Icon name="minimize-2" :size="16" />
        </button>

        <!-- Caller Info -->
        <div class="caller-info">
          <div class="caller-avatar-container">
            <Avatar
              :src="callerAvatar"
              :alt="callerName"
              size="lg"
              class="caller-avatar pulsing"
            />
            <div class="call-type-indicator">
              <Icon :name="callType === 'video' ? 'video' : 'phone'" :size="24" />
            </div>
          </div>

          <h2 class="caller-name"><DisplayName :user-id="callerId" :fallback="callerName" /></h2>
          <p class="call-type-text">
            {{ callType === 'video' ? 'Incoming video call' : 'Incoming voice call' }}
          </p>

          <div class="ringing-text">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>
        </div>

        <!-- Call Actions -->
        <div class="call-actions">
          <button
            @click="handleDecline"
            class="call-btn decline-btn"
            title="Decline"
          >
            <Icon name="phone-off" :size="24" />
            <span>Decline</span>
          </button>

          <button
            @click="handleAccept('voice')"
            class="call-btn accept-btn voice-accept"
            title="Accept voice call"
          >
            <Icon name="phone" :size="24" />
            <span>Accept</span>
          </button>

          <button
            v-if="callType === 'video'"
            @click="handleAccept('video')"
            class="call-btn accept-btn video-accept"
            title="Accept with video"
          >
            <Icon name="video" :size="24" />
            <span>Video</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Minimized floating card: keeps ringing without blocking the app -->
    <div v-if="show && isMinimized" class="incoming-call-mini" @click="isMinimized = false">
      <Avatar
        :src="callerAvatar"
        :alt="callerName"
        size="sm"
        class="mini-avatar"
      />
      <div class="mini-info">
        <span class="mini-name"><DisplayName :user-id="callerId" :fallback="callerName" /></span>
        <span class="mini-subtitle">
          {{ callType === 'video' ? 'Incoming video call' : 'Incoming call' }}
        </span>
      </div>
      <div class="mini-actions" @click.stop>
        <button class="mini-btn mini-decline" title="Decline" @click="handleDecline">
          <Icon name="phone-off" :size="16" />
        </button>
        <button class="mini-btn mini-accept" title="Accept" @click="handleAccept(callType)">
          <Icon :name="callType === 'video' ? 'video' : 'phone'" :size="16" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useThemeStore } from '@/stores/useTheme'

interface Props {
  show: boolean
  callerId: string
  callerName: string
  callerAvatar: string
  callType: 'voice' | 'video'
  conversationId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  accept: [acceptWithVideo: boolean]
  decline: []
}>()

const themeStore = useThemeStore()
const isMinimized = ref(false)
let ringtoneInterval: number | null = null

const startRingtone = () => {
  themeStore.playAudio('call_incoming')

  ringtoneInterval = window.setInterval(() => {
    themeStore.playAudio('call_incoming')
  }, 3000)
}

const stopRingtone = () => {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval)
    ringtoneInterval = null
  }
}

watch(() => props.show, (isShowing) => {
  if (isShowing) {
    isMinimized.value = false
    startRingtone()
  } else {
    stopRingtone()
  }
}, { immediate: true })

onUnmounted(() => {
  stopRingtone()
})

const handleAccept = (type: 'voice' | 'video') => {
  stopRingtone()
  emit('accept', type === 'video')
}

const handleDecline = () => {
  stopRingtone()
  emit('decline')
}
</script>

<style scoped>
.incoming-call-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.3s ease;
  cursor: pointer;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.incoming-call-modal {
  position: relative;
  background: var(--background-primary);
  border-radius: 16px;
  padding: 48px 32px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  text-align: center;
  min-width: 320px;
  max-width: 400px;
  animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  cursor: default;
}

@keyframes slideUp {
  from {
    transform: translateY(50px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.minimize-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.minimize-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.incoming-call-modal.video-call {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.05));
  border: 2px solid rgba(14, 165, 233, 0.3);
}

.caller-info {
  margin-bottom: 32px;
}

.caller-avatar-container {
  position: relative;
  display: inline-block;
  margin-bottom: 24px;
}

.caller-avatar {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.7);
  }
  50% {
    transform: scale(1.05);
    box-shadow: 0 0 0 20px rgba(14, 165, 233, 0);
  }
}

.call-type-indicator {
  position: absolute;
  bottom: -5px;
  right: -5px;
  width: 48px;
  height: 48px;
  background: var(--harmony-primary);
  border: 4px solid var(--background-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  animation: bounce 1s ease-in-out infinite;
}

@keyframes bounce {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

.caller-name {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.call-type-text {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
}

.ringing-text {
  display: flex;
  gap: 6px;
  justify-content: center;
  align-items: center;
}

.dot {
  width: 8px;
  height: 8px;
  background: var(--harmony-primary);
  border-radius: 50%;
  animation: blink 1.4s ease-in-out infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.2s;
}

.dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes blink {
  0%, 60%, 100% {
    opacity: 0.3;
  }
  30% {
    opacity: 1;
  }
}

.call-actions {
  display: flex;
  gap: 16px;
  justify-content: center;
}

.call-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 90px;
}

.call-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.decline-btn {
  background: #ed4245;
  color: var(--text-primary);
}

.decline-btn:hover {
  background: #c03537;
}

.accept-btn {
  background: #43b581;
  color: var(--text-primary);
}

.accept-btn:hover {
  background: #369968;
}

.video-accept {
  background: var(--harmony-primary);
}

.video-accept:hover {
  background: #0284C7;
}

/* Minimized floating card */
.incoming-call-mini {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  animation: slideInRight 0.25s ease;
}

@keyframes slideInRight {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.mini-avatar {
  animation: pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}

.mini-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 160px;
}

.mini-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.mini-actions {
  display: flex;
  gap: 8px;
  cursor: default;
}

.mini-btn {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.mini-btn:hover {
  transform: scale(1.08);
}

.mini-decline {
  background: #ed4245;
}

.mini-decline:hover {
  background: #c03537;
}

.mini-accept {
  background: #43b581;
}

.mini-accept:hover {
  background: #369968;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .incoming-call-modal {
    padding: 40px 24px;
    min-width: 280px;
  }

  .caller-name {
    font-size: 20px;
  }

  .call-actions {
    flex-direction: column;
    width: 100%;
  }

  .call-btn {
    width: 100%;
    flex-direction: row;
    justify-content: center;
  }

  .incoming-call-mini {
    top: calc(8px + env(safe-area-inset-top, 0px));
    right: 8px;
    left: 8px;
    justify-content: space-between;
  }

  .mini-info {
    max-width: none;
    flex: 1;
  }
}
</style>
