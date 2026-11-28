<template>
  <div data-testid="matrix-connect-self">
    <p class="db-text">{{ t('matrixBridge.self.lead') }}</p>

    <fieldset v-if="connections.length > 1" class="connection-pick" data-testid="matrix-connection">
      <legend class="db-label">{{ t('matrixBridge.self.connection.label') }}</legend>
      <label v-for="c in connections" :key="c" class="connection-option">
        <input v-model="fields.connection" type="radio" :name="`${uid}-connection`" :value="c" :data-testid="`matrix-connection-${c}`" />
        <span>
          <span class="connection-title">{{ t(`matrixBridge.self.connection.${c}.title`) }}</span>
          <span class="db-muted connection-lead">{{ t(`matrixBridge.self.connection.${c}.lead`) }}</span>
        </span>
      </label>
    </fieldset>

    <p class="db-muted">{{ t(appService ? 'matrixBridge.self.needsAppService' : 'matrixBridge.self.needsAccount') }}</p>
    <p v-if="!appService" class="db-muted" data-testid="matrix-token-note">{{ t('matrixBridge.self.copiedToken') }}</p>

    <div class="connect-fields">
      <div v-for="field in shownFields" :key="field.name" class="db-field">
        <label class="db-label" :for="`${uid}-${field.name}`">{{ t(`matrixBridge.self.field.${field.name}.label`) }}</label>
        <input
          :id="`${uid}-${field.name}`"
          v-model.trim="fields[field.name]"
          class="db-input"
          type="text"
          :inputmode="field.url ? 'url' : 'text'"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="255"
          :placeholder="field.example"
          :aria-invalid="field.invalid ? 'true' : undefined"
          :aria-describedby="`${uid}-${field.name}-help`"
          :data-testid="`matrix-field-${field.name}`"
        />
        <p :id="`${uid}-${field.name}-help`" :class="field.invalid ? 'db-field-error' : 'db-muted field-help'" :data-testid="`matrix-field-${field.name}-help`">
          {{ t(`matrixBridge.self.field.${field.name}.${field.invalid ? 'invalid' : 'help'}`) }}
        </p>
      </div>
    </div>

    <BridgeSetupCode
      :bridge-id="bridgeId"
      :issue="createMatrixSetupCode"
      :variants="VARIANTS"
      :variant-name="(v) => t(v === 'source' ? 'matrixBridge.self.source.name' : `discordBridge.self.variant.${v}`)"
      :auto-issue="autoIssue"
    >
      <template #default="{ variant, code }">
        <BridgeDockerHint v-if="variant !== 'source'" />
        <p v-if="!complete" class="db-muted" data-testid="matrix-fields-missing">{{ t('matrixBridge.self.fillFields') }}</p>

        <ol v-if="variant === 'source'" class="db-steps">
          <li>
            {{ t('matrixBridge.self.source.install') }}
            <BridgeCopyBlock :text="MATRIX_SOURCE_INSTALL" :label="t('discordBridge.common.commandLabel')" data-testid="matrix-source-install" />
          </li>
          <li>
            <i18n-t keypath="matrixBridge.self.source.env" tag="span" scope="global">
              <template #file><code class="db-inline-code">.env</code></template>
            </i18n-t>
            <BridgeCopyBlock :text="buildMatrixEnvFile(commandInput(code))" label=".env" data-testid="matrix-source-env" />
          </li>
          <template v-if="!appService">
            <li>
              {{ t('matrixBridge.self.login') }}
              <BridgeCopyBlock :text="MATRIX_LOGIN_SOURCE" :label="t('discordBridge.common.commandLabel')" data-testid="matrix-login" />
            </li>
            <li>{{ t('matrixBridge.self.replaceToken', { placeholder: MATRIX_PLACEHOLDERS.accessToken }) }}</li>
          </template>
          <li>
            {{ t('matrixBridge.self.source.run') }}
            <BridgeCopyBlock :text="MATRIX_SOURCE_RUN" :label="t('discordBridge.common.commandLabel')" data-testid="matrix-source-run" />
          </li>
        </ol>
        <ol v-else class="db-steps">
          <li v-if="!appService">
            {{ t('matrixBridge.self.login') }}
            <BridgeCopyBlock :text="buildMatrixLoginDocker(values.homeserverUrl)" :label="t('discordBridge.common.commandLabel')" data-testid="matrix-login" />
          </li>
          <li>
            {{ t(variant === 'run' ? 'discordBridge.self.run.copy' : 'discordBridge.self.compose.copy') }}
            <BridgeCopyBlock
              :text="variant === 'run' ? buildMatrixDockerRun(commandInput(code)) : buildMatrixCompose(commandInput(code))"
              :label="t(variant === 'run' ? 'discordBridge.self.run.label' : 'discordBridge.self.compose.label')"
              :data-testid="variant === 'run' ? 'docker-run' : 'docker-compose'"
            />
          </li>
          <li v-if="!appService">{{ t('matrixBridge.self.replaceToken', { placeholder: MATRIX_PLACEHOLDERS.accessToken }) }}</li>
          <li v-if="variant === 'run'">{{ t('discordBridge.self.run.paste') }}</li>
          <li v-else>
            <i18n-t keypath="discordBridge.self.compose.run" tag="span" scope="global">
              <template #command><code class="db-inline-code">docker compose up -d</code></template>
            </i18n-t>
          </li>
        </ol>

        <div v-if="appService" data-testid="matrix-registration">
          <h4 class="db-card-sub">{{ t('matrixBridge.self.registration.title') }}</h4>
          <ol class="db-steps">
            <li>
              <i18n-t
                :keypath="variant === 'source' ? 'matrixBridge.self.registration.fromSource' : 'matrixBridge.self.registration.fromDocker'"
                tag="span"
                scope="global"
              >
                <template #file><code class="db-inline-code">{{ variant === 'source' ? MATRIX_REGISTRATION_SOURCE : MATRIX_REGISTRATION_FILE }}</code></template>
              </i18n-t>
              <BridgeCopyBlock
                v-if="variant !== 'source'"
                :text="MATRIX_REGISTRATION_COPY"
                :label="t('discordBridge.common.commandLabel')"
                data-testid="matrix-registration-copy"
              />
            </li>
            <li>
              <i18n-t keypath="matrixBridge.self.registration.install" tag="span" scope="global">
                <template #file><code class="db-inline-code">{{ MATRIX_REGISTRATION_FILE }}</code></template>
                <template #setting><code class="db-inline-code">app_service_config_files</code></template>
              </i18n-t>
            </li>
            <li>{{ t('matrixBridge.self.registration.done') }}</li>
          </ol>
          <p class="db-muted">{{ t('matrixBridge.self.registration.secret') }}</p>
        </div>

        <p class="db-muted" data-testid="matrix-keep-data">
          <i18n-t :keypath="appService ? 'matrixBridge.self.keepData' : 'matrixBridge.self.keepDataAccount'" tag="span" scope="global">
            <template #place><code class="db-inline-code">{{ variant === 'source' ? 'data' : MATRIX_BRIDGE_VOLUME }}</code></template>
          </i18n-t>
        </p>
      </template>
      <template #trouble="{ variant }">
        <p v-if="variant === 'source'" class="db-muted">{{ t('matrixBridge.self.source.trouble') }}</p>
        <BridgeDockerTrouble v-else :logs="MATRIX_LOGS_COMMAND" :remove="MATRIX_REMOVE_COMMAND" />
      </template>
    </BridgeSetupCode>
  </div>
