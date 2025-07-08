<template>
  <div class="server-advanced-settings">
    <div class="settings-section">
      <h2 class="section-title">Advanced Settings</h2>
      <p class="section-description">
        {{ permissions.canDeleteServer ? 'Manage advanced server options and dangerous actions' : 'View advanced server settings' }}
      </p>
    </div>

    <!-- Permission Notice for Non-Owners -->
    <div v-if="!permissions.canDeleteServer" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h4>Owner Only Access</h4>
          <p>Advanced settings and server deletion can only be performed by the server owner.</p>
        </div>
      </div>
    </div>

    <!-- Server Statistics -->
    <div class="settings-card">
      <div class="form-group">
        <label class="form-label">Server Statistics</label>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-label">Created</div>
            <div class="stat-value">{{ formatDate(createdAt) }}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Server ID</div>
            <div class="stat-value">{{ serverId }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Danger Zone -->
    <div v-if="permissions.canDeleteServer" class="settings-card danger-zone">
      <div class="form-group">
        <h3 class="section-title danger">Danger Zone</h3>
        <p class="section-description danger">
          These actions cannot be undone. Please proceed with caution.
        </p>
      </div>

      <div class="danger-action">
        <div class="danger-info">
          <h4 class="danger-label">Delete Server</h4>
          <p class="danger-description">
            Permanently delete this server and all associated data including channels, messages, emojis, and member information.
          </p>
        </div>
        <div class="danger-control">
          <button 
            class="btn btn-danger" 
            @click="showDeleteConfirmation"
            :disabled="loading"
          >
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
            </svg>
            Delete Server
          </button>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <UnifiedConfirmationModal
      v-model="showDeleteModal"
      title="Delete Server"
      :message="`Deleting ${serverName} will permanently remove all channels, messages, emojis, files, member data, roles, and server configuration.`"
      secondary-message="This action cannot be undone!"
      confirm-button-text="Delete Server"
      :require-confirmation="true"
      :confirmation-text="serverName"
      :danger-action="true"
      @confirm="confirmDeleteServer"
      @cancel="hideDeleteConfirmation"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import UnifiedConfirmationModal from '@/components/shared/UnifiedConfirmationModal.vue'

interface ServerAdvancedPermissions {
  canDeleteServer: boolean
}

interface Props {
  serverId: string
  serverName: string
  createdAt: string | undefined
  loading: boolean
  permissions: ServerAdvancedPermissions
}

const props = defineProps<Props>()

const router = useRouter()
const toast = useToast()
const serverStore = useServerStore()
const authStore = useAuthStore()

// State
const showDeleteModal = ref(false)

// Methods
const showDeleteConfirmation = () => {
  showDeleteModal.value = true
}

const hideDeleteConfirmation = () => {
  showDeleteModal.value = false
}

const confirmDeleteServer = async () => {
  const userId = authStore.session?.user?.id
  if (!userId) {
    toast.error('Authentication required')
    return
  }

  try {
    const success = await serverStore.deleteServer(props.serverId, userId)
    
    if (success) {
      toast.success('Server deleted successfully')
      hideDeleteConfirmation()
      // Navigate to home or server list
      router.push('/')
    } else {
      throw new Error('Failed to delete server')
    }
  } catch (error: any) {
    console.error('Error deleting server:', error)
    toast.error(error.message || 'Failed to delete server')
  }
}

const formatDate = (dateString: string | undefined): string => {
  if (!dateString) return 'Unknown'
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}
</script>

<style scoped>
.server-advanced-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-title.danger {
  color: #ed4245;
  font-size: 18px;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.section-description.danger {
  color: #ed4245;
}

.permission-notice {
  padding: 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #faa61a;
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: #faa61a;
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
}

.settings-card {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  border: 1px solid var(--h-chat-light);
}

.settings-card.danger-zone {
  border-color: #ed4245;
  background-color: rgba(237, 66, 69, 0.05);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.stat-item {
  padding: 12px;
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  border: 1px solid var(--h-chat-light);
}

.stat-label {
  font-size: 12px;
  color: #72767d;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 14px;
  color: #ffffff;
  font-family: 'Courier New', monospace;
}

.danger-action {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
  background-color: rgba(237, 66, 69, 0.1);
  border: 1px solid rgba(237, 66, 69, 0.3);
  border-radius: 6px;
}

.danger-info {
  flex: 1;
}

.danger-label {
  font-size: 16px;
  font-weight: 600;
  color: #ed4245;
  margin: 0 0 4px 0;
}

.danger-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.4;
}

.danger-control {
  flex-shrink: 0;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-danger {
  background-color: #ed4245;
  color: #ffffff;
}

.btn-danger:hover:not(:disabled) {
  background-color: #c53030;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

/* Modal styles now handled by UnifiedConfirmationModal */

@media (max-width: 768px) {
  .danger-action {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .stats-grid {
    grid-template-columns: 1fr;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>