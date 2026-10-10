<template>
  <div class="voice-settings-inline">
    <!-- Input Mode Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="mic" />
        Input mode
      </h4>
      
      <VoiceInputModeSettings @input-mode-change="onInputModeChange" />
    </div>

    <!-- Audio Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="volume-2" />
        Audio devices
      </h4>
      
      <div class="setting-group">
        <label class="setting-label">Input device</label>
        <select v-model="selectedInputDevice" class="setting-select" @change="updateInputDevice">
          <option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">
            {{ device.label || `Microphone ${device.deviceId.slice(0, 8)}` }}
          </option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">Output device</label>
        <select v-model="selectedOutputDevice" class="setting-select" @change="updateOutputDevice">
          <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">
            {{ device.label || `Speaker ${device.deviceId.slice(0, 8)}` }}
          </option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          Input volume
          <span class="setting-value">{{ inputVolume }}%</span>
        </label>
        <div class="volume-control">
          <input
            type="range"
            v-model.number="inputVolume"
            min="0"
            max="200"
            class="setting-slider"
            @input="updateInputVolume"
            @dblclick="resetInputVolume"
          />
          <div class="volume-indicator" :style="{ width: `${inputVolume / 2}%` }"></div>
        </div>
        <small class="setting-hint">
          {{ t('voice.inputVolumeHint') }}
          <template v-if="autoGainControl">{{ t('voice.inputVolumeAgcHint') }}</template>
        </small>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          Output volume
          <span class="setting-value">{{ outputVolume }}%</span>
        </label>
        <div class="volume-control">
          <input
            type="range"
            v-model.number="outputVolume"
            min="0"
            max="200"
            class="setting-slider"
            @input="updateOutputVolume"
            @dblclick="resetOutputVolume"
          />
          <div class="volume-indicator" :style="{ width: `${outputVolume / 2}%` }"></div>
        </div>
      </div>

      <!-- Audio Test -->
      <div class="setting-group">
        <div class="audio-test">
          <button @click="micTest.toggle(selectedInputDevice || null, inputVolume)" class="test-btn" :class="{ active: isTesting }">
            <Icon name="mic" />
            {{ isTesting ? 'Testing...' : 'Test microphone' }}
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
        Audio quality
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
            <span>Echo cancellation</span>
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
            <span>Noise suppression</span>
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
            <span>Auto gain control</span>
            <small>Automatically adjusts microphone sensitivity</small>
          </div>
        </label>
      </div>
    </div>

    <!-- Streams -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="screen-share" />
        {{ t('voice.streamSettings') }}
      </h4>

      <div class="setting-group checkbox-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            v-model="autoWatchStreams"
            @change="updateAutoWatchStreams"
            class="setting-checkbox"
          />
          <div class="checkbox-custom"></div>
          <div class="checkbox-content">
            <span>{{ t('voice.autoWatchStreams') }}</span>
            <small>{{ t('voice.autoWatchStreamsHint') }}</small>
          </div>
        </label>
      </div>
    </div>

    <!-- Soundboard -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="music" />
        {{ t('soundboard.title') }}
      </h4>

      <div class="setting-group">
        <label class="setting-label">
          {{ t('soundboard.volume') }}
          <span class="setting-value">{{ soundboardVolume }}%</span>
        </label>
        <div class="volume-control">
          <input
            type="range"
            v-model.number="soundboardVolume"
            min="0"
            max="100"
            class="setting-slider"
            :aria-label="t('soundboard.volume')"
            @input="updateSoundboardVolume"
            @dblclick="soundboardVolume = 100; updateSoundboardVolume()"
          />
          <div class="volume-indicator" :style="{ width: `${soundboardVolume}%` }"></div>
        </div>
      </div>

      <div class="setting-group checkbox-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            v-model="soundboardMuted"
            @change="updateSoundboardMuted"
            class="setting-checkbox"
          />
          <div class="checkbox-custom"></div>
          <div class="checkbox-content">
            <span>{{ t('soundboard.mute') }}</span>
            <small>{{ t('soundboard.muteHint') }}</small>
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
          <option value="">No camera</option>
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
        <label class="setting-label">Frame rate</label>
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
            <span>Camera preview</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { enumerateMediaDevices } from '@/utils/mediaDevices';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { webrtcManager } from '@/services/webrtcManager';
