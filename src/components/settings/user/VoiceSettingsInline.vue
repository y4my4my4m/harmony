<template>
  <div class="voice-settings-inline">
    <!-- Input Mode Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="mic" />
        Input Mode
      </h4>
      
      <div class="input-mode-options">
        <label 
          class="input-mode-option" 
          :class="{ active: inputMode === 'voice_activity' }"
          @click="setInputMode('voice_activity')"
        >
          <div class="radio-custom" :class="{ checked: inputMode === 'voice_activity' }">
            <div class="radio-inner"></div>
          </div>
          <div class="mode-content">
            <span class="mode-title">Voice Activity</span>
            <small class="mode-description">Automatically transmit when you speak</small>
          </div>
        </label>
        
        <label 
          class="input-mode-option" 
          :class="{ active: inputMode === 'push_to_talk' }"
          @click="setInputMode('push_to_talk')"
        >
          <div class="radio-custom" :class="{ checked: inputMode === 'push_to_talk' }">
            <div class="radio-inner"></div>
          </div>
          <div class="mode-content">
            <span class="mode-title">Push to Talk</span>
            <small class="mode-description">Hold a key to transmit</small>
          </div>
        </label>
      </div>
      
      <!-- PTT-specific settings -->
      <div v-if="inputMode === 'push_to_talk'" class="ptt-settings">
        <div class="setting-group">
          <label class="setting-label">Push to Talk Shortcut</label>
          <button 
            class="keybind-button" 
            :class="{ recording: isRecordingKeybind }"
            @click="handleKeybindClick"
          >
            <Icon name="keyboard" />
            <span v-if="isRecordingKeybind">Press any key...</span>
            <span v-else>{{ pttKeyDisplay }}</span>
          </button>
          <small class="setting-hint">Click to change the keybind</small>
        </div>
        
        <div class="setting-group">
          <label class="setting-label">
            Release Delay
            <span class="setting-value">{{ releaseDelay }}ms</span>
          </label>
          <div class="volume-control">
            <input 
              type="range" 
              v-model.number="localReleaseDelay"
              min="0" 
              max="500" 
              step="50"
              class="setting-slider"
              @input="updateReleaseDelay"
            />
            <div class="volume-indicator" :style="{ width: `${(localReleaseDelay / 500) * 100}%` }"></div>
          </div>
          <small class="setting-hint">Delay before muting after releasing the key (prevents cutting off words)</small>
        </div>
      </div>
    </div>

    <!-- Audio Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="volume-2" />
        Audio Devices
      </h4>
      
      <div class="setting-group">
        <label class="setting-label">Input Device</label>
        <select v-model="selectedInputDevice" class="setting-select" @change="updateInputDevice">
          <option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">
            {{ device.label || `Microphone ${device.deviceId.slice(0, 8)}` }}
          </option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">Output Device</label>
        <select v-model="selectedOutputDevice" class="setting-select" @change="updateOutputDevice">
          <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">
            {{ device.label || `Speaker ${device.deviceId.slice(0, 8)}` }}
          </option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          Input Volume
          <span class="setting-value">{{ inputVolume }}%</span>
        </label>
        <div class="volume-control">
          <input 
            type="range" 
            v-model="inputVolume"
            min="0" 
            max="100" 
            class="setting-slider"
            @input="updateInputVolume"
          />
          <div class="volume-indicator" :style="{ width: `${inputVolume}%` }"></div>
        </div>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          Output Volume
          <span class="setting-value">{{ outputVolume }}%</span>
        </label>
        <div class="volume-control">
          <input 
            type="range" 
            v-model="outputVolume"
            min="0" 
            max="100" 
            class="setting-slider"
            @input="updateOutputVolume"
          />
          <div class="volume-indicator" :style="{ width: `${outputVolume}%` }"></div>
        </div>
      </div>

      <!-- Audio Test -->
      <div class="setting-group">
        <div class="audio-test">
          <button @click="testMicrophone" class="test-btn" :class="{ active: isTesting }">
            <Icon name="mic" />
            {{ isTesting ? 'Testing...' : 'Test Microphone' }}
          </button>
          <div v-if="isTesting" class="test-indicator">
            <div class="test-level" :style="{ width: `${testLevel}%` }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Audio Quality -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="settings" />
        Audio Quality
      </h4>

      <div class="setting-group checkbox-group">
        <label class="checkbox-label">
          <input 
            type="checkbox" 
            v-model="echoCancellation"
            @change="updateAudioSettings"
            class="setting-checkbox"
          />
          <div class="checkbox-custom"></div>
          <div class="checkbox-content">
            <span>Echo Cancellation</span>
            <small>Reduces echo from your speakers</small>
          </div>
        </label>
      </div>

      <div class="setting-group checkbox-group">
        <label class="checkbox-label">
          <input 
            type="checkbox" 
            v-model="noiseSuppression"
            @change="updateAudioSettings"
            class="setting-checkbox"
          />
          <div class="checkbox-custom"></div>
          <div class="checkbox-content">
            <span>Noise Suppression</span>
            <small>Filters background noise</small>
          </div>
        </label>
      </div>

      <div class="setting-group checkbox-group">
        <label class="checkbox-label">
          <input 
            type="checkbox" 
            v-model="autoGainControl"
            @change="updateAudioSettings"
            class="setting-checkbox"
          />
          <div class="checkbox-custom"></div>
          <div class="checkbox-content">
            <span>Auto Gain Control</span>
            <small>Automatically adjusts microphone sensitivity</small>
          </div>
        </label>
      </div>
    </div>

    <!-- Video Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="video" />
        Video
      </h4>

      <div class="setting-group">
        <label class="setting-label">Camera</label>
        <select v-model="selectedVideoDevice" class="setting-select" @change="updateVideoSettings">
          <option value="">No Camera</option>
          <option v-for="device in videoDevices" :key="device.deviceId" :value="device.deviceId">
            {{ device.label || `Camera ${device.deviceId.slice(0, 8)}` }}
          </option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">Quality</label>
        <select v-model="videoQuality" class="setting-select" @change="updateVideoSettings">
          <option value="480p">480p (Standard)</option>
          <option value="720p">720p (HD)</option>
          <option value="1080p">1080p (Full HD)</option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">Frame Rate</label>
        <select v-model="frameRate" class="setting-select" @change="updateVideoSettings">
          <option value="15">15 FPS</option>
          <option value="30">30 FPS</option>
          <option value="60">60 FPS</option>
        </select>
      </div>

      <!-- Video Preview -->
      <div class="setting-group">
        <div class="video-preview">
          <video 
            ref="previewVideo"
            autoplay
            muted
            playsinline
            class="preview-stream"
          ></video>
          <div v-if="!previewStream" class="preview-placeholder">
            <Icon name="video-off" size="xl" />
            <span>Camera Preview</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { debug } from '@/utils/debug'
