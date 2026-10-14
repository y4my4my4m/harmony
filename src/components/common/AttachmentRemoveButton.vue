<template>
  <button
    type="button"
    class="attachment-remove-btn"
    title="Delete"
    aria-label="Remove attachment"
    @click.stop="$emit('click')"
  >
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineEmits<{ click: [] }>();
</script>

<style>
.attachment-remove-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Same box as .floating-video-popout beside it. */
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: 8px;
  background: rgb(12 14 20 / 0.72);
  color: #ff7a7d;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}

.attachment-remove-btn:hover {
  background: #f23f43;
  border-color: #f23f43;
  color: #fff;
}

.media-frame:hover > .attachment-remove-btn,
.message-media-gallery__item:hover .attachment-remove-btn,
.file-attachment:hover .attachment-remove-btn {
  opacity: 1;
}

.attachment-remove-btn:focus-visible {
  opacity: 1;
  outline: 2px solid #fff;
  outline-offset: 2px;
}
</style>
