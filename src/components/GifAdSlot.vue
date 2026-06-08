<template>
  <div class="gif-ad-slot" :style="slotStyle">
    <span class="gif-ad-label">{{ $t('gif.ad') }}</span>
    <iframe
      :srcdoc="content"
      class="gif-ad-frame"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      loading="lazy"
      scrolling="no"
      title="Advertisement"
    ></iframe>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { KLIPY_AD_MAX_HEIGHT, KLIPY_AD_MIN_SIZE } from '@/utils/klipyAdContext';

/**
 * Renders a Klipy ad. Klipy ads are an HTML blob meant for a WebView; on the web
 * we render it in a sandboxed iframe. The sandbox intentionally omits
 * `allow-same-origin` so the ad cannot reach Harmony's origin, cookies, or DOM.
 */
const props = defineProps<{
  content: string;
  width?: number;
  height?: number;
}>();

const slotStyle = computed(() => {
  const w = props.width && props.width >= KLIPY_AD_MIN_SIZE ? props.width : 300;
  const h = props.height && props.height >= KLIPY_AD_MIN_SIZE ? props.height : 250;
  const cappedH = Math.min(h, KLIPY_AD_MAX_HEIGHT);
  return {
    aspectRatio: `${w} / ${cappedH}`,
    minHeight: `${Math.max(KLIPY_AD_MIN_SIZE, Math.min(cappedH, KLIPY_AD_MAX_HEIGHT))}px`,
    maxHeight: `${KLIPY_AD_MAX_HEIGHT}px`,
  };
});
</script>

<style scoped>
.gif-ad-slot {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 4px;
  background: var(--background-senary-alpha);
  border: 1px solid var(--border-secondary);
}

.gif-ad-label {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 1;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--background-secondary);
  padding: 1px 5px;
  border-radius: 3px;
  opacity: 0.85;
  pointer-events: none;
}

.gif-ad-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
</style>
