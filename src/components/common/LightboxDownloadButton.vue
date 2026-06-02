<template>
  <Teleport to="body">
    <button
      v-if="visible && url"
      type="button"
      class="lightbox-download-btn"
      aria-label="Download"
      title="Download"
      @click.stop="handleDownload"
    >
      <Icon name="download" />
    </button>
  </Teleport>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue';
import { downloadMediaFromUrl } from '@/utils/downloadMedia';

const props = defineProps<{
  visible: boolean;
  url: string;
  filename?: string;
}>();

async function handleDownload() {
  if (!props.url) return;
  await downloadMediaFromUrl(props.url, props.filename);
}
</script>

<style scoped>
.lightbox-download-btn {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 50%;
  background: rgba(45, 45, 45, 0.92);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  transition: background 0.15s ease, transform 0.15s ease;
}

.lightbox-download-btn:hover {
  background: rgba(61, 61, 61, 0.95);
}

.lightbox-download-btn:active {
  transform: scale(0.94);
}

@media (max-width: 750px) {
  .lightbox-download-btn {
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    right: calc(12px + env(safe-area-inset-right, 0px));
  }
}
</style>