</template>

<script lang="ts">
import { reactive } from 'vue'
import type { MatrixConnection } from '@/utils/matrixBridgeSetup'

interface ConnectFields {
  connection: MatrixConnection
  homeserverUrl: string
  serverName: string
  appserviceUrl: string
}

/** What was entered per bridge in this page session; a remounted step keeps it. */
const entered = new Map<string, ConnectFields>()

function fieldsFor(bridgeId: string, connection: MatrixConnection): ConnectFields {
  const known = entered.get(bridgeId)
  if (known) return known
  const fields = reactive({ connection, homeserverUrl: '', serverName: '', appserviceUrl: '' })
  entered.set(bridgeId, fields)
  return fields
}

export function forgetMatrixConnectFields(): void {
  entered.clear()
}
</script>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MATRIX_BRIDGE_PORT,
  MATRIX_BRIDGE_VOLUME,
  MATRIX_LOGIN_SOURCE,
  MATRIX_LOGS_COMMAND,
  MATRIX_PLACEHOLDERS,
  MATRIX_REGISTRATION_COPY,
  MATRIX_REGISTRATION_FILE,
  MATRIX_REGISTRATION_SOURCE,
  MATRIX_REMOVE_COMMAND,
  MATRIX_SELF_CONNECTIONS,
  MATRIX_SOURCE_INSTALL,
  MATRIX_SOURCE_RUN,
  buildMatrixCompose,
  buildMatrixDockerRun,
  buildMatrixEnvFile,
  buildMatrixLoginDocker,
  matrixServerName,
  shellSafeUrl,
  type MatrixCommandInput,
} from '@/utils/matrixBridgeSetup'
import BridgeCopyBlock from '@/components/settings/discord-bridge/BridgeCopyBlock.vue'
import BridgeDockerHint from '@/components/settings/discord-bridge/BridgeDockerHint.vue'
import BridgeDockerTrouble from '@/components/settings/discord-bridge/BridgeDockerTrouble.vue'
import BridgeSetupCode from '@/components/settings/discord-bridge/BridgeSetupCode.vue'
import { createMatrixSetupCode } from './matrixManagedApi'

