<template>
  <BaseModal
    :show="show"
    :title="t('invite.modal.title')"
    :subtitle="t('invite.modal.subtitle')"
    :icon="InviteIcon"
    compact
    :background-image="modalBanner"
    @close="$emit('close')"
  >
    <div class="invite-modal">
      <div class="server-row">
        <div class="server-icon" aria-hidden="true">
          <img v-if="resolvedIcon && !iconLoadError" :src="resolvedIcon" alt="" @error="iconLoadError = true" />
          <span v-else>{{ serverInitial }}</span>
        </div>
        <div class="server-meta">
          <p class="server-name">{{ serverName }}</p>
          <p class="server-members">{{ t('invite.modal.members', { count: memberCount }, memberCount) }}</p>
        </div>
      </div>

      <section class="link-section">
        <label :for="inputId" class="field-label">{{ t('invite.modal.linkLabel') }}</label>
        <div class="link-row">
          <input
            :id="inputId"
            class="link-input"
            readonly
            :value="currentUrl"
            :placeholder="loading || creating ? t('invite.modal.loading') : ''"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button
            type="button"
            class="copy-btn"
            :class="{ copied }"
            :disabled="!currentUrl"
            @click="copyLink"
          >
            <Icon :name="copied ? 'check' : 'copy'" :size="16" />
            {{ copied ? t('invite.modal.copied') : t('invite.modal.copy') }}
          </button>
        </div>
        <span class="sr-only" aria-live="polite">{{ copied ? t('invite.modal.copied') : '' }}</span>

        <div class="link-meta">
          <p class="link-status">
            <template v-if="current">{{ describe(current) }}</template>
            <template v-else-if="!loading && !creating && !canCreate">{{ t('invite.modal.noPermission') }}</template>
            <template v-else-if="!loading && !creating">{{ t('invite.modal.noLink') }}</template>
          </p>
          <div class="link-actions">
            <button v-if="canShare && currentUrl" type="button" class="text-btn" @click="shareLink">
              <Icon name="share" :size="14" />
              {{ t('invite.modal.share') }}
            </button>
            <button
              v-if="canCreate"
              type="button"
              class="text-btn"
              :aria-expanded="editing"
              :aria-controls="settingsId"
              @click="editing = !editing"
            >
              <Icon name="settings" :size="14" />
              {{ t('invite.modal.editLink') }}
            </button>
            <button v-if="current" type="button" class="text-btn danger" @click="revokeLink(current)">
              {{ t('invite.modal.revoke') }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="editing && canCreate" :id="settingsId" class="settings">
        <div class="settings-grid">
          <label class="setting">
            <span class="field-label">{{ t('invite.modal.expireAfter') }}</span>
            <select v-model.number="expiresIn" class="setting-select">
              <option v-for="minutes in expiryChoices" :key="minutes" :value="minutes">
                {{ expiryLabel(minutes) }}
              </option>
            </select>
          </label>
          <label class="setting">
            <span class="field-label">{{ t('invite.modal.maxUses') }}</span>
            <select v-model.number="maxUses" class="setting-select">
              <option v-for="count in maxUseChoices" :key="count" :value="count">
                {{ count === 0 ? t('invite.modal.unlimited') : t('invite.modal.usesOption', { count }, count) }}
              </option>
            </select>
          </label>
        </div>
        <p class="settings-hint">{{ t('invite.modal.newLinkHint') }}</p>
        <button type="button" class="primary-btn" :disabled="creating" @click="createLink">
          {{ creating ? t('invite.modal.creating') : t('invite.modal.newLink') }}
        </button>
      </section>

      <section v-if="otherInvites.length" class="others">
        <h3 class="field-label">{{ t('invite.modal.otherLinks', { count: otherInvites.length }) }}</h3>
        <ul class="other-list">
          <li v-for="invite in otherInvites" :key="invite.id" class="other-row">
            <button type="button" class="other-main" :title="t('invite.modal.showLink')" @click="showInvite(invite)">
              <span class="other-code">{{ invite.code }}</span>
              <span class="other-meta">{{ describe(invite) }}</span>
            </button>
            <button
              type="button"
              class="icon-btn"
              :aria-label="t('invite.modal.revokeCode', { code: invite.code })"
              :title="t('invite.modal.revoke')"
              @click="revokeLink(invite)"
            >
              <Icon name="x" :size="16" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils'
import { durationParts, timeUntil } from '@/utils/inviteLink'
import type { Invite } from '@/services/inviteService'
import { useServerInvites } from '@/composables/useServerInvites'
import { useVisualTheme } from '@/composables/useVisualTheme'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import InviteIcon from '@/components/icons/ServerInviteIcon.vue'

interface Props {
  show: boolean
  serverId?: string
  // A raw `servers` row (icon / banner) or a pre-resolved object (icon_url /
  // banner_url); both normalise through serverUtils.
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

const props = defineProps<Props>()
defineEmits<{ close: [] }>()

const { t, locale } = useI18n()
const toast = useToast()
const visualTheme = useVisualTheme()

const {
  canCreate,
  create,
  creating,
  current,
  currentUrl,
  expiresIn,
  expiryChoices,
  loading,
  maxUseChoices,
  maxUses,
  open,
  otherInvites,
  revoke,
  show: showInvite,
} = useServerInvites(toRef(props, 'serverId'))

const uid = Math.random().toString(36).slice(2, 8)
const inputId = `invite-link-${uid}`
const settingsId = `invite-settings-${uid}`
const editing = ref(false)
const copied = ref(false)
const iconLoadError = ref(false)
const liveMemberCount = ref<number | null>(null)
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const serverName = computed(() => props.serverData?.name || t('invite.modal.thisServer'))
const serverInitial = computed(() => serverName.value.charAt(0).toUpperCase())
const memberCount = computed(() => liveMemberCount.value ?? props.serverData?.member_count ?? 0)

const resolvedIcon = computed(() => {
  const raw = props.serverData?.icon ?? props.serverData?.icon_url ?? null
  return raw ? getServerIconUrl(raw, 96) : null
})

// Appearance setting gates the blurred banner behind the dialog (default on).
const modalBanner = computed(() => {
  if (visualTheme.settings.value.inviteBannerBackground === false) return null
  const raw = props.serverData?.banner ?? props.serverData?.banner_url ?? null
  return raw ? getServerBannerUrl(raw, { width: 960, height: 540 }) : null
})

function expiryLabel(minutes: number): string {
  if (minutes === 0) return t('invite.modal.never')
  const { unit, count } = durationParts(minutes)
  return t(`invite.modal.duration.${unit}`, { count }, count)
}

/** "Expires in 6 days · 2 of 10 uses" for an active invite. */
function describe(invite: Invite): string {
  let expiry = t('invite.modal.neverExpires')
  if (invite.expires_at) {
    const { value, unit } = timeUntil(invite.expires_at)
    const when = new Intl.RelativeTimeFormat(locale.value, { numeric: 'always' }).format(value, unit)
    expiry = t('invite.modal.expires', { when })
  }
  const used = invite.uses ?? 0
  const uses = invite.max_uses
    ? t('invite.modal.usesOf', { used, max: invite.max_uses })
    : t('invite.modal.usesCount', { count: used }, used)
  return `${expiry} · ${uses}`
}

async function copyLink() {
  if (!currentUrl.value) return
  try {
    await navigator.clipboard.writeText(currentUrl.value)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 2000)
  } catch (err) {
    debug.error('Failed to copy invite link:', err)
    toast.error(t('invite.modal.copyFailed'))
  }
}

async function shareLink() {
  try {
    await navigator.share({
      title: t('invite.modal.shareTitle', { server: serverName.value }),
      url: currentUrl.value,
    })
  } catch (err) {
    // AbortError is the user closing the share sheet.
    if ((err as DOMException)?.name !== 'AbortError') debug.warn('Share failed:', err)
  }
}

async function createLink() {
  if (await create()) {
    editing.value = false
    toast.success(t('invite.modal.created'))
  } else {
    toast.error(t('invite.modal.createFailed'))
  }
}

async function revokeLink(invite: Invite) {
  if (await revoke(invite)) toast.success(t('invite.modal.revoked'))
  else toast.error(t('invite.modal.revokeFailed'))
}

// The caller's count is often stale; the RPC is the member count of record.
async function fetchMemberCount() {
  const id = props.serverId || props.serverData?.id
  if (!id) return
  try {
    const { data, error } = await supabase.rpc('get_server_member_counts', { p_server_ids: [id] })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : null
    if (row && (row.server_id === id || !row.server_id)) liveMemberCount.value = Number(row.member_count) || 0
  } catch (err) {
    debug.warn('Failed to fetch server member count:', err)
  }
}

function reset() {
  editing.value = false
  copied.value = false
  iconLoadError.value = false
  liveMemberCount.value = null
  void fetchMemberCount()
  void open()
}

onMounted(() => {
  if (props.show) reset()
})

watch(() => props.show, (visible) => {
  if (visible) reset()
})

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style scoped>
.invite-modal {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.server-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.server-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.server-meta {
  min-width: 0;
}

.server-name,
.server-members {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.server-members {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.field-label {
  display: block;
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.link-row {
  display: flex;
  gap: var(--space-2);
}

.link-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-size-sm);
}

.link-input:focus {
  outline: none;
  border-color: var(--border-focus);
}

.copy-btn,
.primary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--transition-fast);
}

.copy-btn {
  min-width: 104px;
  flex-shrink: 0;
}

.copy-btn:hover:not(:disabled),
.primary-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.copy-btn.copied {
  background: var(--success);
}

.copy-btn:disabled,
.primary-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.link-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1) var(--space-3);
  margin-top: var(--space-2);
}

.link-status {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.link-actions {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}

.text-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 32px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--harmony-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.text-btn:hover {
  background: var(--background-modifier-hover);
}

.text-btn.danger {
  color: var(--error);
}

.settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.setting {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.setting .field-label {
  margin-bottom: var(--space-1);
}

.setting-select {
  height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.setting-select:focus {
  outline: none;
  border-color: var(--border-focus);
}

.settings-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.settings .primary-btn {
  align-self: flex-start;
}

.others .field-label {
  margin-bottom: var(--space-2);
}

.other-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.other-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.other-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.other-main:hover {
  background: var(--background-modifier-hover);
}

.other-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.other-meta {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-btn:hover {
  background: color-mix(in srgb, var(--error) 14%, transparent);
  color: var(--error);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 480px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }

  .settings .primary-btn {
    align-self: stretch;
  }
}
</style>
