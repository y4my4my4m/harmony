<template>
  <div class="server-bots-settings">
    <div class="settings-section">
      <h2 class="section-title">Server Bots</h2>
      <p class="section-description">
        Add and manage bots in this server. Bots can automate tasks, moderate content, and integrate with external services.
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>Loading bots...</p>
    </div>

    <!-- Bot Browser (Add New Bot) -->
    <div v-if="!loading" class="settings-card">
      <div class="card-header">
        <h3>Add Bots</h3>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Search bots..."
        />
      </div>

      <div v-if="availableBots.length === 0" class="empty-state">
        <p>No bots available. Check with your instance administrator.</p>
      </div>

      <div v-else class="bots-grid">
        <div
          v-for="bot in filteredAvailableBots"
          :key="bot.id"
          class="bot-card available"
        >
          <div class="bot-card-header">
            <BotAvatar :bot="bot" :size="48" />
            <span class="bot-badge">BOT</span>
          </div>

          <div class="bot-info">
            <h4>{{ bot.username }}</h4>
            <p class="bot-bio">{{ bot.bio || 'No description' }}</p>
            <div class="bot-stats">
              <span>{{ bot.server_count || 0 }} servers</span>
              <span v-if="bot.tags && bot.tags.length">{{ bot.tags.join(', ') }}</span>
            </div>
          </div>

          <button
            v-if="!isInstalled(bot.id)"
            @click="showAddModal(bot)"
            class="btn-primary"
          >
            Add to Server
          </button>
          <button v-else disabled class="btn-secondary">
            Already Added
          </button>
        </div>
      </div>
    </div>

    <!-- Installed Bots -->
    <div v-if="!loading && installedBots.length > 0" class="settings-card">
      <div class="card-header">
        <h3>Installed Bots ({{ installedBots.length }})</h3>
      </div>

      <div class="bots-list">
        <div
          v-for="installation in installedBots"
          :key="installation.id"
          class="bot-item"
        >
          <BotAvatar :bot="installation.bot" :size="40" :show-status="true" />

          <div class="bot-info">
            <h4>{{ installation.bot.username }}</h4>
            <p>{{ installation.bot.bio || 'No description' }}</p>
            <span class="install-date">Added {{ formatDate(installation.installed_at) }}</span>
          </div>

          <div class="bot-actions">
            <button @click="showPermissionsModal(installation)" class="btn-secondary">
              Permissions
            </button>
            <button @click="removeBot(installation)" class="btn-danger">
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Bot Modal -->
    <div v-if="showModal" class="modal-overlay" @click="closeModal">
      <div class="modal" @click.stop>
        <div class="modal-header">
          <h3>Add Bot to Server</h3>
          <button @click="closeModal" class="close-btn">×</button>
        </div>

        <div v-if="selectedBot" class="modal-content">
          <div class="bot-preview">
            <BotAvatar :bot="selectedBot" :size="56" />
            <div class="bot-preview-text">
              <h4>{{ selectedBot.username }}</h4>
              <p>{{ selectedBot.bio || 'No description' }}</p>
            </div>
          </div>

          <div class="permissions-section">
            <div class="permissions-section-header">
              <h4>Bot Permissions</h4>
              <p class="permissions-hint">Select what this bot can do in your server. Required permissions can't be turned off.</p>
            </div>

            <div class="permissions-list">
              <label v-for="perm in availablePermissions" :key="perm.key" class="permission-row" :class="{ disabled: perm.required }">
                <input
                  type="checkbox"
                  v-model="selectedPermissions[perm.key]"
                  :disabled="perm.required"
                />
                <div class="permission-text">
                  <span class="permission-label">
                    {{ perm.label }}
                    <span v-if="perm.required" class="permission-required-badge">Required</span>
                  </span>
                  <span class="permission-description">{{ perm.description }}</span>
                </div>
              </label>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closeModal" class="btn-secondary">Cancel</button>
            <button @click="addBot" class="btn-primary" :disabled="adding">
              {{ adding ? 'Adding...' : 'Add Bot' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Permissions Modal -->
    <div v-if="showPermModal" class="modal-overlay" @click="closePermissionsModal">
      <div class="modal" @click.stop>
        <div class="modal-header">
          <h3>Bot Permissions</h3>
          <button @click="closePermissionsModal" class="close-btn">×</button>
        </div>

        <div v-if="selectedInstallation" class="modal-content">
          <div class="bot-preview">
            <BotAvatar :bot="selectedInstallation.bot" :size="56" />
            <div class="bot-preview-text">
              <h4>{{ selectedInstallation.bot.username }}</h4>
              <p>Manage permissions for this bot</p>
            </div>
          </div>

          <div class="permissions-section">
            <div class="permissions-list">
              <label v-for="perm in availablePermissions" :key="perm.key" class="permission-row" :class="{ disabled: perm.required }">
                <input
                  type="checkbox"
                  v-model="editingPermissions[perm.key]"
                  :disabled="perm.required"
                />
                <div class="permission-text">
                  <span class="permission-label">
                    {{ perm.label }}
                    <span v-if="perm.required" class="permission-required-badge">Required</span>
                  </span>
                  <span class="permission-description">{{ perm.description }}</span>
                </div>
              </label>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closePermissionsModal" class="btn-secondary">Cancel</button>
            <button @click="updatePermissions" class="btn-primary" :disabled="updatingPerms">
              {{ updatingPerms ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Error/Success Messages -->
    <div v-if="message" class="message" :class="message.type">
      <span>{{ message.text }}</span>
      <button @click="message = null" class="close-btn">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { formatDistanceToNow } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import BotAvatar from '@/components/common/BotAvatar.vue'

interface Props {
  serverId: string
}

const props = defineProps<Props>()

// State
const loading = ref(true)
const adding = ref(false)
const updatingPerms = ref(false)
const searchQuery = ref('')
const showModal = ref(false)
const showPermModal = ref(false)
const selectedBot = ref<any>(null)
const selectedInstallation = ref<any>(null)
const message = ref<{ type: string; text: string } | null>(null)

const availableBots = ref<any[]>([])
const installedBots = ref<any[]>([])
const botStatuses = ref<Record<string, boolean>>({})

const selectedPermissions = ref<Record<string, boolean>>({})
const editingPermissions = ref<Record<string, boolean>>({})

// Available permissions
const availablePermissions = [
  { key: 'read_messages', label: 'Read Messages', description: 'View channels and read message history', required: true },
  { key: 'send_messages', label: 'Send Messages', description: 'Send messages in channels', required: true },
  { key: 'manage_messages', label: 'Manage Messages', description: 'Delete and edit any message', required: false },
  { key: 'embed_links', label: 'Embed Links', description: 'Send embeds and link previews', required: false },
  { key: 'attach_files', label: 'Attach Files', description: 'Upload files and attachments', required: false },
  { key: 'mention_everyone', label: 'Mention Everyone', description: 'Use @everyone mentions', required: false },
  { key: 'add_reactions', label: 'Add Reactions', description: 'React to messages', required: false },
  { key: 'manage_channels', label: 'Manage Channels', description: 'Create, edit, and delete channels', required: false },
  { key: 'kick_members', label: 'Kick Members', description: 'Remove members from server', required: false },
  { key: 'ban_members', label: 'Ban Members', description: 'Ban members from server', required: false },
]

// Computed
const filteredAvailableBots = computed(() => {
  if (!searchQuery.value) return availableBots.value

  const query = searchQuery.value.toLowerCase()
  return availableBots.value.filter(bot =>
    bot.username.toLowerCase().includes(query) ||
    bot.bio?.toLowerCase().includes(query) ||
    bot.tags?.some((tag: string) => tag.toLowerCase().includes(query))
  )
})

// Methods
async function loadBots() {
  loading.value = true

  try {
    // Load available public bots
    const { data: bots, error: botsError } = await supabase
      .from('bots')
      .select('*')
      .eq('is_public', true)
      .eq('is_active', true)
      .order('server_count', { ascending: false })

    if (botsError) throw botsError
    availableBots.value = bots || []

    // Load installed bots for this server
    const { data: installations, error: installError } = await supabase
      .from('bot_server_permissions')
      .select(`
        *,
        bot:bots(*)
      `)
      .eq('server_id', props.serverId)
      .eq('is_active', true)

    if (installError) throw installError
    installedBots.value = installations || []

    debug.log('✅ Bots loaded:', { available: bots?.length, installed: installations?.length })
  } catch (error: any) {
    debug.error('❌ Failed to load bots:', error)
    showMessage('error', error.message || 'Failed to load bots')
  } finally {
    loading.value = false
  }
}

function isInstalled(botId: string): boolean {
  return installedBots.value.some(inst => inst.bot_id === botId)
}

function showAddModal(bot: any) {
  selectedBot.value = bot
  
  // Set default permissions
  selectedPermissions.value = {
    read_messages: true,
    send_messages: true,
    manage_messages: false,
    embed_links: true,
    attach_files: true,
    mention_everyone: false,
    add_reactions: true,
    manage_channels: false,
    kick_members: false,
    ban_members: false,
  }

  showModal.value = true
}

function closeModal() {
  showModal.value = false
  selectedBot.value = null
}

async function addBot() {
  if (!selectedBot.value || adding.value) return

  adding.value = true

  try {
    // Call RPC function to add bot
    const { data, error } = await supabase.rpc('add_bot_to_server', {
      p_bot_id: selectedBot.value.id,
      p_server_id: props.serverId,
      p_installed_by: (await supabase.auth.getUser()).data.user?.id,
      p_permissions: selectedPermissions.value
    })

    if (error) throw error

    showMessage('success', `${selectedBot.value.username} added successfully!`)
    closeModal()
    await loadBots()
  } catch (error: any) {
    debug.error('❌ Failed to add bot:', error)
    showMessage('error', error.message || 'Failed to add bot')
  } finally {
    adding.value = false
  }
}

function showPermissionsModal(installation: any) {
  selectedInstallation.value = installation
  
  // Load current permissions
  editingPermissions.value = {
    read_messages: installation.read_messages,
    send_messages: installation.send_messages,
    manage_messages: installation.manage_messages,
    embed_links: installation.embed_links,
    attach_files: installation.attach_files,
    mention_everyone: installation.mention_everyone,
    add_reactions: installation.add_reactions,
    manage_channels: installation.manage_channels,
    kick_members: installation.kick_members,
    ban_members: installation.ban_members,
  }

  showPermModal.value = true
}

function closePermissionsModal() {
  showPermModal.value = false
  selectedInstallation.value = null
}

async function updatePermissions() {
  if (!selectedInstallation.value || updatingPerms.value) return

  updatingPerms.value = true

  try {
    const { error } = await supabase
      .from('bot_server_permissions')
      .update(editingPermissions.value)
      .eq('id', selectedInstallation.value.id)

    if (error) throw error

    showMessage('success', 'Permissions updated successfully!')
    closePermissionsModal()
    await loadBots()
  } catch (error: any) {
    debug.error('❌ Failed to update permissions:', error)
    showMessage('error', error.message || 'Failed to update permissions')
  } finally {
    updatingPerms.value = false
  }
}

async function removeBot(installation: any) {
  const confirmed = confirm(`Remove ${installation.bot.username} from this server?`)
  if (!confirmed) return

  try {
    const { error } = await supabase
      .from('bot_server_permissions')
      .update({ is_active: false })
      .eq('id', installation.id)

    if (error) throw error

    showMessage('success', `${installation.bot.username} removed from server`)
    await loadBots()
  } catch (error: any) {
    debug.error('❌ Failed to remove bot:', error)
    showMessage('error', error.message || 'Failed to remove bot')
  }
}

function formatDate(date: string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

function showMessage(type: string, text: string) {
  message.value = { type, text }
  setTimeout(() => {
    message.value = null
  }, 5000)
}

// Lifecycle
onMounted(() => {
  loadBots()
})
</script>

<style scoped>
.server-bots-settings {
  margin-top: 24px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
  padding: 20px;
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.card-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.search-input {
  padding: 8px 12px;
  background-color: var(--h-chat-dark);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 200px;
}

.search-input:focus {
  outline: none;
  border-color: #0EA5E9;
}

.loading-state {
  text-align: center;
  padding: 48px 0;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--h-chat-light);
  border-top-color: #0EA5E9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  text-align: center;
  padding: 32px;
  color: var(--text-secondary);
}

.bots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.bot-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background-color: var(--h-chat-dark);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
  transition: all 0.2s;
}

.bot-card:hover {
  border-color: #0EA5E9;
  transform: translateY(-2px);
}

.bot-avatar img {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
}

.bot-badge {
  display: inline-block;
  padding: 2px 6px;
  background-color: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 700;
  border-radius: 3px;
  margin-top: 4px;
}

.bot-info h4 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.bot-bio {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.bot-stats {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.bot-stats span {
  margin-right: 12px;
}

.bots-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.bot-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background-color: var(--h-chat-dark);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
}

.bot-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: #43b581;
  position: absolute;
  bottom: 0;
  right: 0;
  border: 2px solid var(--h-chat);
}

.install-date {
  font-size: 12px;
  color: var(--text-muted);
  display: block;
  margin-top: 4px;
}

.bot-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.btn-primary,
.btn-secondary,
.btn-danger {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: #0284C7;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--h-chat-light);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  background-color: #ed4245;
  color: var(--text-primary);
}

.btn-danger:hover {
  background-color: #c03537;
}

/* =========================================================================
   Bot card header & badge
   ======================================================================= */
.bot-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.bot-card .bot-badge {
  display: inline-block;
  padding: 2px 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  border-radius: 3px;
}

/* =========================================================================
   Modal — wider, breathable, scrollable permission list
   ======================================================================= */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 24px;
}

.modal {
  background: var(--background-primary, #1e1f22);
  border: 1px solid var(--border-color, #2b2d31);
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-color, #2b2d31);
  flex-shrink: 0;
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.modal-header .close-btn {
  background: none;
  border: none;
  font-size: 24px;
  line-height: 1;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}

.modal-header .close-btn:hover {
  background: var(--background-modifier-hover, var(--background-secondary));
  color: var(--text-primary);
}

.modal-content {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Bot preview header inside modal */
.bot-preview {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.bot-preview-text {
  flex: 1;
  min-width: 0;
}

.bot-preview-text h4 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-preview-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

/* Permissions list */
.permissions-section-header {
  margin-bottom: 4px;
}

.permissions-section-header h4 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.permissions-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.permissions-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.permission-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.permission-row:hover:not(.disabled) {
  background: var(--background-modifier-hover, var(--background-secondary));
}

.permission-row.disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.permission-row input[type="checkbox"] {
  margin-top: 2px;
  width: 16px;
  height: 16px;
  accent-color: var(--harmony-primary, #0EA5E9);
  cursor: pointer;
  flex-shrink: 0;
}

.permission-row.disabled input[type="checkbox"] {
  cursor: not-allowed;
}

.permission-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.permission-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-required-badge {
  font-size: 10px;
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.permission-description {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
</style>

