<template>
  <section class="hosted-detail" data-testid="hosted-server-detail" :aria-label="server.name">
    <div class="detail-top">
      <button type="button" class="btn btn-ghost btn-sm" data-testid="hosted-server-back" @click="emit('back')">
        <Icon name="arrow-left" :size="14" />{{ t('hostStaff.back') }}
      </button>
    </div>

    <header class="detail-header">
      <img class="detail-icon" :src="getServerIconUrl(server.icon, 96, server.name)" alt="" />
      <div class="detail-title">
        <h3 ref="headingEl" tabindex="-1" class="detail-heading" data-testid="hosted-server-heading">
          {{ server.name }}
          <span v-if="server.suspended_at" class="badge suspended">{{ t('hostStaff.suspendedBadge') }}</span>
        </h3>
        <p class="detail-meta">
          <span>
            {{ t('hostStaff.owner') }}:
            <template v-if="server.owner_id">
              {{ server.owner_display_name || server.owner_username }}
              <span class="muted">@{{ server.owner_username }}</span>
            </template>
            <template v-else>{{ t('hostStaff.noOwner') }}</template>
          </span>
          <span>{{ t('hostStaff.members', { count: server.member_count }, server.member_count) }}</span>
          <span v-if="server.remote_member_count > 0">
            {{ t('hostStaff.remoteMembers', { count: server.remote_member_count }) }}
          </span>
        </p>
        <p v-if="server.suspended_at" class="detail-suspension" data-testid="hosted-server-suspension">
          {{ server.suspended_by_username
            ? t('hostStaff.suspendedBy', { name: server.suspended_by_username })
            : t('hostStaff.suspendedBadge') }}<template v-if="server.suspended_reason"> · {{ t('hostStaff.suspendedReason', { reason: server.suspended_reason }) }}</template>
        </p>
      </div>
      <div class="detail-actions">
        <button
          v-if="server.suspended_at"
          type="button"
          class="btn btn-secondary btn-sm"
          :aria-label="rowAction('hostStaff.actions.unsuspendServer', server.name)"
          @click="emit('act', { kind: 'unsuspend', server })"
        >{{ t('hostStaff.actions.unsuspendServer') }}</button>
        <button
          v-else
          type="button"
          class="btn btn-secondary btn-sm"
          :aria-label="rowAction('hostStaff.actions.suspendServer', server.name)"
          @click="emit('act', { kind: 'suspend', server })"
        >{{ t('hostStaff.actions.suspendServer') }}</button>
        <button
          type="button"
          class="btn btn-danger btn-sm"
          :aria-label="rowAction('hostStaff.actions.deleteServer', server.name)"
          @click="emit('act', { kind: 'delete', server })"
        >{{ t('hostStaff.actions.deleteServer') }}</button>
      </div>
    </header>

    <div class="detail-tabs" role="tablist">
      <button
        v-for="key in (['members', 'messages'] as const)"
        :id="`${uid}-tab-${key}`"
        :key="key"
        type="button"
        role="tab"
        :aria-selected="tab === key"
        :aria-controls="`${uid}-panel-${key}`"
        :class="['detail-tab', { active: tab === key }]"
        @click="tab = key"
      >{{ t(`hostStaff.tabs.${key}`) }}</button>
    </div>

    <!-- Members -->
    <div
      v-if="tab === 'members'"
      :id="`${uid}-panel-members`"
      role="tabpanel"
      :aria-labelledby="`${uid}-tab-members`"
      class="detail-panel"
    >
      <input
        v-model="memberSearch"
        type="search"
        class="cyber-input"
        :placeholder="t('hostStaff.membersSearchHint')"
        :aria-label="t('hostStaff.membersSearch')"
      />
      <p v-if="membersError" class="detail-error" role="alert">{{ membersError }}</p>
      <p v-else-if="!membersLoading && members.length === 0" class="detail-empty">{{ t('hostStaff.noMembers') }}</p>
      <ul class="detail-list">
        <li v-for="member in members" :key="member.user_id" class="detail-row" data-testid="hosted-member-row">
          <Avatar :src="member.avatar_url" :alt="memberName(member)" size="sm" />
          <div class="row-main">
            <div class="row-name">
              <span>{{ memberName(member) }}</span>
              <span class="muted">{{ memberHandle(member) }}</span>
              <span v-if="member.is_owner" class="badge owner">{{ t('hostStaff.ownerBadge') }}</span>
              <span v-if="member.is_instance_staff" class="badge admin">{{ t('hostStaff.instanceStaffBadge') }}</span>
              <span v-if="member.status === 'pending'" class="badge inactive">{{ t('hostStaff.pending') }}</span>
            </div>
          </div>
          <div class="row-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-label="rowAction('hostStaff.viewMessages', memberLabel(member))"
              @click="showMessagesBy(member)"
            >{{ t('hostStaff.viewMessages') }}</button>
            <template v-if="canAct(member)">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                data-testid="hosted-member-remove"
                :aria-label="rowAction('hostStaff.actions.removeMember', memberLabel(member))"
                @click="emit('act', { kind: 'remove', server, member })"
              >{{ t('hostStaff.actions.removeMember') }}</button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                data-testid="hosted-member-ban"
                :aria-label="rowAction('hostStaff.actions.banMember', memberLabel(member))"
                @click="emit('act', { kind: 'ban', server, member })"
              >{{ t('hostStaff.actions.banMember') }}</button>
            </template>
          </div>
        </li>
      </ul>
      <div v-if="membersLoading" class="detail-loading"><LoadingSpinner :size="18" /></div>
      <button
        v-else-if="members.length < membersTotal"
        type="button"
        class="btn btn-secondary btn-sm detail-more"
        @click="loadMembers(false)"
      >{{ t('hostStaff.loadMore') }}</button>
    </div>

    <!-- Messages -->
    <div
      v-else
      :id="`${uid}-panel-messages`"
      role="tabpanel"
      :aria-labelledby="`${uid}-tab-messages`"
      class="detail-panel"
    >
      <div class="message-filters">
        <label class="filter-field">
          <span>{{ t('hostStaff.channel') }}</span>
          <select v-model="channelId" class="cyber-select" data-testid="hosted-channel-select">
            <option v-if="author" :value="null">{{ t('hostStaff.allChannels') }}</option>
            <option v-for="channel in channels" :key="channel.id" :value="channel.id">
              #{{ channel.name }}<template v-if="channel.category_name"> ({{ channel.category_name }})</template>
            </option>
          </select>
        </label>
        <span v-if="author" class="author-chip">
          {{ t('hostStaff.byAuthor', { name: memberName(author) }) }}
          <button type="button" class="chip-clear" :aria-label="t('hostStaff.clearAuthor')" :title="t('hostStaff.clearAuthor')" @click="clearAuthor">
            <Icon name="x" :size="12" />
          </button>
        </span>
      </div>

      <p v-if="messagesError" class="detail-error" role="alert">{{ messagesError }}</p>
      <p v-else-if="!messagesLoading && messages.length === 0" class="detail-empty">{{ t('hostStaff.noMessages') }}</p>
      <ul class="detail-list">
        <li v-for="message in messages" :key="message.id" class="detail-row message-row" data-testid="hosted-message-row">
          <Avatar :src="message.author_avatar_url" :alt="message.author_display_name || message.author_username || ''" size="sm" />
          <div class="row-main">
            <div class="row-name">
              <span>{{ message.author_display_name || message.author_username }}</span>
              <span class="muted">{{ messageHandle(message) }}</span>
              <span class="muted">· #{{ message.channel_name }}</span>
              <time class="muted" :datetime="message.created_at">· {{ formatDateTime(message.created_at) }}</time>
            </div>
            <p v-if="message.encrypted" class="row-text muted">{{ t('hostStaff.encrypted') }}</p>
            <p v-else class="row-text">{{ previewOf(message) }}</p>
          </div>
          <div class="row-actions">
            <button
              type="button"
              class="btn btn-danger btn-sm"
              data-testid="hosted-message-remove"
              :aria-label="rowAction('hostStaff.actions.removeMessage', messageLabel(message))"
              @click="emit('act', { kind: 'message', server, message })"
            >{{ t('hostStaff.actions.removeMessage') }}</button>
          </div>
        </li>
      </ul>
      <div v-if="messagesLoading" class="detail-loading"><LoadingSpinner :size="18" /></div>
      <button
        v-else-if="messagesMore"
        type="button"
        class="btn btn-secondary btn-sm detail-more"
        @click="loadMessages(false)"
      >{{ t('hostStaff.loadMore') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, useId, watch } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useT } from '@/composables/useT'