import { webrtcManager } from '@/services/webrtcManager';
import { unifiedWebRTC } from '@/services/unifiedWebRTC';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import { useKeybinds, type KeybindModifiers } from '@/composables/useKeybinds';
import Icon from '@/components/common/Icon.vue';

type InputMode = 'voice_activity' | 'push_to_talk';

interface Props {
  loading?: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
  'update-voice-settings': [settings: any];
}>();

// Centralized keybind system
const keybinds = useKeybinds();

// Local state for keybind recording
const isRecordingKeybind = ref(false);

// Computed refs for PTT settings
const inputMode = keybinds.inputMode;
const pttKeyDisplay = computed(() => keybinds.getKeybindDisplay('push-to-talk'));
const releaseDelay = keybinds.releaseDelay;
const localReleaseDelay = ref(keybinds.releaseDelay.value);

// Device lists
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const videoDevices = ref<MediaDeviceInfo[]>([]);

// Selected devices
const selectedInputDevice = ref('');
const selectedOutputDevice = ref('');
const selectedVideoDevice = ref('');

// Audio settings
const inputVolume = ref(75);
const outputVolume = ref(75);
const echoCancellation = ref(true);
const noiseSuppression = ref(true);
const autoGainControl = ref(true);

// Video settings
const videoQuality = ref('720p');
const frameRate = ref('30');

