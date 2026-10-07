<template>
  <div class="db-code-block">
    <pre class="db-code" :aria-label="label" tabindex="0"><code>{{ text }}</code></pre>
    <div class="db-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-testid="copy-button" @click="copy">
        <Icon :name="copied ? 'check' : 'copy'" :size="14" aria-hidden="true" />
        {{ copied ? t('discordBridge.common.copied') : (copyLabel || t('discordBridge.common.copy')) }}
      </button>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'

const props = defineProps<{
  text: string
  label: string
  copyLabel?: string
}>()

const { t } = useI18n()
const toast = useToast()
const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | null = null

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    toast.error(t('discordBridge.common.copyFailed'))
  }
}

onUnmounted(() => {
  if (resetTimer) clearTimeout(resetTimer)
})
</script>

<style scoped src="./bridge.css"></style>
