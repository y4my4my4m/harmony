<template>
  <div class="discord-bridge-setup">
    <div class="settings-section">
      <h2 class="section-title">Discord Bridge</h2>
      <p class="section-description">
        Self-host the
        <a href="https://github.com/y4my4my4m/harmony-discord-bridge" target="_blank" rel="noopener noreferrer">
          harmony-discord-bridge
        </a>
        on your machine. Each community runs its own Discord application and bridge process.
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <LoadingSpinner :size="40" />
      <p>Loading bridge setup...</p>
    </div>

    <template v-else>
      <!-- Pairing + server identity -->
      <div class="settings-card">
        <div class="card-header">
          <h3>Harmony connection</h3>
        </div>

        <div class="field-row">
          <div class="field-label">Pairing code</div>
          <div class="field-value mono">
            {{ pairingCode || '—' }}
            <button
              v-if="pairingCode"
              type="button"
              class="copy-btn"
              @click="copyText(pairingCode, 'Pairing code')"
            >
              Copy
            </button>
          </div>
        </div>

        <div class="field-row">
          <div class="field-label">Harmony server ID</div>
          <div class="field-value mono">
            {{ serverId }}
            <button type="button" class="copy-btn" @click="copyText(serverId, 'Server ID')">Copy</button>
          </div>
        </div>

        <div class="field-row">
          <div class="field-label">Gateway URLs</div>
          <div class="field-stack">
            <label class="toggle-row">
              <input v-model="coLocated" type="checkbox" />
              <span>Bridge runs on the same machine as this Harmony instance</span>
            </label>
            <div class="url-block">
              <span class="url-label">gatewayUrl</span>
              <code>{{ gatewayUrls.gatewayUrl }}</code>
            </div>
            <div class="url-block">
              <span class="url-label">apiUrl</span>
              <code>{{ gatewayUrls.apiUrl }}</code>
            </div>
            <div class="url-block">
              <span class="url-label">baseUrl</span>
              <code>{{ gatewayUrls.baseUrl }}</code>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <button type="button" class="btn-secondary" :disabled="regenerating" @click="regeneratePairingCode">
            {{ regenerating ? 'Regenerating…' : 'Regenerate pairing code' }}
          </button>
        </div>

        <p class="hint">
          The bridge can resolve this code via
          <code>GET /bot-gateway/bridge-setup/{{ pairingCode || 'HRM-XXXX-XXXX' }}</code>
          to auto-fill <code>serverId</code> and gateway URLs.
        </p>
      </div>

      <!-- Harmony bot -->
      <div class="settings-card">
        <div class="card-header">
          <h3>1. Harmony bot</h3>
        </div>

        <div v-if="installedBridgeBot" class="success-banner">
          <strong>{{ installedBridgeBot.bot.username }}</strong> is installed on this server.
          Create the bot token in
          <router-link to="/settings/bots">User Settings → My Bots</router-link>
          (shown once — paste it into <code>bridge-config.yml</code>).
        </div>

        <div v-else class="warning-banner">
          No bridge bot on this server yet. Create one in
          <router-link to="/settings/bots">User Settings → My Bots</router-link>
          (<code>bot_type: bridge</code>), then add it below.
        </div>

        <ul class="checklist">
          <li v-for="perm in harmonyPermissions" :key="perm.key">
            <span class="check-icon">{{ perm.required ? '●' : '○' }}</span>
            <span>
              <strong>{{ perm.label }}</strong>
              <span v-if="perm.required" class="badge required">Required</span>
              <span v-else class="badge optional">For /bridge clone-server</span>
              — {{ perm.description }}
            </span>
          </li>
        </ul>

        <p class="hint">
          After creating the bot, add it under <strong>Server Settings → Advanced → Server Bots</strong>
          with at least Read + Send Messages.
        </p>
      </div>

      <!-- Discord setup (#4) -->
      <div class="settings-card highlight">
        <div class="card-header">
          <h3>2. Discord application</h3>
        </div>

        <p class="intro">
          Each community needs its <strong>own</strong> Discord application (you keep the bot token).
          Create one at the
          <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">
            Discord Developer Portal
          </a>.
        </p>

        <div class="form-group">
          <label for="discord-client-id">Application Client ID</label>
          <input
            id="discord-client-id"
            v-model="discordClientId"
            type="text"
            class="text-input"
            placeholder="Paste from Developer Portal → OAuth2 → Client ID"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="subsection">
          <h4>Privileged gateway intents</h4>
          <p class="hint">Bot → Privileged Gateway Intents in the Developer Portal:</p>
          <ul class="checklist">
            <li v-for="intent in discordIntents" :key="intent.name">
              <span class="check-icon">{{ intent.required ? '●' : '○' }}</span>
              <span>
                <strong>{{ intent.name }}</strong>
                <span v-if="intent.required" class="badge required">Required</span>
                <span v-else class="badge optional">Optional</span>
                — {{ intent.description }}
              </span>
            </li>
          </ul>
        </div>

        <div class="subsection">
          <h4>Bot invite URL</h4>
          <p class="hint">
            Scopes: <code>bot</code> + <code>applications.commands</code>.
            Permissions are pre-filled for bridging (including Manage Webhooks for avatar puppeting).
          </p>

          <label class="toggle-row">
            <input v-model="includeClonePermissions" type="checkbox" />
            <span>Also include Manage Channels (for <code>/bridge clone-server</code>)</span>
          </label>

          <div v-if="discordInviteUrl" class="invite-box">
            <code class="invite-url">{{ discordInviteUrl }}</code>
            <button type="button" class="btn-primary" @click="copyText(discordInviteUrl, 'Invite URL')">
              Copy invite URL
            </button>
            <a :href="discordInviteUrl" target="_blank" rel="noopener noreferrer" class="btn-secondary link-btn">
              Open in Discord
            </a>
          </div>
          <p v-else class="hint">Enter your Client ID above to generate the invite link.</p>
        </div>

        <div class="subsection">
          <h4>After inviting the bot</h4>
          <ol class="numbered-steps">
            <li>Developer Portal → <strong>Bot</strong> → <strong>Reset Token</strong> → copy token into <code>discord.token</code></li>
            <li>Enable <strong>Developer Mode</strong> in Discord → right-click your server → <strong>Copy Server ID</strong> → <code>discord.guildId</code></li>
            <li>Right-click channels → <strong>Copy Channel ID</strong> for mappings (or use <code>/bridge link</code> later)</li>
          </ol>
        </div>
      </div>

      <!-- Generated config -->
      <div class="settings-card">
        <div class="card-header">
          <h3>3. Bridge config</h3>
        </div>

        <p class="hint">
          Save as <code>config/bridge-config.yml</code> in the bridge repo, fill in tokens and channel IDs, then
          <code>docker compose up -d</code>.
        </p>

        <pre class="config-preview">{{ configYaml }}</pre>

        <div class="card-actions">
          <button type="button" class="btn-primary" @click="copyText(configYaml, 'Bridge config')">
            Copy bridge-config.yml
          </button>
          <button type="button" class="btn-secondary" @click="downloadConfig">
            Download YAML
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import {
  buildBridgeGatewayUrls,
  buildDiscordInviteUrl,
  generateBridgeConfigYaml,
  resolveHarmonyBaseUrl,
  isBridgeBot,
  HARMONY_BRIDGE_BOT_PERMISSIONS,
  DISCORD_BRIDGE_INTENTS,
} from '@/utils/discordBridgeSetup'

interface Props {
  serverId: string
}

const props = defineProps<Props>()
const toast = useToast()

const loading = ref(true)
const regenerating = ref(false)
const pairingCode = ref('')
const coLocated = ref(false)
const discordClientId = ref('')
const includeClonePermissions = ref(true)
const installedBridgeBot = ref<{ bot: { username: string } } | null>(null)

const harmonyPermissions = HARMONY_BRIDGE_BOT_PERMISSIONS
const discordIntents = DISCORD_BRIDGE_INTENTS

const baseUrl = computed(() => resolveHarmonyBaseUrl())
const gatewayUrls = computed(() => buildBridgeGatewayUrls(baseUrl.value, coLocated.value))

const discordInviteUrl = computed(() =>
  buildDiscordInviteUrl(discordClientId.value, {
    includeClonePermissions: includeClonePermissions.value,
  }),
)

const configYaml = computed(() => {
  if (!pairingCode.value) return '# Loading pairing code…'
  return generateBridgeConfigYaml({
    pairingCode: pairingCode.value,
    serverId: props.serverId,
    gateway: gatewayUrls.value,
    includeClonePermissions: includeClonePermissions.value,
  })
})

async function loadPairingCode() {
  const { data, error } = await supabase.rpc('get_or_create_discord_bridge_pairing', {
    p_server_id: props.serverId,
  })
  if (error) throw error
  pairingCode.value = data as string
}

interface BotInstallRow {
  bot: {
    bot_type?: string | null
    username?: string | null
  } | null
}

async function loadInstalledBridgeBot() {
  const { data, error } = await supabase
    .from('bot_server_permissions')
    .select('bot:bots(bot_type, username)')
    .eq('server_id', props.serverId)
    .eq('is_active', true)

  if (error) throw error

  const rows = (data ?? []) as BotInstallRow[]
  const bridgeInstall = rows.find(row => row.bot && isBridgeBot(row.bot))
  installedBridgeBot.value = bridgeInstall?.bot?.username
    ? { bot: { username: bridgeInstall.bot.username } }
    : null
}

async function regeneratePairingCode() {
  regenerating.value = true
  try {
    const { data, error } = await supabase.rpc('regenerate_discord_bridge_pairing', {
      p_server_id: props.serverId,
    })
    if (error) throw error
    pairingCode.value = data as string
    toast.success('New pairing code generated')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to regenerate pairing code'
    debug.error('regenerate_discord_bridge_pairing failed:', error)
    toast.error(message)
  } finally {
    regenerating.value = false
  }
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error('Failed to copy')
  }
}