// Testing
const isTesting = ref(false);
const testLevel = ref(0);
const previewStream = ref<MediaStream | null>(null);
const previewVideo = ref<HTMLVideoElement | null>(null);

// PTT Functions
const setInputMode = (mode: InputMode) => {
  keybinds.setInputMode(mode);
  emit('update-voice-settings', { type: 'inputMode', value: mode });
};

const handleKeybindClick = () => {
  if (isRecordingKeybind.value) {
    isRecordingKeybind.value = false;
  } else {
    isRecordingKeybind.value = true;
  }
};

const handleKeybindKeydown = (event: KeyboardEvent) => {
  if (isRecordingKeybind.value) {
    event.preventDefault();
    
    // Ignore modifier-only keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return;
    }
    
    // Escape cancels
    if (event.code === 'Escape') {
      isRecordingKeybind.value = false;
      return;
    }
    
    // Record the keybind
    recordKey(event.code, {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    });
    event.stopPropagation();
  }
};

const handleKeybindMousedown = (event: MouseEvent) => {
  if (!isRecordingKeybind.value) return;
  
  // Only capture extra mouse buttons (3, 4, 5+) by default
  // Left (0), Middle (1), Right (2) are used for UI interaction
  if (event.button < 3) {
    // Allow capturing if user holds a modifier key
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      return;
    }
  }
  
  event.preventDefault();
  event.stopPropagation();
  
  const mouseKey = `Mouse${event.button}`;
  recordKey(mouseKey, {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  });
};

// Common function to record a key/mouse button
const recordKey = (key: string, modifiers: KeybindModifiers) => {
  keybinds.setKeybind('push-to-talk', key, modifiers);
  isRecordingKeybind.value = false;
};

// Cancel keybind recording
const cancelRecordingKeybind = () => {
  isRecordingKeybind.value = false;
};

const updateReleaseDelay = () => {
  keybinds.setReleaseDelay(localReleaseDelay.value);
};

// Sync local release delay with store
watch(releaseDelay, (newValue) => {
  localReleaseDelay.value = newValue;
}, { immediate: true });

const getDevices = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputDevices.value = devices.filter(d => d.kind === 'audioinput');
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');
    
    debug.log('🎛️ [VoiceSettingsInline] Enumerated devices:', {
      inputs: inputDevices.value.length,
      outputs: outputDevices.value.length,
      videos: videoDevices.value.length
    });

    // Now that we have devices, load and validate stored settings
    await loadStoredSettings();
  } catch (error) {
    debug.error('Error getting devices:', error);
  }
};

