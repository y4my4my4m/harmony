<template>
  <div class="privacy-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.privacy') }}</h2>
      <p class="settings-description">
        Control who can interact with you, manage your account security, and control how your data is used.
      </p>
    </div>

    <div class="settings-section security-section">
      <h3 class="section-title">
        <ShieldIcon class="section-icon" />
        Account security
      </h3>
      <i18n-t keypath="security.privacyLink" tag="p" class="setting-description">
        <template #link>
          <router-link :to="{ name: 'UserSettings', params: { section: 'security' } }">{{ $t('settings.security') }}</router-link>
        </template>
      </i18n-t>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('activitypub.followApprovalTitle') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('activitypub.followApprovalLabel') }}</h4>
          <p class="setting-description">{{ $t('activitypub.followApprovalDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="requireFollowApproval"
            :disabled="followApprovalSaving || !profile?.id"
            data-testid="follow-approval-toggle"
            @change="onFollowApprovalChange"
          />
        </div>
      </div>
    </div>

    <!-- Encryption Settings -->
    <div class="settings-section security-section">
      <h3 class="section-title">
        <ShieldIcon class="section-icon" />
        Encryption settings
      </h3>
      <EncryptionSettings :loading="loading" />
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data & privacy</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Strip tracking parameters from URLs</h4>
          <p class="setting-description">
            Automatically remove tracking parameters (like ?si=...) from URLs in your messages for YouTube, X/Twitter, TikTok, Instagram, and Facebook.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.stripUrlTrackers"
            @change="onUrlStripChange"
          />
        </div>
      </div>

    </div>

    <DataExportPanel class="export-card" />

    <div class="settings-section">
      <h3 class="section-title">Blocked users</h3>
      
      <EmptyState
        v-if="blockedUsers.length === 0"
        size="sm"
        icon="shield"
        :title="$t('empty.blocked.title')"
      />
      
      <div v-else class="blocked-users-list">
        <div 
          v-for="user in blockedUsers" 
          :key="user.id"
          class="blocked-user-item"
        >
          <div class="user-info">
            <Avatar :src="user.avatar_url" size="sm" class="user-avatar" />
            <div class="user-details">
              <span class="user-name">{{ user.display_name }}</span>
              <span class="user-username">{{ user.username }}</span>
            </div>
          </div>
          <button 
            class="unblock-btn"
            @click="unblockUser(user.id)"
          >
            Unblock
          </button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Muted users</h3>
      
      <EmptyState
        v-if="mutedUsers.length === 0"
        size="sm"
        icon="volume-x"
        :title="$t('empty.muted.title')"
      />
      
      <div v-else class="blocked-users-list">
        <div 
          v-for="user in mutedUsers" 
          :key="user.id"
          class="blocked-user-item"
        >
          <div class="user-info">
            <Avatar :src="user.avatar_url" size="sm" class="user-avatar" />
            <div class="user-details">
              <span class="user-name">{{ user.display_name }}</span>
              <span class="user-username">{{ user.username }}</span>
            </div>
          </div>
          <button 
            class="unblock-btn"
            @click="unmuteUser(user.id)"
          >
            Unmute
          </button>
        </div>
      </div>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        Save changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import type { User } from '@/types'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import { isUrlTrackingStrippingEnabled, setUrlTrackingStrippingEnabled } from '@/utils/urlTrackerStripper'

// Components
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import EncryptionSettings from '@/components/encryption/EncryptionSettings.vue'
import DataExportPanel from './DataExportPanel.vue'

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-privacy': [settings: any]
}>()

// Composables
const toast = useToast()
const { t } = useI18n()

// Privacy State
const settings = ref({
  stripUrlTrackers: true,
})

const originalSettings = ref({ ...settings.value })
const requireFollowApproval = ref(false)
const followApprovalSaving = ref(false)
const blockedUsers = ref<User[]>([])
const mutedUsers = ref<User[]>([])
const activityPubStore = useActivityPubStore()
let blocksMutesLastFetchedAt = 0
const CACHE_TTL_MS = 30000

// Computed
const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

// Methods
// eslint-disable-next-line unused-imports/no-unused-vars
const onSettingChange = () => {
  // Empty: the template binds it to enable the save button via hasChanges.
}

// The URL-tracker flag lives in localStorage and is read by the message-send
// pipeline (`unifiedContentProcessing.ts`) on every send. Applied on toggle
// rather than on Save Changes so the next message reflects it.
const onUrlStripChange = () => {
  setUrlTrackingStrippingEnabled(settings.value.stripUrlTrackers)
  originalSettings.value.stripUrlTrackers = settings.value.stripUrlTrackers
}

const saveSettings = () => {
  setUrlTrackingStrippingEnabled(settings.value.stripUrlTrackers)
  
  emit('update-privacy', settings.value)
  originalSettings.value = { ...settings.value }
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
}

// The profile can arrive after mount; the switch stays disabled until it does.
watch(() => props.profile?.id, async (profileId) => {
  if (!profileId) return
  const { data, error } = await supabase
    .from('profiles')
    .select('manually_approves_followers')
    .eq('id', profileId)
    .maybeSingle()
  if (error) debug.error('Failed to load follow approval:', error)
  else requireFollowApproval.value = data?.manually_approves_followers === true
}, { immediate: true })

// Applied on toggle. The database federates the change and, when approval is
// turned off, accepts the requests still waiting.
const onFollowApprovalChange = async (value: boolean) => {
  const profileId = props.profile?.id
  if (!profileId) return

  followApprovalSaving.value = true
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ manually_approves_followers: value })
      .eq('id', profileId)
    if (error) throw error
  } catch (error: any) {
    debug.error('Failed to save follow approval:', error)
    requireFollowApproval.value = !value
    toast.error(t('activitypub.followApprovalFailed'))
  } finally {
    followApprovalSaving.value = false
  }
}

