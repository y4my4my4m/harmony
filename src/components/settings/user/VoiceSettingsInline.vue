<template>
  <div class="voice-settings-inline">
    <!-- Audio Settings -->
    <div class="settings-section">
      <h4 class="section-title">
        <Icon name="mic" />
        Audio
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
        <Icon name="camera" />
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
            <Icon name="camera-off" size="xl" />
            <span>Camera Preview</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { debug } from '@/utils/debug'
import { unifiedWebRTC } from '@/services/unifiedWebRTC';
import Icon from '@/components/common/Icon.vue';

interface Props {
  loading?: boolean;
}

defineProps<Props>();

const emit = defineEmits<{
  'update-voice-settings': [settings: any];
}>();

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

// Get available devices
const getDevices = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputDevices.value = devices.filter(d => d.kind === 'audioinput');
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');

    // Set defaults if not already set
    if (!selectedInputDevice.value && inputDevices.value.length > 0) {
      selectedInputDevice.value = inputDevices.value[0].deviceId;
    }
    if (!selectedOutputDevice.value && outputDevices.value.length > 0) {
      selectedOutputDevice.value = outputDevices.value[0].deviceId;
    }
    if (!selectedVideoDevice.value && videoDevices.value.length > 0) {
      selectedVideoDevice.value = videoDevices.value[0].deviceId;
    }
  } catch (error) {
    debug.error('Error getting devices:', error);
  }
};

// Load stored settings
const loadStoredSettings = () => {
  try {
    // Load from WebRTC service first (most up-to-date)
    const currentConstraints = unifiedWebRTC.getAudioConstraints();
    echoCancellation.value = currentConstraints.echoCancellation;
    noiseSuppression.value = currentConstraints.noiseSuppression;
    autoGainControl.value = currentConstraints.autoGainControl;
    
    // Then load other settings from localStorage
    const stored = localStorage.getItem('harmony-voice-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      
      // Load other settings if they exist
      if (settings.inputVolume !== undefined) inputVolume.value = settings.inputVolume;
      if (settings.outputVolume !== undefined) outputVolume.value = settings.outputVolume;
      if (settings.selectedInputDevice) selectedInputDevice.value = settings.selectedInputDevice;
      if (settings.selectedOutputDevice) selectedOutputDevice.value = settings.selectedOutputDevice;
      if (settings.selectedVideoDevice) selectedVideoDevice.value = settings.selectedVideoDevice;
      if (settings.videoQuality) videoQuality.value = settings.videoQuality;
      if (settings.frameRate) frameRate.value = settings.frameRate;
    }
    
    debug.log('🎛️ [VoiceSettingsInline] Loaded settings - Audio constraints:', currentConstraints);
    debug.log('🎛️ [VoiceSettingsInline] Loaded localStorage settings:', stored ? JSON.parse(stored) : 'None');
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

// Update video preview
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
    // Use the WebRTC service method to properly switch devices
    await unifiedWebRTC.updateInputDevice(selectedInputDevice.value);
    debug.log('✅ Successfully switched to new input device');
  } catch (error) {
    debug.error('❌ Failed to switch input device:', error);
    // Could show user notification here
  }
  
  saveSettings();
  emit('update-voice-settings', { type: 'inputDevice', value: selectedInputDevice.value });
};

const updateOutputDevice = async () => {
  if (!selectedOutputDevice.value) return;
  
  try {
    // Use the WebRTC service method to properly switch output devices
    await unifiedWebRTC.updateOutputDevice(selectedOutputDevice.value);
    debug.log('🔊 Successfully switched to new output device');
  } catch (error) {
    debug.error('❌ Failed to switch output device:', error);
    // Could show user notification here
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
  
  // Update WebRTC service directly
  unifiedWebRTC.updateAudioConstraints(audioConstraints);
  saveSettings();
  
  // Also emit for any parent components that might be listening
  emit('update-voice-settings', {
    type: 'audioConstraints',
    value: audioConstraints
  });
};

const updateVideoSettings = () => {
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
    const settings = {
      selectedInputDevice: selectedInputDevice.value,
      selectedOutputDevice: selectedOutputDevice.value,
      selectedVideoDevice: selectedVideoDevice.value,
      inputVolume: inputVolume.value,
      outputVolume: outputVolume.value,
      echoCancellation: echoCancellation.value,
      noiseSuppression: noiseSuppression.value,
      autoGainControl: autoGainControl.value,
      videoQuality: videoQuality.value,
      frameRate: frameRate.value
    };

    localStorage.setItem('harmony-voice-settings', JSON.stringify(settings));
    debug.log('💾 [VoiceSettingsInline] Saved settings:', settings);
  } catch (error) {
    debug.warn('⚠️ Failed to save settings:', error);
  }
};

// Watch for device changes
watch(selectedVideoDevice, updateVideoPreview);

// Lifecycle
onMounted(() => {
  debug.log('🎛️ [VoiceSettingsInline] Component mounted, loading settings...');
  getDevices();
  loadStoredSettings();
  navigator.mediaDevices.addEventListener('devicechange', getDevices);
});

onUnmounted(() => {
  navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  if (previewStream.value) {
    previewStream.value.getTracks().forEach(track => track.stop());
  }
  stopTesting();
});
</script>

<style scoped>
.voice-settings-inline {
  width: 100%;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat, rgba(255, 255, 255, 0.05));
  border-radius: 8px;
  border: 1px solid var(--h-chat-light, rgba(255, 255, 255, 0.1));
}

.section-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
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
  color: #5865f2;
  font-weight: 600;
}

.setting-select {
  width: 100%;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-secondary);
  font-size: 14px;
  transition: all 0.2s ease;
}

.setting-select:focus {
  outline: none;
  border-color: #5865f2;
  background: rgba(255, 255, 255, 0.08);
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
  box-shadow: 0 2px 8px rgba(88, 101, 242, 0.3);
}

.volume-indicator {
  position: absolute;
  top: 10px;
  left: 0;
  height: 6px;
  background: linear-gradient(90deg, #00d4aa, #5865f2);
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
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: transparent;
  position: relative;
  transition: all 0.2s ease;
  flex-shrink: 0;
  margin-top: 2px;
}

.setting-checkbox:checked + .checkbox-custom {
  background: var(--harmony-primary);
  border-color: #5865f2;
}

.setting-checkbox:checked + .checkbox-custom::after {
  content: '✓';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
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
  color: white;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-btn:hover {
  background: #4752c4;
}

.test-btn.active {
  background: #00d4aa;
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
  background: linear-gradient(90deg, #00d4aa, #5865f2);
  transition: width 0.1s ease;
}

.video-preview {
  width: 100%;
  height: 200px;
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
</style>
