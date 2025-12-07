<template>
  <svg class="threadIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
    <path d="M17 13.44 4.442 17.082A2 2 0 0 0 4.982 21H19a2 2 0 0 0 .558-3.921l-1.115-.32A2 2 0 0 1 17 14.837V7.66"/>
    <path d="m7 10.56 12.558-3.642A2 2 0 0 0 19.018 3H5a2 2 0 0 0-.558 3.921l1.115.32A2 2 0 0 1 7 9.163v7.178"/>
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
  stroke: #aaa;
  transition: fill .2s;
  cursor: pointer;
}
.threadIcon:hover path {
  stroke: #fff;
}
</style>

