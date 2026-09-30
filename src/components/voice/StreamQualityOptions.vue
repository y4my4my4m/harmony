<template>
  <div class="sq-options">
    <div class="sq-group" role="radiogroup" :aria-label="t('voice.streamQuality')">
      <span class="sq-group-label">{{ t('voice.streamQuality') }}</span>
      <div class="sq-presets">
        <button
          v-for="preset in STREAM_QUALITY_PRESETS"
          :key="preset.id"
          type="button"
          role="radio"
          class="sq-preset"
          :class="{ active: activePresetId === preset.id }"
          :aria-checked="activePresetId === preset.id"
          @click="selectPreset(preset)"
        >
          <span class="sq-preset-res">{{ resolutionText(preset.resolution) }}</span>
          <span class="sq-preset-fps">{{ t('voice.fps', { n: preset.frameRate }) }}</span>
        </button>
      </div>
      <p v-if="!activePresetId" class="sq-custom">
        {{ resolutionText(current.resolution) }} · {{ t('voice.fps', { n: current.frameRate }) }}
      </p>
    </div>

    <div class="sq-group" role="radiogroup" :aria-label="t('voice.streamAudioQuality')">
      <span class="sq-group-label">{{ t('voice.streamAudioQuality') }}</span>
      <div class="sq-bitrates">
        <button
          v-for="kbps in STREAM_AUDIO_BITRATES"
          :key="kbps"
          type="button"
          role="radio"
          class="sq-bitrate"
          :class="{ active: current.audioBitrate === kbps }"
          :aria-checked="current.audioBitrate === kbps"
          @click="selectBitrate(kbps)"
        >
          {{ kbps }}
        </button>
      </div>
      <span class="sq-unit">{{ t('voice.kbps', { n: current.audioBitrate }) }}</span>
    </div>

    <p class="sq-hint">{{ t('voice.qualityHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import {
  DEFAULT_STREAM_AUDIO_BITRATE,
  SOURCE_RESOLUTION,
  STREAM_AUDIO_BITRATES,
  STREAM_QUALITY_PRESETS,
  findPreset,
  type StreamQualityPreset,
} from '@/services/voice/streamQuality';

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();

const current = computed(() => ({
  resolution: voiceStore.streamSettings?.resolution ?? 720,
  frameRate: voiceStore.streamSettings?.frameRate || 30,
  audioBitrate: voiceStore.streamSettings?.audioBitrate || DEFAULT_STREAM_AUDIO_BITRATE,
}));

const activePresetId = computed(() => findPreset(current.value)?.id ?? null);

function resolutionText(resolution: number): string {
  return resolution === SOURCE_RESOLUTION ? t('voice.source') : `${resolution}p`;
}

function selectPreset(preset: StreamQualityPreset): void {
  void voiceStore.updateStreamQuality({ resolution: preset.resolution, frameRate: preset.frameRate });
}

function selectBitrate(kbps: number): void {
  void voiceStore.updateStreamQuality({ audioBitrate: kbps });
}
</script>

<style scoped>
.sq-options {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sq-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sq-group-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.sq-presets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.sq-preset {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.sq-preset:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.sq-preset:focus-visible,
.sq-bitrate:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.sq-preset.active {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--text-primary);
}

.sq-preset-res {
  font-weight: 700;
  font-size: var(--font-size-sm);
}

.sq-preset-fps {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sq-preset.active .sq-preset-fps {
  color: var(--text-secondary);
}

.sq-custom {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sq-bitrates {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.sq-bitrate {
  flex: 1 1 0;
  min-width: 40px;
  padding: 5px 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.sq-bitrate:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.sq-bitrate.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.sq-unit {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sq-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
</style>
