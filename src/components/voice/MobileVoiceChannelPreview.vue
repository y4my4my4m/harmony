<template>
  <Teleport to="body">
    <Transition name="slide-up">
      <div v-if="isVisible" class="mobile-voice-preview-backdrop" @click.self="close">
        <div class="mobile-voice-preview">
          <!-- Header with channel info -->
          <div class="preview-header">
            <button class="close-btn" @click="close">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
              </svg>
            </button>
            <div class="channel-info">
              <div class="channel-icon">
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path fill="currentColor" d="M12,1A3,3 0 0,1 15,4V12A3,3 0 0,1 12,15A3,3 0 0,1 9,12V4A3,3 0 0,1 12,1M19,12C19,15.53 16.39,18.44 13,18.93V21H17V23H7V21H11V18.93C7.61,18.44 5,15.53 5,12H7A5,5 0 0,0 12,17A5,5 0 0,0 17,12H19Z"/>
                </svg>
              </div>
              <span class="channel-name">{{ channelName }}</span>
            </div>
            <button class="menu-btn">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M12,8A2,2 0 0,1 14,10A2,2 0 0,1 12,12A2,2 0 0,1 10,10A2,2 0 0,1 12,8M12,14A2,2 0 0,1 14,16A2,2 0 0,1 12,18A2,2 0 0,1 10,16A2,2 0 0,1 12,14M12,2A2,2 0 0,1 14,4A2,2 0 0,1 12,6A2,2 0 0,1 10,4A2,2 0 0,1 12,2Z"/>
              </svg>
            </button>
          </div>

          <!-- Participants section -->
          <div class="participants-section">
            <div v-if="participants.length === 0" class="empty-state">
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" width="48" height="48">
                  <path fill="currentColor" d="M17,12V3A1,1 0 0,0 16,2H3A1,1 0 0,0 2,3V17L6,13H16A1,1 0 0,0 17,12M21,6H19V15H6V17A1,1 0 0,0 7,18H18L22,22V7A1,1 0 0,0 21,6Z"/>
                </svg>
              </div>
              <span class="empty-text">No one's here yet!</span>
              <span class="empty-subtext">When you're ready to talk, just hop in.</span>
            </div>
            <div v-else class="participants-list">
              <div v-for="participant in participants" :key="participant.id" class="participant-item">
                <Avatar
                  :src="getUserAvatarUrl(participant.id).value"
                  :alt="getUserDisplayName(participant.id).value || 'User'"
                  size="md"
                  class="participant-avatar"
                />
                <span class="participant-name"><DisplayName :userId="participant.id" /></span>
              </div>
            </div>
          </div>

          <!-- Control buttons -->
          <div class="preview-controls">
            <button class="control-btn mute-btn" :class="{ 'active': isMuted }" @click="toggleMuted">
              <svg v-if="isMuted" viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M1.27,1.73L0,3L4.73,7.73C4.26,8.31 4,9.09 4,10V17L6,15V10A2,2 0 0,1 8,8L10.45,10.45C10.17,10.75 10,11.15 10,11.6V16.4C10,17.08 10.54,17.63 11.2,17.63H12.8C13.46,17.63 14,17.08 14,16.4V14.45L20.27,20.73L21.54,19.46L1.27,1.73M11.2,6.37H12.8C13.46,6.37 14,6.92 14,7.6V8.86L20,14.86V4A2,2 0 0,0 18,2H6.5L8.5,4H18V6H8.5L10,7.5V7.6C10,7.14 10.17,6.74 10.45,6.45L11.2,6.37Z"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"/>
              </svg>
            </button>
            <button class="join-btn" @click="handleJoin">
              <span>Join Voice</span>
            </button>
            <button class="control-btn chat-btn" @click="handleOpenChat">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M6,9H18V11H6M14,14H6V12H14M18,8H6V6H18"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useUserData } from '@/composables/useUserData'

interface Participant {
  id: string
  username?: string
  avatar_url?: string
}

interface Props {
  isVisible: boolean
  channelId: string
  channelName: string
  participants: Participant[]
}

interface Emits {
  (e: 'close'): void
  (e: 'join', muted: boolean): void
  (e: 'open-chat'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { getUserDisplayName, getUserAvatarUrl } = useUserData()

const isMuted = ref(false)

const toggleMuted = () => {
  isMuted.value = !isMuted.value
}

const close = () => {
  emit('close')
}

const handleJoin = () => {
  emit('join', isMuted.value)
}

const handleOpenChat = () => {
  emit('open-chat')
}
</script>

<style scoped>
.mobile-voice-preview-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.mobile-voice-preview {
  width: 100%;
  max-height: 80vh;
  background: var(--bg-primary, #1e1f22);
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Slide up animation */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.slide-up-enter-active .mobile-voice-preview,
.slide-up-leave-active .mobile-voice-preview {
  transition: transform 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
}

.slide-up-enter-from .mobile-voice-preview,
.slide-up-leave-to .mobile-voice-preview {
  transform: translateY(100%);
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.close-btn,
.menu-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary, #b9bbbe);
  cursor: pointer;
  border-radius: 50%;
  transition: background 0.15s ease;
}

.close-btn:hover,
.menu-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: center;
}

.channel-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  color: var(--text-secondary);
}

.channel-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #fff);
}

.participants-section {
  flex: 1;
  padding: 24px 16px;
  overflow-y: auto;
  min-height: 200px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  color: var(--text-secondary, #b9bbbe);
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin-bottom: 4px;
}

.empty-subtext {
  font-size: 14px;
  color: var(--text-secondary, #b9bbbe);
}

.participants-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: 16px;
  justify-items: center;
}

.participant-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.participant-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.participant-avatar {
  width: 48px;
  height: 48px;
}

.participant-name {
  font-size: 12px;
  color: var(--text-primary, #fff);
  text-align: center;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  background: var(--bg-secondary, #2b2d31);
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.control-btn {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: var(--text-primary, #fff);
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.control-btn:active {
  transform: scale(0.95);
}

.control-btn.mute-btn.active {
  background: var(--harmony-danger, #ed4245);
  color: var(--text-primary);
}

.join-btn {
  flex: 1;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--harmony-success, #3ba55d);
  border: none;
  border-radius: 24px;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}

.join-btn:hover {
  background: var(--harmony-success-hover, #2d8049);
}

.join-btn:active {
  transform: scale(0.98);
}

/* Safe area for devices with notches/home indicators */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .preview-controls {
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
}
</style>

