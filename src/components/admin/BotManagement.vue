<template>
  <div class="bot-management">
    <div class="header">
      <h2>Bot Management</h2>
      <button @click="showCreateModal = true" class="btn-primary">
        Create New Bot
      </button>
    </div>
    
    <div v-if="loading" class="loading">
      <LoadingSpinner :size="48" />
      <p>Loading bots...</p>
    </div>
    
    <div v-else-if="bots.length === 0" class="empty-state">
      <h3>No Bots Yet</h3>
      <p>Create your first bot to automate tasks and integrate services</p>
      <button @click="showCreateModal = true" class="btn-primary">Create Bot</button>
    </div>
    
    <div v-else class="bots-grid">
      <div v-for="bot in bots" :key="bot.id" class="bot-card">
        <div class="bot-avatar">
          <BotAvatar :bot="bot" :size="40" />
          <div class="bot-status" :class="{ online: botStatuses[bot.id] }"></div>
        </div>
        
        <div class="bot-info">
          <h3>{{ bot.username }}</h3>
          <span class="bot-badge">BOT</span>
          <p class="bot-bio">{{ bot.bio || 'No description' }}</p>
          
          <div class="bot-stats">
            <div class="stat">
              <span class="stat-label">Servers</span>
              <span class="stat-value">{{ bot.server_count || 0 }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Commands</span>
              <span class="stat-value">{{ bot.command_count || 0 }}</span>
            </div>
          </div>
        </div>
        
        <div class="bot-actions">
          <button @click="viewBot(bot)" class="btn-secondary">View</button>
          <button @click="regenerateToken(bot)" class="btn-secondary">Token</button>
          <button @click="deleteBot(bot)" class="btn-danger">Delete</button>
        </div>
      </div>
    </div>
    
    <!-- Create Bot Modal -->
    <Teleport to="body">
      <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
        <div class="modal">
          <h2>Create New Bot</h2>
          
          <div class="form-group">
            <label>Bot Username*</label>
            <input 
              v-model="newBot.username" 
              type="text"
              placeholder="my-awesome-bot"
              @input="validateUsername"
            />
            <span v-if="usernameError" class="error">{{ usernameError }}</span>
          </div>
          
          <div class="form-group">
            <label>Display Name</label>
            <input 
              v-model="newBot.display_name" 
              type="text"
              placeholder="My Awesome Bot"
            />
          </div>
          
          <div class="form-group">
            <label>Description</label>
            <textarea 
              v-model="newBot.bio" 
              placeholder="What does your bot do?"
              rows="3"
            ></textarea>
          </div>
          
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="newBot.is_public" />
              <span>Public Bot (anyone can add to their server)</span>
            </label>
          </div>
          
          <div class="modal-actions">
            <button @click="showCreateModal = false" class="btn-secondary">Cancel</button>
            <button 
              @click="createBot" 
              :disabled="!canCreate || creating"
              class="btn-primary"
            >
              <span v-if="creating">Creating...</span>
              <span v-else>Create Bot</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    
    <!-- Bot Token Modal -->
    <Teleport to="body">
      <div v-if="showTokenModal" class="modal-overlay" @click.self="showTokenModal = false">
        <div class="modal">
          <h2>Bot Token</h2>
          
          <div class="warning-box">
            <span class="warning-icon">⚠️</span>
            <div>
              <strong>Keep this token secret!</strong>
              <p>Anyone with this token can control your bot. Never share it or commit it to version control.</p>
            </div>
          </div>
          
          <div class="token-display">
            <code>{{ currentToken }}</code>
            <button @click="copyToken" class="btn-copy">
              <span v-if="tokenCopied">Copied!</span>
              <span v-else>Copy</span>
            </button>
          </div>
          
          <p class="token-note">
            This token will only be shown once. Save it securely now.
          </p>
          
          <div class="modal-actions">
            <button @click="showTokenModal = false" class="btn-primary">Done</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { useToast } from 'vue-toastification'
import { generateBotToken, hashBotToken } from '@/utils/botUtils'
import BotAvatar from '@/components/common/BotAvatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const toast = useToast()
const { confirm } = useConfirmDialog()
const authStore = useAuthStore()

const loading = ref(true)
const bots = ref<any[]>([])
const botStatuses = ref<Record<string, boolean>>({})

const showCreateModal = ref(false)
const showTokenModal = ref(false)
const currentToken = ref('')
const tokenCopied = ref(false)

const creating = ref(false)
const newBot = ref({
  username: '',
  display_name: '',
  bio: '',
  is_public: true
})

const usernameError = ref('')

const canCreate = computed(() => {
  return newBot.value.username.length >= 3 && 
         !usernameError.value &&
         /^[a-z0-9_-]+$/.test(newBot.value.username)
})

function validateUsername() {
  const username = newBot.value.username
  
  if (username.length < 3) {
    usernameError.value = 'Username must be at least 3 characters'
  } else if (!/^[a-z0-9_-]+$/.test(username)) {
    usernameError.value = 'Username can only contain lowercase letters, numbers, hyphens, and underscores'
  } else {
    usernameError.value = ''
  }
}

async function loadBots() {
  try {
    const userId = authStore.session?.user?.id
    if (!userId) return
    
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
    
    if (error) throw error
    
    bots.value = data || []
    
    // Check bot statuses
    for (const bot of bots.value) {
      const { data: presence } = await supabase
        .from('bot_presence')
        .select('status')
        .eq('bot_id', bot.id)
        .single()
      
      botStatuses.value[bot.id] = presence?.status === 'online'
    }
  } catch (error: any) {
    debug.error('Failed to load bots:', error)
    toast.error('Failed to load bots')
  } finally {
    loading.value = false
  }
}

async function createBot() {
  try {
    creating.value = true
    const userId = authStore.session?.user?.id
    if (!userId) return
    
    // Generate bot token
    const token = generateBotToken()
    const tokenHash = await hashBotToken(token)
    const tokenPrefix = token.substring(0, 8)
    
    // Create bot
    const { data: bot, error: botError } = await supabase
      .from('bots')
      .insert({
        username: newBot.value.username,
        display_name: newBot.value.display_name || newBot.value.username,
        bio: newBot.value.bio,
        is_public: newBot.value.is_public,
        owner_id: userId
      })
      .select()
      .single()
    
    if (botError) throw botError
    
    // Create bot token
    const { error: tokenError } = await supabase
      .from('bot_tokens')
      .insert({
        bot_id: bot.id,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        name: 'Default Token'
      })
    
    if (tokenError) throw tokenError
    
    // Show token
    currentToken.value = token
    showTokenModal.value = true
    showCreateModal.value = false
    
    // Reset form
    newBot.value = {
      username: '',
      display_name: '',
      bio: '',
      is_public: true
    }
    
    // Reload bots
    await loadBots()
    
    toast.success('Bot created successfully!')
  } catch (error: any) {
    debug.error('Failed to create bot:', error)
    toast.error(error.message || 'Failed to create bot')
  } finally {
    creating.value = false
  }
}

async function regenerateToken(bot: any) {
  if (!(await confirm({ title: 'Regenerate token', message: `Regenerate token for ${bot.username}? This will invalidate the old token.`, confirmButtonText: 'Regenerate', dangerAction: true }))) {
    return
  }
  
  try {
    const token = generateBotToken()
    const tokenHash = await hashBotToken(token)
    const tokenPrefix = token.substring(0, 8)
    
    // Revoke old tokens
    await supabase
      .from('bot_tokens')
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq('bot_id', bot.id)
    
    // Create new token
    await supabase
      .from('bot_tokens')
      .insert({
        bot_id: bot.id,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        name: 'Regenerated Token'
      })
    
    currentToken.value = token
    showTokenModal.value = true
    toast.success('Token regenerated successfully')
  } catch (error: any) {
    toast.error('Failed to regenerate token')
  }
}

function copyToken() {
  navigator.clipboard.writeText(currentToken.value)
  tokenCopied.value = true
  setTimeout(() => {
    tokenCopied.value = false
  }, 2000)
}

function viewBot(bot: any) {
  // Navigate to bot details page
  debug.log('View bot:', bot)
}

async function deleteBot(bot: any) {
  if (!(await confirm({ title: 'Delete bot', message: `Delete ${bot.username}? This action cannot be undone.`, confirmButtonText: 'Delete', dangerAction: true }))) {
    return
  }
  
  try {
    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', bot.id)
    
    if (error) throw error
    
    await loadBots()
    toast.success('Bot deleted successfully')
  } catch (error: any) {
    toast.error('Failed to delete bot')
  }
}

onMounted(() => {
  loadBots()
})
</script>

<style scoped>
.bot-management {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
}

.header h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.loading {
  text-align: center;
  padding: 48px 0;
}

.empty-state {
  text-align: center;
  padding: 64px 24px;
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-state h3 {
  font-size: 20px;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.empty-state p {
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.bots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 24px;
}

.bot-card {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bot-avatar {
  position: relative;
  width: 64px;
  height: 64px;
}

.bot-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.bot-status {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: 3px solid var(--bg-secondary);
}

.bot-status::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #747f8d;
}

.bot-status.online::after {
  background: #23a55a;
}

.bot-info h3 {
  font-size: 18px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.bot-badge {
  display: inline-block;
  padding: 2px 8px;
  background: var(--primary);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 600;
  border-radius: 4px;
  text-transform: uppercase;
}

.bot-bio {
  color: var(--text-secondary);
  font-size: 14px;
  margin-top: 8px;
}

.bot-stats {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}

.stat {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-actions {
  display: flex;
  gap: 8px;
}

.btn-primary,
.btn-secondary,
.btn-danger {
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  font-size: 14px;
  flex: 1;
}

.btn-primary {
  background: var(--primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: var(--bg-quaternary);
}

.btn-danger {
  background: #da373c;
  color: var(--text-primary);
}

.btn-danger:hover {
  background: #a12828;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal {
  background: var(--bg-primary);
  padding: 24px;
  border-radius: 12px;
  max-width: 480px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
}

.modal h2 {
  font-size: 20px;
  color: var(--text-primary);
  margin-bottom: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  color: var(--text-primary);
  font-weight: 500;
  margin-bottom: 8px;
  font-size: 14px;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.form-group .error {
  color: #da373c;
  font-size: 12px;
  margin-top: 4px;
  display: block;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-label input {
  width: auto;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.warning-box {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 152, 0, 0.1);
  border: 1px solid rgba(255, 152, 0, 0.3);
  border-radius: 6px;
  margin-bottom: 16px;
}

.warning-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.warning-box strong {
  color: var(--text-primary);
  display: block;
  margin-bottom: 4px;
}

.warning-box p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.token-display {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.token-display code {
  flex: 1;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  word-break: break-all;
  color: var(--primary);
}

.btn-copy {
  padding: 12px 20px;
  background: var(--primary);
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  white-space: nowrap;
}

.btn-copy:hover {
  background: var(--primary-hover);
}

.token-note {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 16px;
}
</style>

