<template>
  <section class="bridge-bot-guide" data-testid="bridge-bot-guide">
    <h3 class="guide-title">{{ t('discordBridge.botGuide.title') }}</h3>

    <p v-if="owner" class="guide-text" data-testid="bridge-owner">
      {{ t('discordBridge.botGuide.managed', { server: owner.serverName || t('discordBridge.botGuide.aServer') }) }}
      <router-link :to="settingsLink(owner.serverId)">{{ t('discordBridge.botGuide.openSettings') }}</router-link>
    </p>
    <p v-else class="guide-text" data-testid="bridge-unmanaged">{{ t('discordBridge.botGuide.unmanaged') }}</p>

    <details class="legacy">
      <summary>{{ t('discordBridge.botGuide.legacyTitle') }}</summary>
      <p class="guide-muted">{{ t('discordBridge.botGuide.legacyLead') }}</p>
      <ul class="guide-list">
        <li>{{ t('discordBridge.botGuide.harmonyPermissions') }}</li>
        <li>
          {{ t('discordBridge.botGuide.intents', { messageContent: DISCORD_INTENT_NAMES.message_content, members: DISCORD_INTENT_NAMES.members, presence: DISCORD_INTENT_NAMES.presence }) }}
        </li>
        <li>{{ t('discordBridge.botGuide.invite') }}</li>
      </ul>
      <div class="db-field client-id">
        <label :for="inputId" class="db-label">{{ t('discordBridge.botGuide.applicationId') }}</label>
        <input
          :id="inputId"
          v-model="applicationId"
          type="text"
          inputmode="numeric"
          class="db-input"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">
        {{ t('discordBridge.actions.invite') }}
      </a>
      <p class="guide-muted">
        <a :href="BRIDGE_REPO_URL" target="_blank" rel="noopener noreferrer">harmony-discord-bridge</a>
      </p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildDiscordInviteUrl } from '@/utils/discordBridgeSetup'
import { fetchBridgeForBot, type BridgeOwnerServer } from './discord-bridge/bridgeApi'
import { DISCORD_INTENT_NAMES } from './discord-bridge/portalLabels'

const props = defineProps<{ botId?: string }>()

const BRIDGE_REPO_URL = 'https://github.com/y4my4my4m/harmony-discord-bridge'

const { t } = useI18n()
const inputId = `bridge-guide-app-id-${useId()}`
const applicationId = ref('')
const owner = ref<BridgeOwnerServer | null>(null)
const inviteUrl = computed(() => buildDiscordInviteUrl(applicationId.value))

function settingsLink(serverId: string) {
  return { name: 'ServerSettings', params: { serverId }, query: { section: 'discord-bridge' } }
}

watch(
  () => props.botId,
  async (botId) => {
    owner.value = botId ? await fetchBridgeForBot(botId) : null
  },
  { immediate: true },
)
</script>

<style scoped src="./discord-bridge/bridge.css"></style>
<style scoped>
.bridge-bot-guide {
  padding: 20px;
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-secondary);
}

.guide-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.guide-text {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary);
}

.guide-text a,
.guide-muted a {
  color: var(--harmony-primary);
}

.guide-muted {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.legacy > summary {
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.legacy > summary:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.guide-list {
  margin: 8px 0 12px;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary);
}

.client-id {
  max-width: 360px;
}
</style>