const VARIANTS = ['run', 'compose', 'source'] as const

type FieldName = 'homeserverUrl' | 'serverName' | 'appserviceUrl'

const props = withDefaults(
  defineProps<{
    bridgeId: string
    harmonyUrl: string
    /** Issue a code on mount; off where reinstalling is optional. */
    autoIssue?: boolean
    /** The ways to sign in to Matrix offered; one needs no choice. */
    connections?: readonly MatrixConnection[]
    /** How the bridge signs in now, as it reports it. */
    connection?: MatrixConnection | null
  }>(),
  { autoIssue: true, connections: () => MATRIX_SELF_CONNECTIONS, connection: null },
)

const { t } = useI18n()
const uid = `matrix-connect-${useId()}`

const current = props.connection && props.connections.includes(props.connection) ? props.connection : props.connections[0]
const fields = fieldsFor(props.bridgeId, current)
const appService = computed(() => fields.connection === 'application_service')

const values = computed<Record<FieldName, string | null>>(() => ({
  homeserverUrl: shellSafeUrl(fields.homeserverUrl),
  serverName: matrixServerName(fields.serverName),
  appserviceUrl: shellSafeUrl(fields.appserviceUrl),
}))

const shownFields = computed(() => {
  const names: { name: FieldName; url: boolean; example: string }[] = [
    { name: 'homeserverUrl', url: true, example: 'https://matrix.example.org' },
    { name: 'serverName', url: false, example: 'example.org' },
    { name: 'appserviceUrl', url: true, example: `http://192.168.1.20:${MATRIX_BRIDGE_PORT}` },
  ]
  return names
    .filter((field) => appService.value || field.name === 'homeserverUrl')
    .map((field) => ({ ...field, invalid: !!fields[field.name] && values.value[field.name] === null }))
})
const complete = computed(() => shownFields.value.every((field) => values.value[field.name] !== null))

function commandInput(setupCode: string): MatrixCommandInput {
  return { harmonyUrl: props.harmonyUrl, setupCode, connection: fields.connection, ...values.value }
}
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.db-steps .db-code-block {
  margin-top: 8px;
}

.connection-pick {
  margin: 0 0 12px;
  padding: 0;
  border: none;
  min-width: 0;
}

.connection-pick legend {
  padding: 0;
  margin-bottom: 6px;
}

.connection-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 0;
  cursor: pointer;
}

.connection-option input {
  margin-top: 3px;
  flex-shrink: 0;
}

.connection-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.connection-lead {
  display: block;
  margin: 2px 0 0;
}

.connect-fields {
  max-width: 480px;
}

.field-help {
  margin: 0;
}
</style>
