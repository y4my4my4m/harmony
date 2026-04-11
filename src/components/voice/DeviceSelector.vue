<template>
  <div class="device-selector" :class="{ open: isOpen }" ref="selectorRef">
    <button
      class="selector-trigger"
      :class="{ open: isOpen }"
      @click.stop="toggleDropdown"
      :title="triggerTitle"
    >
      <!-- <Icon :name="triggerIcon" /> -->
      <Icon name="chevron-down" class="chevron" />
    </button>

    <Teleport to="body">
      <!-- Invisible backdrop to catch clicks outside -->
      <div 
        v-if="isOpen"
        class="device-dropdown-backdrop"
        @click="closeDropdown"
      />
      <Transition name="dropdown">
        <div
          v-if="isOpen"
          class="device-dropdown"
          :style="dropdownStyle"
          ref="dropdownRef"
          @click.stop
        >
          <!-- Input Devices (Microphones) -->
          <div v-if="type === 'input' || type === 'all'" class="device-section">
            <div class="section-header">
              <Icon name="mic" />
              <span>Microphone</span>
            </div>
            <div class="device-list">
              <button
                v-for="device in inputDevices"
                :key="device.deviceId"
                class="device-item"
                :class="{ active: device.deviceId === selectedInputDevice }"
                @click="selectInputDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedInputDevice ? 'check' : 'mic'" />
                <span class="device-label">{{ device.label || 'Microphone' }}</span>
              </button>
              <div v-if="inputDevices.length === 0" class="no-devices">
                No microphones found
              </div>
            </div>
          </div>

          <!-- Output Devices (Speakers) -->
          <div v-if="type === 'output' || type === 'all'" class="device-section">
            <div class="section-header">
              <Icon name="volume-2" />
              <span>Speaker / Headphones</span>
            </div>
            <div class="device-list">
              <button
                v-for="device in outputDevices"
                :key="device.deviceId"
                class="device-item"
                :class="{ active: device.deviceId === selectedOutputDevice }"
                @click="selectOutputDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedOutputDevice ? 'check' : 'volume-2'" />
                <span class="device-label">{{ device.label || 'Speaker' }}</span>
              </button>
              <div v-if="outputDevices.length === 0" class="no-devices">
                No speakers found
              </div>
            </div>
          </div>

          <!-- Video Devices (Cameras) -->
          <div v-if="type === 'video' || type === 'all'" class="device-section">
            <div class="section-header">
              <Icon name="video" />
              <span>Camera</span>
            </div>
            <div class="device-list">
              <button
                v-for="device in videoDevices"
                :key="device.deviceId"
                class="device-item"
                :class="{ active: device.deviceId === selectedVideoDevice }"
                @click="selectVideoDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedVideoDevice ? 'check' : 'video'" />
                <span class="device-label">{{ device.label || 'Camera' }}</span>
              </button>
              <div v-if="videoDevices.length === 0" class="no-devices">
                No cameras found
              </div>
            </div>
          </div>

          <div class="dropdown-footer">
            <button class="settings-link" @click="openSettings">
              <Icon name="settings" />
              <span>Audio Settings</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { webrtcManager } from '@/services/webrtcManager';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import Icon from '@/components/common/Icon.vue';

interface Props {
  type?: 'input' | 'output' | 'video' | 'all';
}

const props = withDefaults(defineProps<Props>(), {
  type: 'all',
});

interface Emits {
  (e: 'open-settings'): void;
}

const emit = defineEmits<Emits>();

const selectorRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const dropdownPosition = ref({ x: 0, y: 0 });

// Device lists
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const videoDevices = ref<MediaDeviceInfo[]>([]);

// Selected devices
const selectedInputDevice = ref<string | null>(null);
const selectedOutputDevice = ref<string | null>(null);
const selectedVideoDevice = ref<string | null>(null);

// Computed
const triggerIcon = computed(() => {
  switch (props.type) {
    case 'input': return 'mic';
    case 'output': return 'volume-2';
    case 'video': return 'video';
    default: return 'settings';
  }
});

const triggerTitle = computed(() => {
  switch (props.type) {
    case 'input': return 'Select Microphone';
    case 'output': return 'Select Speaker';
    case 'video': return 'Select Camera';
    default: return 'Audio/Video Settings';
  }
});

const dropdownStyle = computed(() => ({
  left: `${dropdownPosition.value.x}px`,
  top: `${dropdownPosition.value.y}px`,
}));

