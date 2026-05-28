<template>
  <span
    v-if="effectiveBadge && effectiveBadge.is_active"
    class="supporter-badge"
    :style="badgeStyle"
    :title="`${effectiveBadge.tier_name} Supporter`"
  >
    <SupporterBadgeIcon :icon="effectiveBadge.badge_icon" />
  </span>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { fundingService, type SupporterBadge } from '@/services/FundingService'
import SupporterBadgeIcon from './SupporterBadgeIcon.vue'

interface Props {
  userId?: string
  badge?: SupporterBadge | null
}

const props = defineProps<Props>()

const fetchedBadge = ref<SupporterBadge | null>(null)

const effectiveBadge = computed<SupporterBadge | null>(() => {
  if (props.badge !== undefined) return props.badge
  return fetchedBadge.value
})

const badgeStyle = computed(() => {
  const b = effectiveBadge.value
  if (!b?.badge_color) return {}
  return {
    backgroundColor: `${b.badge_color}20`,
    borderColor: 'transparent',
    color: b.badge_color
  }
})

const loadBadge = async () => {
  if (props.badge !== undefined) return
  if (!props.userId) {
    fetchedBadge.value = null
    return
  }
  fetchedBadge.value = await fundingService.getSupporterBadge(props.userId)
}

watch(() => [props.userId, props.badge], loadBadge)
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
</style>
