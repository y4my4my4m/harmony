<template>
  <div class="settings-build-footer">
    <button
      type="button"
      class="build-line"
      :title="$t('settings.buildInfo.copyHint')"
      :aria-label="$t('settings.buildInfo.copyHint')"
      data-testid="build-line"
      @click="copySupportInfo"
    >
      {{ versionLine }}
    </button>
    <div class="legal-links">
      <a :href="termsUrl" target="_blank" rel="noopener noreferrer">{{ $t('settings.buildInfo.terms') }}</a>
      <a :href="privacyUrl" target="_blank" rel="noopener noreferrer">{{ $t('settings.buildInfo.privacy') }}</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { safeHref } from '@/utils/sanitize'
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

const build = getBuildInfo()
const platform = getPlatformLabel()
const nativeVersion = ref<string | null>(null)

const versionLine = computed(() => formatVersionLine(build, platform, nativeVersion.value))
const termsUrl = computed(() => safeHref(instanceSettings.settings.termsUrl) || DEFAULT_TERMS_URL)
const privacyUrl = computed(() => safeHref(instanceSettings.settings.privacyUrl) || DEFAULT_PRIVACY_URL)

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
