import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useViewport } from '@/composables/useViewport';
import { userStorage } from '@/utils/userScopedStorage';
import { debug } from '@/utils/debug';

export type DockVideoSource = 'camera' | 'screen';

export interface DockVideoTileModel {
  id: string;
  userState: UserMediaState;
  source: DockVideoSource;
}

// Stored per device; expanded is stored as absence of the key.
const STORAGE_KEY_COLLAPSED = 'voice-dock-video-strip-collapsed';

// Layout height hidden by the visual viewport, px. Matches MediaPickerPopup.
const KEYBOARD_OPEN_THRESHOLD = 120;
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
};

/**
 * State of the video strip above the voice dock. Registers lifecycle hooks;
 * call from component setup.
 *
 * Mobile text entry raises the keyboard; the strip yields the space until the
 * keyboard closes. That collapse is not persisted.
 */
export function useDockVideoStrip() {
  const voiceStore = useUnifiedVoiceChannelStore();
  const { isMobileViewport } = useViewport();

  // Remote screens, own screen, remote cameras, own camera.
  const tiles = computed<DockVideoTileModel[]>(() => {
    const localId = voiceStore.localState.userId;
    const remoteScreens: DockVideoTileModel[] = [];
    const ownScreens: DockVideoTileModel[] = [];
    const remoteCameras: DockVideoTileModel[] = [];
    const ownCameras: DockVideoTileModel[] = [];

    for (const p of voiceStore.allParticipants) {
      const self = p.userId === localId;
      if (p.isScreenSharing) {
        (self ? ownScreens : remoteScreens).push({ id: `${p.userId}:screen`, userState: p, source: 'screen' });
      }
      if (p.isVideoEnabled) {
        (self ? ownCameras : remoteCameras).push({ id: `${p.userId}:camera`, userState: p, source: 'camera' });
      }
    }

    return [...remoteScreens, ...ownScreens, ...remoteCameras, ...ownCameras];
  });

  const loadCollapsed = (): boolean => {
    try {
      return userStorage.getItem(STORAGE_KEY_COLLAPSED) === '1';
    } catch (error) {
      debug.warn('Failed to load video strip state:', error);
      return false;
    }
  };

  const collapsed = ref(loadCollapsed());

  const setCollapsed = (value: boolean) => {
    collapsed.value = value;
    try {
      if (value) {
        userStorage.setItem(STORAGE_KEY_COLLAPSED, '1');
      } else {
        userStorage.removeItem(STORAGE_KEY_COLLAPSED);
      }
    } catch (error) {
      debug.warn('Failed to save video strip state:', error);
    }
  };

  const measureKeyboard = (): boolean => {
    const vv = window.visualViewport;
    return !!vv && window.innerHeight - vv.height > KEYBOARD_OPEN_THRESHOLD;
  };

  // Read at setup: a first render with the wrong state attaches tiles the next render detaches.
  const keyboardOpen = ref(measureKeyboard());
  const editingText = ref(isTextEntry(document.activeElement));

  const syncKeyboard = () => {
    keyboardOpen.value = measureKeyboard();
  };

  const onFocusIn = (e: FocusEvent) => {
    editingText.value = isTextEntry(e.target);
  };

  const onFocusOut = (e: FocusEvent) => {
    editingText.value = isTextEntry(e.relatedTarget);
  };

  const autoCollapsed = computed(() => isMobileViewport.value && (keyboardOpen.value || editingText.value));

  const expanded = computed(() => tiles.value.length > 0 && !collapsed.value && !autoCollapsed.value);

  onMounted(() => {
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.visualViewport?.addEventListener('resize', syncKeyboard);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    window.visualViewport?.removeEventListener('resize', syncKeyboard);
  });

  return { tiles, collapsed, autoCollapsed, expanded, setCollapsed };
}
