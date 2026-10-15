<template>
  <div class="settings-build-footer">
    <button
      type="button"
      class="build-line"
      :title="$t('settings.buildInfo.copyHint')"
      :aria-describedby="hintId"
      data-testid="build-line"
      @click="copySupportInfo"
    >
      {{ versionLine }}
    </button>
    <span :id="hintId" class="sr-only">{{ $t('settings.buildInfo.copyHint') }}</span>
    <div class="legal-links">
      <a :href="termsUrl" target="_blank" rel="noopener noreferrer">{{ $t('settings.buildInfo.terms') }}</a>
      <a :href="privacyUrl" target="_blank" rel="noopener noreferrer">{{ $t('settings.buildInfo.privacy') }}</a>
      <a v-if="statusUrl" :href="statusUrl" target="_blank" rel="noopener noreferrer" data-testid="settings-status-link">{{ $t('settings.buildInfo.status') }}</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { safeHref } from '@/utils/sanitize'
import { runtimeConfig } from '@/services/runtimeConfig'
import {
  collectSupportInfo,
  formatSupportText,
  formatVersionLine,
  getBuildInfo,
  getNativeVersion,
  getPlatformLabel,
} from '@/utils/buildInfo'

// Fallbacks for instances without configured terms_url / privacy_url.
const DEFAULT_TERMS_URL = 'https://mony.lol/terms'
const DEFAULT_PRIVACY_URL = 'https://mony.lol/privacy-policy'

const { t } = useI18n()
const toast = useToast()
const instanceSettings = useInstanceSettingsStore()

const hintId = `build-hint-${useId()}`
const build = getBuildInfo()
const platform = getPlatformLabel()
const nativeVersion = ref<string | null>(null)

const versionLine = computed(() => formatVersionLine(build, platform, nativeVersion.value))
const termsUrl = computed(() => safeHref(instanceSettings.settings.termsUrl) || DEFAULT_TERMS_URL)
const privacyUrl = computed(() => safeHref(instanceSettings.settings.privacyUrl) || DEFAULT_PRIVACY_URL)
const statusUrl = safeHref(runtimeConfig.statusUrl)

onMounted(async () => {
  nativeVersion.value = await getNativeVersion()
})

async function copySupportInfo() {
  try {
    const text = formatSupportText(await collectSupportInfo())
    await navigator.clipboard.writeText(text)
    toast.success(t('settings.buildInfo.copied'))
  } catch {
    toast.error(t('settings.buildInfo.copyFailed'))
  }
}
</script>

<style scoped>
.settings-build-footer {
  margin-top: 24px;
  padding: 0 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.build-line {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  word-break: break-word;
}

.build-line:hover {
  color: var(--text-secondary);
}

.build-line:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.legal-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.legal-links a {
  color: inherit;
  text-decoration: none;
}

.legal-links a:hover {
  color: var(--text-secondary);
  text-decoration: underline;
}
</style>