import { VoiceSettingsService, normalizeInputVolume, normalizeOutputVolume } from '@/services/VoiceSettingsService';
import { useMicTest } from '@/composables/useMicTest';
import { useSoundboardSettings } from '@/composables/useSoundboardSettings';
import Icon from '@/components/common/Icon.vue';
import VoiceInputModeSettings from '@/components/voice/VoiceInputModeSettings.vue';

interface Props {
  loading?: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
  'update-voice-settings': [settings: any];
}>();

const { t } = useI18n();

function onInputModeChange(mode: 'voice_activity' | 'push_to_talk') {
  emit('update-voice-settings', { type: 'inputMode', value: mode });
}

// Device lists
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const videoDevices = ref<MediaDeviceInfo[]>([]);

// Selected devices
const selectedInputDevice = ref('');
const selectedOutputDevice = ref('');
const selectedVideoDevice = ref('');

// Audio settings
// Outgoing mic, percent 0-200; 100 sends the capture untouched.
const inputVolume = ref(100);
// Master output, percent 0-200; applied to every remote track at once.
const outputVolume = ref(100);
const autoWatchStreams = ref(false);
const { soundboardVolume, soundboardMuted, updateSoundboardVolume, updateSoundboardMuted } = useSoundboardSettings();
const echoCancellation = ref(true);
const noiseSuppression = ref(true);
const autoGainControl = ref(true);

// Video settings
const videoQuality = ref('720p');
const frameRate = ref('30');

// Testing
// Post-gain meter: the level a call would send.
const micTest = useMicTest();
const { isTesting, testLevel } = micTest;
const previewStream = ref<MediaStream | null>(null);
const previewVideo = ref<HTMLVideoElement | null>(null);


const getDevices = async () => {
  try {
    const devices = await enumerateMediaDevices();
    inputDevices.value = devices.filter(d => d.kind === 'audioinput');
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');
    
    debug.log('[VoiceSettingsInline] Enumerated devices:', {
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
    
    inputVolume.value = normalizeInputVolume(settings.inputVolume);
    outputVolume.value = normalizeOutputVolume(settings.outputVolume);
    autoWatchStreams.value = !!settings.autoWatchStreams;
    if (settings.videoQuality) videoQuality.value = settings.videoQuality;
    if (settings.frameRate) frameRate.value = settings.frameRate;
    
    // Validate and apply device selections
    // Only select stored device if it exists in current device list
    const storedInputDevice = settings.selectedInputDevice;
    const storedOutputDevice = settings.selectedOutputDevice;
    const storedVideoDevice = settings.selectedVideoDevice;
    
    if (storedInputDevice && inputDevices.value.some(d => d.deviceId === storedInputDevice)) {
      selectedInputDevice.value = storedInputDevice;
      debug.log('[VoiceSettingsInline] Using stored input device:', storedInputDevice);
    } else if (inputDevices.value.length > 0) {
      // Fallback to first available device
      selectedInputDevice.value = inputDevices.value[0].deviceId;
      if (storedInputDevice) {
        debug.warn('[VoiceSettingsInline] Stored input device not found, using default');
        VoiceSettingsService.setInputDevice(selectedInputDevice.value);
      }
    }
    
    if (storedOutputDevice && outputDevices.value.some(d => d.deviceId === storedOutputDevice)) {
      selectedOutputDevice.value = storedOutputDevice;
      debug.log('[VoiceSettingsInline] Using stored output device:', storedOutputDevice);
    } else if (outputDevices.value.length > 0) {
      // Fallback to first available device
      selectedOutputDevice.value = outputDevices.value[0].deviceId;
      if (storedOutputDevice) {
        debug.warn('[VoiceSettingsInline] Stored output device not found, using default');
        VoiceSettingsService.setOutputDevice(selectedOutputDevice.value);
      }
    }
    
    if (storedVideoDevice && videoDevices.value.some(d => d.deviceId === storedVideoDevice)) {
      selectedVideoDevice.value = storedVideoDevice;
      debug.log('[VoiceSettingsInline] Using stored video device:', storedVideoDevice);
    } else if (videoDevices.value.length > 0) {
      // Fallback to first available device
      selectedVideoDevice.value = videoDevices.value[0].deviceId;
      if (storedVideoDevice) {
        debug.warn('[VoiceSettingsInline] Stored video device not found, using default');
        VoiceSettingsService.setVideoDevice(selectedVideoDevice.value);
      }
    }
    
    debug.log('[VoiceSettingsInline] Loaded settings:', settings);
  } catch (error) {
    debug.warn('Failed to load stored settings:', error);
  }
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
    debug.log('Successfully switched to new input device');
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId: selectedInputDevice.value } }));
  } catch (error) {
    debug.error('Failed to switch input device:', error);
  }
  
  saveSettings();
  emit('update-voice-settings', { type: 'inputDevice', value: selectedInputDevice.value });
};

