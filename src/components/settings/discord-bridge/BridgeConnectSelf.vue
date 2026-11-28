<template>
  <div data-testid="connect-self">
    <p class="db-text">{{ t('discordBridge.self.lead') }}</p>
    <BridgeDockerHint />

    <BridgeSetupCode
      :bridge-id="bridgeId"
      :issue="createSetupCode"
      :variants="VARIANTS"
      :variant-name="(v) => t(`discordBridge.self.variant.${v}`)"
      :auto-issue="autoIssue"
    >
      <template #default="{ variant, code }">
        <ol class="db-steps">
          <li>
            {{ variant === 'run' ? t('discordBridge.self.run.copy') : t('discordBridge.self.compose.copy') }}
            <BridgeCopyBlock
              :text="variant === 'run' ? buildDockerRunCommand({ harmonyUrl, setupCode: code }) : buildDockerCompose({ harmonyUrl, setupCode: code })"
              :label="variant === 'run' ? t('discordBridge.self.run.label') : t('discordBridge.self.compose.label')"
              :data-testid="variant === 'run' ? 'docker-run' : 'docker-compose'"
            />
          </li>
          <li>
            <i18n-t keypath="discordBridge.self.replaceToken" tag="span" scope="global">
              <template #placeholder><code class="db-inline-code">{{ DISCORD_TOKEN_PLACEHOLDER }}</code></template>
            </i18n-t>
          </li>
          <li v-if="variant === 'run'">{{ t('discordBridge.self.run.paste') }}</li>
          <li v-else>
            <i18n-t keypath="discordBridge.self.compose.run" tag="span" scope="global">
              <template #command><code class="db-inline-code">docker compose up -d</code></template>
            </i18n-t>
          </li>
        </ol>
      </template>
      <template #trouble>
        <BridgeDockerTrouble :logs="BRIDGE_LOGS_COMMAND" :remove="BRIDGE_REMOVE_COMMAND" :reset="BRIDGE_RESET_COMMAND" />
      </template>
    </BridgeSetupCode>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  BRIDGE_LOGS_COMMAND,
  BRIDGE_REMOVE_COMMAND,
  BRIDGE_RESET_COMMAND,
  DISCORD_TOKEN_PLACEHOLDER,
  buildDockerCompose,
  buildDockerRunCommand,
} from '@/utils/discordBridgeSetup'
import { createSetupCode } from './bridgeApi'
import BridgeCopyBlock from './BridgeCopyBlock.vue'
import BridgeDockerHint from './BridgeDockerHint.vue'
import BridgeDockerTrouble from './BridgeDockerTrouble.vue'
import BridgeSetupCode from './BridgeSetupCode.vue'

const VARIANTS = ['run', 'compose'] as const

withDefaults(
  defineProps<{
    bridgeId: string
    harmonyUrl: string
    /** Issue a code on mount; off where reinstalling is optional. */
    autoIssue?: boolean
  }>(),
  { autoIssue: true },
)

const { t } = useI18n()
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.db-steps .db-code-block {
  margin-top: 8px;
}
</style>