import { useProfileStore } from '@/stores/useProfile'
import { getServerIconUrl } from '@/utils/serverUtils'
import { messagePartsToPlainText } from '@/utils/messageContentUtils'
import { debug } from '@/utils/debug'
import { staffMayActOn } from '@/utils/instanceStaff'
import {
  listServerChannels,
  listServerMembers,
  listServerMessages,
  STAFF_MESSAGE_PAGE_SIZE,
  type HostedServer,
  type HostedServerChannel,
  type HostedServerMember,
  type HostedServerMessage,
} from '@/services/HostedServerStaffService'
import { memberHandle, memberName, type StaffAction } from './hostedServerStaff'

const props = defineProps<{
  server: HostedServer
  instance: string
  /** Bumped after an action: lists reload. */
  refreshKey: number
}>()

const emit = defineEmits<{
  back: []
  act: [action: StaffAction]
}>()

const { t, locale } = useT()
const uid = `hosted-${useId()}`
const profileStore = useProfileStore()

const tab = ref<'members' | 'messages'>('members')
const headingEl = ref<HTMLElement | null>(null)

// Visible text first, then what the row is about: "Remove member: Alice (@alice)".
function rowAction(actionKey: string, target: string): string {
  return t('hostStaff.rowAction', { action: t(actionKey), target })
}

