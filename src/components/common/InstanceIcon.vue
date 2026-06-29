<template>
  <img
    v-if="src && !failed"
    :src="src"
    alt=""
    class="instance-icon-img"
    @error="failed = true"
  />
  <Icon v-else name="globe" :size="size" class="instance-icon-fallback" />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    src?: string | null
    size?: number
  }>(),
  { size: 14 },
)

const failed = ref(false)

watch(
  () => props.src,
  () => {
    failed.value = false
  },
)
</script>

<style scoped>
.instance-icon-img {
  width: 100%;
  height: 100%;
  border-radius: 4px;
  object-fit: cover;
  display: block;
}

.instance-icon-fallback {
  flex-shrink: 0;
  opacity: 0.85;
}
</style>
