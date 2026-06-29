<template>
  <div class="bridge-bot-guide">
    <p class="intro">
      This bot bridges a Discord guild with a Harmony server. Each community runs its
      <strong>own</strong> Discord application (you keep the bot token). Set the Discord side up
      here, then wire it to a specific server under
      <strong>Server Settings → Advanced → Discord Bridge</strong>.
    </p>

    <!-- Harmony bot permissions -->
    <div class="guide-card">
      <div class="card-header">
        <h3>1. Harmony bot permissions</h3>
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
        Add this bot under <strong>Server Settings → Advanced → Server Bots</strong>
        with at least Read + Send Messages.
      </p>
    </div>

    <!-- Discord application -->
    <div class="guide-card highlight">
      <div class="card-header">
        <h3>2. Discord application</h3>
      </div>

      <p class="intro">
        Create your application at the
        <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">
          Discord Developer Portal
        </a>.
      </p>

      <div class="form-group">
        <label for="bridge-guide-client-id">Application Client ID</label>
        <input
          id="bridge-guide-client-id"
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
        <h4>3. After inviting the bot</h4>
        <ol class="numbered-steps">
          <li>Developer Portal → <strong>Bot</strong> → <strong>Reset Token</strong> → copy token into <code>discord.token</code></li>
          <li>Enable <strong>Developer Mode</strong> in Discord → right-click your server → <strong>Copy Server ID</strong> → <code>discord.guildId</code></li>
          <li>Right-click channels → <strong>Copy Channel ID</strong> for mappings (or use <code>/bridge link</code> later)</li>
        </ol>
      </div>
    </div>

    <p class="hint repo-hint">
      Bridge source &amp; full docs:
      <a href="https://github.com/y4my4my4m/harmony-discord-bridge" target="_blank" rel="noopener noreferrer">
        harmony-discord-bridge
      </a>. Wire this bot to a server under <strong>Server Settings → Advanced → Discord Bridge</strong>
      to get its pairing code and downloadable <code>bridge-config.yml</code>.
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useToast } from 'vue-toastification'
import {
  buildDiscordInviteUrl,
  HARMONY_BRIDGE_BOT_PERMISSIONS,
  DISCORD_BRIDGE_INTENTS,
} from '@/utils/discordBridgeSetup'

const toast = useToast()

const discordClientId = ref('')
const includeClonePermissions = ref(true)

const harmonyPermissions = HARMONY_BRIDGE_BOT_PERMISSIONS
const discordIntents = DISCORD_BRIDGE_INTENTS

const discordInviteUrl = computed(() =>
  buildDiscordInviteUrl(discordClientId.value, {
    includeClonePermissions: includeClonePermissions.value,
  }),
)

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error('Failed to copy')
  }
}
</script>

<style scoped>
.bridge-bot-guide {
  margin-top: 8px;
}

.guide-card {
  background: var(--color-background-primary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

.guide-card.highlight {
  border-color: rgba(88, 101, 242, 0.45);
}

.card-header h3 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.intro {
  margin: 0 0 16px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.intro a,
.repo-hint a {
  color: var(--harmony-primary);
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

.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
  margin-bottom: 12px;
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

.repo-hint {
  margin-top: 4px;
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

.numbered-steps {
  margin: 0;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.6;
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

.link-btn {
  text-align: center;
  text-decoration: none;
  display: inline-block;
}
</style>