function memberLabel(member: HostedServerMember): string {
  const handle = memberHandle(member)
  return handle ? `${memberName(member)} (${handle})` : memberName(member)
}

function messageLabel(message: HostedServerMessage): string {
  const author = message.author_display_name || message.author_username || ''
  return [author, `#${message.channel_name}`, formatDateTime(message.created_at)].filter(Boolean).join(', ')
}

defineExpose({ focusHeading: () => headingEl.value?.focus() })

// Members ------------------------------------------------------------------------------------

const members = ref<HostedServerMember[]>([])
const membersTotal = ref(0)
const membersLoading = ref(false)
const membersError = ref('')
const memberSearch = ref('')
let membersSeq = 0

async function loadMembers(reset: boolean) {
  const seq = ++membersSeq
  membersLoading.value = true
  membersError.value = ''
  try {
    const page = await listServerMembers(props.server.id, {
      search: memberSearch.value,
      offset: reset ? 0 : members.value.length,
    })
    if (seq !== membersSeq) return
    members.value = reset ? page.rows : [...members.value, ...page.rows]
    membersTotal.value = page.total
  } catch (error) {
    if (seq !== membersSeq) return
    debug.error('Failed to load members:', error)
    membersError.value = t('hostStaff.loadError')
  } finally {
    if (seq === membersSeq) membersLoading.value = false
  }
}

let memberSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(memberSearch, () => {
  if (memberSearchTimer) clearTimeout(memberSearchTimer)
  memberSearchTimer = setTimeout(() => { void loadMembers(true) }, 300)
})

// The owner is not removed (the server is suspended or deleted instead).
function canAct(member: HostedServerMember): boolean {
  if (member.is_owner || member.user_id === profileStore.profile?.id) return false
  return staffMayActOn(profileStore.profile, member.is_instance_staff)
}

// Messages -----------------------------------------------------------------------------------

const channels = ref<HostedServerChannel[]>([])
const channelId = ref<string | null>(null)
const author = ref<HostedServerMember | null>(null)
const messages = ref<HostedServerMessage[]>([])
const messagesLoading = ref(false)
const messagesError = ref('')
const messagesMore = ref(false)
let messagesSeq = 0

