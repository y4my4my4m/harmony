<!-- Sharing of a Drive file: its /d/ address and general access (restricted, or anyone with the
     link), accounts of this instance, servers and channels. Messages that send the file are not
     listed here: their rooms read it already. -->
<template>
  <UnifiedModal
    :model-value="true"
    :title="t('drive.share.title')"
    :subtitle="name"
    size="md"
    topmost
    @update:model-value="(open) => !open && emit('close')"
  >
    <div class="drive-share" data-testid="drive-share-dialog">
      <section class="drive-share__section" data-testid="drive-share-link">
        <h3 class="drive-share__heading">{{ t('drive.share.linkHeading') }}</h3>
        <div class="drive-share__link">
          <input class="drive-input" readonly :value="linkUrl" :aria-label="t('drive.share.linkLabel')" data-testid="drive-link-url" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" class="drive-btn drive-btn--primary" :disabled="!link" data-testid="drive-link-copy" @click="link && copyDriveLink(link.token)">
            <Icon name="link" :size="15" />{{ t('drive.actions.copyLink') }}
          </button>
        </div>
        <div class="drive-share__row">
          <span class="drive-share__glyph"><Icon :name="isPublic ? 'globe' : 'lock'" :size="18" /></span>
          <div class="drive-share__text">
            <span :id="`${uid}-access`" class="drive-share__label">{{ t('drive.share.generalAccess') }}</span>
            <span class="drive-share__hint" data-testid="drive-link-access-hint">{{ isPublic ? t('drive.share.linkOn') : t('drive.share.accessLinkHint') }}</span>
          </div>
          <select
            class="drive-select drive-share__access"
            :value="isPublic ? 'anyone' : 'restricted'"
            :disabled="busy || !link"
            :aria-labelledby="`${uid}-access`"
            data-testid="drive-link-access"
            @change="setAccess(($event.target as HTMLSelectElement).value === 'anyone')"
          >
            <option value="restricted">{{ t('drive.share.accessRestricted') }}</option>
            <option value="anyone" :disabled="!linkSharing && !isPublic">{{ t('drive.share.linkTitle') }}</option>
          </select>
        </div>
        <template v-if="isPublic">
          <label class="drive-share__option">
            <span>{{ t('drive.share.expires') }}</span>
            <select class="drive-select" :value="expiryChoice" :disabled="busy" data-testid="drive-link-expiry" @change="setExpiry(($event.target as HTMLSelectElement).value)">
              <option v-if="expiryUntil" value="current">{{ expiryUntil }}</option>
              <option value="never">{{ t('drive.share.never') }}</option>
              <option value="1">{{ t('drive.share.days', { count: 1 }, 1) }}</option>
              <option value="7">{{ t('drive.share.days', { count: 7 }, 7) }}</option>
              <option value="30">{{ t('drive.share.days', { count: 30 }, 30) }}</option>
            </select>
          </label>
          <div class="drive-share__option">
            <div class="drive-share__text">
              <span :id="`${uid}-owner`">{{ t('drive.share.showOwner') }}</span>
              <span :id="`${uid}-owner-hint`" class="drive-share__hint">{{ t('drive.share.showOwnerHint') }}</span>
            </div>
            <ToggleSwitch
              :model-value="!!link?.show_owner"
              :labelledby="`${uid}-owner`"
              :describedby="`${uid}-owner-hint`"
              :disabled="busy"
              data-testid="drive-link-show-owner"
              @update:model-value="setShowOwner"
            />
          </div>
        </template>
        <div class="drive-share__reset">
          <button ref="resetButton" type="button" class="drive-btn drive-btn--secondary" :disabled="busy || !link" data-testid="drive-link-reset" @click="confirmingReset = true">
            <Icon name="refresh-cw" :size="15" />{{ t('drive.share.resetLink') }}
          </button>
        </div>
      </section>

      <section class="drive-share__section">
        <h3 class="drive-share__heading">{{ t('drive.share.people') }}</h3>
        <div class="drive-share__search">
          <Icon name="search" :size="15" class="drive-share__search-icon" />
          <input
            v-model="query"
            class="drive-input drive-share__search-input"
            :placeholder="t('drive.share.searchPeopleHint')"
            :aria-label="t('drive.share.searchPeople')"
            :aria-busy="searching"
            data-testid="drive-share-search"
          />
          <LoadingSpinner v-if="searching" :size="14" class="drive-share__search-busy" data-testid="drive-share-searching" />
        </div>
        <p v-if="peopleStatus" class="drive-share__status" role="status" data-testid="drive-share-status">{{ peopleStatus }}</p>
        <ul v-if="people.length" class="drive-share__results" role="listbox" :aria-label="t('drive.share.people')">
          <li v-for="person in people" :key="person.id">
            <button type="button" class="drive-share__result" role="option" :aria-selected="false" :disabled="busy" data-testid="drive-share-person" @click="addShare('user', person.id)">
              <Avatar :src="person.avatar_url" size="sm" class="drive-share__avatar" data-testid="drive-share-person-avatar" />
              <span class="drive-share__person">{{ person.display_name || person.username }}</span>
              <span class="drive-share__handle">@{{ person.username }}</span>
            </button>
          </li>
        </ul>

        <div class="drive-share__targets">
          <select v-model="serverId" class="drive-select" :aria-label="t('drive.share.server')" data-testid="drive-share-server">
            <option value="">{{ t('drive.share.pickServer') }}</option>
            <option v-for="server in servers" :key="server.id" :value="server.id">{{ server.name }}</option>
          </select>
          <select v-model="channelId" class="drive-select" :disabled="!serverId" :aria-label="t('drive.share.channel')" data-testid="drive-share-channel">
            <option value="">{{ t('drive.share.wholeServer') }}</option>
            <option v-for="channel in channels" :key="channel.id" :value="channel.id">#{{ channel.name }}</option>
          </select>
          <button type="button" class="drive-btn drive-btn--secondary" :disabled="!serverId || busy" data-testid="drive-share-add" @click="channelId ? addShare('channel', channelId) : addShare('server', serverId)">
            {{ t('drive.share.add') }}
          </button>
        </div>

        <ul v-if="shares.length" class="drive-share__list" data-testid="drive-share-list">
          <li v-for="share in shares" :key="share.id" class="drive-share__item">
            <Icon :name="share.scope === 'user' ? 'user' : share.scope === 'server' ? 'server' : 'hash'" :size="15" />
            <span class="drive-share__item-name">{{ share.target_name || share.target_id }}</span>
            <span class="drive-share__item-kind">{{ t(`drive.share.scope.${share.scope}`) }}</span>
            <button type="button" class="drive-icon-btn" :aria-label="t('drive.share.remove', { name: share.target_name || '' })" @click="removeShare(share.id)">
              <Icon name="x" :size="15" />
            </button>
          </li>
        </ul>
        <p v-else class="drive-share__empty">{{ t('drive.share.private') }}</p>
      </section>
      <p v-if="error" class="drive-share__error" role="alert">{{ error }}</p>
    </div>
    <DriveConfirmDialog
      v-if="confirmingReset"
      :title="t('drive.share.resetTitle')"
      :message="t('drive.share.resetText')"
      :confirm-label="t('drive.share.resetLink')"
      danger
      @confirm="resetLink"
      @cancel="confirmingReset = false"
    />
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DriveConfirmDialog from './DriveConfirmDialog.vue'
import { supabase } from '@/supabase'
import { useT } from '@/composables/useT'
import { normalizeUserQuery, useUserSearch } from '@/composables/useUserSearch'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useCopyDriveLink } from '@/composables/useCopyDriveLink'
import { driveTokenUrl } from '@/services/drive/driveLinks'
import {
  getDriveFileCard,
  getDriveFileUsage,
  resetDriveLink,
  setDriveLinkAccess,
  shareDriveFile,
  unshareDriveFile,
  type DriveFile,
  type DriveLinkState,
  type DriveShare,
} from '@/services/drive/driveService'

