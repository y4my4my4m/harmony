<template>
  <!-- <h2>Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration Registration </h2> -->
  <AuthComponent :isLogin="false" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import AuthComponent from '@/components/AuthComponent.vue'

export default defineComponent({
  name: 'RegisterView',
  components: {
    AuthComponent,
  },
})
</script>

<style scoped>
  h2 {

    background-clip: text;
    -webkit-text-fill-color: transparent; 
    -moz-text-fill-color: transparent;
    background-image: linear-gradient(45deg, #3416f7, #c41d1d);
    width: 180%;
    height: 100%;
    position: absolute;
    display: block;
    top: -390px;
    margin: 0 auto;
    left: -480px;
    right: 0;
    text-align: center;
    font-weight: 900;
    opacity: .1;
    font-size: 20em;
    text-shadow: 0 3px 10px rgba(0,0,0,0.7);
    transform: skew(6deg, 8deg) rotate3d(7, 0, 0, 30deg);
  }
</style>