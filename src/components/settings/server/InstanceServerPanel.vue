<!--
  "On {instance}": this instance's tools for one server hosted elsewhere. Block it, hide its
  media, remove people from this instance and let kept-out people back. Nothing here reaches
  the server or its members on other instances. Instance admins and moderators.
-->
<template>
  <div class="instance-server-panel" data-testid="instance-server-panel">
    <div class="settings-header">
      <h2 ref="headingEl" class="settings-title" tabindex="-1">{{ t('instanceServer.panel.title', { instance }) }}</h2>
      <p class="settings-description">
        {{ t('instanceServer.panel.intro', { instance, server: serverName }) }}
      </p>
    </div>

    <EmptyState
      v-if="!isStaff"
      icon="shield"
      :title="t('instanceServer.panel.staffOnly', { instance })"
    />

    <div v-else-if="loading && !state" class="loading-state" role="status">
      <LoadingSpinner :size="20" />
    </div>

    <EmptyState
      v-else-if="error"
      tone="error"
      icon="alert-circle"
      :title="error"
      :action-label="t('common.retry')"
      @action="load"
    />

    <EmptyState
      v-else-if="!state"
      icon="server"
      :title="t('instanceServer.panel.notHostedElsewhere', { instance })"
    />

    <template v-else>
      <p v-if="state.host" class="hosted-on">
        <Icon name="globe" :size="14" aria-hidden="true" />
        {{ t('instanceServer.panel.hostedOn', { host: state.host }) }}
      </p>

      <section class="settings-card" :aria-labelledby="`${uid}-access`" data-testid="instance-access">
        <div class="card-stack">
          <div class="card-text">
            <h3 :id="`${uid}-access`" class="card-title">
              <span v-if="state.blocked" class="state-badge blocked" data-testid="instance-blocked-badge">
                {{ t('instanceServer.block.blockedStatus', { instance }) }}
              </span>
              <template v-else>{{ t('instanceServer.block.heading', { instance }) }}</template>
            </h3>
            <p class="card-description">
              {{ state.blocked
                ? t('instanceServer.block.blockedDescription', { instance })
                : t('instanceServer.block.openDescription', { instance }) }}
            </p>
            <p v-if="state.blocked && state.reason" class="card-reason">
              <span class="sr-only">{{ t('moderation.reason') }}: </span>{{ state.reason }}
            </p>
            <p v-if="state.blocked && state.set_at" class="card-meta">
              {{ t('instanceServer.block.setAt', { date: formatDate(state.set_at) }) }}
            </p>
          </div>
          <div class="card-actions">
            <UnifiedButton
              v-if="!state.blocked"
              variant="danger"
              :text="t('instanceServer.block.action', { server: serverName, instance })"
              data-testid="instance-block"
              @click="showBlock = true"
            />
            <UnifiedButton
              v-else
              variant="primary"
              :text="t('instanceServer.block.unblock', { server: serverName, instance })"
              :loading="unblocking"
              data-testid="instance-unblock"
              @click="unblock"
            />
          </div>
        </div>
      </section>

      <section class="settings-card" data-testid="instance-media">
        <div class="card-row">
          <div class="card-text">
            <h3 :id="`${uid}-media`" class="card-title">{{ t('instanceServer.media.toggle', { server: serverName, instance }) }}</h3>
            <p :id="`${uid}-media-hint`" class="card-description">{{ t('instanceServer.media.hint', { instance }) }}</p>
          </div>
          <ToggleSwitch
            :model-value="state.media_hidden"
            :labelledby="`${uid}-media`"
            :describedby="`${uid}-media-hint`"
            :disabled="savingMedia"
            data-testid="instance-media-toggle"
            @update:model-value="setMediaHidden"
          />
        </div>
      </section>

      <section class="settings-card" :aria-labelledby="`${uid}-people`" data-testid="instance-people">
        <h3 :id="`${uid}-people`" class="card-title">{{ t('instanceServer.people.heading', { instance }) }}</h3>
        <p class="card-description">
          {{ t('instanceServer.panel.localMembers', { count: state.local_members, instance }, state.local_members) }}
        </p>

        <p v-if="people.length === 0" class="card-empty">
          {{ t('instanceServer.people.empty', { instance, server: serverName }) }}
        </p>
        <ul v-else class="people-list">
          <li
            v-for="person in people"
            :key="`${person.standing}-${person.profile_id}`"
            class="person"
            data-testid="instance-person"
            :data-username="person.username"
          >
            <Avatar :src="person.avatar_url" size="sm" />
            <div class="person-info">
              <span class="person-name">{{ personName(person) }}</span>
              <span class="person-meta">
                @{{ person.username }}
                <template v-if="person.standing === 'pending'"> · {{ t('instanceServer.people.pending') }}</template>
                <template v-else-if="person.standing === 'kept_out'"> · {{ t('instanceServer.people.keptOut') }}</template>
              </span>
              <span v-if="person.standing === 'kept_out' && person.reason" class="person-reason">{{ person.reason }}</span>
            </div>
            <UnifiedButton
              v-if="person.standing === 'kept_out'"
              size="sm"
              variant="secondary"
              :text="t('instanceServer.people.lift')"
              :aria-label="t('instanceServer.people.liftLabel', { name: personName(person), server: serverName, instance })"
              :loading="liftingId === person.profile_id"
              data-testid="instance-lift"
              @click="lift(person)"
            />
            <UnifiedButton
              v-else-if="canRemove(person)"
              size="sm"
              variant="danger"
              outline
              :text="t('instanceServer.people.remove')"
              :aria-label="t('instanceServer.people.removeLabel', { name: personName(person), server: serverName, instance })"
              data-testid="instance-remove"
              @click="removing = person"
            />
          </li>
        </ul>
      </section>
    </template>

    <InstanceBlockServerModal
      v-if="state"
      :show="showBlock"
      :server-id="serverId"
      :server-name="serverName"
      :people="people"
      @close="showBlock = false"
      @done="onBlocked"
    />

    <InstanceRemoveMemberModal
      v-if="removing"
      :show="true"
      :server-id="serverId"
      :server-name="serverName"
      :user="{ id: removing.profile_id, username: removing.username, display_name: removing.display_name, avatar_url: removing.avatar_url }"
      @close="removing = null"
      @done="onRemoved"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useToast } from 'vue-toastification'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import InstanceBlockServerModal from '@/components/moderation/InstanceBlockServerModal.vue'