// Load stored settings - called AFTER devices are enumerated
const loadStoredSettings = async () => {
  try {
    const settings = VoiceSettingsService.getAll();
    const constraints = VoiceSettingsService.getAudioConstraints();
    
    echoCancellation.value = constraints.echoCancellation;
    noiseSuppression.value = constraints.noiseSuppression;
    autoGainControl.value = constraints.autoGainControl;
    
    if (settings.inputVolume !== undefined) inputVolume.value = settings.inputVolume;
    if (settings.outputVolume !== undefined) outputVolume.value = settings.outputVolume;
    if (settings.videoQuality) videoQuality.value = settings.videoQuality;
    if (settings.frameRate) frameRate.value = settings.frameRate;
    
    // Validate and apply device selections
    // Only select stored device if it exists in current device list
    const storedInputDevice = settings.selectedInputDevice;
    const storedOutputDevice = settings.selectedOutputDevice;
    const storedVideoDevice = settings.selectedVideoDevice;
    
    if (storedInputDevice && inputDevices.value.some(d => d.deviceId === storedInputDevice)) {
      selectedInputDevice.value = storedInputDevice;
      debug.log('🎤 [VoiceSettingsInline] Using stored input device:', storedInputDevice);
    } else if (inputDevices.value.length > 0) {
      // Fallback to first available device
      selectedInputDevice.value = inputDevices.value[0].deviceId;
      if (storedInputDevice) {
        debug.warn('⚠️ [VoiceSettingsInline] Stored input device not found, using default');
        VoiceSettingsService.setInputDevice(selectedInputDevice.value);
      }
    }
    
    if (storedOutputDevice && outputDevices.value.some(d => d.deviceId === storedOutputDevice)) {
      selectedOutputDevice.value = storedOutputDevice;
      debug.log('🔊 [VoiceSettingsInline] Using stored output device:', storedOutputDevice);
    } else if (outputDevices.value.length > 0) {
      // Fallback to first available device
      selectedOutputDevice.value = outputDevices.value[0].deviceId;
      if (storedOutputDevice) {
        debug.warn('⚠️ [VoiceSettingsInline] Stored output device not found, using default');
        VoiceSettingsService.setOutputDevice(selectedOutputDevice.value);
      }
    }
    
    if (storedVideoDevice && videoDevices.value.some(d => d.deviceId === storedVideoDevice)) {
      selectedVideoDevice.value = storedVideoDevice;
      debug.log('📹 [VoiceSettingsInline] Using stored video device:', storedVideoDevice);
    } else if (videoDevices.value.length > 0) {
      // Fallback to first available device
      selectedVideoDevice.value = videoDevices.value[0].deviceId;
      if (storedVideoDevice) {
        debug.warn('⚠️ [VoiceSettingsInline] Stored video device not found, using default');
        VoiceSettingsService.setVideoDevice(selectedVideoDevice.value);
      }
    }
    
    debug.log('🎛️ [VoiceSettingsInline] Loaded settings:', settings);
  } catch (error) {
    debug.warn('⚠️ Failed to load stored settings:', error);
  }
};

// Test microphone
const testMicrophone = async () => {
  if (isTesting.value) {
    stopTesting();
    return;
  }

  try {
    isTesting.value = true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedInputDevice.value }
    });

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    microphone.connect(analyser);
    analyser.fftSize = 256;

    const updateLevel = () => {
      if (!isTesting.value) return;
      
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      testLevel.value = (average / 255) * 100;
      
      requestAnimationFrame(updateLevel);
    };

    updateLevel();

    // Stop testing after 10 seconds
    setTimeout(() => {
      stopTesting();
      stream.getTracks().forEach(track => track.stop());
      audioContext.close();
    }, 10000);

  } catch (error) {
    debug.error('Error testing microphone:', error);
    isTesting.value = false;
  }
};

const stopTesting = () => {
  isTesting.value = false;
  testLevel.value = 0;
};

const updateVideoPreview = async () => {
  if (previewStream.value) {
    previewStream.value.getTracks().forEach(track => track.stop());
    previewStream.value = null;
  }

  if (selectedVideoDevice.value && previewVideo.value) {
    try {
      const constraints = {
        video: {
          deviceId: selectedVideoDevice.value,
          width: { ideal: videoQuality.value === '1080p' ? 1920 : videoQuality.value === '720p' ? 1280 : 640 },
          height: { ideal: videoQuality.value === '1080p' ? 1080 : videoQuality.value === '720p' ? 720 : 480 },
          frameRate: { ideal: parseInt(frameRate.value) }
        }
      };

      previewStream.value = await navigator.mediaDevices.getUserMedia(constraints);
      previewVideo.value.srcObject = previewStream.value;
    } catch (error) {
      debug.error('Error starting video preview:', error);
    }
  }
};

