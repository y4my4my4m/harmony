<template>
  <div class="gif-ad-slot" :style="{ aspectRatio: width && height ? `${width} / ${height}` : undefined }">
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
/**
 * Renders a Klipy ad. Klipy ads are an HTML blob meant for a WebView; on the web
 * we render it in a sandboxed iframe. The sandbox intentionally omits
 * `allow-same-origin` so the ad cannot reach Harmony's origin, cookies, or DOM.
 */
defineProps<{
  content: string;
  width?: number;
  height?: number;
}>();
</script>

<style scoped>
.gif-ad-slot {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 4px;
  background: var(--background-senary-alpha);
  border: 1px solid var(--border-secondary);
  min-height: 80px;
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
  min-height: 80px;
  border: 0;
  display: block;
}
</style>
