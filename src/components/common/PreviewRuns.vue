<template>
  <template v-for="(run, index) in runs" :key="index">
    <img
      v-if="run.emoji && !failed.has(run.emoji.url)"
      class="preview-emoji"
      :src="getEmojiUrl(run.emoji.url, 48)"
      :alt="`:${run.emoji.name}:`"
      :title="`:${run.emoji.name}:`"
      draggable="false"
      @error="failed.add(run.emoji.url)"
    />
    <TwemojiText v-else :text="run.emoji ? `:${run.emoji.name}:` : run.text" />
  </template>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import TwemojiText from '@/components/common/TwemojiText.vue'
import { getEmojiUrl } from '@/utils/emojiUtils'
import type { PreviewRun } from '@/utils/previewRuns'

defineProps<{ runs: PreviewRun[] }>()

/** Emoji addresses that did not load; their names stand in. */
const failed = reactive(new Set<string>())
</script>

<style scoped>
/* Sized on both axes: the line keeps its height before the image loads. */
.preview-emoji {
  width: 1.2em;
  height: 1.2em;
  object-fit: contain;
  vertical-align: -0.2em;
  margin: 0 1px;
}
</style>
