<!--
  OutsideLinkDialog - "Leaving Harmony": the link services/outsideLinks holds back, its whole
  address with the host in bold, and Copy link, Cancel, Open. Signed in, "Trust <host>" makes
  that host open without asking from now on. An alertdialog: the address is its description,
  read on opening; Cancel takes focus; Escape and the overlay cancel; focus returns to the link.
-->
<template>
  <AppDialog
    :open="!!link"
    role="alertdialog"
    class="outside-link-dialog"
    overlay-class="outside-link-overlay"
    :describedby="descriptionId"
    data-testid="outside-link-dialog"
    v-slot="{ titleId }"
    @close="cancel"
  >
    <template v-if="link">
      <h2 :id="titleId" class="outside-link-title">{{ t('outsideLink.title') }}</h2>
      <div :id="descriptionId">
        <p class="outside-link-lead">{{ link.masked ? t('outsideLink.maskedLead') : t('outsideLink.lead') }}</p>
        <p class="outside-link-url" dir="ltr" translate="no" data-testid="outside-link-url"><span
          class="outside-link-url__rest">{{ parts.before }}</span><strong
          class="outside-link-url__host" data-testid="outside-link-host">{{ parts.host }}</strong><span
          class="outside-link-url__rest">{{ parts.after }}</span></p>
      </div>
      <label v-if="canTrust" class="outside-link-trust">
        <input v-model="trust" type="checkbox" data-testid="outside-link-trust" />
        <span>{{ t('outsideLink.trust', { host: link.host }) }}</span>
      </label>
      <div class="outside-link-actions">
        <button type="button" class="btn btn-ghost outside-link-copy" data-testid="outside-link-copy" @click="copy">
          <Icon name="copy" :size="16" aria-hidden="true" />
          {{ t('outsideLink.copy') }}
        </button>
        <button type="button" class="btn btn-secondary" data-autofocus data-testid="outside-link-cancel" @click="cancel">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="btn btn-primary" data-testid="outside-link-open" @click="open">
          {{ t('outsideLink.open') }}
        </button>
      </div>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import AppDialog from '@/components/a11y/AppDialog.vue'
import Icon from '@/components/common/Icon.vue'
import { useOutsideLinkPrompt } from '@/services/outsideLinks'
import { useOutsideLinkSettingsStore } from '@/stores/outsideLinkSettings'
import { uid } from '@/utils/a11y/focus'
import { debug } from '@/utils/debug'
import { splitUrlForDisplay } from '@/utils/outsideLinks'

const { t } = useI18n()
const toast = useToast()
const prompt = useOutsideLinkPrompt()
const settings = useOutsideLinkSettingsStore()

const descriptionId = uid('outside-link-desc')
const link = computed(() => prompt.pending.value)
const parts = computed(() => (link.value && splitUrlForDisplay(link.value.url)) || { before: link.value?.url ?? '', host: '', after: '' })
const canTrust = computed(() => settings.signedIn && !!link.value?.host)
const trust = ref(false)

watch(link, () => {
  trust.value = false
})

function cancel(): void {
  prompt.cancel()
}

function open(): void {
  const host = link.value?.host
  prompt.proceed(trust.value).catch((error) => {
    debug.warn('[outsideLinks] trust failed:', error)
    toast.error(t('outsideLink.trustFailed', { host }))
  })
}

async function copy(): Promise<void> {
  const url = link.value?.url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    toast.success(t('outsideLink.copied'))
  } catch (error) {
    debug.warn('[outsideLinks] copy failed:', error)
    toast.error(t('outsideLink.copyFailed'))
  }
}
</script>

<style>
/* The dialog element is AppDialog's; scoped styles reach only the slot content. */
.app-dialog-overlay.outside-link-overlay {
  --app-dialog-z: 10020;
}

.app-dialog-overlay > .outside-link-dialog {
  width: min(480px, calc(100 * var(--app-vw) - 32px));
  max-height: calc(100 * var(--app-vh) - 32px);
  overflow: auto;
  padding: var(--space-5, 20px);
  border-radius: var(--radius-lg, 12px);
  background: var(--background-primary);
  box-shadow: var(--shadow-large);
  color: var(--text-primary);
}

@media (max-width: 480px) {
  .app-dialog-overlay.outside-link-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .app-dialog-overlay > .outside-link-dialog {
    width: 100%;
    max-height: calc(100 * var(--app-vh));
    border-radius: var(--radius-lg, 12px) var(--radius-lg, 12px) 0 0;
    padding-bottom: calc(var(--space-5, 20px) + env(safe-area-inset-bottom, 0px));
  }
}
</style>

<style scoped>
.outside-link-title {
  margin: 0 0 8px;
  font-size: 1.125rem;
  font-weight: 600;
}

.outside-link-lead {
  margin: 0 0 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.outside-link-url {
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md, 8px);
  background: var(--background-secondary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-size-sm, 0.875rem);
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-all;
  unicode-bidi: isolate;
}

.outside-link-url__rest {
  color: var(--text-secondary);
}

.outside-link-url__host {
  color: var(--text-primary);
  font-weight: 700;
}

.outside-link-trust {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 16px;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.outside-link-trust input {
  flex-shrink: 0;
  margin-top: 3px;
  accent-color: var(--harmony-primary);
}

.outside-link-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.outside-link-copy {
  margin-right: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 480px) {
  .outside-link-actions {
    flex-direction: column-reverse;
    align-items: stretch;
  }

  .outside-link-actions .btn {
    justify-content: center;
    min-height: 44px;
  }

  .outside-link-copy {
    margin-right: 0;
  }
}
</style>