// Settings update handlers
const updateInputDevice = async () => {
  if (!selectedInputDevice.value) return;
  
  try {
    await webrtcManager.updateInputDevice(selectedInputDevice.value);
    debug.log('✅ Successfully switched to new input device');
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId: selectedInputDevice.value } }));
  } catch (error) {
    debug.error('❌ Failed to switch input device:', error);
  }
  
  saveSettings();
  emit('update-voice-settings', { type: 'inputDevice', value: selectedInputDevice.value });
};

const updateOutputDevice = async () => {
  if (!selectedOutputDevice.value) return;
  
  try {
    await webrtcManager.updateOutputDevice(selectedOutputDevice.value);
    debug.log('🔊 Successfully switched to new output device');
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'output', deviceId: selectedOutputDevice.value } }));
  } catch (error) {
    debug.error('❌ Failed to switch output device:', error);
  }
  
  saveSettings();
  emit('update-voice-settings', { type: 'outputDevice', value: selectedOutputDevice.value });
};

const updateInputVolume = () => {
  saveSettings();
  emit('update-voice-settings', { type: 'inputVolume', value: inputVolume.value });
};

const updateOutputVolume = () => {
  saveSettings();
  emit('update-voice-settings', { type: 'outputVolume', value: outputVolume.value });
};

const updateAudioSettings = () => {
  const audioConstraints = {
    echoCancellation: echoCancellation.value,
    noiseSuppression: noiseSuppression.value,
    autoGainControl: autoGainControl.value
  };
  
  unifiedWebRTC.updateAudioConstraints(audioConstraints);
  saveSettings();
  
  // Also emit for any parent components that might be listening
  emit('update-voice-settings', {
    type: 'audioConstraints',
    value: audioConstraints
  });
};

const updateVideoSettings = async () => {
  if (selectedVideoDevice.value) {
    try {
      await webrtcManager.updateVideoDevice(selectedVideoDevice.value);
      debug.log('📹 Successfully switched to new video device');
    } catch (error) {
      debug.error('❌ Failed to switch video device:', error);
    }
  }
  saveSettings();
  emit('update-voice-settings', {
    type: 'videoConstraints',
    value: {
      quality: videoQuality.value,
      frameRate: parseInt(frameRate.value)
    }
  });
  updateVideoPreview();
};

const saveSettings = () => {
  try {
    VoiceSettingsService.updateMany({
      selectedInputDevice: selectedInputDevice.value || null,
      selectedOutputDevice: selectedOutputDevice.value || null,
      selectedVideoDevice: selectedVideoDevice.value || null,
      inputVolume: inputVolume.value,
      outputVolume: outputVolume.value,
      echoCancellation: echoCancellation.value,
      noiseSuppression: noiseSuppression.value,
      autoGainControl: autoGainControl.value,
      videoQuality: videoQuality.value as '480p' | '720p' | '1080p',
      frameRate: frameRate.value
    });

    debug.log('💾 [VoiceSettingsInline] Saved settings via VoiceSettingsService');
  } catch (error) {
    debug.warn('⚠️ Failed to save settings:', error);
  }
};

// Watch for device changes
watch(selectedVideoDevice, updateVideoPreview);

// Lifecycle
const handleExternalDeviceChange = (e: Event) => {
  const { type, deviceId } = (e as CustomEvent).detail || {}
  if (!deviceId) return
  if (type === 'input' && deviceId !== selectedInputDevice.value) {
    selectedInputDevice.value = deviceId
  } else if (type === 'output' && deviceId !== selectedOutputDevice.value) {
    selectedOutputDevice.value = deviceId
  } else if (type === 'video' && deviceId !== selectedVideoDevice.value) {
    selectedVideoDevice.value = deviceId
  }
}

onMounted(() => {
  debug.log('🎛️ [VoiceSettingsInline] Component mounted, loading settings...');
  getDevices();
  navigator.mediaDevices.addEventListener('devicechange', getDevices);
  window.addEventListener('keydown', handleKeybindKeydown);
  window.addEventListener('mousedown', handleKeybindMousedown, { capture: true });
  window.addEventListener('harmony-device-changed', handleExternalDeviceChange);
});

