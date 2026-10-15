<!-- Sharing of a Drive file: a link anyone can open, accounts of this instance, servers and
     channels. Messages that send the file are not listed here: their rooms read it already. -->
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
      <section v-if="linkSharing" class="drive-share__section">
        <div class="drive-share__row">
          <span class="drive-share__glyph"><Icon name="link" :size="18" /></span>
          <div class="drive-share__text">
            <span :id="`${uid}-link`" class="drive-share__label">{{ t('drive.share.linkTitle') }}</span>
            <span class="drive-share__hint">{{ link ? t('drive.share.linkOn') : t('drive.share.linkOff') }}</span>
          </div>
          <ToggleSwitch :model-value="!!link" :labelledby="`${uid}-link`" :disabled="busy" data-testid="drive-link-toggle" @update:model-value="toggleLink" />
        </div>
        <div v-if="link" class="drive-share__link">
          <input class="drive-input" readonly :value="linkUrl" :aria-label="t('drive.share.linkTitle')" data-testid="drive-link-url" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" class="drive-btn drive-btn--primary" data-testid="drive-link-copy" @click="copyLink">
            <Icon :name="copied ? 'check' : 'copy'" :size="15" />{{ copied ? t('drive.share.copied') : t('drive.share.copy') }}
          </button>
        </div>
        <label v-if="link" class="drive-share__expiry">
          <span>{{ t('drive.share.expires') }}</span>
          <select class="drive-select" :value="expiryChoice" :disabled="busy" @change="setExpiry(($event.target as HTMLSelectElement).value)">
            <option value="never">{{ t('drive.share.never') }}</option>
            <option value="1">{{ t('drive.share.days', { count: 1 }, 1) }}</option>
            <option value="7">{{ t('drive.share.days', { count: 7 }, 7) }}</option>
            <option value="30">{{ t('drive.share.days', { count: 30 }, 30) }}</option>
          </select>
        </label>
      </section>

      <section class="drive-share__section">
        <h3 class="drive-share__heading">{{ t('drive.share.people') }}</h3>
        <div class="drive-share__search">
          <Icon name="search" :size="15" class="drive-share__search-icon" />
          <input
            v-model="query"
            class="drive-input drive-share__search-input"
            :placeholder="t('drive.share.searchPeople')"
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
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { supabase } from '@/supabase'
import { useT } from '@/composables/useT'
import { normalizeUserQuery, useUserSearch } from '@/composables/useUserSearch'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { apiUrl } from '@/services/instanceConfig'
import {
  createDriveLink,
  getDriveFileUsage,
  shareDriveFile,
  unshareDriveFile,
  type DriveFile,
  type DriveShare,
} from '@/services/drive/driveService'

const props = defineProps<{ file: DriveFile; name: string; linkSharing: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const { t } = useT()
const uid = useId()
const serverStore = useServerChannelStore()
const allShares = ref<DriveShare[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const copied = ref(false)
const serverId = ref('')
const channelId = ref('')
const channels = ref<Array<{ id: string; name: string }>>([])

const link = computed(() => allShares.value.find((s) => s.scope === 'link') ?? null)
const shares = computed(() => allShares.value.filter((s) => s.scope !== 'link'))
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
const linkUrl = computed(() => (link.value?.token
  ? new URL(apiUrl(`/d/${link.value.token}`), window.location.href).toString()
  : ''))
const expiryChoice = computed(() => {
  const exp = link.value?.expires_at
  if (!exp) return 'never'
  const days = Math.round((new Date(exp).getTime() - new Date(link.value!.created_at).getTime()) / 86_400_000)
  return ['1', '7', '30'].includes(String(days)) ? String(days) : 'never'
})

async function load(): Promise<void> {
  try {
    allShares.value = (await getDriveFileUsage(props.file.id)).shares
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

const toggleLink = (on: boolean) => run(async () => {
  if (on) await createDriveLink(props.file.id)
  else if (link.value) await unshareDriveFile(link.value.id)
})

const setExpiry = (choice: string) => run(() => createDriveLink(props.file.id, expiryDate(choice)))

const addShare = (scope: 'user' | 'server' | 'channel', target: string) => run(async () => {
  await shareDriveFile(props.file.id, scope, target)
  if (scope === 'user') clearPeople()
})

const removeShare = (id: string) => run(() => unshareDriveFile(id))

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(linkUrl.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1800)
  } catch {
    /* clipboard refused; the field stays selectable */
  }
}

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

.drive-share__expiry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
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
}
</style>
