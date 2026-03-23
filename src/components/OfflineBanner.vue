<template>
  <Transition name="offline-slide">
    <div v-if="isOffline" class="offline-banner">
      <span class="offline-icon">&#9888;</span>
      <span>{{ t('offline.banner') }}</span>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const isOffline = ref(!navigator.onLine)

function handleOnline() { isOffline.value = false }
function handleOffline() { isOffline.value = true }

onMounted(() => {
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
})

onUnmounted(() => {
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
})
</script>

<style scoped>
.offline-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 16px;
  background: var(--color-error, #e53935);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  text-align: center;
}

.offline-icon {
  font-size: 15px;
}

.offline-slide-enter-active,
.offline-slide-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.offline-slide-enter-from,
.offline-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
