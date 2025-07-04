<template>
  <RouterView />
  <NotificationToast />
</template>

<script setup lang="ts">
import NotificationToast from '@/components/NotificationToast.vue'
</script>

<style>

  /* @font-face {
    font-family: 'NEC';
    src:  url('/assets/fonts/Web437_NEC_APC3_8x8.woff') format('woff')
  } */
  /* @font-face {
    font-family: 'Montserrat', sans-serif;
    src: url('/assets/fonts/Montserrat-Regular.ttf') format('truetype');
    font-weight: normal;
    font-style: normal;
  }
  @font-face {
    font-family: 'Montserrat', sans-serif;
    src: url('/assets/fonts/Montserrat-Italic.ttf') format('truetype');
    font-weight: normal;
    font-style: italic;
  } */


  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 300;
    src: local('gg sans Normal Regular'), url('/assets/fonts/gg_sans_Regular.woff') format('woff');
  }
  
  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 400;
    src: local('gg sans Medium Regular'), url('/assets/fonts/gg_sans_Medium.woff') format('woff');
  }

  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 700;
    src: local('gg sans SemiBold Regular'), url('/assets/fonts/gg_sans_Semibold.woff') format('woff');
  }
  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 900;
    src: local('gg sans Bold'), url('/assets/fonts/gg_sans_Bold.woff') format('woff');
  }
  
  /* Global styles */
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: 'gg sans', Arial, sans-serif;
    font-weight:100!important;
  }

  #app {
    width: 100%;
    height: 100%;
  }
</style>
