<template>
  <span
    v-if="badge && badge.is_active"
    class="supporter-badge"
    :style="badgeStyle"
    :title="`${badge.tier_name} Supporter`"
  >
    {{ badge.badge_icon || '⭐' }}
  </span>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { fundingService, type SupporterBadge } from '@/services/FundingService'

interface Props {
  userId: string
}

const props = defineProps<Props>()

const badge = ref<SupporterBadge | null>(null)

const badgeStyle = computed(() => {
  if (!badge.value?.badge_color) return {}
  return {
    backgroundColor: `${badge.value.badge_color}20`,
    // borderColor: badge.value.badge_color,
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
</style>