import InstanceRemoveMemberModal from '@/components/moderation/InstanceRemoveMemberModal.vue'
import { useT } from '@/composables/useT'
import { setServerMediaHiddenLocally } from '@/composables/useInstanceMediaHidden'
import { getInstanceDomain } from '@/services/instanceConfig'
import {
  getRemoteServer,
  getRemoteServerPeople,
  liftKeepout,
  setServerBlocked,
  setServerMediaHidden,
  type RemoteServerPerson,
  type RemoteServerState,
} from '@/services/instanceServerTools'
import { useProfileStore } from '@/stores/useProfile'
import { isInstanceStaff, staffMayActOn } from '@/utils/instanceStaff'

const props = defineProps<{ serverId: string }>()

const emit = defineEmits<{
  /** The server's state on this instance changed (block, media). */
  changed: [state: RemoteServerState]
}>()

const { t, locale } = useT()
const toast = useToast()
const profileStore = useProfileStore()
const instance = getInstanceDomain()
const uid = `isp-${useId()}`

const state = ref<RemoteServerState | null>(null)
const people = ref<RemoteServerPerson[]>([])
const loading = ref(false)
const error = ref('')
const showBlock = ref(false)
const unblocking = ref(false)
const savingMedia = ref(false)
const liftingId = ref<string | null>(null)
const removing = ref<RemoteServerPerson | null>(null)
const headingEl = ref<HTMLElement | null>(null)

const isStaff = computed(() => isInstanceStaff(profileStore.profile))
const myProfileId = computed(() => profileStore.profile?.id ?? null)
const serverName = computed(() => state.value?.name || state.value?.host || t('instanceServer.panel.thisServer'))

