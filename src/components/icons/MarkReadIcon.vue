<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :class="className"
  >
    <polyline points="20,6 9,17 4,12" />
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'MarkReadIcon',
  props: {
    size: {
      type: [Number, String],
      default: 16
    },
    className: {
      type: String,
      default: ''
    }
  }
});
</script>