<template>
  <!-- A 20x14 pill with G, I, F cut out (evenodd): Figtree wght 800 outlines, 7px cap height,
       0.9px tracking, centred on (12, 12). Colour follows the button (currentColor). -->
  <svg class="icon-component" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M6 5h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z M8.22 15.68Q7.15 15.68 6.32 15.21Q5.49 14.75 5.02 13.94Q4.55 13.12 4.55 12.06Q4.55 11 5.02 10.19Q5.49 9.37 6.32 8.91Q7.15 8.44 8.22 8.44Q8.9 8.44 9.44 8.64Q9.98 8.83 10.39 9.17Q10.8 9.51 11.08 9.95L9.75 10.75Q9.59 10.51 9.35 10.32Q9.1 10.13 8.81 10.02Q8.52 9.92 8.22 9.92Q7.63 9.92 7.18 10.19Q6.72 10.46 6.46 10.94Q6.2 11.43 6.2 12.06Q6.2 12.69 6.45 13.18Q6.71 13.66 7.17 13.94Q7.64 14.22 8.26 14.22Q8.7 14.22 9.04 14.06Q9.39 13.9 9.6 13.62Q9.81 13.34 9.85 12.96H8.27V11.72H11.4V12.67Q11.38 13.65 10.96 14.32Q10.55 15 9.84 15.34Q9.13 15.68 8.22 15.68Z M12.3 15.56V8.56H13.91V15.56Z M14.81 15.56V8.56H19.45V10.04H16.42V11.39H18.87V12.86H16.42V15.56Z"
    />
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'GifIcon',
});
</script>

<style scoped>
.icon-component {
  display: block;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}
</style>
