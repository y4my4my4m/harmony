<template>
  <Transition name="android-update">
    <div v-if="release" class="android-update" role="status">
      <span class="android-update__text">
        {{ t('updater.android.available', { version: release.version }) }}
      </span>
      <button type="button" class="android-update__download" @click="download">
        <Icon name="download" :size="14" aria-hidden="true" />
        {{ t('updater.android.download') }}
      </button>
      <button
        type="button"
        class="android-update__dismiss"
        :aria-label="t('updater.android.dismiss')"
        @click="dismiss"
      >
        <Icon name="x" :size="16" aria-hidden="true" />
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { dismissVersion, findAndroidUpdate, type AndroidRelease } from '@/services/androidReleaseNotice'
import { openExternalUrl } from '@/services/tauriLinks'

const { t } = useI18n()
const release = ref<AndroidRelease | null>(null)

function download() {
  if (release.value) void openExternalUrl(release.value.url)
}

function dismiss() {
  if (release.value) dismissVersion(release.value.version)
  release.value = null
}

onMounted(async () => {
  release.value = await findAndroidUpdate()
})
</script>

<style scoped>
.android-update {
  position: fixed;
  left: var(--space-3);
  right: var(--space-3);
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 480px;
  margin: 0 auto;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.android-update__text {
  flex: 1;
  min-width: 0;
}

.android-update__download {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: var(--success);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.android-update__dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.android-update-enter-active,
.android-update-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.android-update-enter-from,
.android-update-leave-to {
  transform: translateY(8px);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .android-update-enter-active,
  .android-update-leave-active {
    transition: none;
  }
}
</style>
