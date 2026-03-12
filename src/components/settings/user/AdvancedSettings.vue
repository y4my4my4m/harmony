<template>
  <div class="advanced-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.advanced.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.advanced.description') }}
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Developer Settings</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.advanced.developerMode') }}</h4>
          <p class="setting-description">{{ $t('settings.advanced.developerModeDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.developerMode"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.advanced.hardwareAcceleration') }}</h4>
          <p class="setting-description">Use hardware acceleration when available.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.hardwareAcceleration"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data Management</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('common.clear') }} Cache</h4>
          <p class="setting-description">Clear stored cache data to free up space.</p>
        </div>
        <div class="setting-control">
          <button class="btn btn-secondary" @click="clearCache">
            {{ $t('common.clear') }} Cache
          </button>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('common.download') }} Data</h4>
          <p class="setting-description">Export your user data for backup purposes.</p>
        </div>
        <div class="setting-control">
          <button class="btn btn-secondary" @click="exportData">
            {{ $t('common.download') }} Data
          </button>
        </div>
      </div>
    </div>

    <div class="settings-section danger-zone">
      <h3 class="section-title danger">Danger Zone</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label danger">{{ $t('common.delete') }} Account</h4>
          <p class="setting-description">Permanently delete your account and all associated data.</p>
        </div>
        <div class="setting-control">
          <button class="btn btn-danger" @click="showDeleteConfirmation">
            {{ $t('common.delete') }} Account
          </button>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <div v-if="showDeleteModal" class="modal-overlay" @click="hideDeleteConfirmation">
      <div class="modal-content" @click.stop>
        <h3 class="modal-title">Delete Account</h3>
        <p class="modal-text">
          Are you sure you want to delete your account? This action cannot be undone.
        </p>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="hideDeleteConfirmation">
            Cancel
          </button>
          <button class="btn btn-danger" @click="deleteAccount">
            Delete Account
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useDeveloperTools } from '@/composables/useDeveloperTools'

interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-advanced': [settings: any]
}>()

const { developerToolsEnabled, setDeveloperToolsEnabled } = useDeveloperTools()

const settings = ref({
  developerMode: false,
  hardwareAcceleration: true,
})

const showDeleteModal = ref(false)
const originalSettings = ref({ ...settings.value })

const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

onMounted(() => {
  settings.value.developerMode = developerToolsEnabled.value
  originalSettings.value = { ...settings.value }
})

watch(developerToolsEnabled, (v) => {
  settings.value.developerMode = v
})

const onSettingChange = () => {
  setDeveloperToolsEnabled(settings.value.developerMode)
  emit('update-advanced', settings.value)
}

const clearCache = () => {
  // Clear cache logic
  debug.log('Clearing cache...')
}

const exportData = () => {
  // Export data logic
  debug.log('Exporting data...')
}

const showDeleteConfirmation = () => {
  showDeleteModal.value = true
}

const hideDeleteConfirmation = () => {
  showDeleteModal.value = false
}

const deleteAccount = () => {
  // Delete account logic
  debug.log('Deleting account...')
  showDeleteModal.value = false
}
</script>

<style scoped>
.advanced-settings {
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

.settings-section.danger-zone {
  border-color: #ed4245;
  background-color: rgba(237, 66, 69, 0.05);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.section-title.danger {
  color: #ed4245;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--h-chat-light);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-label.danger {
  color: #ed4245;
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
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
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid #4f545c;
}

.btn-secondary:hover {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
}

.btn-danger {
  background-color: #ed4245;
  color: var(--text-primary);
}

.btn-danger:hover {
  background-color: #c73e41;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-content {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
  border: 1px solid var(--h-chat-light);
}

.modal-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.modal-text {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  line-height: 1.4;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
</style>