// The viewer leaves on their own (instance_remove_member refuses a self-removal).
function canRemove(person: RemoteServerPerson): boolean {
  return person.profile_id !== myProfileId.value && staffMayActOn(profileStore.profile, person.is_instance_staff)
}

function personName(person: RemoteServerPerson): string {
  return person.display_name || person.username
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
}

async function load() {
  if (!isStaff.value) return
  loading.value = true
  error.value = ''
  try {
    const [server, list] = await Promise.all([
      getRemoteServer(props.serverId),
      getRemoteServerPeople(props.serverId),
    ])
    state.value = server
    people.value = list
  } catch (err: any) {
    error.value = t('instanceServer.panel.loadFailed', { instance })
    if (err?.message) error.value += ` ${err.message}`
  } finally {
    loading.value = false
  }
}

async function refresh() {
  await load()
  if (state.value) emit('changed', state.value)
}

async function onBlocked() {
  showBlock.value = false
  await refresh()
  headingEl.value?.focus()
}

async function unblock() {
  if (!state.value || unblocking.value) return
  unblocking.value = true
  try {
    await setServerBlocked(props.serverId, false)
    toast.success(t('instanceServer.block.unblocked', { server: serverName.value, instance }))
    await refresh()
  } catch (err: any) {
    toast.error(t('instanceServer.block.failed') + (err?.message ? ` ${err.message}` : ''))
  } finally {
    unblocking.value = false
  }
}

async function setMediaHidden(hidden: boolean) {
  if (!state.value || savingMedia.value) return
  savingMedia.value = true
  const before = state.value.media_hidden
  state.value = { ...state.value, media_hidden: hidden }
  try {
    await setServerMediaHidden(props.serverId, hidden)
    setServerMediaHiddenLocally(props.serverId, hidden)
    emit('changed', state.value)
  } catch (err: any) {
    state.value = { ...state.value, media_hidden: before }
    toast.error(t('instanceServer.media.failed') + (err?.message ? ` ${err.message}` : ''))
  } finally {
    savingMedia.value = false
  }
}

async function lift(person: RemoteServerPerson) {
  if (liftingId.value) return
  liftingId.value = person.profile_id
  try {
    await liftKeepout(props.serverId, person.profile_id)
    toast.success(t('instanceServer.people.lifted', { name: personName(person), server: serverName.value }))
    await refresh()
  } catch (err: any) {
    toast.error(t('instanceServer.people.liftFailed', { name: personName(person) }) + (err?.message ? ` ${err.message}` : ''))
  } finally {
    liftingId.value = null
  }
}

async function onRemoved() {
  removing.value = null
  await refresh()
}

watch(() => props.serverId, () => { void load() })
onMounted(load)
</script>

<style scoped>
.instance-server-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-header {
  margin-bottom: 8px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px;
}

.settings-title:focus {
  outline: none;
}

.settings-description {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  margin: 0;
}

.hosted-on {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 48px 16px;
  color: var(--text-muted);
}

.settings-card {
  background-color: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  padding: 20px;
}

.card-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.card-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* The action names the server and the instance; it wraps instead of clipping at phone width. */
.card-actions > * {
  max-width: 100%;
  height: auto;
}

.card-actions :deep(.btn-content) {
  white-space: normal;
  text-align: center;
}

.card-text {
  min-width: 0;
  flex: 1;
}

.card-title {
  margin: 0 0 4px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.card-description,
.card-empty {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.card-empty {
  margin-top: 12px;
}

.card-reason {
  margin: 8px 0 0;
  padding-left: 8px;
  border-left: 3px solid var(--border-primary);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.card-meta {
  margin: 4px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.state-badge {
  display: inline-block;
  margin-bottom: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.state-badge.blocked {
  background: var(--error-fill);
  color: var(--text-on-primary);
}

.people-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}

.person {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-base);
  background: var(--background-tertiary);
}

.person-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.person-name {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.person-meta,
.person-reason {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .card-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
