<template>
  <div class="user-bots-management">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.myBots') }}</h2>
      <p class="settings-description">
        {{ $t('settings.myBotsDescription') }}
      </p>
    </div>

    <div v-if="isLoading" class="loading-state">
      <LoadingSpinner :size="48" />
      <p>Loading your bots...</p>
    </div>

    <!-- No Bots State -->
    <div v-else-if="myBots.length === 0" class="settings-section">
      <div class="empty-state">
        <h3>No Bots Yet</h3>
        <p>Create your first bot to automate tasks, integrate services, or bridge with other platforms</p>
        <button @click="showCreateModal = true" class="btn btn-primary">
          Create Your First Bot
        </button>
      </div>
    </div>

    <!-- My Bots List -->
    <div v-else class="settings-section">
      <div class="section-header">
        <h3 class="section-title">Your Bots ({{ myBots.length }})</h3>
        <button @click="showCreateModal = true" class="btn btn-primary">
          Create New Bot
        </button>
      </div>

      <div class="bots-list">
        <div v-for="bot in myBots" :key="bot.id" class="bot-card">
          <div class="bot-header">
            <BotAvatar :bot="bot" :size="48" :show-status="true" />

            <div class="bot-info">
              <div class="bot-title">
                <h4>{{ bot.username }}</h4>
                <span class="bot-badge">BOT</span>
                <span v-if="bot.is_verified" class="verified-badge" title="Verified Bot">✓</span>
              </div>
              <p class="bot-bio">{{ bot.bio || 'No description' }}</p>
              <div class="bot-meta">
                <span>Created {{ formatDate(bot.created_at) }}</span>
                <span v-if="bot.last_online_at">• Last online {{ formatDate(bot.last_online_at) }}</span>
              </div>
            </div>
          </div>

          <div class="bot-stats">
            <div class="stat">
              <span class="stat-value">{{ bot.server_count || 0 }}</span>
              <span class="stat-label">Servers</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ formatNumber(bot.command_count || 0) }}</span>
              <span class="stat-label">Commands</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ bot.is_public ? 'Public' : 'Private' }}</span>
              <span class="stat-label">Visibility</span>
            </div>
          </div>

          <div class="bot-actions">
            <button @click="viewBotDetails(bot)" class="btn-secondary">
              View Details
            </button>
            <button @click="showTokenModal(bot)" class="btn-secondary">
              Manage Token
            </button>
            <button @click="editBot(bot)" class="btn-secondary">
              Edit
            </button>
            <button @click="deleteBot(bot)" class="btn-danger">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Bot Modal -->
    <Teleport to="body">
      <div v-if="showCreateModal" class="modal-overlay" @click.self="closeCreateModal">
        <div class="modal">
          <div class="modal-header">
            <h3>Create New Bot</h3>
            <button @click="closeCreateModal" class="close-btn">×</button>
          </div>

          <div class="modal-content">
            <div class="form-group">
              <label>Bot Username*</label>
              <input
                v-model="newBot.username"
                type="text"
                placeholder="my-awesome-bot"
                maxlength="32"
                @input="validateUsername"
              />
              <span v-if="usernameError" class="error">{{ usernameError }}</span>
              <span class="hint">Lowercase letters, numbers, hyphens, and underscores only</span>
            </div>

            <div class="form-group">
              <label>Display Name</label>
              <input
                v-model="newBot.display_name"
                type="text"
                placeholder="My Awesome Bot"
                maxlength="100"
              />
            </div>

            <div class="form-group">
              <label>Description</label>
              <textarea
                v-model="newBot.bio"
                placeholder="What does your bot do?"
                rows="3"
                maxlength="500"
              ></textarea>
            </div>

            <div class="form-group">
              <label>Bot Type</label>
              <select v-model="newBot.bot_type">
                <option value="bot">Standard Bot</option>
                <option value="bridge">Cross-Platform Bridge</option>
                <option value="integration">Service Integration</option>
              </select>
            </div>

            <div class="form-group checkbox">
              <label>
                <input type="checkbox" v-model="newBot.is_public" />
                <span>Public Bot (anyone can add it to their servers)</span>
              </label>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closeCreateModal" class="btn-secondary">Cancel</button>
            <button
              @click="createBot"
              :disabled="!canCreate || creating"
              class="btn-primary"
            >
              {{ creating ? 'Creating...' : 'Create Bot' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Bot Modal -->
    <Teleport to="body">
      <div v-if="showEditModal" class="modal-overlay" @click.self="closeEditModal">
        <div class="modal">
          <div class="modal-header">
            <h3>Edit Bot</h3>
            <button @click="closeEditModal" class="close-btn">×</button>
          </div>

          <div class="modal-content">
            <!-- Avatar uploader: bot owners can change the avatar.
                 Changes propagate to every chat view that re-reads the
                 `bots` row (we also broadcast `bot:updated` after save so
                 anything caching bot rows in-memory can invalidate). -->
            <div class="form-group bot-avatar-edit">
              <label>Avatar</label>
              <div class="bot-avatar-edit-row">
                <BotAvatar :bot="editAvatarPreview" :size="72" />
                <div class="bot-avatar-edit-actions">
                  <button
                    type="button"
                    class="btn-secondary"
                    :disabled="uploadingAvatar"
                    @click="botAvatarInput?.click()"
                  >
                    {{ uploadingAvatar ? 'Uploading...' : 'Change Avatar' }}
                  </button>
                  <button
                    v-if="editBotForm.avatar_url"
                    type="button"
                    class="btn-secondary"
                    :disabled="uploadingAvatar"
                    @click="editBotForm.avatar_url = null"
                  >
                    Remove
                  </button>
                  <input
                    ref="botAvatarInput"
                    type="file"
                    accept="image/png, image/jpeg, image/webp, image/gif"
                    style="display: none"
                    @change="handleBotAvatarUpload"
                  />
                </div>
              </div>
              <span class="hint">PNG, JPG, WebP, or GIF. Max 4 MB.</span>
            </div>

            <div class="form-group">
              <label>Username</label>
              <input
                :value="editBotForm.username"
                type="text"
                disabled
                class="disabled-input"
              />
              <span class="hint">Bot usernames cannot be changed after creation.</span>
            </div>

            <div class="form-group">
              <label>Display Name</label>
              <input
                v-model="editBotForm.display_name"
                type="text"
                placeholder="Bot display name"
                maxlength="100"
              />
            </div>

            <div class="form-group">
              <label>Description</label>
              <textarea
                v-model="editBotForm.bio"
                placeholder="What does your bot do?"
                rows="3"
                maxlength="500"
              ></textarea>
              <span class="hint">{{ (editBotForm.bio?.length ?? 0) }} / 500</span>
            </div>

            <div class="form-group">
              <label>Bot Type</label>
              <select v-model="editBotForm.bot_type">
                <option value="bot">Standard Bot</option>
                <option value="bridge">Cross-Platform Bridge</option>
                <option value="integration">Service Integration</option>
              </select>
            </div>

            <div class="form-group checkbox">
              <label>
                <input type="checkbox" v-model="editBotForm.is_public" />
                <span>Public Bot (anyone can add it to their servers)</span>
              </label>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closeEditModal" class="btn-secondary">Cancel</button>
            <button
              @click="saveEditBot"
              :disabled="savingEdit"
              class="btn-primary"
            >
              {{ savingEdit ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Token Display Modal -->
    <Teleport to="body">
      <div v-if="showToken" class="modal-overlay" @click.self="closeTokenModal">
        <div class="modal">
          <div class="modal-header">
            <h3>Bot Token</h3>
            <button @click="closeTokenModal" class="close-btn">×</button>
          </div>

          <div class="modal-content">
            <div v-if="newBotToken" class="token-warning">
              <span class="warning-icon">⚠️</span>
              <div>
                <strong>Save this token!</strong>
                <p>This token will only be shown once. Copy it now.</p>
              </div>
            </div>

            <div class="token-display">
              <code>{{ currentToken }}</code>
              <button @click="copyToken" class="btn-copy" title="Copy token">
                📋 Copy
              </button>
            </div>

            <div class="token-actions">
              <button @click="regenerateToken" class="btn-danger">
                Regenerate Token
              </button>
              <p class="regenerate-warning">
                Regenerating will invalidate the old token immediately
              </p>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closeTokenModal" class="btn-primary">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Messages -->
    <div v-if="message" class="message-banner" :class="message.type">
      <span>{{ message.text }}</span>
      <button @click="message = null" class="close-btn">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import { formatDistanceToNow } from 'date-fns'
import { generateBotToken, hashBotToken } from '@/utils/botUtils'
import BotAvatar from '@/components/common/BotAvatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

defineProps<{ loading: boolean }>()
const toast = useToast()

// State
const isLoading = ref(false)
const creating = ref(false)
const myBots = ref<any[]>([])
const showCreateModal = ref(false)
const showToken = ref(false)
const currentToken = ref('')
const newBotToken = ref(false)
const currentBot = ref<any>(null)
const message = ref<{ type: string; text: string } | null>(null)

const newBot = ref({
  username: '',
  display_name: '',
  bio: '',
  bot_type: 'bot',
  is_public: true
})

const usernameError = ref('')

// Computed
const canCreate = computed(() => {
  return newBot.value.username.length >= 3 && !usernameError.value
})

// Methods
function validateUsername() {
  const username = newBot.value.username
  
  if (username.length < 3) {
    usernameError.value = 'Username must be at least 3 characters'
    return
  }
  
  if (!/^[a-z0-9_-]+$/.test(username)) {
    usernameError.value = 'Only lowercase letters, numbers, hyphens, and underscores'
    return
  }
  
  usernameError.value = ''
}

async function loadMyBots() {
  isLoading.value = true

  try {
    // Get current user
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Not authenticated')

    // Get user profile ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (!profile) throw new Error('Profile not found')

    // Load bots owned by this user
    const { data: bots, error } = await supabase
      .from('bots')
      .select('*')
      .eq('owner_id', profile.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    myBots.value = bots || []
    debug.log('✅ Loaded', myBots.value.length, 'bots')
  } catch (error: any) {
    debug.error('❌ Failed to load bots:', error)
    toast.error(error.message || 'Failed to load bots')
  } finally {
    isLoading.value = false
  }
}

async function createBot() {
  if (!canCreate.value || creating.value) return

  creating.value = true

  try {
    // Get current user profile
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Not authenticated')

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (!profile) throw new Error('Profile not found')

    // Create bot
    const { data: bot, error: botError } = await supabase
      .from('bots')
      .insert({
        username: newBot.value.username,
        display_name: newBot.value.display_name || newBot.value.username,
        bio: newBot.value.bio,
        bot_type: newBot.value.bot_type,
        is_public: newBot.value.is_public,
        owner_id: profile.id
      })
      .select()
      .single()

    if (botError) throw botError

    // Generate token
    const token = generateBotToken()
    const tokenHash = await hashBotToken(token)

    const { error: tokenError } = await supabase
      .from('bot_tokens')
      .insert({
        bot_id: bot.id,
        token_hash: tokenHash,
        token_prefix: token.substring(0, 8),
        name: 'Default Token',
        scopes: ['bot']
      })

    if (tokenError) throw tokenError

    // Show token
    currentToken.value = token
    newBotToken.value = true
    currentBot.value = bot
    showToken.value = true
    showCreateModal.value = false

    // Reset form
    newBot.value = {
      username: '',
      display_name: '',
      bio: '',
      bot_type: 'bot',
      is_public: true
    }

    // Reload bots
    await loadMyBots()

    toast.success(`Bot "${bot.username}" created successfully!`)
  } catch (error: any) {
    debug.error('❌ Failed to create bot:', error)
    toast.error(error.message || 'Failed to create bot')
  } finally {
    creating.value = false
  }
}

function viewBotDetails(bot: any) {
  debug.log('Viewing bot:', bot)
  // TODO: Implement bot details view
  toast.info('Bot details view coming soon!')
}

function showTokenModal(bot: any) {
  currentBot.value = bot
  currentToken.value = '••••••••••••••••••••'
  newBotToken.value = false
  showToken.value = true
}

function closeTokenModal() {
  showToken.value = false
  currentToken.value = ''
  newBotToken.value = false
  currentBot.value = null
}

function closeCreateModal() {
  showCreateModal.value = false
  newBot.value = {
    username: '',
    display_name: '',
    bio: '',
    bot_type: 'bot',
    is_public: true
  }
  usernameError.value = ''
}

async function regenerateToken() {
  if (!currentBot.value) return

  const confirmed = confirm('Regenerate token? This will immediately invalidate the old token.')
  if (!confirmed) return

  try {
    // Generate new token
    const token = generateBotToken()
    const tokenHash = await hashBotToken(token)

    // Revoke old tokens
    await supabase
      .from('bot_tokens')
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq('bot_id', currentBot.value.id)

    // Create new token
    const { error } = await supabase
      .from('bot_tokens')
      .insert({
        bot_id: currentBot.value.id,
        token_hash: tokenHash,
        token_prefix: token.substring(0, 8),
        name: 'Regenerated Token',
        scopes: ['bot']
      })

    if (error) throw error

    currentToken.value = token
    newBotToken.value = true
    toast.success('Token regenerated successfully!')
  } catch (error: any) {
    debug.error('❌ Failed to regenerate token:', error)
    toast.error('Failed to regenerate token')
  }
}

// -------------------------------------------------------------------------
// Edit bot
// -------------------------------------------------------------------------
const showEditModal = ref(false)
const savingEdit = ref(false)
const editingBotId = ref<string | null>(null)
const editBotForm = ref<{
  username: string
  display_name: string
  bio: string
  bot_type: string
  is_public: boolean
  avatar_url: string | null
}>({
  username: '',
  display_name: '',
  bio: '',
  bot_type: 'bot',
  is_public: true,
  avatar_url: null,
})
const botAvatarInput = ref<HTMLInputElement | null>(null)
const uploadingAvatar = ref(false)

// Used purely to feed <BotAvatar> with reactive form data.
const editAvatarPreview = computed(() => ({
  username: editBotForm.value.username,
  avatar_url: editBotForm.value.avatar_url,
}))

function editBot(bot: any) {
  editingBotId.value = bot.id
  editBotForm.value = {
    username: bot.username ?? '',
    display_name: bot.display_name ?? '',
    bio: bot.bio ?? '',
    bot_type: bot.bot_type ?? 'bot',
    is_public: !!bot.is_public,
    avatar_url: bot.avatar_url ?? null,
  }
  showEditModal.value = true
}

async function handleBotAvatarUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // reset so the same file re-fires change next time
  if (!file || !editingBotId.value) return

  if (file.size > 4 * 1024 * 1024) {
    toast.error('Avatar must be 4 MB or smaller.')
    return
  }

  uploadingAvatar.value = true
  try {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `bots/${editingBotId.value}/avatar-${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type })
    if (upErr) throw upErr

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path)
    editBotForm.value.avatar_url = pub.publicUrl
    toast.success('Avatar updated - remember to save.')
  } catch (err: any) {
    debug.error('Failed to upload bot avatar:', err)
    toast.error(err?.message || 'Failed to upload avatar.')
  } finally {
    uploadingAvatar.value = false
  }
}

function closeEditModal() {
  showEditModal.value = false
  editingBotId.value = null
}

async function saveEditBot() {
  if (!editingBotId.value || savingEdit.value) return
  savingEdit.value = true

  try {
    // Username is immutable here - never include it in the update payload.
    const { error } = await supabase
      .from('bots')
      .update({
        display_name: editBotForm.value.display_name || null,
        bio: editBotForm.value.bio || null,
        bot_type: editBotForm.value.bot_type,
        is_public: editBotForm.value.is_public,
        avatar_url: editBotForm.value.avatar_url,
      })
      .eq('id', editingBotId.value)

    if (error) throw error

    // Broadcast so any view caching this bot row in memory (MessageDisplay's
    // botDataCache, etc.) can refresh without a full reload.
    window.dispatchEvent(new CustomEvent('bot:updated', {
      detail: {
        id: editingBotId.value,
        display_name: editBotForm.value.display_name || null,
        avatar_url: editBotForm.value.avatar_url,
        bio: editBotForm.value.bio || null,
      },
    }))

    toast.success('Bot updated')
    closeEditModal()
    await loadMyBots()
  } catch (error: any) {
    debug.error('Failed to update bot:', error)
    toast.error(error.message || 'Failed to update bot')
  } finally {
    savingEdit.value = false
  }
}

async function deleteBot(bot: any) {
  const confirmed = confirm(`Delete "${bot.username}"? This cannot be undone.`)
  if (!confirmed) return

  try {
    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', bot.id)

    if (error) throw error

    toast.success(`Bot "${bot.username}" deleted`)
    await loadMyBots()
  } catch (error: any) {
    debug.error('❌ Failed to delete bot:', error)
    toast.error('Failed to delete bot')
  }
}

function copyToken() {
  navigator.clipboard.writeText(currentToken.value)
  toast.success('Token copied to clipboard!')
}

function formatDate(date: string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// Lifecycle
onMounted(() => {
  loadMyBots()
})
</script>

<style scoped>
/* Reuse styles from existing settings components */
.user-bots-management {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  margin: 0 0 20px 0;
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 48px 24px;
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-state h3 {
  font-size: 20px;
  color: var(--color-text-primary, #ffffff);
  margin: 0 0 8px 0;
}

.empty-state p {
  color: var(--color-text-secondary, var(--text-secondary));
  margin: 0 0 24px 0;
}

.section-actions {
  margin-bottom: 24px;
}

.bots-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bot-card {
  padding: 20px;
  background: var(--h-chat-dark);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
  transition: all 0.2s;
  margin-bottom: 16px;
}

.bot-card:last-child {
  margin-bottom: 0;
}

.bot-card:hover {
  border-color: #0EA5E9;
}

.bot-header {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.bot-avatar {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}

.bot-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.bot-status {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #747f8d;
  border: 3px solid var(--color-background-secondary, var(--background-tertiary));
}

.bot-status.online {
  background: #3ba55d;
}

.bot-info {
  flex: 1;
  min-width: 0;
}

.bot-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.bot-title h4 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary, #ffffff);
  margin: 0;
}

.bot-badge {
  padding: 2px 6px;
  background: var(--color-primary, #0EA5E9);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 600;
  border-radius: 4px;
}

.verified-badge {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #3ba55d;
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 50%;
}

.bot-bio {
  font-size: 14px;
  color: var(--color-text-secondary, var(--text-secondary));
  margin: 0 0 8px 0;
}

.bot-meta {
  font-size: 12px;
  color: var(--color-text-tertiary, var(--text-muted));
}

.bot-stats {
  display: flex;
  gap: 24px;
  padding: 12px 0;
  border-top: 1px solid var(--color-border, var(--h-black-lighter));
  border-bottom: 1px solid var(--color-border, var(--h-black-lighter));
  margin-bottom: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text-primary, #ffffff);
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary, var(--text-secondary));
}

.bot-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.btn,
.btn-primary,
.btn-secondary,
.btn-danger,
.btn-copy {
  padding: 8px 16px;
  border-radius: 4px;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: #0284C7;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--h-chat-light);
}

.btn-secondary:hover {
  background: var(--h-chat-light);
}

.btn-danger {
  background: #ed4245;
  color: var(--text-primary);
}

.btn-danger:hover {
  background: #c03537;
}

.btn-copy {
  background: var(--color-background-tertiary, #4f545c);
  color: var(--color-text-primary, #ffffff);
}

/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal {
  background: var(--color-background-primary, var(--background-secondary));
  border-radius: 8px;
  width: 90%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  animation: slideUp 0.3s;
}

@keyframes slideUp {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--color-border, var(--h-black-lighter));
}

.modal-header h3 {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text-primary, #ffffff);
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--color-text-secondary, var(--text-secondary));
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
}

.close-btn:hover {
  color: var(--color-text-primary, #ffffff);
}

.modal-content {
  padding: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary, #ffffff);
  margin-bottom: 8px;
}

.form-group input[type="text"],
.form-group textarea,
.form-group select {
  width: 100%;
  padding: 10px 12px;
  background: var(--color-background-tertiary, #202225);
  border: 1px solid var(--color-border, var(--h-black-lighter));
  border-radius: 4px;
  color: var(--color-text-primary, #ffffff);
  font-size: 14px;
  font-family: inherit;
}

.form-group input:focus,
.form-group textarea:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--color-primary, #0EA5E9);
}

.bot-avatar-edit-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 4px;
}

.bot-avatar-edit-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group input.disabled-input,
.form-group input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--background-secondary);
}

.form-group.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-group.checkbox label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
}

.error {
  display: block;
  color: #ed4245;
  font-size: 12px;
  margin-top: 4px;
}

.hint {
  display: block;
  color: var(--color-text-secondary, var(--text-secondary));
  font-size: 12px;
  margin-top: 4px;
}

.token-warning {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(237, 66, 69, 0.1);
  border-left: 4px solid #ed4245;
  border-radius: 4px;
  margin-bottom: 16px;
}

.warning-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.token-warning strong {
  display: block;
  color: #ed4245;
  margin-bottom: 4px;
}

.token-warning p {
  color: var(--color-text-secondary, var(--text-secondary));
  font-size: 13px;
  margin: 0;
}

.token-display {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.token-display code {
  flex: 1;
  padding: 12px;
  background: var(--color-background-tertiary, #202225);
  border: 1px solid var(--color-border, var(--h-black-lighter));
  border-radius: 4px;
  color: var(--color-text-primary, #ffffff);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  overflow-x: auto;
}

.token-actions {
  margin-top: 16px;
}

.regenerate-warning {
  font-size: 12px;
  color: var(--color-text-secondary, var(--text-secondary));
  margin: 8px 0 0 0;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  padding: 20px 24px;
  border-top: 1px solid var(--color-border, var(--h-black-lighter));
}

.message-banner {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 16px 20px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  animation: slideIn 0.3s;
  z-index: 10001;
}

.message-banner.success {
  background: #3ba55d;
  color: var(--text-primary);
}

.message-banner.error {
  background: #ed4245;
  color: var(--text-primary);
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@media (max-width: 768px) {
  .bot-header {
    flex-direction: column;
  }

  .bot-stats {
    flex-direction: column;
    gap: 12px;
  }

  .bot-actions {
    flex-direction: column;
  }

  .bot-actions button {
    width: 100%;
  }
}
</style>

