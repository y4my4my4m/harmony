<template>
  <template v-if="hasEmojiParts">
    <template v-for="(part, i) in parts!" :key="i">
      <span v-if="part.type === 'text'">{{ part.text }}</span>
      <img
        v-else-if="part.type === 'emoji'"
        class="badge-emoji"
        :src="getEmojiUrl(part.emoji.url, size)"
        :alt="`:${part.emoji.name}:`"
        :title="`:${part.emoji.name}:`"
        draggable="false"
      />
    </template>
  </template>
  <template v-else>{{ displayText }}</template>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useSupporterBadgeIcon } from '@/composables/useSupporterBadgeIcon'
import { getEmojiUrl } from '@/utils/emojiUtils'

const props = withDefaults(defineProps<{
  icon?: string | null
  size?: number
}>(), {
  icon: null,
  size: 32,
})

const iconRef = toRef(props, 'icon')
const { parts, displayText } = useSupporterBadgeIcon(iconRef)

const hasEmojiParts = computed(() => parts.value?.some(p => p.type === 'emoji') ?? false)
</script>

<style scoped>
.badge-emoji {
  height: 1em;
  width: auto;
  vertical-align: -0.1em;
  object-fit: contain;
}
</style>
