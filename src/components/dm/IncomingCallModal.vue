<template>
  <Teleport to="body">
    <!-- Full-screen ringing modal; clicking the backdrop minimizes instead of blocking -->
    <div
      v-if="show && !isMinimized"
      class="incoming-call-overlay"
      @click.self="minimize"
    >
      <div
        ref="modalRef"
        class="incoming-call-modal"
        :class="{ 'video-call': callType === 'video' }"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="descriptionId"
        tabindex="-1"
        data-testid="incoming-call-modal"
      >
        <button type="button" class="minimize-btn" :title="t('dm.callMinimize')" :aria-label="t('dm.callMinimize')" @click="minimize">
          <Icon name="minimize-2" :size="16" aria-hidden="true" />
        </button>

        <!-- Caller Info -->
        <div class="caller-info">
          <div class="caller-avatar-container">
            <Avatar
              :src="callerAvatar"
              alt=""
              size="lg"
              class="caller-avatar"
            />
            <div class="call-type-indicator" aria-hidden="true">
              <Icon :name="callType === 'video' ? 'video' : 'phone'" :size="24" />
            </div>
          </div>

          <h2 :id="titleId" class="caller-name">
            <template v-if="groupName">{{ groupName }}</template>
            <DisplayName v-else :user-id="callerId" :fallback="callerName" />
          </h2>
          <p :id="descriptionId" class="call-type-text">
            <template v-if="groupName">
              {{ t(callType === 'video' ? 'dm.groupVideoCallFrom' : 'dm.groupVoiceCallFrom', { name: callerName }) }}
            </template>
            <template v-else>
              {{ callType === 'video' ? t('dm.incomingVideoCall') : t('dm.incomingVoiceCall') }}
            </template>
          </p>

          <div class="ringing-text" aria-hidden="true">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>
        </div>

        <!-- Call Actions -->
        <div class="call-actions">
          <button
            type="button"
            @click="handleDecline"
            class="call-btn decline-btn"
            data-testid="incoming-call-decline"
          >
            <Icon name="phone-off" :size="24" aria-hidden="true" />
            <span>{{ t('dm.callDecline') }}</span>
          </button>

          <button
            ref="acceptButtonRef"
            type="button"
            @click="handleAccept('voice')"
            class="call-btn accept-btn voice-accept"
            :title="t('dm.callAcceptVoice')"
            data-testid="incoming-call-accept"
          >
            <Icon name="phone" :size="24" aria-hidden="true" />
            <span>{{ t('dm.callAccept') }}</span>
          </button>

          <button
            v-if="callType === 'video'"
            type="button"
            @click="handleAccept('video')"
            class="call-btn accept-btn video-accept"
            :title="t('dm.callAcceptVideo')"
          >
            <Icon name="video" :size="24" aria-hidden="true" />
            <span>{{ t('dm.callVideo') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Minimized floating card: keeps ringing without blocking the app -->
    <div
      v-if="show && isMinimized"
      ref="miniRef"
      class="incoming-call-mini"
      role="alertdialog"
      :aria-labelledby="`${titleId}-mini`"
      :aria-describedby="`${descriptionId}-mini`"
      tabindex="-1"
      data-testid="incoming-call-mini"
      @click="expand"
    >
      <Avatar
        :src="callerAvatar"
        alt=""
        size="sm"
        class="mini-avatar"
      />
      <div class="mini-info">
        <span :id="`${titleId}-mini`" class="mini-name">
          <template v-if="groupName">{{ groupName }}</template>
          <DisplayName v-else :user-id="callerId" :fallback="callerName" />
        </span>
        <span :id="`${descriptionId}-mini`" class="mini-subtitle">
          {{ callType === 'video' ? t('dm.incomingVideoCall') : t('dm.incomingVoiceCall') }}
        </span>
      </div>
      <div class="mini-actions" @click.stop>
        <button type="button" class="mini-btn mini-expand" :title="t('dm.callExpand')" :aria-label="t('dm.callExpand')" @click="expand">
          <Icon name="maximize-2" :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="mini-btn mini-decline" :title="t('dm.callDecline')" :aria-label="t('dm.callDecline')" data-testid="incoming-call-mini-decline" @click="handleDecline">
          <Icon name="phone-off" :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="mini-btn mini-accept" :title="t('dm.callAccept')" :aria-label="t('dm.callAccept')" @click="handleAccept(callType)">
          <Icon :name="callType === 'video' ? 'video' : 'phone'" :size="16" aria-hidden="true" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, onUnmounted } from 'vue'
import { useDialog } from '@/composables/useDialog'
import { useT } from '@/composables/useT'
import { currentFocusOrigin, focusElement, focusProgrammatically } from '@/utils/a11y/focus'
import { restoreFocusIfLost } from '@/components/voice/voiceFocus'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useThemeStore } from '@/stores/useTheme'
import { useDMStore } from '@/stores/useDM'

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

