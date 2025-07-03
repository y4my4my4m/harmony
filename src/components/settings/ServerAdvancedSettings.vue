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
    <div v-if="showDeleteModal" class="modal-overlay" @click="hideDeleteConfirmation">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3 class="modal-title">Delete Server</h3>
          <button class="modal-close" @click="hideDeleteConfirmation">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body">
          <div class="warning-section">
            <svg class="warning-icon" width="48" height="48" viewBox="0 0 24 24">
              <path fill="#ed4245" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
            </svg>
            <h4 class="warning-title">This action cannot be undone!</h4>
            <p class="warning-text">
              Deleting <strong>{{ serverName }}</strong> will permanently remove:
            </p>
            <ul class="warning-list">
              <li>All channels and messages</li>
              <li>All server emojis and files</li>
              <li>All member data and roles</li>
              <li>Server settings and configuration</li>
            </ul>
          </div>

          <div class="confirmation-section">
            <label class="confirmation-label">
              To confirm deletion, type the exact server name: <strong>{{ serverName }}</strong>
            </label>
            <input
              v-model="confirmationText"
              type="text"
              class="confirmation-input"
              :class="{ 'error': confirmationError }"
              placeholder="Type server name here..."
              @input="validateConfirmation"
            />
            <div v-if="confirmationError" class="error-message">
              {{ confirmationError }}
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" @click="hideDeleteConfirmation" :disabled="deleting">
            Cancel
          </button>
          <button 
            class="btn btn-danger" 
            @click="confirmDeleteServer"
            :disabled="!isConfirmationValid || deleting"
          >
            <span v-if="deleting" class="loading-spinner"></span>
            {{ deleting ? 'Deleting...' : 'Delete Server' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'

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
const confirmationText = ref('')
const confirmationError = ref('')
const deleting = ref(false)

// Computed
const isConfirmationValid = computed(() => {
  return confirmationText.value === props.serverName && !confirmationError.value
})

// Methods
const showDeleteConfirmation = () => {
  showDeleteModal.value = true
  confirmationText.value = ''
  confirmationError.value = ''
}

const hideDeleteConfirmation = () => {
  showDeleteModal.value = false
  confirmationText.value = ''
  confirmationError.value = ''
}

const validateConfirmation = () => {
  if (confirmationText.value && confirmationText.value !== props.serverName) {
    confirmationError.value = 'Server name does not match'
  } else {
    confirmationError.value = ''
  }
}

const confirmDeleteServer = async () => {
  if (!isConfirmationValid.value) {
    confirmationError.value = 'Please type the exact server name to confirm'
    return
  }

  const userId = authStore.session?.user?.id
  if (!userId) {
    toast.error('Authentication required')
    return
  }

  try {
    deleting.value = true
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
  } finally {
    deleting.value = false
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

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
}

.modal-content {
  background: var(--h-chat);
  border-radius: 8px;
  width: 100%;
  max-width: 500px;
  border: 1px solid var(--h-chat-light);
  box-shadow: 0 32px 64px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--h-chat-light);
}

.modal-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.modal-body {
  padding: 20px;
}

.warning-section {
  text-align: center;
  margin-bottom: 24px;
}

.warning-icon {
  margin-bottom: 12px;
}

.warning-title {
  font-size: 16px;
  font-weight: 600;
  color: #ed4245;
  margin: 0 0 8px 0;
}

.warning-text {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 12px 0;
}

.warning-list {
  text-align: left;
  color: #b9bbbe;
  font-size: 13px;
  margin: 0;
  padding-left: 20px;
}

.warning-list li {
  margin-bottom: 4px;
}

.confirmation-section {
  margin-bottom: 24px;
}

.confirmation-label {
  display: block;
  font-size: 14px;
  color: #ffffff;
  margin-bottom: 8px;
  font-weight: 500;
}

.confirmation-input {
  width: 100%;
  padding: 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: #ffffff;
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.confirmation-input:focus {
  outline: none;
  border-color: #5865f2;
}

.confirmation-input.error {
  border-color: #ed4245;
}

.error-message {
  font-size: 12px;
  color: #ed4245;
  margin-top: 4px;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  padding: 16px 20px;
  border-top: 1px solid var(--h-chat-light);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

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
  
  .modal-content {
    margin: 0 16px;
  }
}
</style>