function downloadConfig() {
  const blob = new Blob([configYaml.value], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'bridge-config.yml'
  anchor.click()
  URL.revokeObjectURL(url)
  toast.success('Downloaded bridge-config.yml')
}

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([loadPairingCode(), loadInstalledBridgeBot()])
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load bridge setup'
    debug.error('Discord bridge setup load failed:', error)
    toast.error(message)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.discord-bridge-setup {
  margin-bottom: 32px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 700;
}

.section-description {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.section-description a {
  color: var(--harmony-primary);
}

.settings-card {
  background: var(--color-background-primary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

.settings-card.highlight {
  border-color: rgba(88, 101, 242, 0.45);
}

.card-header h3 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.field-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  margin-bottom: 14px;
  align-items: start;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding-top: 2px;
}

.field-value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.field-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
}

.url-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.url-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.url-block code {
  font-size: 12px;
  word-break: break-all;
  background: var(--color-background-secondary);
  padding: 6px 8px;
  border-radius: 6px;
}

.copy-btn {
  border: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  color: var(--color-text-primary);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.copy-btn:hover {
  background: var(--color-background-tertiary, var(--color-background-secondary));
}

.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
}

.toggle-row input {
  margin-top: 3px;
}

.hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.hint code {
  font-size: 12px;
}

.intro {
  margin: 0 0 16px;
  line-height: 1.5;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}

.text-input {
  width: 100%;
  max-width: 420px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  color: var(--color-text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
}

.subsection {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}

.subsection h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.checklist li {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 14px;
  line-height: 1.45;
}

.check-icon {
  color: var(--harmony-primary);
  flex-shrink: 0;
  width: 14px;
}

.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 6px;
  vertical-align: middle;
}

.badge.required {
  background: rgba(var(--color-success-rgb, 46, 160, 67), 0.15);
  color: var(--color-success, #2ea043);
}

.badge.optional {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.success-banner,
.warning-banner {
  padding: 12px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  line-height: 1.5;
}

.success-banner {
  background: rgba(var(--color-success-rgb, 46, 160, 67), 0.1);
  border-left: 3px solid var(--color-success, #2ea043);
}

.warning-banner {
  background: rgba(var(--color-warning-rgb, 210, 153, 34), 0.1);
  border-left: 3px solid var(--color-warning, #d29922);
}

.success-banner a,
.warning-banner a {
  color: var(--harmony-primary);
}

.invite-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.invite-url {
  display: block;
  word-break: break-all;
  font-size: 12px;
  padding: 10px;
  background: var(--color-background-secondary);
  border-radius: 8px;
  border: 1px solid var(--color-border);
}

.link-btn {
  text-align: center;
  text-decoration: none;
  display: inline-block;
}

.numbered-steps {
  margin: 0;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.6;
}

.config-preview {
  margin: 12px 0 16px;
  padding: 14px;
  background: var(--color-background-secondary);
  border-radius: 8px;
  border: 1px solid var(--color-border);
  font-size: 12px;
  line-height: 1.45;
  overflow-x: auto;
  white-space: pre;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn-primary,
.btn-secondary {
  padding: 10px 16px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  border: none;
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
}

.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
  color: var(--color-text-secondary);
}

@media (max-width: 640px) {
  .field-row {
    grid-template-columns: 1fr;
  }
}
</style>
