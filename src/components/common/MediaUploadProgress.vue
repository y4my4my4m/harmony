<!-- Upload progress of a message_media object this client is uploading, with Cancel
     when the upload's owner offers it. Absolutely positioned over the nearest
     positioned ancestor; takes no layout. `inline`: for a row-shaped attachment, the
     label at the right end and the bar on the bottom edge. -->
<template>
  <div
    v-if="state && (state.status === 'uploading' || isError)"
    class="media-upload-progress"
    :class="{ 'is-error': isError, 'is-inline': inline }"
  >
    <div class="media-upload-progress__head">
      <span v-if="isError" class="media-upload-progress__label" role="alert">{{ $t('message.upload.failed') }}</span>
      <span v-else class="media-upload-progress__label" aria-hidden="true">{{ percent }}%</span>
      <button
        v-if="!isError && state.cancel"
        type="button"
        class="media-upload-progress__cancel"
        :aria-label="$t('message.upload.cancel')"
        :title="$t('message.upload.cancel')"
        @click.stop="state.cancel()"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" />
        </svg>
      </button>
    </div>
    <!-- A failed upload is announced once by the alert; its bar is decoration. -->
    <div v-if="isError" class="media-upload-progress__track" aria-hidden="true">
      <div class="media-upload-progress__bar" />
    </div>
    <div
      v-else
      class="media-upload-progress__track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
      :aria-label="$t('message.upload.progress', { percent })"
    >
      <div class="media-upload-progress__bar" :style="{ transform: `scaleX(${state.progress})` }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { messageMediaUploadState } from '@/services/messageMediaUpload';

const props = defineProps<{ path: string; inline?: boolean }>();

const state = computed(() => messageMediaUploadState(props.path));
const isError = computed(() => state.value?.status === 'error');
const percent = computed(() => Math.round((state.value?.progress ?? 0) * 100));
</script>

<style scoped>
.media-upload-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 6px;
  pointer-events: none;
}

.media-upload-progress__head {
  display: flex;
  align-items: center;
  gap: 4px;
}

.media-upload-progress__label {
  padding: 1px 6px;
  border-radius: var(--radius-full, 999px);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
}

.media-upload-progress__cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  cursor: pointer;
  pointer-events: auto;
}

.media-upload-progress__cancel:hover {
  background: rgba(0, 0, 0, 0.85);
}

.media-upload-progress__cancel:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.media-upload-progress__track {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.media-upload-progress__bar {
  width: 100%;
  height: 100%;
  background: var(--harmony-primary);
  transform-origin: left center;
  transition: transform 0.2s linear;
}

.media-upload-progress.is-error .media-upload-progress__bar {
  background: var(--error);
}

.media-upload-progress.is-inline {
  top: 0;
  padding: 0;
  display: block;
}

.media-upload-progress.is-inline .media-upload-progress__head {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
}

.media-upload-progress.is-inline .media-upload-progress__track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  border-radius: 0 0 8px 8px;
}

@media (prefers-reduced-motion: reduce) {
  .media-upload-progress__bar {
    transition: none;
  }
}
</style>
