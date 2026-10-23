<template>
  <Icon v-if="type === 'thread_created'" name="thread" :size="16" class="system-icon" />
  <template v-else-if="isCall">
    <div class="system-icon call-icon-container">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="call-system-icon" :class="{ active: type === 'call_started', missed: missedCall }">
        <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" fill="currentColor"/>
      </svg>
    </div>
  </template>
  <Icon v-else-if="type === 'group_created'" name="users" :size="16" class="system-icon" />
  <Icon v-else-if="type === 'member_join'" name="arrow-right" :size="16" class="system-icon join" />
  <Icon v-else-if="type === 'member_leave'" name="arrow-left" :size="16" class="system-icon leave" />
  <Icon v-else-if="type === 'member_kick'" name="user-x" :size="16" class="system-icon leave" />
  <Icon v-else-if="type === 'member_ban'" name="gavel" :size="16" class="system-icon leave" />
  <Icon v-else-if="encryptionKey" :name="type.endsWith('_enabled') ? 'lock' : 'unlock'" :size="16" class="system-icon" />
  <Icon v-else-if="isAutomodAlert" name="shield" :size="16" class="system-icon automod-icon" />
  <Icon v-else name="info" :size="16" class="system-icon" />

  <!-- A known type reads from metadata; content is the text of clients before 1.8.11. -->
  <div
    v-if="sentence"
    class="system-text"
    :class="{ 'thread-created-text': type === 'thread_created', 'call-system-text': isCall }"
    :data-system-type="type"
  >
    <i18n-t :keypath="sentence.key" :plural="sentence.plural" tag="span" scope="global">
      <template #subject>
        <button
          v-if="subject.id"
          type="button"
          class="system-user-mention"
          :style="{ color: userColor(subject.id) }"
          @click="emit('showUserProfile', subject.id)"
        ><DisplayName :user-id="subject.id" /></button>
        <span v-else class="system-user-name">{{ subject.name }}</span>
      </template>
      <template #actor>
        <button
          v-if="actor.id"
          type="button"
          class="system-user-mention"
          :style="{ color: userColor(actor.id) }"
          @click="emit('showUserProfile', actor.id)"
        ><DisplayName :user-id="actor.id" /></button>
        <span v-else class="system-user-name">{{ actor.name }}</span>
        <span v-if="staffInstance" class="system-staff" data-testid="system-staff">{{ ' ' + t('hostStaff.systemActor', { instance: staffInstance }) }}</span>
      </template>
      <template #members>
        <template v-for="(memberId, index) in members" :key="memberId">
          <template v-if="index > 0">{{ t('systemEvents.listSeparator') }}</template>
          <button
            type="button"
            class="system-user-mention"
            :style="{ color: userColor(memberId) }"
            @click="emit('showUserProfile', memberId)"
          ><DisplayName :user-id="memberId" /></button>
        </template>
      </template>
      <template #thread>
        <button
          type="button"
          class="system-thread-link"
          @click="emit('openThread', meta.thread_id, meta.thread_name)"
        >{{ meta.thread_name || t('systemEvents.threadFallbackName') }}</button>
      </template>
      <template #allThreads>
        <button type="button" class="system-threads-link" @click="emit('showAllThreads')">{{ t('systemEvents.allThreads') }}</button>
      </template>
      <template #duration><span class="call-duration">{{ callDuration }}</span></template>
      <template #count>{{ participantCount }}</template>
    </i18n-t>
    <span v-if="reason" class="system-reason">{{ t('systemEvents.reason', { reason }) }}</span>
    <span v-if="missedCall && !missedByMe" class="call-missed">{{ t('systemEvents.noAnswer') }}</span>
    <CallJoinButton
      v-if="type === 'call_started'"
      :message-id="message.id"
      :conversation-id="conversationId"
    />
  </div>

  <!-- AutoMod alert. Only the database writes authorless rows; a client row cannot pose as one. -->
  <div v-else-if="isAutomodAlert" class="system-text automod-alert-text">
    <span class="automod-badge">{{ t('automod.title') }}</span>
    <template v-if="meta.automod?.event_type === 'raid'">
      {{ t('automod.alert.raid', {
        joins: meta.automod?.joins,
        seconds: meta.automod?.window_seconds,
      }) }}
    </template>
    <template v-else>
      {{ t(meta.automod?.actions?.includes('block')
        ? (meta.automod?.event_type === 'edit' ? 'automod.alert.blockedEdit' : 'automod.alert.blocked')
        : 'automod.alert.flagged') }}
      <button
        v-if="meta.automod?.user_id"
        type="button"
        class="system-user-mention"
        :style="{ color: userColor(meta.automod.user_id) }"
        @click="emit('showUserProfile', meta.automod.user_id)"
      ><DisplayName :user-id="meta.automod.user_id" /></button>
      <span
        v-else-if="meta.automod?.author_name"
        class="system-user-mention"
      >{{ meta.automod.author_name }} · Discord</span>
      <span v-else class="system-user-mention">{{ t('automod.alert.aBot') }}</span>
      <span class="automod-rule">{{ meta.automod?.rule_name }}</span>
      <span v-if="meta.automod?.actions?.includes('timeout')" class="automod-timeout">
        {{ t('automod.alert.timedOut') }}
      </span>
      <div v-if="meta.automod?.excerpt" class="automod-alert-excerpt">
        {{ meta.automod.excerpt }}
      </div>
    </template>
  </div>

  <!-- Unknown type: the server's text. -->
  <div v-else class="system-text">
    <UnifiedMessageContent
      :content="message.content"
      :message-id="message.id"
      :is-system="true"
      :embed-payloads="meta.embeds"
      @show-user-profile="(id: string) => emit('showUserProfile', id)"
    />
  </div>
