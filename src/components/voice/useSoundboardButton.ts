import { computed, ref, watch, type Ref } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSoundboardStore } from '@/stores/soundboard';
import type { Rect } from './voiceMenuModel';

/**
 * Soundboard button of a voice control bar: shown in a local server's voice
 * channel to members holding USE_SOUNDBOARD and SPEAK there; toggles the
 * popover anchored to the button.
 */
export function useSoundboardButton(buttonRef: Ref<HTMLElement | null>) {
  const voiceStore = useUnifiedVoiceChannelStore();
  const soundboard = useSoundboardStore();

  const visible = ref(false);
  const anchor = ref<Rect | null>(null);

  const available = computed(() => !!soundboard.currentChannel() && soundboard.permitted);

  watch(
    () => [voiceStore.isConnected, voiceStore.currentServerId, voiceStore.currentChannelId, voiceStore.localState.userId] as const,
    () => {
      void soundboard.refreshPermission();
    },
    { immediate: true },
  );

  watch(available, (now) => {
    if (!now) visible.value = false;
  });

  const toggle = () => {
    if (visible.value) {
      visible.value = false;
      return;
    }
    const r = buttonRef.value?.getBoundingClientRect();
    anchor.value = r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
    visible.value = true;
  };

  const close = () => {
    visible.value = false;
  };

  return { available, visible, anchor, toggle, close };
}