onUnmounted(() => {
  navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  window.removeEventListener('keydown', handleKeybindKeydown);
  window.removeEventListener('mousedown', handleKeybindMousedown, { capture: true });
  window.removeEventListener('harmony-device-changed', handleExternalDeviceChange);
  if (previewStream.value) {
    previewStream.value.getTracks().forEach(track => track.stop());
  }
  stopTesting();
  // Cancel keybind recording if active
  if (isRecordingKeybind.value) {
    cancelRecordingKeybind();
  }
});
</script>

<style scoped>
.voice-settings-inline {
  width: 100%;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 20px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-primary);
}

.setting-group {
  margin-bottom: 20px;
}

.setting-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.setting-value {
  color: var(--harmony-primary);
  font-weight: 600;
}

.setting-select {
  width: 100%;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-secondary);
  font-size: 14px;
  transition: all 0.2s ease;
}

.setting-select:focus {
  outline: none;
  border-color: var(--harmony-primary);
  background: var(--background-secondary);
}

.volume-control {
  position: relative;
}

.setting-slider {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}

.setting-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: var(--harmony-primary);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.volume-indicator {
  position: absolute;
  top: 10px;
  left: 0;
  height: 6px;
  background: var(--harmony-primary);
  border-radius: 3px;
  pointer-events: none;
  transition: width 0.1s ease;
}

.checkbox-group {
  margin-bottom: 16px;
}

.checkbox-label {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  padding: 12px;
  border-radius: 8px;
  transition: background 0.2s ease;
}

.checkbox-label:hover {
  background: rgba(255, 255, 255, 0.02);
}

.setting-checkbox {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.checkbox-custom {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-muted);
  border-radius: 4px;
  background: transparent;
  position: relative;
  transition: all 0.2s ease;
  flex-shrink: 0;
  margin-top: 2px;
}

.setting-checkbox:checked + .checkbox-custom {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.setting-checkbox:checked + .checkbox-custom::after {
  content: '✓';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: bold;
}

.checkbox-content {
  flex: 1;
}

.checkbox-content span {
  display: block;
  color: var(--text-secondary);
  font-weight: 500;
  margin-bottom: 4px;
}

.checkbox-content small {
  color: var(--text-secondary);
  font-size: 12px;
}

.audio-test {
  display: flex;
  align-items: center;
  gap: 12px;
}

.test-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-btn:hover {
  background: var(--harmony-primary-hover);
}

.test-btn.active {
  background: var(--harmony-primary-hover);
}

.test-indicator {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.test-level {
  height: 100%;
  background: var(--harmony-primary);
  transition: width 0.1s ease;
}

.video-preview {
  width: 100%;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-stream {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-placeholder {
  display: flex;
  position: absolute;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
}

/* Input Mode Styles */
.input-mode-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.input-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 2px solid var(--border-primary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.input-mode-option:hover {
  background: var(--background-secondary);
  border-color: var(--border-hover);
}

.input-mode-option.active {
  background: var(--harmony-primary-light);
  border-color: var(--harmony-primary);
}

.radio-custom {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-muted);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
  transition: all 0.2s ease;
}

.radio-custom.checked {
  border-color: var(--harmony-primary);
}

.radio-inner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: transparent;
  transition: all 0.2s ease;
}

.radio-custom.checked .radio-inner {
  background: var(--harmony-primary);
}

.mode-content {
  flex: 1;
}

.mode-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.mode-description {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.ptt-settings {
  padding-top: 16px;
  border-top: 1px solid var(--border-primary);
}

.keybind-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.keybind-button:hover {
  background: var(--background-secondary);
  border-color: var(--border-hover);
}

.keybind-button.recording {
  background: var(--harmony-primary-light);
  border-color: var(--harmony-primary);
  color: var(--harmony-primary);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.setting-hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.8;
}
</style>
