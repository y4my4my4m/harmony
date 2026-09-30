<template>
  <div class="tile-volume" :class="{ muted: isMuted }" @click.stop @dblclick.stop @pointerdown.stop>
    <button
      type="button"
      class="tile-volume__btn"
      :title="isMuted ? unmuteLabel : muteLabel"
      :aria-label="isMuted ? unmuteLabel : muteLabel"
      :aria-pressed="isMuted"
      @click="voiceStore.toggleUserLocalMute(userId, kind)"
    >
      <Icon :name="icon" :size="16" />
    </button>
    <div class="tile-volume__slider">
      <VolumeSlider
        compact
        :model-value="volume"
        :label="label"
        :muted="isMuted"
        @update:model-value="setVolume"
      />
    </div>
    <span class="tile-volume__value" aria-hidden="true">{{ volume }}%</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import type { RemoteAudioKind } from '@/services/voice/remoteAudioMixer';
import Icon from '@/components/common/Icon.vue';
import VolumeSlider from './VolumeSlider.vue';

// Listener-side level for one user's mic or stream: an icon that toggles a
// local mute and a slider that opens on hover or focus.
const props = defineProps<{
  userId: string;
  kind: RemoteAudioKind;
}>();

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();

const volume = computed(() =>
  props.kind === 'mic'
    ? voiceStore.getUserVolume(props.userId)
    : voiceStore.getUserScreenShareVolume(props.userId)
);
const isMuted = computed(() => voiceStore.isUserLocallyMuted(props.userId, props.kind) || volume.value === 0);

const label = computed(() => (props.kind === 'mic' ? t('voice.userVolume') : t('voice.streamVolume')));
const muteLabel = computed(() => (props.kind === 'mic' ? t('voice.muteUser') : t('voice.muteStream')));
const unmuteLabel = computed(() => t('voice.unmute'));

const icon = computed(() => {
  if (isMuted.value) return 'volume-x';
  return volume.value < 50 ? 'volume-1' : 'volume-2';
});

function setVolume(value: number): void {
  if (props.kind === 'mic') voiceStore.setUserVolume(props.userId, value);
  else voiceStore.setUserScreenShareVolume(props.userId, value);
  if (value > 0 && voiceStore.isUserLocallyMuted(props.userId, props.kind)) {
    voiceStore.setUserLocalMute(props.userId, props.kind, false);
  }
}
</script>

<style scoped>
.tile-volume {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 4px;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
}

.tile-volume__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.tile-volume__btn:hover,
.tile-volume__btn:focus-visible {
  background: rgba(255, 255, 255, 0.18);
  outline: none;
}

.tile-volume.muted .tile-volume__btn {
  color: var(--error);
}

/* Collapsed until hovered or focused; width animates open. */
.tile-volume__slider {
  width: 0;
  overflow: hidden;
  transition: width var(--transition-fast);
}

.tile-volume__value {
  display: none;
  min-width: 36px;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.tile-volume:hover .tile-volume__slider,
.tile-volume:focus-within .tile-volume__slider {
  width: 96px;
  overflow: visible;
}

.tile-volume:hover .tile-volume__value,
.tile-volume:focus-within .tile-volume__value {
  display: inline;
}

.tile-volume :deep(.volume-slider__input) {
  --track: rgba(255, 255, 255, 0.25);
}

@media (hover: none) {
  .tile-volume__slider {
    width: 80px;
    overflow: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tile-volume__slider { transition: none; }
}

:root[data-reduce-motion="true"] .tile-volume__slider {
  transition: none;
}
</style>