const { t } = useT()
const themeStore = useThemeStore()
const dmStore = useDMStore()
const isMinimized = ref(false)
const acceptButtonRef = ref<HTMLButtonElement | null>(null)
const modalRef = ref<HTMLElement | null>(null)
const miniRef = ref<HTMLElement | null>(null)

// Focus is managed here rather than restored by useDialog: minimizing moves it
// to the card, and only the end of the call returns it to where it was.
const { titleId, descriptionId } = useDialog({
  open: () => props.show && !isMinimized.value,
  element: modalRef,
  onClose: () => minimize(),
  initialFocus: () => acceptButtonRef.value,
  returnFocus: false,
})

let focusBeforeCall: HTMLElement | null = null

const minimize = async () => {
  isMinimized.value = true
  await nextTick()
  focusProgrammatically(miniRef.value)
}

const expand = () => {
  isMinimized.value = false
}

// Group DMs name the group; the caller moves to the subtitle (Discord).
const groupName = computed(() => {
  const conv = dmStore.conversations.find(c => c.id === props.conversationId)
  if (!conv || conv.type !== 'group') return ''
  return conv.name || 'Group call'
})
let ringtoneInterval: number | null = null

const startRingtone = () => {
  // Play ringtone immediately
  themeStore.playAudio('call_incoming')

  // Play ringtone every 3 seconds
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

watch(() => props.show, async (isShowing, wasShowing) => {
  if (isShowing) {
    if (!wasShowing) focusBeforeCall = currentFocusOrigin()
    isMinimized.value = false
    startRingtone()
  } else {
    stopRingtone()
    const target = focusBeforeCall
    focusBeforeCall = null
    await nextTick()
    restoreFocusIfLost(target)
  }
}, { immediate: true, flush: 'sync' })

// Keyboard users land on Accept; Esc minimizes.
watch(() => props.show && !isMinimized.value, async (visible) => {
  if (!visible) return
  await nextTick()
  focusElement(acceptButtonRef.value)
})

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
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  cursor: pointer;
}

.incoming-call-modal {
  position: relative;
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  padding: 48px 32px;
  box-shadow: var(--shadow-large);
  text-align: center;
  min-width: 320px;
  max-width: 400px;
  cursor: default;
}

@media (prefers-reduced-motion: no-preference) {
  .incoming-call-overlay {
    animation: fadeIn 0.3s ease;
  }

  .incoming-call-modal {
    animation: slideUp 0.3s ease-out;
  }

  .incoming-call-mini {
    animation: slideInRight 0.25s ease;
  }

  .dot {
    animation: blink 1.4s ease-in-out infinite;
  }

  .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .dot:nth-child(3) {
    animation-delay: 0.4s;
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

@keyframes slideUp {
  from {
    transform: translateY(16px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
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

@keyframes blink {
  0%, 60%, 100% {
    opacity: 0.3;
  }
  30% {
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
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.minimize-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.caller-info {
  margin-bottom: 32px;
}

.caller-avatar-container {
  position: relative;
  display: inline-block;
  margin-bottom: 24px;
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
  color: var(--text-on-primary);
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
  opacity: 0.6;
}

.call-actions {
  display: flex;
  gap: 16px;
  justify-content: center;
}

:root[data-disable-blur="true"] .incoming-call-overlay {
  backdrop-filter: none;
}

.call-btn:focus-visible,
.mini-btn:focus-visible,
.minimize-btn:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.call-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border: none;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s ease;
  min-width: 90px;
}

/* --error under white text is 3.7:1; the hover shade is 5.3:1 (WCAG AA). */
.decline-btn {
  background: var(--error-hover);
  color: var(--text-on-primary);
}

.decline-btn:hover {
  background: color-mix(in srgb, var(--error-hover) 85%, black);
}

.accept-btn {
  background: var(--success);
  color: var(--text-on-primary);
}

.accept-btn:hover {
  background: var(--success-hover);
}

.video-accept {
  background: var(--harmony-primary);
}

.video-accept:hover {
  background: var(--harmony-primary-hover);
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
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  cursor: pointer;
}

.mini-avatar {
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
  color: var(--text-on-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease;
}

.mini-expand {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.mini-expand:hover {
  background: var(--background-modifier-hover);
}

.incoming-call-mini:focus {
  outline: none;
}

.incoming-call-mini:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.mini-decline {
  background: var(--error);
}

.mini-decline:hover {
  background: var(--error-hover);
}

.mini-accept {
  background: var(--success);
}

.mini-accept:hover {
  background: var(--success-hover);
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
