<template>
  <div class="instance-bot-admin" data-testid="bridge-instance-bot-admin">
    <h4>{{ t('discordBridge.instanceAdmin.title') }}</h4>
    <p class="hint">{{ t('discordBridge.instanceAdmin.lead') }}</p>

    <p v-if="loadError" class="error" role="alert">{{ t('discordBridge.instanceAdmin.loadFailed') }}</p>

    <template v-if="loaded">
      <p class="summary" data-testid="instance-bot-summary">
        <span>
          {{
            status.configured
              ? t('discordBridge.instanceAdmin.configured', { name: status.botUserName || status.applicationId })
              : t('discordBridge.instanceAdmin.notConfigured')
          }}
        </span>
        <span data-testid="instance-bot-count">
          {{ t('discordBridge.instanceAdmin.linkedCount', { count: status.linkedCount, limit: status.limit }) }}
        </span>
      </p>

      <details class="portal" :open="!status.configured" data-testid="instance-bot-portal-steps">
        <summary>{{ t('discordBridge.instanceAdmin.portal.title') }}</summary>
        <ol class="portal-steps">
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.create" tag="span" scope="global">
              <template #portal>
                <a :href="DISCORD_DEVELOPER_PORTAL_URL" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.bot.portalName') }}</a>
              </template>
              <template #newApplication><strong>{{ PORTAL.newApplication }}</strong></template>
              <template #example><em>{{ exampleName }}</em></template>
              <template #create><strong>{{ PORTAL.create }}</strong></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.applicationId" tag="span" scope="global">
              <template #generalInformation><strong>{{ PORTAL.generalInformation }}</strong></template>
              <template #applicationId><strong>{{ PORTAL.applicationId }}</strong></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.bot" tag="span" scope="global">
              <template #bot><strong>{{ PORTAL.bot }}</strong></template>
              <template #publicBot><strong>{{ PORTAL.publicBot }}</strong></template>
              <template #codeGrant><strong>{{ PORTAL.requiresCodeGrant }}</strong></template>
            </i18n-t>
            <span class="step-why">{{ t('discordBridge.instanceAdmin.portal.codeGrantWhy') }}</span>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.intents" tag="span" scope="global">
              <template #section><strong>{{ PORTAL.privilegedIntents }}</strong></template>
              <template #messageContent><strong>{{ DISCORD_INTENT_NAMES.message_content }}</strong></template>
              <template #members><strong>{{ DISCORD_INTENT_NAMES.members }}</strong></template>
              <template #presence><strong>{{ DISCORD_INTENT_NAMES.presence }}</strong></template>
              <template #save><strong>{{ PORTAL.saveChanges }}</strong></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.token" tag="span" scope="global">
              <template #reset><strong>{{ PORTAL.resetToken }}</strong></template>
              <template #copy><strong>{{ PORTAL.copy }}</strong></template>
              <template #field><strong>{{ t('discordBridge.instanceAdmin.botToken') }}</strong></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.redirect" tag="span" scope="global">
              <template #oauth2><strong>{{ PORTAL.oauth2 }}</strong></template>
              <template #redirects><strong>{{ PORTAL.redirects }}</strong></template>
              <template #addRedirect><strong>{{ PORTAL.addRedirect }}</strong></template>
              <template #save><strong>{{ PORTAL.saveChanges }}</strong></template>
            </i18n-t>
            <BridgeCopyBlock
              :text="redirectUri"
              :label="t('discordBridge.instanceAdmin.redirectLabel')"
              data-testid="instance-bot-redirect"
            />
            <span class="step-why">{{ t('discordBridge.instanceAdmin.portal.redirectExact') }}</span>
          </li>
          <li>
            <i18n-t keypath="discordBridge.instanceAdmin.portal.secret" tag="span" scope="global">
              <template #oauth2><strong>{{ PORTAL.oauth2 }}</strong></template>
              <template #resetSecret><strong>{{ PORTAL.resetSecret }}</strong></template>
              <template #clientSecret><strong>{{ PORTAL.clientSecret }}</strong></template>
              <template #field><strong>{{ t('discordBridge.instanceAdmin.clientSecret') }}</strong></template>
            </i18n-t>
          </li>
          <li>{{ t('discordBridge.instanceAdmin.portal.finish') }}</li>
        </ol>
        <p class="note">{{ t('discordBridge.instanceAdmin.portal.verification') }}</p>
      </details>

      <form class="credentials" novalidate data-testid="instance-bot-credentials" @submit.prevent="saveCredentials">
        <div class="field">
          <label :for="`${uid}-app`" class="title">{{ t('discordBridge.instanceAdmin.applicationId') }}</label>
          <input
            :id="`${uid}-app`"
            v-model="applicationId"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            class="cyber-input mono"
            :disabled="busy"
            data-testid="instance-bot-app-id"
          />
          <span v-if="appIdInvalid" class="error" role="alert">{{ t('discordBridge.instanceAdmin.appIdInvalid') }}</span>
        </div>

        <div class="field">
          <label :for="`${uid}-secret`" class="title">
            {{ t('discordBridge.instanceAdmin.clientSecret') }}
            <span :class="['state', status.hasClientSecret ? 'state--ok' : '']" data-testid="instance-bot-secret-state">
              {{ status.hasClientSecret ? t('discordBridge.instanceAdmin.stored') : t('discordBridge.instanceAdmin.notStored') }}
            </span>
          </label>
          <input
            :id="`${uid}-secret`"
            v-model="clientSecret"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            class="cyber-input mono"
            :placeholder="status.hasClientSecret ? t('discordBridge.instanceAdmin.keepPlaceholder') : ''"
            :disabled="busy"
            data-testid="instance-bot-client-secret"
          />
          <span v-if="secretIssue" class="error" role="alert">{{ secretIssue }}</span>
        </div>

        <div class="field">
          <label :for="`${uid}-token`" class="title">
            {{ t('discordBridge.instanceAdmin.botToken') }}
            <span :class="['state', status.hasBotToken ? 'state--ok' : '']" data-testid="instance-bot-token-state">
              {{ status.hasBotToken ? t('discordBridge.instanceAdmin.stored') : t('discordBridge.instanceAdmin.notStored') }}
            </span>
          </label>
          <input
            :id="`${uid}-token`"
            v-model="botToken"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            class="cyber-input mono"
            :placeholder="status.hasBotToken ? t('discordBridge.instanceAdmin.keepPlaceholder') : ''"
            :disabled="busy"
            data-testid="instance-bot-token"
          />
          <span v-if="tokenIssue" class="error" role="alert">{{ tokenIssue }}</span>
          <span class="hint">{{ t('discordBridge.instanceAdmin.writeOnly') }}</span>
        </div>

        <div class="buttons">
          <button type="submit" class="btn btn-primary" :disabled="!credentialsSavable" data-testid="instance-bot-save-credentials">
            {{ busy ? t('discordBridge.admin.saving') : t('discordBridge.instanceAdmin.saveCredentials') }}
          </button>
          <button
            v-if="status.applicationId && !confirmingClear"
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            data-testid="instance-bot-clear"
            @click="confirmingClear = true"
          >
            {{ t('discordBridge.instanceAdmin.clear') }}
          </button>
        </div>
        <div v-if="confirmingClear" class="confirm" role="alertdialog" :aria-labelledby="`${uid}-clear`">
          <p :id="`${uid}-clear`">{{ t('discordBridge.instanceAdmin.clearConfirm') }}</p>
          <div class="buttons">
            <button type="button" class="btn btn-danger" :disabled="busy" data-testid="instance-bot-clear-confirm" @click="clear">
              {{ t('discordBridge.instanceAdmin.clear') }}
            </button>
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="confirmingClear = false">
              {{ t('discordBridge.instanceAdmin.cancel') }}
            </button>
          </div>
        </div>
      </form>

      <div class="row">
        <div class="text">
          <span :id="`${uid}-enabled-label`" class="title">{{ t('discordBridge.instanceAdmin.enable') }}</span>
          <span :id="`${uid}-enabled-hint`" class="hint">
            {{ status.configured ? t('discordBridge.instanceAdmin.enableHint') : t('discordBridge.instanceAdmin.enableNeedsConfig') }}
          </span>
        </div>
        <ToggleSwitch
          :model-value="enabled"
          :disabled="busy || switching || (!status.configured && !enabled)"
          :aria-labelledby="`${uid}-enabled-label`"
          :aria-describedby="`${uid}-enabled-hint`"
          data-testid="instance-bot-enabled"
          @update:model-value="setSwitch('enabled', $event)"
        />
      </div>

      <div class="row">
        <div class="text">
          <span :id="`${uid}-presence-label`" class="title">{{ t('discordBridge.instanceAdmin.presence') }}</span>
          <span :id="`${uid}-presence-hint`" class="hint">{{ t('discordBridge.instanceAdmin.presenceHint') }}</span>
        </div>
        <ToggleSwitch
          :model-value="presence"
          :disabled="busy || switching"
          :aria-labelledby="`${uid}-presence-label`"
          :aria-describedby="`${uid}-presence-hint`"
          data-testid="instance-bot-presence"
          @update:model-value="setSwitch('presence', $event)"
        />
      </div>

      <div class="field">
        <label :for="`${uid}-limit`" class="title">{{ t('discordBridge.instanceAdmin.limit') }}</label>
        <input
          :id="`${uid}-limit`"
          v-model.number="limit"
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          class="cyber-input limit-input"
          :disabled="busy || savingLimit"
          :aria-describedby="`${uid}-limit-hint`"
          data-testid="instance-bot-limit"
        />
        <span :id="`${uid}-limit-hint`" class="hint">{{ t('discordBridge.instanceAdmin.limitHint') }}</span>
        <span v-if="limitInvalid" class="error" role="alert">{{ t('discordBridge.admin.limitInvalid') }}</span>
      </div>

      <p class="note" data-testid="instance-bot-host-note">
        <i18n-t keypath="discordBridge.instanceAdmin.hostNote" tag="span" scope="global">
          <template #service><code>BRIDGE_MODE=host</code></template>
          <template #docs>
            <a :href="HOSTING_DOCS_URL" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.admin.docs') }}</a>
          </template>
        </i18n-t>
      </p>

      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || savingLimit || !limitDirty || limitInvalid"
        data-testid="instance-bot-save-limit"
        @click="saveLimit"
      >
        {{ savingLimit ? t('discordBridge.admin.saving') : t('discordBridge.admin.saveLimit') }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import {
  DISCORD_DEVELOPER_PORTAL_URL,
  buildInstanceBotRedirectUri,
  checkDiscordToken,
  resolveHarmonyBaseUrl,
  resolveInstanceName,
} from '@/utils/discordBridgeSetup'
import {
  DEFAULT_INSTANCE_BOT_LIMIT,
  INSTANCE_BOT_ENABLED_KEY,
  INSTANCE_BOT_LIMIT_KEY,
  INSTANCE_BOT_PRESENCE_KEY,
  clearInstanceBot,
  fetchInstanceBotStatus,
  saveBridgeInstanceConfig,
  saveInstanceBotCredentials,
  type InstanceBotStatus,
} from './bridgeApi'
import { DISCORD_INTENT_NAMES, PORTAL } from './portalLabels'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

const HOSTING_DOCS_URL = 'https://github.com/y4my4my4m/harmony/blob/master/self-host/README.md#discord-bridge-hosting'
const APPLICATION_ID = /^\d{17,20}$/
const CLIENT_SECRET = /^[A-Za-z0-9_-]{16,128}$/

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-instance-bot-${useId()}`
const redirectUri = buildInstanceBotRedirectUri(resolveHarmonyBaseUrl())
const exampleName = t('discordBridge.bot.exampleName', { server: resolveInstanceName() })

const status = ref<InstanceBotStatus>({
  enabled: false,
  configured: false,
  applicationId: null,
  hasClientSecret: false,
  hasBotToken: false,
  botUserName: null,
  linkedCount: 0,
  limit: DEFAULT_INSTANCE_BOT_LIMIT,
  presence: false,
})
const loaded = ref(false)
const loadError = ref(false)
const busy = ref(false)
const switching = ref(false)
const savingLimit = ref(false)
const confirmingClear = ref(false)

const applicationId = ref('')
const clientSecret = ref('')
const botToken = ref('')
const enabled = ref(false)
const presence = ref(false)
const limit = ref<number>(DEFAULT_INSTANCE_BOT_LIMIT)

const appIdInvalid = computed(() => applicationId.value.trim() !== '' && !APPLICATION_ID.test(applicationId.value.trim()))
const secretIssue = computed(() => {
  const value = clientSecret.value.trim()
  if (!value) return ''
  if (checkDiscordToken(value).issue === null) return t('discordBridge.instanceAdmin.secretIsToken')
  return CLIENT_SECRET.test(value) ? '' : t('discordBridge.instanceAdmin.secretInvalid')
})
const tokenIssue = computed(() => {
  if (!botToken.value.trim()) return ''
  const issue = checkDiscordToken(botToken.value).issue
  return issue ? t(`discordBridge.hosted.issue.${issue}`) : ''
})
const credentialsSavable = computed(() => {
  if (busy.value || appIdInvalid.value || secretIssue.value || tokenIssue.value) return false
  const app = applicationId.value.trim()
  if (!app && !status.value.applicationId) return false
  return app !== (status.value.applicationId ?? '') || clientSecret.value.trim() !== '' || botToken.value.trim() !== ''
})
const limitInvalid = computed(() => !Number.isInteger(limit.value) || limit.value < 0)
const limitDirty = computed(() => limit.value !== status.value.limit)

const SWITCH_KEYS = { enabled: INSTANCE_BOT_ENABLED_KEY, presence: INSTANCE_BOT_PRESENCE_KEY } as const
const switchRefs = { enabled, presence }

function apply(next: InstanceBotStatus) {
  status.value = next
  applicationId.value = next.applicationId ?? ''
  enabled.value = next.enabled
  presence.value = next.presence
  limit.value = next.limit
}

async function load() {
  try {
    apply(await fetchInstanceBotStatus())
    loaded.value = true
    loadError.value = false
  } catch (error) {
    debug.warn('Instance Discord bot status unavailable:', error)
    loadError.value = true
  }
}

async function saveCredentials() {
  if (!credentialsSavable.value) return
  busy.value = true
  try {
    const next = await saveInstanceBotCredentials({
      applicationId: applicationId.value,
      clientSecret: clientSecret.value,
      botToken: botToken.value,
    })
    clientSecret.value = ''
    botToken.value = ''
    apply(next)
    toast.success(t('discordBridge.instanceAdmin.credentialsSaved'))
  } catch (error) {
    debug.error('discord_bridge_instance_bot_set failed:', error)
    toast.error(t('discordBridge.instanceAdmin.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function clear() {
  busy.value = true
  try {
    await clearInstanceBot()
    confirmingClear.value = false
    clientSecret.value = ''
    botToken.value = ''
    await load()
    toast.success(t('discordBridge.instanceAdmin.cleared'))
  } catch (error) {
    debug.error('discord_bridge_instance_bot_clear failed:', error)
    toast.error(t('discordBridge.instanceAdmin.saveFailed'))
  } finally {
    busy.value = false
  }
}

/** Saved on change; the switch returns to its previous position when the save fails. */
async function setSwitch(name: keyof typeof SWITCH_KEYS, next: boolean) {
  const value = switchRefs[name]
  const previous = value.value
  value.value = next
  switching.value = true
  try {
    await saveBridgeInstanceConfig(SWITCH_KEYS[name], next)
    status.value = { ...status.value, [name]: next }
    toast.success(t('discordBridge.instanceAdmin.settingsSaved'))
  } catch (error) {
    value.value = previous
    debug.error(`Saving the instance Discord bot's ${name} switch failed:`, error)
    toast.error(t('discordBridge.instanceAdmin.saveFailed'))
  } finally {
    switching.value = false
  }
}

