<template>
  <div
    ref="rootRef"
    class="gif-ad-slot"
    :class="`gif-ad-slot--${layout}`"
    :style="slotStyle"
  >
    <span class="gif-ad-label">{{ $t('gif.ad') }}</span>
    <div class="gif-ad-frame-wrap">
      <iframe
        :srcdoc="iframeContent"
        class="gif-ad-frame"
        :style="iframeStyle"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
        scrolling="no"
        title="Advertisement"
      ></iframe>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { prepareKlipyAdHtml, resolveKlipyAdDimensions } from '@/utils/klipyAdContent';
import { KLIPY_AD_MAX_HEIGHT } from '@/utils/klipyAdContext';

export type GifAdLayout = 'banner' | 'inline';

/**
 * Renders a Klipy ad (ad-iframe=0 HTML blob) in a sandboxed iframe - the web
 * equivalent of Klipy's recommended WebView. `banner` = full-width row in the
 * picker masonry feed; `inline` = wider tile in the /gif horizontal strip.
 */
const props = withDefaults(
  defineProps<{
    content: string;
    width?: number;
    height?: number;
    layout?: GifAdLayout;
  }>(),
  { layout: 'banner' },
);

const rootRef = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
let resizeObserver: ResizeObserver | null = null;

const dims = computed(() => resolveKlipyAdDimensions(props.width, props.height));
const iframeContent = computed(() => prepareKlipyAdHtml(props.content));

/** Banner: scale the native creative to the container width. Inline: fixed width tile. */
const displaySize = computed(() => {
  const { width: nativeW, height: nativeH } = dims.value;

  if (props.layout === 'inline') {
    // ~2–2.5 gif cells wide in the slash-command strip (cells are 88px).
    const targetW = Math.min(Math.max(nativeW, 176), 240);
    const targetH = Math.min(Math.round(targetW * (nativeH / nativeW)), 100);
    return { width: targetW, height: targetH, scale: 1 };
  }

  const cw = containerWidth.value || nativeW;
  const scale = cw / nativeW;
  return {
    width: cw,
    height: Math.min(Math.round(nativeH * scale), KLIPY_AD_MAX_HEIGHT),
    scale,
  };
});

const slotStyle = computed(() => ({
  width: props.layout === 'inline' ? `${displaySize.value.width}px` : '100%',
  height: `${displaySize.value.height}px`,
}));

const iframeStyle = computed(() => {
  const { width: nativeW, height: nativeH } = dims.value;
  const { scale } = displaySize.value;
  if (props.layout === 'inline') {
    return { width: `${nativeW}px`, height: `${nativeH}px`, transform: `scale(${displaySize.value.width / nativeW})` };
  }
  if (scale === 1) {
    return { width: `${nativeW}px`, height: `${nativeH}px` };
  }
  return {
    width: `${nativeW}px`,
    height: `${nativeH}px`,
    transform: `scale(${scale})`,
  };
});

onMounted(() => {
  if (props.layout !== 'banner') return;
  const measure = () => {
    containerWidth.value = rootRef.value?.clientWidth ?? 0;
  };
  measure();
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(rootRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<style scoped>
.gif-ad-slot {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 4px;
  background: var(--background-senary-alpha);
  border: 1px solid var(--border-secondary);
}

.gif-ad-slot--banner {
  width: 100%;
}

.gif-ad-frame-wrap {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.gif-ad-frame {
  border: 0;
  display: block;
  transform-origin: top left;
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
</style>