const unblockUser = async (userId: string) => {
  try {
    const profileId = props.profile?.id
    if (!profileId) return

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', profileId)
      .eq('blocked_user_id', userId)

    if (error) throw error

    blockedUsers.value = blockedUsers.value.filter(user => user.id !== userId)
    activityPubStore.loadBlockingData()
    toast.success('User unblocked')
  } catch (error: any) {
    debug.error('Failed to unblock user:', error)
    toast.error('Failed to unblock user')
  }
}

const unmuteUser = async (userId: string) => {
  try {
    const profileId = props.profile?.id
    if (!profileId) return

    const { error } = await supabase
      .from('user_mutes')
      .delete()
      .eq('muter_id', profileId)
      .eq('muted_user_id', userId)

    if (error) throw error

    mutedUsers.value = mutedUsers.value.filter(user => user.id !== userId)
    activityPubStore.loadBlockingData()
    toast.success('User unmuted')
  } catch (error: any) {
    debug.error('Failed to unmute user:', error)
    toast.error('Failed to unmute user')
  }
}

onMounted(async () => {
  settings.value.stripUrlTrackers = isUrlTrackingStrippingEnabled()

  const profileId = props.profile?.id
  if (profileId && Date.now() - blocksMutesLastFetchedAt > CACHE_TTL_MS) {
    try {
      const { data: blocks, error: blocksError } = await supabase
        .from('user_blocks')
        .select('blocked_user_id')
        .eq('blocker_id', profileId)

      if (!blocksError && blocks && blocks.length > 0) {
        const blockedIds = blocks.map(b => b.blocked_user_id)
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', blockedIds)

        if (profiles) {
          blockedUsers.value = profiles as User[]
        }
      } else {
        blockedUsers.value = []
      }
    } catch (e) {
      debug.error('Failed to load blocked users:', e)
    }

    try {
      const { data: mutes, error: mutesError } = await supabase
        .from('user_mutes')
        .select('muted_user_id')
        .eq('muter_id', profileId)

      if (!mutesError && mutes && mutes.length > 0) {
        const mutedIds = mutes.map(m => m.muted_user_id)
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', mutedIds)

        if (profiles) {
          mutedUsers.value = profiles as User[]
        }
      } else {
        mutedUsers.value = []
      }
    } catch (e) {
      debug.error('Failed to load muted users:', e)
    }

    blocksMutesLastFetchedAt = Date.now()
  }

  // No read for the DM-from-server-members / DM-from-follows toggles:
  // `notification_preferences` has no columns for them and the controls are
  // disabled placeholders.

  originalSettings.value = { ...settings.value }
})
</script>

<style scoped>
.privacy-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--background-quaternary);
}

.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
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
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}



.setting-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 8px 0;
}

.radio-option input[type="radio"] {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-muted);
  border-radius: 50%;
  background-color: transparent;
  cursor: pointer;
}

.radio-option input[type="radio"]:checked {
  border-color: var(--harmony-primary);
  background-color: var(--harmony-primary);
}

.radio-label {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
}

.blocked-users-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.blocked-user-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background-color: var(--surface-inset);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.user-details {
  display: flex;
  flex-direction: column;
}

.user-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.user-username {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.unblock-btn {
  padding: 6px 12px;
  background-color: var(--error);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.15s ease;
}

.unblock-btn:hover {
  background-color: var(--error-hover);
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  font-weight: var(--font-weight-medium);
  font-size: var(--font-size-sm);
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

.btn-primary {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--harmony-primary-hover);
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-hover);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid var(--text-on-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .setting-info {
    margin-right: 0;
  }
}

/* Security Section Styles */
.security-section {
  border-left: 3px solid var(--harmony-primary);
}

.section-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
  vertical-align: middle;
}

@media (max-width: 768px) {
  .btn {
    width: 100%;
  }
}

.export-card {
  margin-bottom: 32px;
}

.setting-description a {
  color: var(--text-link, var(--harmony-primary));
}
</style>