async function loadChannels() {
  try {
    channels.value = await listServerChannels(props.server.id)
    if (!channelId.value && !author.value) {
      channelId.value = (channels.value.find(c => c.type === 0) ?? channels.value[0])?.id ?? null
    }
  } catch (error) {
    debug.error('Failed to load channels:', error)
    messagesError.value = t('hostStaff.loadError')
  }
}

async function loadMessages(reset: boolean) {
  if (!channelId.value && !author.value) {
    messages.value = []
    messagesMore.value = false
    return
  }
  const seq = ++messagesSeq
  messagesLoading.value = true
  messagesError.value = ''
  try {
    const before = reset ? null : messages.value[messages.value.length - 1]?.created_at ?? null
    const rows = await listServerMessages(props.server.id, {
      channelId: channelId.value,
      authorId: author.value?.user_id ?? null,
      before,
    })
    if (seq !== messagesSeq) return
    messages.value = reset ? rows : [...messages.value, ...rows]
    messagesMore.value = rows.length === STAFF_MESSAGE_PAGE_SIZE
  } catch (error) {
    if (seq !== messagesSeq) return
    debug.error('Failed to load messages:', error)
    messagesError.value = t('hostStaff.loadError')
  } finally {
    if (seq === messagesSeq) messagesLoading.value = false
  }
}

function showMessagesBy(member: HostedServerMember) {
  author.value = member
  channelId.value = null
  tab.value = 'messages'
}

function clearAuthor() {
  author.value = null
  if (!channelId.value) channelId.value = (channels.value.find(c => c.type === 0) ?? channels.value[0])?.id ?? null
  void loadMessages(true)
}

watch(channelId, () => {
  if (tab.value === 'messages') void loadMessages(true)
})

watch(tab, async (value) => {
  if (value !== 'messages') return
  if (channels.value.length === 0) await loadChannels()
  void loadMessages(true)
})

function previewOf(message: HostedServerMessage): string {
  if (typeof message.content === 'string') return message.content
  return Array.isArray(message.content) ? messagePartsToPlainText(message.content as any) : ''
}

function messageHandle(message: HostedServerMessage): string {
  if (!message.author_username) return ''
  const local = !message.author_domain || message.author_domain === props.instance
  return local ? `@${message.author_username}` : `@${message.author_username}@${message.author_domain}`
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

watch(() => props.refreshKey, () => {
  void loadMembers(true)
  if (tab.value === 'messages') void loadMessages(true)
})

watch(() => props.server.id, () => {
  author.value = null
  channelId.value = null
  channels.value = []
  messages.value = []
  tab.value = 'members'
  void loadMembers(true)
})

onMounted(() => { void loadMembers(true) })
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.hosted-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 24px 24px;
}

.detail-top .btn {
  gap: 6px;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
}

.detail-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  object-fit: cover;
  flex-shrink: 0;
}

.detail-title {
  flex: 1;
  min-width: 200px;
}

.detail-title h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  overflow-wrap: anywhere;
}

/* Focused on open, by script only. */
.detail-heading:focus {
  outline: none;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.detail-suspension {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--warning);
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.detail-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
}

.detail-tab {
  padding: 8px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.detail-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--harmony-primary);
}

.detail-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.message-row {
  align-items: flex-start;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.row-text {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.muted {
  color: var(--text-muted);
  font-weight: 400;
}

.message-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 220px;
}

.author-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-radius: 999px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  font-size: 13px;
}

.chip-clear {
  display: inline-flex;
  padding: 2px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.chip-clear:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.detail-empty,
.detail-error {
  margin: 0;
  padding: 8px 0;
  font-size: 14px;
  color: var(--text-muted);
}

.detail-error {
  color: var(--text-danger);
}

.detail-loading {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.detail-more {
  align-self: center;
}

@media (max-width: 640px) {
  .hosted-detail {
    padding: 12px 16px 16px;
  }

  .detail-row {
    flex-wrap: wrap;
  }

  .row-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