</template>

<script setup lang="ts">
// Body of a system row (messages.is_system): the people it names are metadata ids, never
// the row's author (migration 20261026100001_system_events).
//
//   member_join, member_leave        subject_id
//   member_kick, member_ban          subject_id, actor_id, reason, staff (the actor is instance
//                                    staff of the server's host, 20261027250001)
//   thread_created                   actor_id | actor_bot_id (+ discord_user) | actor_name,
//                                    thread_id, thread_name
//   group_created                    actor_id, event 'created' (participant_count) | 'members_added' (user_ids)
//   call_started, call_ended         actor_id, call_type, participants, duration_seconds
//   channel_(voice_)encryption_*     actor_id
//   automod_alert                    automod
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import CallJoinButton from '@/components/messages/CallJoinButton.vue'
import { useProfileStore } from '@/stores/useProfile'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useT } from '@/composables/useT'
import type { Message } from '@/types/chat'

const props = defineProps<{
  message: Message
  conversationId?: string | null
  /** Display colour of a profile in the rendered room. */
  userColor: (userId: string) => string
  /** Display name of a bot. */
  botName: (botId: string) => string
}>()

const emit = defineEmits<{
  showUserProfile: [userId: string]
  openThread: [threadId: string | undefined, threadName: string | undefined]
  showAllThreads: []
}>()

const { t } = useT()
const profileStore = useProfileStore()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const meta = computed<Record<string, any>>(() => {
  const value = props.message.metadata
  return value && typeof value === 'object' ? value : {}
})
const type = computed<string>(() => (typeof meta.value.type === 'string' ? meta.value.type : ''))

const profileIdOf = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

interface Person {
  id: string | null
  name: string
}

const subject = computed<Person>(() => ({
  id: profileIdOf(meta.value.subject_id),
  name: t('systemEvents.someone'),
}))

// A Discord member relayed by a bridge, a bot, or a name carried from another instance.
const actor = computed<Person>(() => {
  const id = profileIdOf(meta.value.actor_id)
  if (id) return { id, name: '' }
  const discord = meta.value.discord_user
  const discordName = discord?.display_name || discord?.username
  if (typeof discordName === 'string' && discordName) return { id: null, name: discordName }
  const botId = profileIdOf(meta.value.actor_bot_id)
  if (botId) return { id: null, name: props.botName(botId) }
  if (typeof meta.value.actor_name === 'string' && meta.value.actor_name) {
    return { id: null, name: meta.value.actor_name }
  }
  return { id: null, name: t('systemEvents.someone') }
})

const members = computed<string[]>(() =>
  Array.isArray(meta.value.user_ids) ? meta.value.user_ids.filter((id: unknown) => profileIdOf(id)) : [])

// Staff of the instance hosting the server: this one, or a copy's host. Stores are read only
// for a staff notice.
const staffInstance = computed<string>(() => {
  if (meta.value.staff !== true || (type.value !== 'member_kick' && type.value !== 'member_ban')) return ''
  const server = useServerChannelStore().currentServer
  if (server && server.is_local_server === false && server.federation_domain) return server.federation_domain
  return useInstanceSettingsStore().settings.domain
})

const participantCount = computed(() => Number(meta.value.participant_count) || 0)
const reason = computed(() =>
  (type.value === 'member_kick' || type.value === 'member_ban') && typeof meta.value.reason === 'string'
    ? meta.value.reason.trim()
    : '')

const isCall = computed(() => type.value === 'call_started' || type.value === 'call_ended')
const callType = computed(() => (meta.value.call_type === 'video' ? 'video' : 'voice'))
// Nobody answered: the callee reads it as missed, the caller as no answer (Discord).
const missedCall = computed(() =>
  type.value === 'call_ended' && (!Array.isArray(meta.value.participants) || meta.value.participants.length < 2))
const missedByMe = computed(() => missedCall.value && actor.value.id !== profileStore.profile?.id)