async function saveLimit() {
  if (limitInvalid.value || !limitDirty.value) return
  savingLimit.value = true
  try {
    const next = limit.value
    await saveBridgeInstanceConfig(INSTANCE_BOT_LIMIT_KEY, next)
    status.value = { ...status.value, limit: next }
    toast.success(t('discordBridge.instanceAdmin.settingsSaved'))
  } catch (error) {
    debug.error('Saving the instance Discord bot limit failed:', error)
    toast.error(t('discordBridge.instanceAdmin.saveFailed'))
  } finally {
    savingLimit.value = false
  }
}

onMounted(load)
</script>

<style scoped src="../../admin/adminShared.css"></style>
<style scoped>
.instance-bot-admin {
  margin-top: 16px;
}

.instance-bot-admin h4 {
  margin: 0 0 8px;
  font-size: 15px;
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0 0 12px;
  color: var(--text-primary);
  font-size: 14px;
}

.portal {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--background-quaternary);
}

.portal summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-primary);
}

.portal-steps {
  margin: 10px 0;
  padding-left: 22px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
}

.portal-steps > li {
  margin-bottom: 8px;
}

.portal-steps a {
  color: var(--harmony-primary);
}

.step-why {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
}

.credentials {
  margin-bottom: 16px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 12px 0;
}

.text,
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field {
  margin-bottom: 12px;
  max-width: 560px;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-weight: 500;
}

.state {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.state--ok {
  color: var(--success);
}

.hint {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.limit-input {
  max-width: 160px;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.confirm {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-primary);
  font-size: 14px;
}

.confirm p {
  margin: 0 0 8px;
}

.note {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}

.note a {
  color: var(--harmony-primary);
}

.error {
  color: var(--error);
  font-size: 13px;
}
</style>
