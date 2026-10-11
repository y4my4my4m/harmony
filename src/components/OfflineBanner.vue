<!-- The status region stays mounted; only its content changes, which is what
     screen readers announce reliably. -->
<template>
  <div class="offline-banner-region" role="status">
    <Transition name="offline-slide">
      <div v-if="isOffline" class="offline-banner">
        <Icon name="wifi-off" :size="14" class="offline-icon" aria-hidden="true" />
        <span>{{ t('offline.banner') }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { announce } from '@/composables/useAnnouncer'

const { t } = useI18n()

const isOffline = ref(!navigator.onLine)

function handleOnline() {
  if (isOffline.value) announce(t('a11y.backOnline'))
  isOffline.value = false
}
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
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 13px;
  font-weight: 500;
  text-align: center;
}

.offline-icon {
  flex-shrink: 0;
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
