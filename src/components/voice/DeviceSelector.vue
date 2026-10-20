<template>
  <div class="device-selector" :class="{ open: isOpen }" ref="selectorRef">
    <button
      ref="triggerRef"
      type="button"
      class="selector-trigger"
      :class="{ open: isOpen }"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? menuId : undefined"
      :aria-label="triggerTitle"
      :title="triggerTitle"
      @click.stop="toggleDropdown()"
      @keydown="onTriggerKeydown"
    >
      <Icon name="chevron-down" class="chevron" aria-hidden="true" />
    </button>

    <Teleport :to="portalTarget">
      <!-- Invisible backdrop to catch clicks outside -->
      <div 
        v-if="isOpen"
        class="device-dropdown-backdrop"
        @click="closeDropdown"
      />
      <Transition name="dropdown">
        <div
          v-if="isOpen"
          :id="menuId"
          class="device-dropdown"
          :style="dropdownStyle"
          ref="dropdownRef"
          role="menu"
          :aria-label="triggerTitle"
          @click.stop
        >
          <div v-if="type === 'input' || type === 'all'" class="device-section" role="group" :aria-labelledby="`${menuId}-input`">
            <div :id="`${menuId}-input`" class="section-header">
              <Icon name="mic" aria-hidden="true" />
              <span>{{ t('settings.voice.microphone') }}</span>
            </div>
            <div class="device-list" role="none">
              <button
                v-for="device in inputDevices"
                :key="device.deviceId"
                type="button"
                role="menuitemradio"
                :aria-checked="device.deviceId === selectedInputDevice"
                class="device-item"
                :class="{ active: device.deviceId === selectedInputDevice }"
                @click="selectInputDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedInputDevice ? 'check' : 'mic'" aria-hidden="true" />
                <span class="device-label">{{ device.label || t('settings.voice.microphone') }}</span>
              </button>
              <div v-if="inputDevices.length === 0" class="no-devices" role="menuitem" aria-disabled="true">
                {{ t('settings.voice.noMicrophones') }}
              </div>
            </div>
          </div>

          <div v-if="type === 'output' || type === 'all'" class="device-section" role="group" :aria-labelledby="`${menuId}-output`">
            <div :id="`${menuId}-output`" class="section-header">
              <Icon name="volume-2" aria-hidden="true" />
              <span>{{ t('settings.voice.speakers') }}</span>
            </div>
            <div class="device-list" role="none">
              <button
                v-for="device in outputDevices"
                :key="device.deviceId"
                type="button"
                role="menuitemradio"
                :aria-checked="device.deviceId === selectedOutputDevice"
                class="device-item"
                :class="{ active: device.deviceId === selectedOutputDevice }"
                @click="selectOutputDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedOutputDevice ? 'check' : 'volume-2'" aria-hidden="true" />
                <span class="device-label">{{ device.label || t('settings.voice.speakers') }}</span>
              </button>
              <div v-if="outputDevices.length === 0" class="no-devices" role="menuitem" aria-disabled="true">
                {{ t('settings.voice.noSpeakers') }}
              </div>
            </div>
          </div>

          <div v-if="type === 'video' || type === 'all'" class="device-section" role="group" :aria-labelledby="`${menuId}-video`">
            <div :id="`${menuId}-video`" class="section-header">
              <Icon name="video" aria-hidden="true" />
              <span>{{ t('settings.voice.videoDevice') }}</span>
            </div>
            <div class="device-list" role="none">
              <button
                v-for="device in videoDevices"
                :key="device.deviceId"
                type="button"
                role="menuitemradio"
                :aria-checked="device.deviceId === selectedVideoDevice"
                class="device-item"
                :class="{ active: device.deviceId === selectedVideoDevice }"
                @click="selectVideoDevice(device.deviceId)"
              >
                <Icon :name="device.deviceId === selectedVideoDevice ? 'check' : 'video'" aria-hidden="true" />
                <span class="device-label">{{ device.label || t('settings.voice.videoDevice') }}</span>
              </button>
              <div v-if="videoDevices.length === 0" class="no-devices" role="menuitem" aria-disabled="true">
                {{ t('settings.voice.noCameras') }}
              </div>
            </div>
          </div>

          <div class="dropdown-footer" role="none">
            <button type="button" role="menuitem" class="settings-link" @click="openSettings">
              <Icon name="settings" aria-hidden="true" />
              <span>{{ t('settings.voice.audioSettings') }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { enumerateMediaDevices } from '@/utils/mediaDevices';
import { webrtcManager } from '@/services/webrtcManager';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import Icon from '@/components/common/Icon.vue';
import { useMenu } from '@/composables/useMenu';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import { styleRect, styleViewport } from '@/utils/appZoom';
import { usePortalTarget } from '@/composables/usePortalTarget';

const portalTarget = usePortalTarget();

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

const { t } = useT();
const selectorRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const menuId = uid('device-menu');
const initialFocus = ref<'first' | 'last'>('first');

// Menu keys, Escape/Tab/outside close and focus back to the trigger. Initial
// focus waits for the device list.
useMenu(dropdownRef, {
  open: isOpen,
  onClose: () => closeDropdown(),
  trigger: () => triggerRef.value,
  initialFocus: 'none',
});
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
// eslint-disable-next-line unused-imports/no-unused-vars
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
    case 'input': return t('settings.voice.selectMicrophone');
    case 'output': return t('settings.voice.selectSpeaker');
    case 'video': return t('settings.voice.selectCamera');
    default: return t('settings.voice.audioSettings');
  }
});

