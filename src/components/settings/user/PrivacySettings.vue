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
          <h4 class="setting-label" :id="`${a11yId}-t1`">{{ $t('activitypub.followApprovalLabel') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t1-desc`">{{ $t('activitypub.followApprovalDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t1`" :describedby="`${a11yId}-t1-desc`"
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
          <h4 class="setting-label" :id="`${a11yId}-t2`">Strip tracking parameters from URLs</h4>
          <p class="setting-description" :id="`${a11yId}-t2-desc`">
            Automatically remove tracking parameters (like ?si=...) from URLs in your messages for YouTube, X/Twitter, TikTok, Instagram, and Facebook.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t2`" :describedby="`${a11yId}-t2-desc`"
            v-model="stripUrlTrackers"
            data-testid="strip-url-trackers-toggle"
            @change="onUrlStripChange"
          />
        </div>
      </div>

    </div>

    <div class="settings-section" data-testid="outside-link-settings">
      <h3 class="section-title">{{ $t('outsideLink.settings.title') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t3`">{{ $t('outsideLink.settings.askEvery') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t3-desc`">{{ $t('outsideLink.settings.askEveryDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t3`" :describedby="`${a11yId}-t3-desc`"
            :model-value="outsideLinks.askEveryLink"
            :disabled="!outsideLinks.signedIn"
            data-testid="ask-every-link-toggle"
            @change="onAskEveryLinkChange"
          />
        </div>
      </div>

      <h4 class="setting-label trusted-sites-title" :id="`${a11yId}-trusted`">{{ $t('outsideLink.settings.trusted') }}</h4>
      <p class="setting-description">{{ $t('outsideLink.settings.trustedDescription') }}</p>
      <p v-if="outsideLinks.hostList.length === 0" class="setting-description trusted-sites-empty" data-testid="trusted-sites-empty">
        {{ $t('outsideLink.settings.trustedEmpty') }}
      </p>
      <ul v-else class="blocked-users-list trusted-sites-list" :aria-labelledby="`${a11yId}-trusted`" data-testid="trusted-sites">
        <li v-for="host in outsideLinks.hostList" :key="host" class="blocked-user-item">
          <span class="user-name trusted-host" dir="ltr" translate="no">{{ host }}</span>
          <button
            type="button"
            class="unblock-btn"
            :aria-label="$t('outsideLink.settings.removeLabel', { host })"
            @click="untrustHost(host)"
          >
            {{ $t('outsideLink.settings.remove') }}
          </button>
        </li>
      </ul>
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

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import type { User } from '@/types'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import { isUrlTrackingStrippingEnabled, setUrlTrackingStrippingEnabled } from '@/utils/urlTrackerStripper'
import { useOutsideLinkSettingsStore } from '@/stores/outsideLinkSettings'

// Components
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import EncryptionSettings from '@/components/encryption/EncryptionSettings.vue'
import DataExportPanel from './DataExportPanel.vue'

import { uid } from '@/utils/a11y/focus'

// Ids pairing each switch with its visible label.
const a11yId = uid('privacy-settings')

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Composables
const toast = useToast()
const { t } = useI18n()

// Every switch here applies as it is flipped and confirms with a toast, as
// Notifications does; the section has no Save or Reset.
const stripUrlTrackers = ref(true)
const requireFollowApproval = ref(false)
const followApprovalSaving = ref(false)
const blockedUsers = ref<User[]>([])
const mutedUsers = ref<User[]>([])
const activityPubStore = useActivityPubStore()
let blocksMutesLastFetchedAt = 0
const CACHE_TTL_MS = 30000

// The URL-tracker flag lives in localStorage and is read by the message-send
// pipeline (`unifiedContentProcessing.ts`) on every send.
const onUrlStripChange = () => {
  setUrlTrackingStrippingEnabled(stripUrlTrackers.value)
  toast.success(t('settings.toasts.privacyUpdated'))
}

// Outside links (stores/outsideLinkSettings): saved per account as they change.
const outsideLinks = useOutsideLinkSettingsStore()

const onAskEveryLinkChange = async (value: boolean) => {
  try {
    await outsideLinks.setAskEveryLink(value)
    toast.success(t('settings.toasts.privacyUpdated'))
  } catch (error) {
    debug.error('Failed to save ask-every-link:', error)
    toast.error(t('outsideLink.settings.saveFailed'))
  }
}

const untrustHost = async (host: string) => {
  try {
    await outsideLinks.untrust(host)
  } catch (error) {
    debug.error('Failed to remove trusted host:', error)
    toast.error(t('outsideLink.settings.saveFailed'))
  }
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
    toast.success(t('settings.toasts.privacyUpdated'))
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
  stripUrlTrackers.value = isUrlTrackingStrippingEnabled()
  // Another device may have trusted a host since this one loaded.
  void outsideLinks.reload()

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

.trusted-sites-title {
  margin-top: 20px;
}

.trusted-sites-list {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.trusted-host {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.trusted-sites-empty {
  margin-top: 8px;
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
  background-color: var(--error-fill);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.15s ease;
}

.unblock-btn:hover {
  background-color: var(--error-fill-hover);
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

.export-card {
  margin-bottom: 32px;
}

.setting-description a {
  color: var(--text-link, var(--harmony-primary));
  text-decoration: underline;
}
</style>