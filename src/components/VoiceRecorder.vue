<template>
  <div class="voice-recorder" :class="{ recording: isRecording }">
    <Transition name="recorder-fade">
      <div v-if="isRecording" class="recorder-active">
        <button class="recorder-btn cancel-btn" @click="cancel" title="Cancel">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>

        <div class="waveform-area">
          <div class="recording-indicator">
            <span class="rec-dot" :class="{ 'near-limit': nearLimit }" />
            <span class="rec-timer" :class="{ 'near-limit': nearLimit }">{{ formattedDuration }}</span>
            <span v-if="nearLimit" class="rec-limit-warn">{{ formattedRemaining }} left</span>
          </div>
          <div class="waveform-bars">
            <div
              v-for="(bar, i) in displayBars"
              :key="i"
              class="waveform-bar"
              :style="{ height: bar + '%' }"
            />
          </div>
        </div>

        <button class="recorder-btn send-btn" @click="send" title="Send">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </Transition>

    <button
      v-if="!isRecording"
      class="mic-trigger"
      :class="{ disabled: disabled }"
      @click="startRecording"
      :disabled="disabled"
      title="Record voice message"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useVoiceRecording, type VoiceRecordingResult } from '@/services/voiceRecordingService'
import { debug } from '@/utils/debug'

interface Props {
  disabled?: boolean
  autoStart?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  autoStart: false,
})

const emit = defineEmits<{
  (e: 'recording-complete', result: VoiceRecordingResult): void
  (e: 'recording-started'): void
  (e: 'recording-cancelled'): void
}>()

const {
  state,
  liveWaveform,
  maxDuration,
  startRecording: doStart,
  stopRecording: doStop,
  cancelRecording: doCancel,
  onAutoStop,
} = useVoiceRecording()

const isRecording = computed(() => state.value.isRecording)

const nearLimit = computed(() => {
  if (!maxDuration) return false
  return state.value.duration >= maxDuration - 30
})

const formattedDuration = computed(() => {
  const secs = Math.floor(state.value.duration)
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}:${rem.toString().padStart(2, '0')}`
})

const formattedRemaining = computed(() => {
  if (!maxDuration) return ''
  const remaining = Math.max(0, Math.ceil(maxDuration - state.value.duration))
  const mins = Math.floor(remaining / 60)
  const secs = remaining % 60
  if (mins > 0) return `${mins}:${secs.toString().padStart(2, '0')}`
  return `${secs}s`
})

const displayBars = computed(() =>
  liveWaveform.value.map((v) => Math.max(6, v * 100))
)

const startRecording = async () => {
  try {
    await doStart()
    emit('recording-started')

    onAutoStop().then((result) => {
      emit('recording-complete', result)
    })
  } catch (err) {
    debug.error('Voice recording failed to start:', err)
  }
}

const send = async () => {
  try {
    const result = await doStop()
    emit('recording-complete', result)
  } catch (err) {
    debug.error('Voice recording failed to stop:', err)
  }
}

const cancel = () => {
  doCancel()
  emit('recording-cancelled')
}

onMounted(() => {
  if (props.autoStart) startRecording()
})

onUnmounted(() => {
  if (isRecording.value) doCancel()
})
</script>

<style scoped>
.voice-recorder {
  display: flex;
  align-items: center;
}

.voice-recorder.recording {
  flex: 1;
  min-width: 0;
  width: 100%;
}

.mic-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
  padding: 0;
}

.mic-trigger:hover:not(.disabled) {
  color: var(--harmony-primary, #0EA5E9);
  background: rgba(14, 165, 233, 0.1);
}

.mic-trigger.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.recorder-active {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0 4px;
}

.recorder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
  flex-shrink: 0;
}

.recorder-btn:hover {
  transform: scale(1.1);
}

.cancel-btn {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.cancel-btn:hover {
  background: rgba(239, 68, 68, 0.25);
}

.send-btn {
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
}

.send-btn:hover {
  background: var(--harmony-primary-hover, #0284C7);
}

.waveform-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.recording-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  animation: rec-pulse 1.2s ease-in-out infinite;
}

@keyframes rec-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.rec-timer {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  transition: color 0.3s ease;
}

.rec-timer.near-limit {
  color: #ef4444;
}

.rec-dot.near-limit {
  background: #ef4444;
  animation: rec-pulse-fast 0.6s ease-in-out infinite;
}

.rec-limit-warn {
  font-size: 10px;
  color: #ef4444;
  font-weight: 600;
  opacity: 0.85;
}

@keyframes rec-pulse-fast {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}

.waveform-bars {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  width: 100%;
  height: 24px;
  min-width: 0;
}

.waveform-bar {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 1px;
  background: var(--harmony-primary, #0EA5E9);
  transition: height 0.06s ease-out;
  opacity: 0.85;
}

.recorder-fade-enter-active,
.recorder-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.recorder-fade-enter-from,
.recorder-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
