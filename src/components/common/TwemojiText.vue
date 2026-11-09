<template>
  <template v-for="(run, index) in runs" :key="index">
    <img v-if="run.src" class="inline-emoji" :src="run.src" :alt="run.text" draggable="false" />
    <template v-else>{{ run.text }}</template>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ensureEmojiDataLoaded } from '@/composables/useEmojiLoader'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { splitEmojiSequences } from '@/utils/unicodeEmoji'

// Plain text with unicode emoji in the selected emoji pack.
const props = defineProps<{ text: string }>()

const { isLoaded, isNativePack, getTwemojiUrl } = useUnifiedEmoji()

const runs = computed(() => {
  const parts = splitEmojiSequences(props.text)
  if (isNativePack.value || !parts.some((run) => run.emoji)) return parts.map((run) => ({ text: run.text, src: null }))
  void ensureEmojiDataLoaded()
  if (!isLoaded.value) return parts.map((run) => ({ text: run.text, src: null }))
  return parts.map((run) => ({ text: run.text, src: run.emoji ? getTwemojiUrl(run.text) : null }))
})
</script>
