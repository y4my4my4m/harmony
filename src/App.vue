<template>
  <RouterView />
  <NotificationToast />
  
  <!-- Persistent Voice Connection -->
  <PersistentVoiceConnection />
  
  <!-- PWA Components -->
  <PWAInstallBanner />
  <PWAUpdateNotification />
</template>

<script setup lang="ts">
import NotificationToast from '@/components/NotificationToast.vue'
import PersistentVoiceConnection from '@/components/PersistentVoiceConnection.vue'
import PWAInstallBanner from '@/components/PWAInstallBanner.vue'
import PWAUpdateNotification from '@/components/PWAUpdateNotification.vue'
import { onMounted } from 'vue'
import { hapticManager } from '@/utils/hapticFeedback'

// Initialize haptic feedback for the app
onMounted(() => {
  // Add haptic feedback to common interactive elements
  const addHapticToElements = (selector: string, pattern: string = 'light') => {
    document.addEventListener('click', (e) => {
      const element = (e.target as HTMLElement).closest(selector)
      if (element && hapticManager.enabled) {
        hapticManager.trigger({ pattern: pattern as any })
      }
    })
  }

  // Add haptic feedback to buttons and interactive elements
  addHapticToElements('button', 'light')
  addHapticToElements('.interactive-element', 'light')
  addHapticToElements('a[href]', 'selection')
  addHapticToElements('.card-interactive', 'medium')
})
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
