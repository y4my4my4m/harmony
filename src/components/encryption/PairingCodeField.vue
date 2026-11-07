<template>
  <div class="pairing-code" data-testid="pairing-code">
    <label :for="fieldId" class="pc-label">{{ $t('encryption.code.textLabel') }}</label>
    <textarea
      :id="fieldId"
      ref="field"
      class="pc-text"
      :class="{ 'pc-expired': expired }"
      data-testid="pairing-code-text"
      :value="code"
      readonly
      rows="3"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      :aria-describedby="failed ? noteId : undefined"
      @focus="selectAll"
    ></textarea>
    <button
      type="button"
      class="btn btn-secondary btn-sm pc-copy"
      data-testid="pairing-code-copy"
      :disabled="!code || expired"
      @click="copy"
    >
      <Icon :name="copied ? 'check' : 'copy'" :size="14" aria-hidden="true" />
      {{ copied ? $t('common.copied') : $t('encryption.code.copyCode') }}
    </button>
    <p v-if="failed" :id="noteId" class="pc-note" role="status" data-testid="pairing-code-copy-failed">
      {{ $t('encryption.code.copyFailed') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { useAnnouncer } from '@/composables/useAnnouncer'

const props = withDefaults(defineProps<{ code: string; expired?: boolean }>(), { expired: false })

const { t } = useI18n()
const { polite } = useAnnouncer()
const uid = useId()
const fieldId = `pairing-code-${uid}`
const noteId = `pairing-code-note-${uid}`
const field = ref<HTMLTextAreaElement | null>(null)
const copied = ref(false)
const failed = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.code, () => {
  copied.value = false
  failed.value = false
})

function selectAll() {
  field.value?.select()
}

/** execCommand('copy') covers pages without the async Clipboard API (plain http, older WebViews). */
function copySelection(): boolean {
  const el = field.value
  if (!el) return false
  el.focus()
  el.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  }
}

async function copy() {
  if (!props.code) return
  failed.value = false
  let ok = false
  try {
    await navigator.clipboard.writeText(props.code)
    ok = true
  } catch {
    ok = copySelection()
  }
  if (!ok) {
    failed.value = true
    field.value?.focus()
    field.value?.select()
    return
  }
  copied.value = true
  polite(t('common.copied'))
  if (resetTimer) clearTimeout(resetTimer)
  resetTimer = setTimeout(() => { copied.value = false }, 2500)
}

onUnmounted(() => {
  if (resetTimer) clearTimeout(resetTimer)
})
</script>

<style scoped>
.pairing-code {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 280px;
  max-width: 100%;
}

.pc-label {
  align-self: flex-start;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.pc-text {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  word-break: break-all;
  resize: none;
  user-select: all;
}

.pc-text:focus {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: 1px;
}

.pc-expired {
  color: var(--text-secondary);
  text-decoration: line-through;
}

.pc-copy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pc-note {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.45;
  color: var(--text-primary);
}
</style>
