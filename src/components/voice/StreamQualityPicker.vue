<template>
  <Teleport to="body">
    <div v-if="visible" class="sqp-backdrop" @click="close" @contextmenu.prevent="close" />
    <div
      v-if="visible"
      ref="panelRef"
      class="sqp"
      role="dialog"
      tabindex="-1"
      data-voice-popover
      :aria-label="title"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @click.stop
      @keydown.esc.stop.prevent="close"
    >
      <header class="sqp-header">
        <Icon name="screen-share" :size="18" />
        <h3 class="sqp-title">{{ title }}</h3>
        <span v-if="isLive" class="sqp-live">{{ t('voice.live') }}</span>
        <button type="button" class="sqp-close" :aria-label="t('common.close')" :title="t('common.close')" @click="close">
          <Icon name="x" :size="16" />
        </button>
      </header>

      <StreamQualityOptions />

      <template v-if="!isLive && nativeAudio">
        <div class="sqp-audio-toggle">
          <Icon name="volume-2" :size="16" />
          <span class="sqp-audio-label">{{ t('voice.shareStreamAudio') }}</span>
          <ToggleSwitch
            :model-value="shareAudio"
            :aria-label="t('voice.shareStreamAudio')"
            @update:model-value="setShareAudio"
          />
        </div>
        <p v-if="shareAudio" class="sqp-audio-hint">{{ t('voice.streamAudioNativeHint') }}</p>
      </template>
      <p v-else-if="isLive && streamAudio" class="sqp-audio-hint" :title="streamAudio.detail">
        <Icon name="volume-2" :size="14" />
        <span>{{ streamAudioLabel }}</span>
      </p>
      <p v-else-if="!isLive" class="sqp-audio-hint">
        <Icon name="volume-2" :size="14" />
        <span>{{ t('voice.streamAudioHint') }}</span>
      </p>

      <footer class="sqp-footer">
        <button
          v-if="isLive"
          type="button"
          class="sqp-btn danger"
          @click="stop"
        >
          <Icon name="x-circle" :size="16" />
          <span>{{ t('voice.stopStreaming') }}</span>
        </button>
        <button
          v-else
          ref="goLiveRef"
          type="button"
          class="sqp-btn primary"
          :disabled="starting"
          @click="goLive"
        >
          <Icon name="screen-share" :size="16" />
          <span>{{ t('voice.goLive') }}</span>
        </button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import Icon from '@/components/common/Icon.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { activeStreamAudio, nativeStreamAudioSupport, probeNativeStreamAudio } from '@/services/voice/nativeStreamAudio';
import StreamQualityOptions from './StreamQualityOptions.vue';
import { VOICE_POPOVER_DISMISS, placePopover, type Rect } from './voiceMenuModel';

// Discord's "Go live" step: quality before capture, and the same panel with
// "Stop streaming" while live.
const props = defineProps<{
  visible: boolean;
  anchor: Rect | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();

const panelRef = ref<HTMLElement | null>(null);
const goLiveRef = ref<HTMLButtonElement | null>(null);
const position = ref({ x: -9999, y: -9999 });
const starting = ref(false);

const isLive = computed(() => voiceStore.localState.isScreenSharing);
// Desktop app on Windows/macOS: audio is captured natively, so the browser-picker hint does not apply.
const nativeAudio = computed(() => nativeStreamAudioSupport.value?.supported === true);
const shareAudio = computed(() => voiceStore.streamSettings?.shareAudio !== false);
const streamAudio = computed(() => activeStreamAudio.value);
const streamAudioLabel = computed(() => {
  const source = streamAudio.value;
  return source?.scope === 'app' && source.app
    ? t('voice.streamAudioFromApp', { app: source.app })
    : t('voice.streamAudioFromSystem');
});

function setShareAudio(value: boolean): void {
  void voiceStore.updateStreamQuality({ shareAudio: value });
}
const title = computed(() => (isLive.value ? t('voice.streamSettings') : t('voice.shareYourScreen')));

function close(): void {
  emit('close');
}

// The click is the user activation getDisplayMedia needs; nothing awaits before it.
async function goLive(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  close();
  try {
    await voiceStore.toggleScreenShare();
  } finally {
    starting.value = false;
  }
}

function stop(): void {
  close();
  if (voiceStore.localState.isScreenSharing) void voiceStore.toggleScreenShare();
}

async function place(): Promise<void> {
  await nextTick();
  const el = panelRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anchor = props.anchor ?? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 };
  position.value = placePopover(anchor, { width: rect.width, height: rect.height }, viewport);
  (goLiveRef.value ?? el).focus({ preventScroll: true });
}

watch(() => [props.visible, props.anchor, isLive.value] as const, ([visible]) => {
  if (visible) {
    voiceStore.loadStreamSettings();
    void place();
  }
}, { immediate: true });

function onDismiss(): void {
  if (props.visible) close();
}

onMounted(() => {
  void probeNativeStreamAudio();
  window.addEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.addEventListener('resize', onDismiss);
});

onBeforeUnmount(() => {
  window.removeEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.removeEventListener('resize', onDismiss);
});
</script>

<style scoped>
.sqp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10005;
}

.sqp {
  position: fixed;
  z-index: 10006;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 320px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 14px;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  outline: none;
  animation: sqp-in 0.12s ease-out;
}

@keyframes sqp-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .sqp { animation: none; }
}

:root[data-reduce-motion="true"] .sqp {
  animation: none;
}

.sqp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}

.sqp-title {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: 700;
}

.sqp-live {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.sqp-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.sqp-close:hover,
.sqp-close:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.sqp-audio-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.sqp-audio-label {
  flex: 1;
}

.sqp-audio-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.sqp-footer {
  display: flex;
  justify-content: flex-end;
}

.sqp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.sqp-btn:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.sqp-btn.primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.sqp-btn.primary:hover {
  background: var(--harmony-primary-hover);
}

.sqp-btn.primary:disabled {
  opacity: 0.6;
  cursor: progress;
}

.sqp-btn.danger {
  background: var(--error);
  color: var(--text-on-primary);
}

.sqp-btn.danger:hover {
  background: var(--error-hover);
}
</style>
