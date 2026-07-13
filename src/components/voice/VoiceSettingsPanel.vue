<template>
  <div class="settings-overlay" @click.self="$emit('close')">
    <div class="settings-panel">
      <div class="settings-header">
        <h3>Voice & Video Settings</h3>
        <button @click="$emit('close')" class="close-btn">
          <Icon name="x" />
        </button>
      </div>

      <div class="settings-content">
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
            <Icon name="video" />
            Video
          </h4>

          <div class="setting-group">
            <label class="setting-label">Camera</label>
            <select v-model="selectedVideoDevice" class="setting-select">
              <option value="">No Camera</option>
              <option v-for="device in videoDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label || `Camera ${device.deviceId.slice(0, 8)}` }}
              </option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">Resolution</label>
            <select v-model="videoQuality" class="setting-select" @change="updateVideoSettings">
              <option value="360p">360p (Low)</option>
              <option value="480p">480p (SD)</option>
              <option value="720p">720p (HD)</option>
              <option value="1080p">1080p (Full HD)</option>
              <option value="source">Source (Native)</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">Frame Rate</label>
            <select v-model="frameRate" class="setting-select" @change="updateVideoSettings">
              <option value="10">10 FPS (Low)</option>
              <option value="15">15 FPS</option>
              <option value="24">24 FPS (Cinema)</option>
              <option value="30">30 FPS</option>
              <option value="60">60 FPS</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">Audio Bitrate</label>
            <select v-model="audioBitrate" class="setting-select" @change="updateVideoSettings">
              <option value="32">32 kbps (Low)</option>
              <option value="64">64 kbps (Voice)</option>
              <option value="128">128 kbps (Standard)</option>
              <option value="256">256 kbps (High)</option>
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

        <div class="settings-section">
          <h4 class="section-title">
            <Icon name="mic" />
            Input Mode
          </h4>
          <VoiceInputModeSettings />
        </div>

        <!-- Keybinds - Hidden on touch devices -->
        <div v-if="!isTouchDevice" class="settings-section keybinds-section">
          <h4 class="section-title">
            <Icon name="keyboard" />
            Keybinds
          </h4>
          <p class="keybind-hint">Active when voice overlay is open</p>

          <div class="keybind-list">
            <div class="keybind-item">
              <span>Toggle Mute</span>
              <div class="keybind-combo">
                <kbd>M</kbd>
              </div>
            </div>
            <div class="keybind-item">
              <span>Toggle Deafen</span>
              <div class="keybind-combo">
                <kbd>D</kbd>
              </div>
            </div>
            <div class="keybind-item">
              <span>Toggle Camera</span>
              <div class="keybind-combo">
                <kbd>V</kbd>
              </div>
            </div>
            <div class="keybind-item">
              <span>Toggle Screen Share</span>
              <div class="keybind-combo">
                <kbd>S</kbd>
              </div>
            </div>
            <div class="keybind-item">
              <span>Voice Settings</span>
              <div class="keybind-combo">
                <kbd>,</kbd>
              </div>
            </div>
            <div class="keybind-item">
              <span>Exit / Close</span>
              <div class="keybind-combo">
                <kbd>Esc</kbd>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-footer">
        <button @click="resetSettings" class="reset-btn">
          Reset to Default
        </button>
        <div class="footer-actions">
          <button @click="$emit('close')" class="cancel-btn">
            Cancel
          </button>
          <button @click="saveSettings" class="save-btn">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useViewport } from '@/composables/useViewport';
import { enumerateMediaDevices } from '@/utils/mediaDevices';
import { webrtcManager } from '@/services/webrtcManager';
import { unifiedWebRTC } from '@/services/unifiedWebRTC';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import { debug } from '@/utils/debug';
import Icon from '@/components/common/Icon.vue';
import VoiceInputModeSettings from './VoiceInputModeSettings.vue';

