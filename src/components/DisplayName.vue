<template>
  <span class="display-name" :class="{ truncate }" :style="nameStyle">
    <template v-if="resolvedParts && resolvedParts.length > 0">
      <template v-for="(part, i) in resolvedParts" :key="i">
        <span v-if="part.type === 'text'">{{ part.text }}</span>
        <img
          v-else-if="part.type === 'emoji'"
          class="display-name-emoji"
          :src="getEmojiUrl(part.emoji.url, 48)"
          :alt="`:${part.emoji.name}:`"
          :title="`:${part.emoji.name}:`"
          draggable="false"
        />
      </template>
    </template>
    <template v-else>{{ plainName }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useUserData } from '@/composables/useUserData'
import { getEmojiUrl } from '@/utils/emojiUtils'
import type { DisplayNamePart } from '@/types'

const props = defineProps<{
  userId?: string
  parts?: DisplayNamePart[]
  fallback?: string
  color?: string
  truncate?: boolean
}>()

const { getUserDisplayName, getUserDisplayNameParts } = useUserData()

const resolvedParts = computed<DisplayNamePart[] | undefined>(() => {
  if (props.parts) return props.parts
  if (props.userId) return getUserDisplayNameParts(props.userId).value
  return undefined
})

const plainName = computed(() => {
  if (props.userId) return getUserDisplayName(props.userId).value
  return props.fallback || 'Unknown User'
})

const nameStyle = computed(() => {
  if (props.color) return { color: props.color }
  return undefined
})
</script>

<style scoped>
.display-name {
  display: inline;
  vertical-align: baseline;
}

.display-name.truncate {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.display-name-emoji {
  height: 1.2em;
  width: auto;
  vertical-align: -0.2em;
  margin: 0 1px;
  object-fit: contain;
}
</style>