const props = defineProps<{ file: Pick<DriveFile, 'id' | 'owner_id'>; name: string; linkSharing: boolean }>()
const emit = defineEmits<{ close: []; changed: []; token: [token: string] }>()

const { t, locale } = useT()
const uid = useId()
const serverStore = useServerChannelStore()
const allShares = ref<DriveShare[]>([])
const link = ref<DriveLinkState | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const confirmingReset = ref(false)
const serverId = ref('')
const channelId = ref('')
const channels = ref<Array<{ id: string; name: string }>>([])

const shares = computed(() => allShares.value.filter((s) => s.scope !== 'link'))
const isPublic = computed(() => !!link.value?.public)
const {
  query,
  results: people,
  searching,
  error: searchError,
  clear: clearPeople,
} = useUserSearch({
  localOnly: true,
  exclude: () => [props.file.owner_id, ...shares.value.filter((s) => s.scope === 'user').map((s) => s.target_id)],
})
const peopleStatus = computed(() => {
  if (!normalizeUserQuery(query.value)) return ''
  if (searchError.value) return t('drive.share.searchFailed')
  if (searching.value) return people.value.length ? '' : t('drive.share.searching')
  return people.value.length ? '' : t('drive.share.noPeople')
})
const servers = computed(() => serverStore.servers.filter((s) => s.is_local_server !== false))
const copyDriveLink = useCopyDriveLink()
const linkUrl = computed(() => (link.value ? driveTokenUrl(link.value.token) : ''))
// A set expiry stays selected as its date; the presets count from now.
const expiryChoice = computed(() => (link.value?.link_expires_at ? 'current' : 'never'))
const expiryUntil = computed(() => {
  const exp = link.value?.link_expires_at
  if (!exp) return ''
  const date = new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(exp))
  return t('drive.share.until', { date })
})
const resetButton = ref<HTMLButtonElement | null>(null)