export default defineComponent({
  name: 'VoiceSettingsPanel',
  components: { Icon, VoiceInputModeSettings },
  emits: ['close', 'update-settings'],
  setup(props, { emit }) {
    const inputDevices = ref<MediaDeviceInfo[]>([]);
    const outputDevices = ref<MediaDeviceInfo[]>([]);
    const videoDevices = ref<MediaDeviceInfo[]>([]);

    const selectedInputDevice = ref('');
    const selectedOutputDevice = ref('');
    const selectedVideoDevice = ref('');

    const inputVolume = ref(75);
    const outputVolume = ref(75);
    const echoCancellation = ref(true);
    const noiseSuppression = ref(true);
    const autoGainControl = ref(true);

    const videoQuality = ref('720p');
    const frameRate = ref('30');
    const audioBitrate = ref('128');

    const isTesting = ref(false);
    const testLevel = ref(0);
    const previewStream = ref<MediaStream | null>(null);
    const previewVideo = ref<HTMLVideoElement | null>(null);

    // Hide keybinds section on touch devices
    const { isMobileViewport, isTouchOnly } = useViewport();
    const isTouchDevice = computed(() => isMobileViewport.value || isTouchOnly);

    const getDevices = async () => {
      try {
        const devices = await enumerateMediaDevices();
        inputDevices.value = devices.filter(d => d.kind === 'audioinput');
        outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
        videoDevices.value = devices.filter(d => d.kind === 'videoinput');

        debug.log('[VoiceSettingsPanel] Enumerated devices:', {
          inputs: inputDevices.value.length,
          outputs: outputDevices.value.length,
          videos: videoDevices.value.length
        });

        await loadStoredSettings();
      } catch (error) {
        debug.error('Error getting devices:', error);
      }
    };

    // Called AFTER devices are enumerated
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
        if (settings.audioBitrate) audioBitrate.value = settings.audioBitrate;
        
        const storedInputDevice = settings.selectedInputDevice;
        const storedOutputDevice = settings.selectedOutputDevice;
        const storedVideoDevice = settings.selectedVideoDevice;
        
        if (storedInputDevice && inputDevices.value.some(d => d.deviceId === storedInputDevice)) {
          selectedInputDevice.value = storedInputDevice;
          debug.log('[VoiceSettingsPanel] Using stored input device:', storedInputDevice);
        } else if (inputDevices.value.length > 0) {
          selectedInputDevice.value = inputDevices.value[0].deviceId;
          if (storedInputDevice) {
            debug.warn('[VoiceSettingsPanel] Stored input device not found, using default');
            VoiceSettingsService.setInputDevice(selectedInputDevice.value);
          }
        }
        
        if (storedOutputDevice && outputDevices.value.some(d => d.deviceId === storedOutputDevice)) {
          selectedOutputDevice.value = storedOutputDevice;
          debug.log('[VoiceSettingsPanel] Using stored output device:', storedOutputDevice);
        } else if (outputDevices.value.length > 0) {
          selectedOutputDevice.value = outputDevices.value[0].deviceId;
          if (storedOutputDevice) {
            debug.warn('[VoiceSettingsPanel] Stored output device not found, using default');
            VoiceSettingsService.setOutputDevice(selectedOutputDevice.value);
          }
        }
        
        if (storedVideoDevice && videoDevices.value.some(d => d.deviceId === storedVideoDevice)) {
          selectedVideoDevice.value = storedVideoDevice;
          debug.log('[VoiceSettingsPanel] Using stored video device:', storedVideoDevice);
        } else if (videoDevices.value.length > 0) {
          selectedVideoDevice.value = videoDevices.value[0].deviceId;
          if (storedVideoDevice) {
            debug.warn('[VoiceSettingsPanel] Stored video device not found, using default');
            VoiceSettingsService.setVideoDevice(selectedVideoDevice.value);
          }
        }
        
        debug.log('[VoiceSettingsPanel] Loaded settings:', settings);
      } catch (error) {
        debug.warn('Failed to load stored settings:', error);
      }
    };

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

    const updateInputDevice = async () => {
      if (!selectedInputDevice.value) return;
      
      try {
        await webrtcManager.updateInputDevice(selectedInputDevice.value);
        debug.log('[VoiceSettingsPanel] Successfully switched to new input device');
        window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId: selectedInputDevice.value } }));
      } catch (error) {
        debug.error('[VoiceSettingsPanel] Failed to switch input device:', error);
      }
      
      VoiceSettingsService.setInputDevice(selectedInputDevice.value);
      
      emit('update-settings', { type: 'inputDevice', value: selectedInputDevice.value });
    };

    const updateOutputDevice = async () => {
      if (!selectedOutputDevice.value) return;
      
      try {
        await webrtcManager.updateOutputDevice(selectedOutputDevice.value);
        debug.log('[VoiceSettingsPanel] Successfully switched to new output device');
        window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'output', deviceId: selectedOutputDevice.value } }));
      } catch (error) {
        debug.error('[VoiceSettingsPanel] Failed to switch output device:', error);
      }
      
      VoiceSettingsService.setOutputDevice(selectedOutputDevice.value);
      
      emit('update-settings', { type: 'outputDevice', value: selectedOutputDevice.value });
    };

    const updateInputVolume = () => {
      VoiceSettingsService.update('inputVolume', inputVolume.value);
      emit('update-settings', { type: 'inputVolume', value: inputVolume.value });
    };

    const updateOutputVolume = () => {
      VoiceSettingsService.update('outputVolume', outputVolume.value);
      emit('update-settings', { type: 'outputVolume', value: outputVolume.value });
    };

    const updateAudioSettings = () => {
      const audioConstraints = {
        echoCancellation: echoCancellation.value,
        noiseSuppression: noiseSuppression.value,
        autoGainControl: autoGainControl.value
      };
      
      unifiedWebRTC.updateAudioConstraints(audioConstraints);

      emit('update-settings', {
        type: 'audioConstraints',
        value: audioConstraints
      });
    };

    const updateVideoSettings = () => {
      const qualityToResolution: Record<string, number> = {
        '360p': 360,
        '480p': 480,
        '720p': 720,
        '1080p': 1080,
        'source': -1, // -1 means native/source
      };
      
      VoiceSettingsService.updateMany({
        videoQuality: videoQuality.value as '480p' | '720p' | '1080p',
        frameRate: frameRate.value,
        audioBitrate: audioBitrate.value,
      });
      
      emit('update-settings', {
        type: 'streamQuality',
        value: {
          resolution: qualityToResolution[videoQuality.value] ?? 720,
          frameRate: parseInt(frameRate.value),
          audioBitrate: parseInt(audioBitrate.value)
        }
      });
      updateVideoPreview();
    };

    const resetSettings = () => {
      inputVolume.value = 75;
      outputVolume.value = 75;
      echoCancellation.value = true;
      noiseSuppression.value = true;
      autoGainControl.value = true;
      videoQuality.value = '720p';
      frameRate.value = '30';
      audioBitrate.value = '128';
    };

    const saveSettings = () => {
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
        frameRate: frameRate.value,
        audioBitrate: audioBitrate.value
      };

      emit('update-settings', { type: 'saveAll', value: settings });
      emit('close');
    };

    watch(selectedVideoDevice, updateVideoPreview);

    const handleExternalDeviceChange = (e: Event) => {
      const { type, deviceId } = (e as CustomEvent).detail || {};
      if (!deviceId) return;
      if (type === 'input' && deviceId !== selectedInputDevice.value) {
        selectedInputDevice.value = deviceId;
      } else if (type === 'output' && deviceId !== selectedOutputDevice.value) {
        selectedOutputDevice.value = deviceId;
      } else if (type === 'video' && deviceId !== selectedVideoDevice.value) {
        selectedVideoDevice.value = deviceId;
      }
    };

    onMounted(() => {
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
      stopTesting();
    });

    return {
      inputDevices,
      outputDevices,
      videoDevices,
      selectedInputDevice,
      selectedOutputDevice,
      selectedVideoDevice,
      inputVolume,
      outputVolume,
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      videoQuality,
      frameRate,
      audioBitrate,
      isTesting,
      testLevel,
      previewStream,
      previewVideo,
      isTouchDevice,
      testMicrophone,
      updateInputDevice,
      updateOutputDevice,
      updateInputVolume,
      updateOutputVolume,
      updateAudioSettings,
      updateVideoSettings,
      resetSettings,
      saveSettings
    };
  }
});
</script>

