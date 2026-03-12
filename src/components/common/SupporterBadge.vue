<template>
  <span
    v-if="badge && badge.is_active"
    class="supporter-badge"
    :style="badgeStyle"
    :title="`${badge.tier_name} Supporter`"
  >
    <template v-if="resolvedParts && resolvedParts.length > 0">
      <template v-for="(part, i) in resolvedParts" :key="i">
        <span v-if="part.type === 'text'">{{ part.text }}</span>
        <img
          v-else-if="part.type === 'emoji'"
          class="badge-emoji"
          :src="getEmojiUrl(part.emoji.url, 32)"
          :alt="`:${part.emoji.name}:`"
          :title="`:${part.emoji.name}:`"
          draggable="false"
        />
      </template>
    </template>
    <template v-else>{{ badgeIcon }}</template>
  </span>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { fundingService, type SupporterBadge } from '@/services/FundingService'
import { userDataService } from '@/services/userDataService'
import { getEmojiUrl } from '@/utils/emojiUtils'
import type { DisplayNamePart } from '@/types'

interface Props {
  userId: string
}

const props = defineProps<Props>()

const badge = ref<SupporterBadge | null>(null)

const badgeIcon = computed(() => badge.value?.badge_icon || '⭐')

const resolvedParts = computed<DisplayNamePart[] | undefined>(() => {
  const icon = badge.value?.badge_icon
  if (!icon) return undefined
  return userDataService.resolveDisplayNameParts(icon)
})

const badgeStyle = computed(() => {
  if (!badge.value?.badge_color) return {}
  return {
    backgroundColor: `${badge.value.badge_color}20`,
    borderColor: 'transparent',
    color: badge.value.badge_color
  }
})

const loadBadge = async () => {
  badge.value = await fundingService.getSupporterBadge(props.userId)
}

watch(() => props.userId, loadBadge)
onMounted(loadBadge)
</script>

<style scoped>
.supporter-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 4px;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid;
  line-height: 1;
  vertical-align: middle;
  margin-left: 4px;
}

.badge-emoji {
  height: 1em;
  width: auto;
  vertical-align: -0.1em;
  object-fit: contain;
}
</style>
