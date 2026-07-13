<template>
  <div class="keybind-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.keybinds.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.keybinds.description') }}
      </p>
    </div>

    <!-- Global Keybinds (Voice Connected) -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">Voice Keybinds</h3>
        <button class="reset-btn" @click="resetAllKeybinds" title="Reset all to defaults">
          <Icon name="refresh" />
          Reset All
        </button>
      </div>
      <p class="section-description">These shortcuts work when connected to a voice channel.</p>
      
      <!-- Push to Talk -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Push to Talk</h4>
          <p class="keybind-description">
            Hold to talk in voice channels.
            <span v-if="!isPTTMode" class="mode-note">(Currently using Voice Activity mode)</span>
          </p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ 
              recording: recordingAction === 'push-to-talk',
              inactive: !isPTTMode 
            }"
            @click="startRecording('push-to-talk')"
          >
            <span v-if="recordingAction === 'push-to-talk'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('push-to-talk') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('push-to-talk')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Toggle Mute -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Mute</h4>
          <p class="keybind-description">Mute or unmute your microphone.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'toggle-mute' }"
            @click="startRecording('toggle-mute')"
          >
            <span v-if="recordingAction === 'toggle-mute'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('toggle-mute') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('toggle-mute')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Toggle Deafen -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Deafen</h4>
          <p class="keybind-description">Deafen or undeafen yourself.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'toggle-deafen' }"
            @click="startRecording('toggle-deafen')"
          >
            <span v-if="recordingAction === 'toggle-deafen'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('toggle-deafen') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('toggle-deafen')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Toggle Camera -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Camera</h4>
          <p class="keybind-description">Turn camera on or off.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'toggle-camera' }"
            @click="startRecording('toggle-camera')"
          >
            <span v-if="recordingAction === 'toggle-camera'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('toggle-camera') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('toggle-camera')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Toggle Screen Share -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Screen Share</h4>
          <p class="keybind-description">Start or stop screen sharing.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'toggle-screenshare' }"
            @click="startRecording('toggle-screenshare')"
          >
            <span v-if="recordingAction === 'toggle-screenshare'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('toggle-screenshare') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('toggle-screenshare')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Voice Settings -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Open Voice Settings</h4>
          <p class="keybind-description">Open voice settings panel.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'toggle-voice-settings' }"
            @click="startRecording('toggle-voice-settings')"
          >
            <span v-if="recordingAction === 'toggle-voice-settings'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('toggle-voice-settings') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('toggle-voice-settings')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <!-- Exit/Escape -->
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Exit / Close</h4>
          <p class="keybind-description">Exit fullscreen or close panels.</p>
        </div>
        <div class="keybind-control">
          <button 
            class="keybind-button" 
            :class="{ recording: recordingAction === 'exit-fullscreen' }"
            @click="startRecording('exit-fullscreen')"
          >
            <span v-if="recordingAction === 'exit-fullscreen'">Press any key...</span>
            <span v-else>{{ getKeybindDisplay('exit-fullscreen') }}</span>
          </button>
          <button 
            class="reset-single-btn" 
            @click="resetKeybind('exit-fullscreen')"
            title="Reset to default"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>
    </div>

    <!-- Conflict Warning -->
    <div v-if="hasConflict" class="conflict-warning">
      <Icon name="alert-triangle" />
      <span>{{ conflictMessage }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useKeybinds, type KeybindAction, type KeybindModifiers } from '@/composables/useKeybinds'
import Icon from '@/components/common/Icon.vue'

interface Props {
  loading: boolean
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = defineProps<Props>()

const emit = defineEmits<{
  'update-keybinds': [settings: any]
}>()

const keybinds = useKeybinds()

const recordingAction = ref<KeybindAction | null>(null)
const hasConflict = ref(false)
const conflictMessage = ref('')

const isPTTMode = keybinds.isPTTMode

const getKeybindDisplay = (action: KeybindAction): string => {
  return keybinds.getKeybindDisplay(action)
}

const startRecording = (action: KeybindAction) => {
  if (recordingAction.value === action) {
    recordingAction.value = null
    return
  }
  recordingAction.value = action
  hasConflict.value = false
}

const resetKeybind = (action: KeybindAction) => {
  keybinds.resetKeybind(action)
}

const resetAllKeybinds = () => {
  keybinds.resetAllKeybinds()
}

const checkConflict = (action: KeybindAction, key: string, modifiers: KeybindModifiers): string | null => {
  for (const kb of keybinds.voiceKeybinds.value) {
    if (kb.id === action) continue
    if (kb.key === key && 
        kb.modifiers.ctrl === modifiers.ctrl &&
        kb.modifiers.alt === modifiers.alt &&
        kb.modifiers.shift === modifiers.shift &&
        kb.modifiers.meta === modifiers.meta) {
      return `This keybind conflicts with "${kb.name}"`
    }
  }
  return null
}

const handleKeydown = (event: KeyboardEvent) => {
  if (!recordingAction.value) return
  
  event.preventDefault()
  event.stopPropagation()
  
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
    return
  }

  if (event.code === 'Escape') {
    recordingAction.value = null
    return
  }
  
  recordKey(event.code, {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  })
}

const handleMousedown = (event: MouseEvent) => {
  if (!recordingAction.value) return
  
  // Only capture extra mouse buttons (3, 4, 5+) by default
  // Left (0), Middle (1), Right (2) are used for UI interaction
  if (event.button < 3) {
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      return
    }
  }
  
  event.preventDefault()
  event.stopPropagation()
  
  const mouseKey = `Mouse${event.button}`
  recordKey(mouseKey, {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  })
}

const recordKey = (key: string, modifiers: KeybindModifiers) => {
  if (!recordingAction.value) return

  const conflict = checkConflict(recordingAction.value, key, modifiers)
  if (conflict) {
    hasConflict.value = true
    conflictMessage.value = conflict
  } else {
    hasConflict.value = false
  }
  
  const action = recordingAction.value
  keybinds.setKeybind(action, key, modifiers)
  recordingAction.value = null
  
  emit('update-keybinds', { action, key, modifiers })
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown, { capture: true })
  window.addEventListener('mousedown', handleMousedown, { capture: true })
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown, { capture: true })
  window.removeEventListener('mousedown', handleMousedown, { capture: true })
})
</script>

<style scoped>
.keybind-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 20px 0;
}

.reset-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background-color: transparent;
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reset-btn:hover {
  background-color: rgba(237, 66, 69, 0.1);
  border-color: #ed4245;
  color: #ed4245;
}

.reset-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

.keybind-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.keybind-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.keybind-info {
  flex: 1;
  margin-right: 16px;
}

.keybind-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.keybind-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.keybind-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.keybind-button {
  padding: 6px 16px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 100px;
  text-align: center;
}

.keybind-button:hover {
  background-color: rgba(14, 165, 233, 0.2);
  border-color: #0EA5E9;
}

.keybind-button.recording {
  background-color: rgba(14, 165, 233, 0.3);
  border-color: #0EA5E9;
  color: #0EA5E9;
  animation: pulse-keybind 1.5s ease-in-out infinite;
}

.keybind-button.inactive {
  opacity: 0.5;
}

.reset-single-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background-color: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 0.5;
}

.reset-single-btn:hover {
  background-color: rgba(237, 66, 69, 0.1);
  border-color: #ed4245;
  color: #ed4245;
  opacity: 1;
}

.reset-single-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

@keyframes pulse-keybind {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.mode-note {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
  margin-top: 4px;
}

.conflict-warning {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
  color: #faa61a;
  font-size: 13px;
}

.conflict-warning :deep(svg) {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
</style>
