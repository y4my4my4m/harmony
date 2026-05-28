<template>
  <DisplayName
    class="supporter-badge-icon"
    :parts="parts ?? undefined"
    :fallback="displayText"
  />
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import DisplayName from '@/components/DisplayName.vue'
import { useSupporterBadgeIcon } from '@/composables/useSupporterBadgeIcon'

const props = withDefaults(defineProps<{
  icon?: string | null
}>(), {
  icon: null,
})

const iconRef = toRef(props, 'icon')
const { parts, displayText } = useSupporterBadgeIcon(iconRef)
</script>

<style scoped>
/* Sized down from DisplayName's defaults — badges live in tight pills. */
.supporter-badge-icon :deep(.display-name-emoji) {
  height: 1em;
  vertical-align: -0.1em;
  /*
   * Suppress the inner <img>'s `title=":har_love:"` tooltip so hover surfaces
   * the parent <span class="supporter-badge">'s title (e.g. "Fantastic
   * Supporter") instead of the raw emoji shortcode. Tooltips come from the
   * topmost hovered element, and DisplayName always sets a per-emoji title.
   */
  pointer-events: none;
}
</style>