<style scoped>
.settings-overlay {
  position: static;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.settings-panel {
  background: var(--background-quinary);
  border-radius: 12px;
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-modal);
  width: 90vw;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid var(--border-primary);
}

.settings-header h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.settings-content {
  flex: 1;
  padding: 24px 32px;
  overflow-y: auto;
}

.settings-section {
  margin-bottom: 32px;
}

.settings-section:last-child {
  margin-bottom: 0;
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
  position:absolute;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
}

.keybind-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 12px 0;
  font-style: italic;
}

.keybind-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.keybind-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  color: var(--text-secondary);
}

.keybind-combo {
  display: flex;
  gap: 4px;
}

kbd {
  background: var(--background-tertiary);
  border: 1px solid var(--border-hover);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: monospace;
  color: var(--text-secondary);
}

.settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 32px;
  border-top: 1px solid var(--border-primary);
  background: var(--background-tertiary);
}

.reset-btn {
  background: none;
  border: 1px solid var(--border-hover);
  border-radius: 8px;
  padding: 8px 16px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.reset-btn:hover {
  border-color: var(--error);
  color: var(--error);
}

.footer-actions {
  display: flex;
  gap: 12px;
}

.cancel-btn {
  background: none;
  border: 1px solid var(--border-hover);
  border-radius: 8px;
  padding: 8px 16px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-btn:hover {
  background: var(--background-quaternary);
}

.save-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: 8px;
  padding: 8px 20px;
  color: var(--text-primary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.save-btn:hover {
  background: var(--harmony-primary-hover);
}

.settings-content::-webkit-scrollbar {
  width: 6px;
}

.settings-content::-webkit-scrollbar-track {
  background: transparent;
}

.settings-content::-webkit-scrollbar-thumb {
  background: var(--border-hover);
  border-radius: 3px;
}

.settings-content::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* ============================================
   MOBILE RESPONSIVE STYLES
   ============================================ */

/* Tablet */
@media (max-width: 768px) {
  .settings-panel {
    width: 95vw;
    max-height: 90vh;
  }
  
  .settings-header {
    padding: 16px 20px;
  }
  
  .settings-header h3 {
    font-size: 18px;
  }
  
  .settings-content {
    padding: 16px 20px;
  }
  
  .settings-section {
    margin-bottom: 24px;
  }
  
  .section-title {
    font-size: 15px;
    margin-bottom: 16px;
  }
  
  .setting-group {
    margin-bottom: 16px;
  }
  
  .setting-select {
    padding: 14px 16px;
    font-size: 16px; /* Prevent iOS zoom */
  }
  
  /* Larger slider thumb for touch */
  .setting-slider::-webkit-slider-thumb {
    width: 24px;
    height: 24px;
  }
  
  .setting-slider::-moz-range-thumb {
    width: 24px;
    height: 24px;
  }
  
  /* Larger checkbox targets */
  .checkbox-label {
    padding: 14px;
    min-height: 56px;
  }
  
  .checkbox-custom {
    width: 24px;
    height: 24px;
  }
  
  .video-preview {
    height: 180px;
  }
  
  .settings-footer {
    padding: 16px 20px;
    flex-wrap: wrap;
    gap: 12px;
  }
  
  .reset-btn,
  .cancel-btn,
  .save-btn {
    padding: 12px 20px;
    font-size: 14px;
  }
}

/* Mobile portrait */
@media (max-width: 480px) {
  /* Make overlay truly fullscreen on mobile */
  .settings-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0;
    align-items: stretch;
    justify-content: stretch;
  }
  
  .settings-panel {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: none;
    box-shadow: none;
  }
  
  .settings-header {
    padding: 16px;
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
  }
  
  .settings-header h3 {
    font-size: 17px;
  }
  
  .close-btn {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .settings-content {
    padding: 16px;
    padding-bottom: 24px;
  }
  
  .settings-section {
    margin-bottom: 20px;
  }
  
  .section-title {
    font-size: 14px;
    gap: 10px;
    margin-bottom: 14px;
  }
  
  .setting-label {
    font-size: 13px;
    margin-bottom: 10px;
  }
  
  .setting-select {
    padding: 16px;
    font-size: 16px; /* Prevent iOS zoom */
    border-radius: 10px;
  }
  
  /* Even larger slider for mobile touch */
  .volume-control {
    padding: 8px 0;
  }
  
  .setting-slider {
    height: 8px;
  }
  
  .setting-slider::-webkit-slider-thumb {
    width: 28px;
    height: 28px;
  }
  
  .setting-slider::-moz-range-thumb {
    width: 28px;
    height: 28px;
  }
  
  .volume-indicator {
    top: 16px;
    height: 8px;
  }
  
  /* Touch-friendly checkboxes */
  .checkbox-label {
    padding: 16px;
    min-height: 64px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
  }
  
  .checkbox-custom {
    width: 28px;
    height: 28px;
    border-radius: 6px;
  }
  
  .checkbox-content span {
    font-size: 15px;
  }
  
  .checkbox-content small {
    font-size: 13px;
  }
  
  /* Test button */
  .audio-test {
    flex-direction: column;
    gap: 12px;
  }
  
  .test-btn {
    width: 100%;
    padding: 14px 20px;
    justify-content: center;
    font-size: 15px;
  }
  
  .test-indicator {
    width: 100%;
    height: 8px;
  }
  
  /* Video preview */
  .video-preview {
    height: 150px;
    border-radius: 10px;
  }
  
  /* Footer - stacked buttons */
  .settings-footer {
    padding: 16px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    flex-direction: column;
    gap: 12px;
  }
  
  .reset-btn {
    order: 3;
    width: 100%;
    padding: 14px;
    font-size: 14px;
  }
  
  .footer-actions {
    width: 100%;
    flex-direction: column-reverse;
    gap: 10px;
  }
  
  .cancel-btn,
  .save-btn {
    width: 100%;
    padding: 16px;
    font-size: 15px;
    border-radius: 10px;
  }
  
  .save-btn {
    order: 1;
  }
  
  .cancel-btn {
    order: 2;
  }
  
  /* Hide keybinds section on mobile via CSS backup (v-if handles JS) */
  .keybinds-section {
    display: none;
  }
}

/* Very small mobile */
@media (max-width: 360px) {
  .settings-header {
    padding: 12px;
    padding-top: calc(12px + env(safe-area-inset-top, 0px));
  }
  
  .settings-header h3 {
    font-size: 16px;
  }
  
  .settings-content {
    padding: 12px;
  }
  
  .section-title {
    font-size: 13px;
  }
  
  .setting-label {
    font-size: 12px;
  }
  
  .checkbox-label {
    padding: 14px;
    min-height: 56px;
  }
  
  .video-preview {
    height: 120px;
  }
}
</style>