// Methods
const loadDevices = async () => {
  try {
    // Request permission first if needed
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      // Continue even if permission denied - might already have it
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    
    inputDevices.value = devices.filter(d => d.kind === 'audioinput');
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');

    // Get currently selected devices from VoiceSettingsService (persisted)
    const storedDevices = VoiceSettingsService.getDevices();
    
    // Validate stored input device exists
    if (storedDevices.inputDevice && inputDevices.value.some(d => d.deviceId === storedDevices.inputDevice)) {
      selectedInputDevice.value = storedDevices.inputDevice;
    } else if (inputDevices.value.length > 0) {
      selectedInputDevice.value = inputDevices.value[0].deviceId;
    }
    
    // Validate stored output device exists
    if (storedDevices.outputDevice && outputDevices.value.some(d => d.deviceId === storedDevices.outputDevice)) {
      selectedOutputDevice.value = storedDevices.outputDevice;
    } else if (outputDevices.value.length > 0) {
      selectedOutputDevice.value = outputDevices.value[0].deviceId;
    }
    
    // Validate stored video device exists
    if (storedDevices.videoDevice && videoDevices.value.some(d => d.deviceId === storedDevices.videoDevice)) {
      selectedVideoDevice.value = storedDevices.videoDevice;
    } else if (videoDevices.value.length > 0) {
      selectedVideoDevice.value = videoDevices.value[0].deviceId;
    }
  } catch (error) {
    console.error('Failed to enumerate devices:', error);
  }
};

const toggleDropdown = async () => {
  if (!isOpen.value) {
    // Set initial position from trigger before showing (prevents flash at 0,0)
    if (selectorRef.value) {
      const rect = selectorRef.value.getBoundingClientRect();
      dropdownPosition.value = { x: rect.left, y: rect.bottom + 8 };
    }
    // Load devices when opening
    await loadDevices();
  }
  isOpen.value = !isOpen.value;
  
  if (isOpen.value) {
    await nextTick();
    positionDropdown();
  }
};

const positionDropdown = () => {
  if (!selectorRef.value || !dropdownRef.value) return;

  // On mobile (< 480px), use bottom sheet style - CSS handles positioning
  if (window.innerWidth <= 480) {
    dropdownPosition.value = { x: 0, y: 0 };
    return;
  }

  const triggerRect = selectorRef.value.getBoundingClientRect();
  const dropdownRect = dropdownRef.value.getBoundingClientRect();
  const padding = 8;

  let x = triggerRect.left;
  let y = triggerRect.bottom + padding;

  // Adjust if dropdown goes off-screen right
  if (x + dropdownRect.width > window.innerWidth - padding) {
    x = window.innerWidth - dropdownRect.width - padding;
  }

  // Adjust if dropdown goes off-screen bottom - show above instead
  if (y + dropdownRect.height > window.innerHeight - padding) {
    y = triggerRect.top - dropdownRect.height - padding;
  }

  // Ensure minimum position
  x = Math.max(padding, x);
  y = Math.max(padding, y);

  dropdownPosition.value = { x, y };
};

const closeDropdown = () => {
  isOpen.value = false;
};

const selectInputDevice = async (deviceId: string) => {
  try {
    await webrtcManager.updateInputDevice(deviceId);
    selectedInputDevice.value = deviceId;
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId } }));
  } catch (error) {
    console.error('Failed to switch input device:', error);
  }
};

const selectOutputDevice = async (deviceId: string) => {
  try {
    await webrtcManager.updateOutputDevice(deviceId);
    selectedOutputDevice.value = deviceId;
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'output', deviceId } }));
  } catch (error) {
    console.error('Failed to switch output device:', error);
  }
};

const selectVideoDevice = async (deviceId: string) => {
  try {
    await webrtcManager.updateVideoDevice(deviceId);
    selectedVideoDevice.value = deviceId;
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'video', deviceId } }));
  } catch (error) {
    console.error('Failed to switch video device:', error);
  }
};

const openSettings = () => {
  closeDropdown();
  emit('open-settings');
};

// Handle clicks outside
const handleClickOutside = (event: MouseEvent) => {
  if (
    selectorRef.value &&
    !selectorRef.value.contains(event.target as Node) &&
    dropdownRef.value &&
    !dropdownRef.value.contains(event.target as Node)
  ) {
    closeDropdown();
  }
};

// Handle device changes (hot-plug support)
const handleDeviceChange = () => {
  if (isOpen.value) {
    loadDevices();
  }
};

// Handle keyboard
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && isOpen.value) {
    closeDropdown();
  }
};

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

// Lifecycle
onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
  navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
  window.addEventListener('harmony-device-changed', handleExternalDeviceChange);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
  navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  window.removeEventListener('harmony-device-changed', handleExternalDeviceChange);
});