const dropdownStyle = computed(() => ({
  left: `${dropdownPosition.value.x}px`,
  top: `${dropdownPosition.value.y}px`,
}));

// Methods
const loadDevices = async () => {
  try {
    // Labels are empty until a capture permission has been granted.
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      // Continue even if permission denied - might already have it
    }

    const devices = await enumerateMediaDevices();
    
    inputDevices.value = devices.filter(d => d.kind === 'audioinput');
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput');
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');

    const storedDevices = VoiceSettingsService.getDevices();
    
    if (storedDevices.inputDevice && inputDevices.value.some(d => d.deviceId === storedDevices.inputDevice)) {
      selectedInputDevice.value = storedDevices.inputDevice;
    } else if (inputDevices.value.length > 0) {
      selectedInputDevice.value = inputDevices.value[0].deviceId;
    }
    
    if (storedDevices.outputDevice && outputDevices.value.some(d => d.deviceId === storedDevices.outputDevice)) {
      selectedOutputDevice.value = storedDevices.outputDevice;
    } else if (outputDevices.value.length > 0) {
      selectedOutputDevice.value = outputDevices.value[0].deviceId;
    }
    
    if (storedDevices.videoDevice && videoDevices.value.some(d => d.deviceId === storedDevices.videoDevice)) {
      selectedVideoDevice.value = storedDevices.videoDevice;
    } else if (videoDevices.value.length > 0) {
      selectedVideoDevice.value = videoDevices.value[0].deviceId;
    }
  } catch (error) {
    console.error('Failed to enumerate devices:', error);
  }
};

const toggleDropdown = async (focus: 'first' | 'last' = 'first') => {
  if (!isOpen.value) {
    // Set initial position from trigger before showing (prevents flash at 0,0)
    if (selectorRef.value) {
      const rect = styleRect(selectorRef.value);
      dropdownPosition.value = { x: rect.left, y: rect.bottom + 8 };
    }
    initialFocus.value = focus;
    await loadDevices();
  }
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    await nextTick();
    positionDropdown();
    focusInitialItem();
  }
};

// The selected device, else the first (ArrowDown, click) or last (ArrowUp) item.
const focusInitialItem = () => {
  const menu = dropdownRef.value;
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]:not([aria-disabled="true"])'));
  const checked = menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
  const target = checked ?? (initialFocus.value === 'last' ? items[items.length - 1] : items[0]);
  target?.focus({ preventScroll: true });
};

const onTriggerKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  if (!isOpen.value) void toggleDropdown(event.key === 'ArrowUp' ? 'last' : 'first');
};

const positionDropdown = () => {
  if (!selectorRef.value || !dropdownRef.value) return;

  // On mobile (< 480px), use bottom sheet style - CSS handles positioning
  if ((selectorRef.value.ownerDocument.defaultView ?? window).innerWidth <= 480) {
    dropdownPosition.value = { x: 0, y: 0 };
    return;
  }

  const triggerRect = styleRect(selectorRef.value);
  const dropdownRect = styleRect(dropdownRef.value);
  const viewport = styleViewport(dropdownRef.value);
  const padding = 8;

  let x = triggerRect.left;
  let y = triggerRect.bottom + padding;

  // Adjust if dropdown goes off-screen right
  if (x + dropdownRect.width > viewport.width - padding) {
    x = viewport.width - dropdownRect.width - padding;
  }

  // Adjust if dropdown goes off-screen bottom - show above instead
  if (y + dropdownRect.height > viewport.height - padding) {
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
  closeDropdown();
  try {
    await webrtcManager.updateInputDevice(deviceId);
    selectedInputDevice.value = deviceId;
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId } }));
  } catch (error) {
    console.error('Failed to switch input device:', error);
  }
};

const selectOutputDevice = async (deviceId: string) => {
  closeDropdown();
  try {
    await webrtcManager.updateOutputDevice(deviceId);
    selectedOutputDevice.value = deviceId;
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'output', deviceId } }));
  } catch (error) {
    console.error('Failed to switch output device:', error);
  }
};

const selectVideoDevice = async (deviceId: string) => {
  closeDropdown();
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

const handleDeviceChange = () => {
  if (isOpen.value) {
    loadDevices();
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
  navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
  window.addEventListener('harmony-device-changed', handleExternalDeviceChange);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
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
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.selector-trigger:hover {
  background: var(--background-modifier-active);
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
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
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

.device-item:focus-visible,
.settings-link:focus-visible,
.selector-trigger:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.device-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.device-item.active {
  background: var(--harmony-primary-light);
  color: var(--text-link);
}

.device-item.active:hover {
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
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
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.settings-link:hover {
  background: var(--background-modifier-hover);
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
  
  .device-dropdown {
    min-width: 300px;
    max-width: calc(90 * var(--app-vw));
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
    border-radius: var(--radius-md);
  }
  
  .device-dropdown-backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
  }

  :root[data-disable-blur="true"] .device-dropdown-backdrop {
    backdrop-filter: none;
  }
  
  .device-dropdown {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    min-width: 100%;
    max-width: 100%;
    max-height: calc(70 * var(--app-vh));
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
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
    background: var(--background-modifier-selected);
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
    border-radius: var(--radius-md);
    justify-content: center;
    background: var(--background-modifier-hover);
  }

  .settings-link:active {
    background: var(--background-modifier-active);
  }
}

@media (max-width: 360px) {
  .device-dropdown {
    max-height: calc(80 * var(--app-vh));
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