async function load(): Promise<void> {
  try {
    const [usage, card] = await Promise.all([
      getDriveFileUsage(props.file.id),
      getDriveFileCard({ fileId: props.file.id }),
    ])
    allShares.value = usage.shares
    if (card.access && card.via === 'file') {
      link.value = { token: card.token, public: card.public, link_expires_at: card.link_expires_at, show_owner: card.show_owner }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function run(work: () => Promise<unknown>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await work()
    await load()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function expiryDate(choice: string): string | null {
  const days = Number(choice)
  return Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null
}

const setAccess = (on: boolean) => run(() => setDriveLinkAccess(props.file.id, { public: on }))

const setExpiry = (choice: string) => choice === 'current' ? undefined : run(() => setDriveLinkAccess(props.file.id, {
  public: true, expiresAt: expiryDate(choice), showOwner: !!link.value?.show_owner,
}))

const setShowOwner = (on: boolean) => run(() => setDriveLinkAccess(props.file.id, {
  public: true, expiresAt: link.value?.link_expires_at ?? null, showOwner: on,
}))

// The confirm dialog returns focus to Reset link while it is disabled (busy); focus goes back once enabled.
const resetLink = async () => {
  confirmingReset.value = false
  await run(async () => {
    const state = await resetDriveLink(props.file.id)
    emit('token', state.token)
  })
  await nextTick()
  resetButton.value?.focus()
}

const addShare = (scope: 'user' | 'server' | 'channel', target: string) => run(async () => {
  await shareDriveFile(props.file.id, scope, target)
  if (scope === 'user') clearPeople()
})

const removeShare = (id: string) => run(() => unshareDriveFile(id))

watch(serverId, async (id) => {
  channelId.value = ''
  channels.value = []
  if (!id) return
  const { data } = await supabase.from('channels').select('id, name, type').eq('server_id', id).order('order')
  channels.value = (data ?? []).filter((c: { type: number | string }) => Number(c.type) === 0)
})

onMounted(load)
</script>

<style scoped>
.drive-share {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.drive-share__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.drive-share__heading {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.drive-share__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.drive-share__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  background: color-mix(in srgb, var(--harmony-primary) 16%, transparent);
  border-radius: var(--radius-full);
  color: var(--harmony-primary);
}

.drive-share__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.drive-share__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.drive-share__hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.drive-share__link {
  display: flex;
  gap: var(--space-2);
}

.drive-share__access {
  flex-shrink: 0;
  width: auto;
  max-width: 50%;
}

.drive-share__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-left: calc(36px + var(--space-3));
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-share__reset {
  display: flex;
  justify-content: flex-end;
}

.drive-share__search {
  position: relative;
}

.drive-share__search-icon {
  position: absolute;
  top: 50%;
  left: 10px;
  color: var(--text-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.drive-share__search-input {
  padding-right: 32px;
  padding-left: 32px;
}

.drive-share__search-busy {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
}

.drive-share__status {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.drive-share__results,
.drive-share__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.drive-share__result {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 38px;
  padding: 0 var(--space-2);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  text-align: left;
  color: var(--text-primary);
  cursor: pointer;
}

.drive-share__result:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}

.drive-share__result:disabled {
  cursor: progress;
}

/* Drawn at 26px from the "sm" (40px) variant the message list fetches. */
.drive-share__result .drive-share__avatar {
  width: 26px;
  height: 26px;
}

.drive-share__person {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}

.drive-share__handle {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.drive-share__targets {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: var(--space-2);
}

.drive-share__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 0 0 var(--space-2);
  background: var(--background-secondary);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-share__item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-share__item-kind {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.drive-share__empty {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.drive-share__error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

@media (max-width: 520px) {
  .drive-share__targets {
    grid-template-columns: 1fr;
  }

  .drive-share__row {
    flex-wrap: wrap;
  }

  .drive-share__access {
    flex-basis: 100%;
    max-width: none;
  }

  .drive-share__option {
    padding-left: 0;
  }
}
</style>
