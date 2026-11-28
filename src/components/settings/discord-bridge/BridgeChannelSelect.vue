<template>
  <div class="db-field">
    <label :for="id" class="db-label">{{ t('discordBridge.pairs.harmonyChannel') }}</label>
    <select :id="id" v-model="model" class="db-select" :aria-describedby="describedby || undefined" data-testid="select-harmony">
      <option value="">{{ t('discordBridge.pairs.choose') }}</option>
      <template v-for="group in groups" :key="group.label">
        <optgroup v-if="group.label" :label="group.label">
          <option v-for="c in group.channels" :key="c.id" :value="c.id" :disabled="isEncrypted(c)">{{ label(c) }}</option>
        </optgroup>
        <template v-else>
          <option v-for="c in group.channels" :key="c.id" :value="c.id" :disabled="isEncrypted(c)">{{ label(c) }}</option>
        </template>
      </template>
    </select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { HarmonyChannelGroup, HarmonyChannelOption } from '@/utils/discordBridgeSetup'

const props = withDefaults(
  defineProps<{
    id: string
    groups: readonly HarmonyChannelGroup[]
    /** Channels listed but not offered, with the reason. */
    encryptedIds?: readonly string[]
    describedby?: string
  }>(),
  { encryptedIds: () => [], describedby: '' },
)

const model = defineModel<string>({ required: true })

const { t } = useI18n()
const isEncrypted = (channel: HarmonyChannelOption) => props.encryptedIds.includes(channel.id)

function label(channel: HarmonyChannelOption): string {
  if (!isEncrypted(channel)) return `#${channel.name}`
  return t('discordBridge.pairs.optionWithIssue', { name: channel.name, issue: t('bridges.encrypted') })
}
</script>

<style scoped src="./bridge.css"></style>