const callDuration = computed(() => {
  const seconds = Math.max(0, Math.floor(Number(meta.value.duration_seconds) || 0))
  if (seconds < 60) return t('systemEvents.duration.seconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const s = seconds % 60
    return s > 0 ? t('systemEvents.duration.minutesSeconds', { m: minutes, s }) : t('systemEvents.duration.minutes', { m: minutes })
  }
  const hours = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? t('systemEvents.duration.hoursMinutes', { h: hours, m }) : t('systemEvents.duration.hours', { h: hours })
})

const ENCRYPTION_KEYS: Record<string, string> = {
  channel_encryption_enabled: 'systemEvents.encryptionEnabled',
  channel_encryption_disabled: 'systemEvents.encryptionDisabled',
  channel_voice_encryption_enabled: 'systemEvents.voiceEncryptionEnabled',
  channel_voice_encryption_disabled: 'systemEvents.voiceEncryptionDisabled',
}
const encryptionKey = computed(() => ENCRYPTION_KEYS[type.value] ?? null)

const isAutomodAlert = computed(() =>
  type.value === 'automod_alert' && !props.message.user_id && !props.message.bot_id)

const sentence = computed<{ key: string; plural?: number } | null>(() => {
  const hasActor = !!profileIdOf(meta.value.actor_id)
  switch (type.value) {
    case 'member_join':
      return { key: 'systemEvents.memberJoin' }
    case 'member_leave':
      return { key: 'systemEvents.memberLeave' }
    case 'member_kick':
      return { key: hasActor ? 'systemEvents.memberKick' : 'systemEvents.memberKickNoActor' }
    case 'member_ban':
      return { key: hasActor ? 'systemEvents.memberBan' : 'systemEvents.memberBanNoActor' }
    case 'thread_created':
      return { key: profileIdOf(meta.value.thread_id) ? 'systemEvents.threadCreated' : 'systemEvents.threadCreatedNoLink' }
    case 'group_created':
      if (meta.value.event === 'members_added' && members.value.length > 0) return { key: 'systemEvents.membersAdded' }
      if (participantCount.value > 0) return { key: 'systemEvents.groupCreatedWith', plural: participantCount.value }
      return { key: 'systemEvents.groupCreated' }
    case 'call_started':
      return { key: `systemEvents.callStarted.${callType.value}` }
    case 'call_ended':
      if (missedByMe.value) return { key: `systemEvents.callMissed.${callType.value}` }
      if (missedCall.value) return { key: `systemEvents.callStarted.${callType.value}` }
      return { key: `systemEvents.callEnded.${callType.value}` }
    default:
      return encryptionKey.value ? { key: encryptionKey.value } : null
  }
})
</script>

<style scoped>
.system-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.system-icon.join {
  color: var(--text-success);
}

.system-icon.leave {
  color: var(--text-danger);
}

.system-text {
  flex: 1;
  color: var(--text-secondary);
}

.system-text :deep(.system-message-content) {
  color: inherit !important;
}

.system-reason {
  margin-left: 6px;
  color: var(--text-muted);
}

.system-staff {
  color: var(--text-muted);
}

/* AutoMod alert */
.system-icon.automod-icon {
  color: var(--warning, #f0b232);
}

.automod-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-on-accent, #fff);
  background: var(--harmony-primary);
  vertical-align: 1px;
}

.automod-rule {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 0.75rem;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.automod-timeout {
  margin-left: 6px;
  font-size: 0.75rem;
  color: var(--text-danger);
}

.automod-alert-excerpt {
  margin-top: 4px;
  padding: 4px 8px;
  border-left: 3px solid var(--warning, #f0b232);
  border-radius: 2px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.system-user-mention,
.system-thread-link,
.system-threads-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: inherit;
}

.system-user-mention:focus-visible,
.system-thread-link:focus-visible,
.system-threads-link:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

.system-user-mention {
  font-weight: 600;
  cursor: pointer;
}

.system-user-name {
  font-weight: 600;
}

.system-user-mention:hover {
  text-decoration: underline;
}

.system-thread-link,
.system-threads-link {
  color: var(--text-link);
  font-weight: 600;
  cursor: pointer;
}

.system-thread-link:hover,
.system-threads-link:hover {
  text-decoration: underline;
}

/* Call notices */
.call-icon-container {
  display: flex;
  align-items: center;
  justify-content: center;
}

.call-system-icon {
  color: var(--text-secondary);
}

.call-system-icon.active {
  color: var(--text-success);
}

.call-system-icon.missed {
  color: var(--text-danger);
}

.call-missed {
  color: var(--text-danger);
  font-size: 0.8rem;
  font-weight: 600;
}

.call-system-text {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.call-duration {
  color: var(--text-muted);
  font-size: 0.8rem;
}
</style>
