<template>
  <div class="discord-bridge-setup">
    <div class="settings-section">
      <h2 class="section-title">Discord bridge</h2>
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

    <!-- No bridge bot on this server yet: point the owner to install one. -->
    <div v-else-if="!installedBridgeBot" class="settings-card">
      <div class="warning-banner">
        No Discord bridge bot is installed on this server yet.
        Create one in
        <router-link to="/settings/bots">User Settings → My Bots</router-link>
        (<code>bot_type: bridge</code>) — its <strong>View Details</strong> page walks you through the
        Discord application setup — then add it under
        <strong>Server Settings → Advanced → Server Bots</strong>.
        The server-specific pairing code and config appear here once it's installed.
      </div>
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

      <!-- Bridge bot installed: confirmation + pointer to bot-level setup -->
      <div class="settings-card">
        <div class="card-header">
          <h3>Bridge bot</h3>
        </div>

        <div class="success-banner">
          <strong>{{ installedBridgeBot.bot.username }}</strong> is installed on this server.
          Discord application setup (Client ID, intents, invite URL) lives on the bot's
          <router-link to="/settings/bots">My Bots → View Details</router-link>
          page. Paste its bot token into the generated <code>bridge-config.yml</code> below.
        </div>
      </div>

      <!-- Generated config -->
      <div class="settings-card">
        <div class="card-header">
          <h3>Bridge config</h3>
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
  generateBridgeConfigYaml,
  resolveHarmonyBaseUrl,
  isBridgeBot,
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
const installedBridgeBot = ref<{ bot: { username: string } } | null>(null)

const baseUrl = computed(() => resolveHarmonyBaseUrl())
const gatewayUrls = computed(() => buildBridgeGatewayUrls(baseUrl.value, coLocated.value))

const configYaml = computed(() => {
  if (!pairingCode.value) return '# Loading pairing code…'
  return generateBridgeConfigYaml({
    pairingCode: pairingCode.value,
    serverId: props.serverId,
    gateway: gatewayUrls.value,
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
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.section-description {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.section-description a {
  color: var(--harmony-primary);
}

.settings-card {
  background: var(--color-background-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin-bottom: 20px;
}

.settings-card.highlight {
  border-color: color-mix(in srgb, var(--harmony-primary) 45%, transparent);
}

.card-header h3 {
  margin: 0 0 16px;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
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
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
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
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.url-block code {
  font-size: var(--font-size-xs);
  word-break: break-all;
  background: var(--surface-inset);
  padding: 6px 8px;
  border-radius: var(--radius-base);
}

.copy-btn {
  border: 1px solid var(--border-primary);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  border-radius: var(--radius-base);
  padding: 4px 10px;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.copy-btn:hover {
  background: var(--background-modifier-active);
}

.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.toggle-row input {
  margin-top: 3px;
}

.hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.hint code {
  font-size: var(--font-size-xs);
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
  font-weight: var(--font-weight-semibold);
}

.text-input {
  width: 100%;
  max-width: 420px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
}

.subsection {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-primary);
}

.subsection h4 {
  margin: 0 0 8px;
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.check-icon {
  color: var(--harmony-primary);
  flex-shrink: 0;
  width: 14px;
}

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  margin-left: 6px;
  vertical-align: middle;
}

.badge.required {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}

.badge.optional {
  background: var(--background-modifier-selected);
  color: var(--text-secondary);
}

.success-banner,
.warning-banner {
  padding: 12px 14px;
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.success-banner {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border-left: 3px solid var(--success);
}

.warning-banner {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-left: 3px solid var(--warning);
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
  font-size: var(--font-size-xs);
  padding: 10px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
}

.link-btn {
  text-align: center;
  text-decoration: none;
  display: inline-block;
}

.numbered-steps {
  margin: 0;
  padding-left: 20px;
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.config-preview {
  margin: 12px 0 16px;
  padding: 14px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  font-size: var(--font-size-xs);
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
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
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
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .field-row {
    grid-template-columns: 1fr;
  }
}
</style>
