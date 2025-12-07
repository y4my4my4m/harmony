<template>
  <svg class="threadIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
    <path d="M12 2.81a1 1 0 0 1 0-1.41l.36-.36a1 1 0 0 1 1.41 0l9.2 9.2a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.3.13l-9.54-6.72a1 1 0 0 1-.08-1.58l1-1 .65.65-1 1 7.93 5.59-7.16-7.16-.77.77ZM23.2 12.8a1 1 0 0 0-1.4-1.41l-7.44 7.43a2 2 0 0 1-1.41.6H8.94l3.48-3.6a.5.5 0 0 0-.35-.84h-2.3a2 2 0 0 1-1.41-.6L5.92 12 4.51 13.4a2 2 0 0 0 0 2.83l4.42 4.42a2 2 0 0 0 1.41.58h5.63a2 2 0 0 0 1.41-.58l5.82-5.83Z" fill="currentColor"/>
    <path d="M1 16.5a1.5 1.5 0 0 1 1.5-1.5H8a1 1 0 0 1 0 2H2.5A1.5 1.5 0 0 1 1 15.5Z" fill="currentColor"/>
    <path d="M1 12a1.5 1.5 0 0 1 1.5-1.5H6a1 1 0 1 1 0 2H2.5A1.5 1.5 0 0 1 1 12Z" fill="currentColor"/>
    <path d="M1 7.5A1.5 1.5 0 0 1 2.5 6H4a1 1 0 0 1 0 2H2.5A1.5 1.5 0 0 1 1 7.5Z" fill="currentColor"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'ThreadIcon',
});
</script>

<style scoped>
.threadIcon {
  width: 20px;
  height: 20px;
}
.threadIcon path {
  fill: #aaa;
  transition: fill .2s;
  cursor: pointer;
}
.threadIcon:hover path {
  fill: #fff;
}
</style>

