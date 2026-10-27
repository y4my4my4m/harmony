<template>
  <!-- A 23x17 pill with G, I, F cut out (evenodd): Figtree wght 800 outlines, 8px cap height,
       1px tracking, centred on (12, 12). Width matches the 23px emoji face (EmojiUI) beside it.
       Colour follows the button (currentColor). -->
  <svg class="icon-component" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M5 3.5h14a4.5 4.5 0 0 1 4.5 4.5v8a4.5 4.5 0 0 1-4.5 4.5H5a4.5 4.5 0 0 1-4.5-4.5V8a4.5 4.5 0 0 1 4.5-4.5z M7.71 16.21Q6.48 16.21 5.53 15.67Q4.59 15.14 4.05 14.21Q3.52 13.28 3.52 12.07Q3.52 10.86 4.05 9.93Q4.59 8.99 5.53 8.46Q6.48 7.93 7.71 7.93Q8.48 7.93 9.1 8.16Q9.72 8.38 10.19 8.77Q10.65 9.15 10.97 9.66L9.45 10.58Q9.27 10.29 8.99 10.08Q8.71 9.86 8.38 9.74Q8.05 9.62 7.71 9.62Q7.04 9.62 6.52 9.93Q6 10.24 5.7 10.79Q5.4 11.34 5.4 12.07Q5.4 12.78 5.69 13.34Q5.98 13.9 6.51 14.22Q7.05 14.54 7.76 14.54Q8.25 14.54 8.65 14.36Q9.04 14.18 9.29 13.85Q9.53 13.53 9.58 13.1H7.77V11.68H11.35V12.76Q11.32 13.89 10.84 14.65Q10.37 15.42 9.56 15.81Q8.75 16.21 7.71 16.21Z M12.35 16.07V8.07H14.18V16.07Z M15.18 16.07V8.07H20.48V9.76H17.02V11.3H19.82V12.99H17.02V16.07Z"
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
