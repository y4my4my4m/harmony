<template>
  <BaseModal
    :show="show"
    @close="$emit('close')"
    title="Invite People"
    subtitle="Share this server with anyone you'd like to bring in"
    :icon="InviteIcon"
    :compact="false"
    :background-image="modalBanner"
  >
    <div class="invite-modal-content">
      <!-- Invite Link Section -->
      <div class="invite-section">
        <div class="section-header">
          <h3 class="section-title">Server Invite Link</h3>
          <p class="section-description">
            Send this link to anyone you'd like to invite to your server
          </p>
        </div>

        <div class="invite-link-container">
          <div class="invite-link-wrapper" :class="{ 'link-copied': linkCopied }">
            <div
              class="invite-preview"
              :class="{ 'has-banner': !!resolvedBanner }"
              :style="resolvedBanner ? { backgroundImage: `url(${resolvedBanner})` } : undefined"
            >
              <div v-if="resolvedBanner" class="invite-preview-overlay"></div>
              <div class="invite-preview-content">
                <div class="server-icon">
                  <img
                    v-if="resolvedIcon && !iconLoadError"
                    :src="resolvedIcon"
                    :alt="props.serverData?.name || 'Server icon'"
                    class="server-image"
                    @error="iconLoadError = true"
                  />
                  <div v-else class="default-server-icon">
                    {{ serverInitial }}
                  </div>
                </div>
                <div class="server-info">
                  <h4 class="server-name">{{ props.serverData?.name || 'Server' }}</h4>
                  <p class="member-count">{{ resolvedMemberCount }} {{ resolvedMemberCount === 1 ? 'member' : 'members' }}</p>
                </div>
              </div>
            </div>
            
            <div class="invite-link-input-container">
              <div class="invite-url-display">
                <input 
                  ref="inviteInput"
                  :value="inviteUrl" 
                  readonly 
                  class="invite-url-input"
                  :class="{ 'url-copied': linkCopied }"
                />
                <button 
                  @click="copyInviteLink" 
                  class="copy-button"
                  :class="{ 'copied': linkCopied }"
                  :disabled="!inviteUrl || isGenerating"
                >
                  <svg v-if="!linkCopied" viewBox="0 0 24 24" class="copy-icon">
                    <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
                  </svg>
                  <svg v-else viewBox="0 0 24 24" class="check-icon">
                    <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
                  </svg>
                  {{ linkCopied ? 'Copied!' : 'Copy' }}
                </button>
              </div>
            </div>
          </div>

          <!-- Link Settings -->
          <div class="link-settings">
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Expires after</span>
                <span class="setting-description">How long the invite link will be valid</span>
              </div>
              <select v-model="expirationTime" class="setting-select">
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="360">6 hours</option>
                <option value="720">12 hours</option>
                <option value="1440">1 day</option>
                <option value="10080">7 days</option>
                <option value="0">Never</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max uses</span>
                <span class="setting-description">How many times this link can be used</span>
              </div>
              <select v-model="maxUses" class="setting-select">
                <option value="1">1 use</option>
                <option value="5">5 uses</option>
                <option value="10">10 uses</option>
                <option value="25">25 uses</option>
                <option value="50">50 uses</option>
                <option value="100">100 uses</option>
                <option value="0">No limit</option>
              </select>
            </div>
            <p class="settings-hint">Settings apply when you generate a new link.</p>
          </div>

          <!-- Generate New Link -->
          <!-- Permission Error Message -->
          <div v-if="permissionError" class="permission-error">
            <svg viewBox="0 0 24 24" class="error-icon">
              <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
            </svg>
            <span>{{ permissionError }}</span>
          </div>

          <div v-if="canCreateInvites" class="generate-section">
            <button 
              @click="generateNewLink" 
              class="generate-button"
              :disabled="isGenerating"
            >
              <svg viewBox="0 0 24 24" class="refresh-icon" :class="{ spinning: isGenerating }">
                <path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" fill="currentColor"/>
              </svg>
              {{ isGenerating ? 'Generating...' : 'Generate New Link' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Invite History -->
      <div v-if="inviteHistory.length > 0" class="invite-history-section">
        <div class="section-header">
          <h3 class="section-title">Recent Invites</h3>
          <p class="section-description">Your recently created invite links</p>
        </div>

        <div class="invite-history-list">
          <div 
            v-for="invite in inviteHistory" 
            :key="invite.id"
            class="history-item"
            :class="{ 'expired': isInviteExpired(invite), 'used-up': isInviteUsedUp(invite) }"
          >
            <div class="history-info">
              <div class="history-url">{{ formatInviteUrl(invite.code) }}</div>
              <div class="history-details">
                <span class="history-stat">{{ invite.uses || 0 }}/{{ invite.max_uses || '∞' }} uses</span>
                <span class="history-separator">•</span>
                <span class="history-stat">
                  {{ formatTimeRemaining(invite.expires_at) }}
                </span>
              </div>
            </div>
            <div class="history-actions">
              <button 
                @click="copyHistoryLink(invite)" 
                class="history-copy-btn"
                :disabled="isInviteExpired(invite) || isInviteUsedUp(invite)"
              >
                <svg viewBox="0 0 24 24" class="copy-icon-small">
                  <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
                </svg>
              </button>
              <button 
                @click="revokeInviteLink(invite)" 
                class="history-revoke-btn"
                :disabled="isInviteExpired(invite)"
              >
                <svg viewBox="0 0 24 24" class="revoke-icon">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Share Options -->
      <div class="quick-share-section">
        <div class="section-header">
          <h3 class="section-title">Quick Share</h3>
          <p class="section-description">Share directly to your favorite platforms</p>
        </div>

        <div class="share-buttons">
          <button @click="shareToClipboard" class="share-button">
            <svg viewBox="0 0 24 24" class="share-icon">
              <path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.6 20.92,19A2.84,2.84 0 0,0 18,16.08Z" fill="currentColor"/>
            </svg>
            Copy Link
          </button>

          <button @click="shareToEmail" class="share-button">
            <svg viewBox="0 0 24 24" class="share-icon">
              <path d="M20,8L12,13L4,8V6L12,11L20,6M20,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6C22,4.89 21.1,4 20,4Z" fill="currentColor"/>
            </svg>
            Email
          </button>

          <button @click="shareToSocial('twitter')" class="share-button">
            <svg viewBox="0 0 24 24" class="share-icon">
              <path d="M22.46,6C21.69,6.35 20.86,6.58 20,6.69C20.88,6.16 21.56,5.32 21.88,4.31C21.05,4.81 20.13,5.16 19.16,5.36C18.37,4.5 17.26,4 16,4C13.65,4 11.73,5.92 11.73,8.29C11.73,8.63 11.77,8.96 11.84,9.27C8.28,9.09 5.11,7.38 3,4.79C2.63,5.42 2.42,6.16 2.42,6.94C2.42,8.43 3.17,9.75 4.33,10.5C3.62,10.5 2.96,10.3 2.38,10C2.38,10 2.38,10 2.38,10.03C2.38,12.11 3.86,13.85 5.82,14.24C5.46,14.34 5.08,14.39 4.69,14.39C4.42,14.39 4.15,14.36 3.89,14.31C4.43,16 6,17.26 7.89,17.29C6.43,18.45 4.58,19.13 2.56,19.13C2.22,19.13 1.88,19.11 1.54,19.07C3.44,20.29 5.7,21 8.12,21C16,21 20.33,14.46 20.33,8.79C20.33,8.6 20.33,8.42 20.32,8.23C21.16,7.63 21.88,6.87 22.46,6Z" fill="currentColor"/>
            </svg>
            Twitter
          </button>

          <button @click="shareToSocial('facebook')" class="share-button">
            <svg viewBox="0 0 24 24" class="share-icon">
              <path d="M24,12.073C24,5.405 18.627,0 12,0S0,5.405 0,12.073C0,18.1 4.388,23.094 10.125,24V15.563H7.078V12.073H10.125V9.404C10.125,6.369 11.917,4.715 14.658,4.715C15.97,4.715 17.344,4.953 17.344,4.953V7.928H15.83C14.34,7.928 13.875,8.814 13.875,9.728V12.073H17.203L16.671,15.563H13.875V24C19.612,23.094 24,18.1 24,12.073Z" fill="currentColor"/>
            </svg>
            Facebook
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer-content">
        <button @click="$emit('close')" class="footer-button secondary">
          Close
        </button>
        <button @click="copyInviteLink" class="footer-button primary" :disabled="!inviteUrl">
          <svg viewBox="0 0 24 24" class="footer-btn-icon">
            <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
          </svg>
          Copy Invite Link
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { generateInviteUrl, getInviteHistory, revokeInvite, type Invite, type InviteOptions } from '@/services/inviteService'
import { getInviteConstraints } from '@/services/permissionsService'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils'
import { useVisualTheme } from '@/composables/useVisualTheme'
import BaseModal from '@/components/common/BaseModal.vue'
import InviteIcon from '@/components/icons/ServerInviteIcon.vue'

interface Props {
  show: boolean
  serverId?: string
  // Accepts a raw `servers` row (icon / banner columns) OR a pre-resolved object
  // with `icon_url` / `banner_url`. Whichever the caller provides, the modal
  // normalizes via the server-utils helpers below.
  serverData?: {
    id: string
    name: string
    icon?: string | null
    icon_url?: string | null
    banner?: string | null
    banner_url?: string | null
    description?: string | null
    member_count?: number
  }
}

// Invite interface is now imported from the service

const props = defineProps<Props>()
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  close: []
}>()

const toast = useToast()
const authStore = useAuthStore()

// Reactive state
const inviteUrl = ref('')
const linkCopied = ref(false)
const isGenerating = ref(false)
const expirationTime = ref(0) // minutes; 0 = never expires
const maxUses = ref(0) // 0 = no limit
const inviteHistory = ref<Invite[]>([])
const inviteInput = ref<HTMLInputElement>()
const canCreateInvites = ref(true) // Start with true, will be updated by constraints
const inviteConstraints = ref({
  canCreate: true,
  maxExpiration: 0,
  allowTemporary: true,
  maxUses: 0,
  defaultExpiration: 1440
})
const permissionError = ref('')

// Image fallbacks
const iconLoadError = ref(false)
// Member count fetched live from the server (the RPC truth) - falls back to
// whatever the caller passed in via serverData.member_count.
const liveMemberCount = ref<number | null>(null)

// Computed
const serverInitial = computed(() => {
  return props.serverData?.name?.charAt(0).toUpperCase() || 'S'
})

const resolvedIcon = computed(() => {
  const raw = props.serverData?.icon ?? props.serverData?.icon_url ?? null
  return raw ? getServerIconUrl(raw, 96) : null
})

const resolvedBanner = computed(() => {
  const raw = props.serverData?.banner ?? props.serverData?.banner_url ?? null
  return raw ? getServerBannerUrl(raw, { width: 480, height: 140 }) : null
})

// Appearance setting gates the full-modal banner backdrop (default on)
const visualTheme = useVisualTheme()
const modalBanner = computed(() => {
  if (visualTheme.settings.value.inviteBannerBackground === false) return null
  const raw = props.serverData?.banner ?? props.serverData?.banner_url ?? null
  return raw ? getServerBannerUrl(raw, { width: 960, height: 540 }) : null
})

const resolvedMemberCount = computed(() => {
  if (typeof liveMemberCount.value === 'number') return liveMemberCount.value
  return props.serverData?.member_count || 0
})

// Pull the canonical member count from the RPC every time the modal opens.
// The caller's count (Object.keys(userProfiles).length) is usually stale or 0.
const fetchMemberCount = async () => {
  const id = props.serverId || props.serverData?.id
  if (!id) return
  try {
    const { data, error } = await supabase.rpc('get_server_member_counts', {
      p_server_ids: [id],
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : null
    if (row && (row.server_id === id || !row.server_id)) {
      liveMemberCount.value = Number(row.member_count) || 0
    }
  } catch (err) {
    debug.warn('Failed to fetch server member count:', err)
  }
}

// Methods
const generateInvite = async () => {
  if (!props.serverId || !authStore.session?.user?.id) return

  isGenerating.value = true
  permissionError.value = ''
  
  try {
    const options: InviteOptions = {
      expiresIn: expirationTime.value,
      maxUses: maxUses.value,
    }
    
    const result = await generateInviteUrl(props.serverId, authStore.session.user.id, options)
    
    if (result.success && result.url) {
      inviteUrl.value = result.url
      await loadInviteHistory()
    } else {
      permissionError.value = result.error || 'Failed to generate invite link'
      toast.error(result.error || 'Failed to generate invite link')
    }
  } catch (error) {
    debug.error('Error generating invite:', error)
    const errorMsg = 'Failed to generate invite link'
    permissionError.value = errorMsg
    toast.error(errorMsg)
  } finally {
    isGenerating.value = false
  }
}

const generateNewLink = async () => {
  await generateInvite()
  toast.success('New invite link generated!')
}

const copyInviteLink = async () => {
  if (!inviteUrl.value) return

  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    linkCopied.value = true
    toast.success('Invite link copied to clipboard!')
    
    setTimeout(() => {
      linkCopied.value = false
    }, 3000)
  } catch (error) {
    debug.error('Failed to copy invite link:', error)
    toast.error('Failed to copy invite link')
  }
}

const formatInviteUrl = (code: string) => {
  const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin
  return `${baseUrl}/invite/${code}`
}

const formatTimeRemaining = (expiresAt: string | null) => {
  if (!expiresAt) return 'Never expires'
  
  const now = new Date()
  const expires = new Date(expiresAt)
  const diff = expires.getTime() - now.getTime()
  
  if (diff <= 0) return 'Expired'
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const isInviteExpired = (invite: Invite) => {
  if (!invite.expires_at) return false
  return new Date(invite.expires_at) <= new Date()
}

const isInviteUsedUp = (invite: Invite) => {
  if (!invite.max_uses) return false
  return invite.uses >= invite.max_uses
}

const copyHistoryLink = async (invite: Invite) => {
  const url = formatInviteUrl(invite.code)
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Invite link copied!')
  } catch (error) {
    toast.error('Failed to copy link')
  }
}

const revokeInviteLink = async (invite: Invite) => {
  if (!authStore.session?.user?.id) return
  
  try {
    const success = await revokeInvite(invite.id, authStore.session.user.id)
    if (success) {
      await loadInviteHistory()
      toast.success('Invite revoked')
    } else {
      toast.error('Failed to revoke invite')
    }
  } catch (error) {
    debug.error('Error revoking invite:', error)
    toast.error('Failed to revoke invite')
  }
}

const shareToClipboard = () => {
  copyInviteLink()
}

const shareToEmail = () => {
  const subject = encodeURIComponent(`Join ${props.serverData?.name || 'our server'}!`)
  const body = encodeURIComponent(`Hey! You're invited to join "${props.serverData?.name || 'our server'}" on Harmony. Click this link to join: ${inviteUrl.value}`)
  window.open(`mailto:?subject=${subject}&body=${body}`)
}

const shareToSocial = (platform: string) => {
  const text = encodeURIComponent(`Join "${props.serverData?.name || 'our server'}" on Harmony!`)
  const url = encodeURIComponent(inviteUrl.value)
  
  let shareUrl = ''
  
  switch (platform) {
    case '𝕏':
      shareUrl = `https://x.com/intent/tweet?text=${text}&url=${url}`
      break
    case 'facebook':
      shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${url}`
      break
  }
  
  if (shareUrl) {
    window.open(shareUrl, '_blank', 'width=600,height=400')
  }
}

const loadInviteConstraints = async () => {
  if (!props.serverId || !authStore.session?.user?.id) return

  try {
    const constraints = await getInviteConstraints(authStore.session.user.id, props.serverId)
    inviteConstraints.value = constraints
    canCreateInvites.value = constraints.canCreate

    // default to Never unless the server caps invite lifetime
    expirationTime.value = constraints.maxExpiration > 0 ? constraints.defaultExpiration : 0

    if (!constraints.canCreate) {
      permissionError.value = 'You do not have permission to create invites for this server'
    }
  } catch (error) {
    debug.error('Error loading invite constraints:', error)
    // Temporarily allow invite creation even if constraints fail
    canCreateInvites.value = true
    inviteConstraints.value = {
      canCreate: true,
      maxExpiration: 0,
      allowTemporary: true,
      maxUses: 0,
      defaultExpiration: 1440
    }
  }
}

const loadInviteHistory = async () => {
  if (!authStore.session?.user?.id) return
  
  try {
    const history = await getInviteHistory(authStore.session.user.id, props.serverId)
    inviteHistory.value = history
  } catch (error) {
    debug.error('Error loading invite history:', error)
  }
}

// Reuse the newest still-valid invite; only mint a new one when none exists.
// "Generate New Link" is the sole explicit regeneration path.
const initializeInvite = async () => {
  if (!props.serverId) return
  iconLoadError.value = false
  liveMemberCount.value = null
  inviteUrl.value = ''

  await Promise.all([
    loadInviteConstraints(),
    fetchMemberCount(),
    loadInviteHistory(),
  ])

  const reusable = inviteHistory.value.find(
    (invite) => !isInviteExpired(invite) && !isInviteUsedUp(invite)
  )
  if (reusable) {
    inviteUrl.value = formatInviteUrl(reusable.code)
  } else if (canCreateInvites.value) {
    await generateInvite()
  }
}

// Lifecycle
onMounted(() => {
  if (props.show) void initializeInvite()
})

// Watch for modal opening
watch(() => props.show, (visible) => {
  if (visible) void initializeInvite()
})
</script>

<style scoped>
.invite-modal-content {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.invite-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section-header {
  text-align: center;
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.section-description {
  font-size: 14px;
  color: #b5bac1;
  margin: 0;
}

.invite-link-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.invite-link-wrapper {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 20px;
  transition: all 0.3s ease;
}

.invite-link-wrapper.link-copied {
  border-color: #00d166;
  background: rgba(0, 209, 102, 0.05);
}

.invite-preview {
  position: relative;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  overflow: hidden;
}

.invite-preview:not(.has-banner) {
  /* No banner - keep the original flat row layout */
  padding: 0 0 16px 0;
  border-radius: 0;
}

.invite-preview.has-banner {
  /* Banner mode - image sits behind, content overlays */
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  padding: 0;
  border-bottom: none;
  min-height: 140px;
  margin-bottom: 16px;
}

.invite-preview-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.25) 0%,
    rgba(0, 0, 0, 0.55) 60%,
    rgba(0, 0, 0, 0.75) 100%
  );
  pointer-events: none;
}

.invite-preview-content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
}

.invite-preview.has-banner .invite-preview-content {
  padding: 16px;
  /* Push content to the bottom of the banner so the image is visible above it */
  padding-top: 70px;
}

.invite-preview.has-banner .server-name,
.invite-preview.has-banner .member-count {
  color: var(--text-primary);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.server-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}

.server-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.default-server-icon {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.member-count {
  font-size: 14px;
  color: #b5bac1;
  margin: 0;
}

.invite-link-input-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.invite-url-display {
  display: flex;
  gap: 8px;
}

.invite-url-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: 'Fira Code', monospace;
  transition: all 0.2s ease;
}

.invite-url-input.url-copied {
  border-color: #00d166;
  background: rgba(0, 209, 102, 0.05);
}

.invite-url-input:focus {
  outline: none;
  border-color: #0EA5E9;
}

.copy-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.copy-button:hover:not(:disabled) {
  background: #0284C7;
  transform: translateY(-1px);
}

.copy-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.copy-button.copied {
  background: #00d166;
}

.copy-icon,
.check-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.link-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.setting-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.setting-description {
  font-size: 12px;
  color: #b5bac1;
}

.setting-select {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  min-width: 120px;
  /* the control is dark regardless of app theme; without this the UA paints a
     light dropdown and inherits our white text — white on white */
  color-scheme: dark;
}

.setting-select option {
  background-color: var(--background-secondary, #1e1f22);
  color: var(--text-primary, #f2f3f5);
}

.setting-select:focus {
  outline: none;
  border-color: #0EA5E9;
}

.settings-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted, #80848e);
}

.generate-section {
  text-align: center;
}

.generate-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: #b5bac1;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.generate-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.generate-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-icon {
  width: 16px;
  height: 16px;
  transition: transform 0.2s ease;
}

.refresh-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.permission-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(237, 66, 69, 0.1);
  border: 1px solid rgba(237, 66, 69, 0.2);
  border-radius: 8px;
  color: #ed4245;
  font-size: 14px;
  font-weight: 500;
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.setting-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.invite-history-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.invite-history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.history-item.expired {
  opacity: 0.5;
  background: rgba(237, 66, 69, 0.05);
  border-color: rgba(237, 66, 69, 0.2);
}

.history-item.used-up {
  opacity: 0.5;
  background: rgba(255, 165, 0, 0.05);
  border-color: rgba(255, 165, 0, 0.2);
}

.history-info {
  flex: 1;
  min-width: 0;
}

.history-url {
  font-size: 14px;
  color: var(--text-primary);
  font-family: 'Fira Code', monospace;
  margin-bottom: 4px;
  word-break: break-all;
}

.history-details {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #b5bac1;
}

.history-stat {
  display: flex;
  align-items: center;
}

.history-separator {
  color: var(--text-muted);
}

.history-actions {
  display: flex;
  gap: 8px;
}

.history-copy-btn,
.history-revoke-btn {
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #b5bac1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.history-copy-btn:hover:not(:disabled) {
  background: rgba(14, 165, 233, 0.2);
  border-color: #0EA5E9;
  color: #0EA5E9;
}

.history-revoke-btn:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.2);
  border-color: #ed4245;
  color: #ed4245;
}

.history-copy-btn:disabled,
.history-revoke-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.copy-icon-small,
.revoke-icon {
  width: 14px;
  height: 14px;
}

.quick-share-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.share-buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 12px;
}

.share-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  color: #b5bac1;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
}

.share-button:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.share-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.modal-footer-content {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.footer-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  flex: 1;
}

.footer-button.secondary {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.footer-button.secondary:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.footer-button.primary {
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
}

.footer-button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.footer-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.footer-btn-icon {
  width: 16px;
  height: 16px;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .invite-modal-content {
    gap: 24px;
  }
  
  .invite-url-display {
    flex-direction: column;
  }
  
  .copy-button {
    justify-content: center;
  }
  
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  
  .setting-select {
    width: 100%;
  }
  
  .share-buttons {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .modal-footer-content {
    flex-direction: column;
  }
}
</style>