const updateOutputDevice = async () => {
  if (!selectedOutputDevice.value) return;
  
  try {
    await webrtcManager.updateOutputDevice(selectedOutputDevice.value);
    debug.log('Successfully switched to new output device');
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'output', deviceId: selectedOutputDevice.value } }));
  } catch (error) {
    debug.error('Failed to switch output device:', error);
  }
  
  saveSettings();
  emit('update-voice-settings', { type: 'outputDevice', value: selectedOutputDevice.value });
};

const updateInputVolume = () => {
  inputVolume.value = normalizeInputVolume(inputVolume.value);
  webrtcManager.setInputVolume(inputVolume.value);
  micTest.setInputVolume(inputVolume.value);
  saveSettings();
  emit('update-voice-settings', { type: 'inputVolume', value: inputVolume.value });
};

const updateOutputVolume = () => {
  outputVolume.value = normalizeOutputVolume(outputVolume.value);
  webrtcManager.setMasterVolume(outputVolume.value);
  saveSettings();
  emit('update-voice-settings', { type: 'outputVolume', value: outputVolume.value });
};

const resetInputVolume = () => {
  inputVolume.value = 100;
  updateInputVolume();
};

const resetOutputVolume = () => {
  outputVolume.value = 100;
  updateOutputVolume();
};

const updateAutoWatchStreams = () => {
  VoiceSettingsService.update('autoWatchStreams', autoWatchStreams.value);
  webrtcManager.setAutoWatchStreams(autoWatchStreams.value);
};

const updateAudioSettings = () => {
  const audioConstraints = {
    echoCancellation: echoCancellation.value,
    noiseSuppression: noiseSuppression.value,
    autoGainControl: autoGainControl.value
  };
  
  // Applies to a live mic on either transport, not only P2P.
  void webrtcManager.updateAudioConstraints(audioConstraints);
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
      debug.log('Successfully switched to new video device');
    } catch (error) {
      debug.error('Failed to switch video device:', error);
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

    debug.log('[VoiceSettingsInline] Saved settings via VoiceSettingsService');
  } catch (error) {
    debug.warn('Failed to save settings:', error);
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
  debug.log('[VoiceSettingsInline] Component mounted, loading settings...');
  getDevices();
  navigator.mediaDevices.addEventListener('devicechange', getDevices);
  window.addEventListener('harmony-device-changed', handleExternalDeviceChange);
});

onUnmounted(() => {
  navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  window.removeEventListener('harmony-device-changed', handleExternalDeviceChange);
  if (previewStream.value) {
    previewStream.value.getTracks().forEach(track => track.stop());
  }
  micTest.stop();
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

/* Containing block for the hidden input. Without it the input resolves
   against .user-settings-container, outside the .settings-content scroller,
   and focusing it scrolls that overflow:hidden container. */
.checkbox-label {
  position: relative;
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
  /* Self view reads as a mirror; the published track is not flipped. */
  transform: scaleX(-1);
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