// Watch for window resize to reposition dropdown
watch(isOpen, (newVal) => {
  if (newVal) {
    window.addEventListener('resize', positionDropdown);
  } else {
    window.removeEventListener('resize', positionDropdown);
  }
});
</script>

<style scoped>
.device-dropdown-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10009;
}

.device-selector {
  position: relative;
  display: inline-flex;
}

.selector-trigger {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.selector-trigger:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.selector-trigger.open {
  background: var(--harmony-primary-light);
  color: var(--text-primary);
  border-color: var(--harmony-primary);
}

.chevron {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.selector-trigger.open .chevron {
  transform: rotate(180deg);
}

/* Dropdown - matches app popover/context-menu styling */
.device-dropdown {
  position: fixed;
  z-index: 10010;
  background: var(--background-quaternary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  box-shadow: var(--shadow-modal);
  min-width: 280px;
  max-width: 360px;
  max-height: 400px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Device Section */
.device-section {
  padding: 6px 0;
  border-bottom: 1px solid var(--border-secondary);
}

.device-section:last-of-type {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.device-list {
  max-height: 150px;
  overflow-y: auto;
}

.device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 16px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.device-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.device-item.active {
  background: var(--harmony-primary-light);
  color: var(--harmony-primary);
}

.device-item.active:hover {
  background: rgba(14, 165, 233, 0.18);
}

.device-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.no-devices {
  padding: 12px 16px;
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}

/* Footer */
.dropdown-footer {
  padding: 6px 8px;
  border-top: 1px solid var(--border-secondary);
}

.settings-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.settings-link:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

/* Scrollbar styling */
.device-list::-webkit-scrollbar {
  width: 6px;
}

.device-list::-webkit-scrollbar-track {
  background: transparent;
}

.device-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.device-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

/* ============================================
   MOBILE RESPONSIVE STYLES
   ============================================ */

@media (max-width: 768px) {
  .selector-trigger {
    padding: 6px 8px;
    font-size: 14px;
    min-width: 36px;
    min-height: 36px;
    justify-content: center;
  }
  
  .chevron {
    display: none;
  }
  
  .device-dropdown {
    min-width: 300px;
    max-width: 90vw;
  }
  
  .section-header {
    padding: 8px 16px;
    font-size: 12px;
  }
  
  .device-item {
    padding: 14px 16px;
    min-height: 48px;
    font-size: 14px;
  }
  
  .settings-link {
    padding: 14px 12px;
    min-height: 48px;
    font-size: 14px;
  }
  
  .device-list {
    max-height: 200px;
    -webkit-overflow-scrolling: touch;
  }
}

@media (max-width: 480px) {
  .selector-trigger {
    padding: 8px 10px;
    min-width: 40px;
    min-height: 40px;
    border-radius: 8px;
  }
  
  .device-dropdown-backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
  }
  
  .device-dropdown {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    min-width: 100%;
    max-width: 100%;
    max-height: 70vh;
    border-radius: 12px 12px 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    transform: none !important;
  }
  
  .dropdown-enter-from,
  .dropdown-leave-to {
    opacity: 1;
    transform: translateY(100%) !important;
  }
  
  .dropdown-enter-active,
  .dropdown-leave-active {
    transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }
  
  .device-dropdown::before {
    content: '';
    display: block;
    width: 36px;
    height: 4px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    margin: 10px auto 6px;
  }
  
  .device-section {
    padding: 8px 0;
  }
  
  .section-header {
    padding: 10px 20px;
    font-size: 13px;
  }
  
  .device-list {
    max-height: none;
    overflow-y: visible;
  }
  
  .device-item {
    padding: 16px 20px;
    min-height: 56px;
    font-size: 15px;
    gap: 12px;
  }
  
  .device-item:active {
    background: rgba(255, 255, 255, 0.08);
  }
  
  .no-devices {
    padding: 16px 20px;
    font-size: 14px;
  }
  
  .dropdown-footer {
    padding: 10px 12px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }
  
  .settings-link {
    padding: 14px;
    min-height: 52px;
    font-size: 15px;
    border-radius: 8px;
    justify-content: center;
    background: rgba(255, 255, 255, 0.04);
  }
  
  .settings-link:active {
    background: rgba(255, 255, 255, 0.08);
  }
}

@media (max-width: 360px) {
  .device-dropdown {
    max-height: 80vh;
  }
  
  .section-header {
    padding: 8px 16px;
    font-size: 12px;
  }
  
  .device-item {
    padding: 14px 16px;
    min-height: 52px;
    font-size: 14px;
  }
  
  .settings-link {
    padding: 14px;
    min-height: 52px;
    font-size: 14px;
  }
}
</style>

