<template>
  <div data-testid="channel-pairs">
    <div
      v-if="!guild && bridge.mode === 'instance' && bridge.discord_guild_id && !bridge.snapshot"
      class="db-banner"
      role="status"
      data-testid="pairs-waiting-instance"
    >
      <p>{{ t('discordBridge.pairs.waitingInstance', { guild: bridge.discord_guild_name || bridge.discord_guild_id }) }}</p>
    </div>

    <div
      v-else-if="!guild && bridge.mode === 'instance' && bridge.discord_guild_id"
      class="db-banner db-banner--warn"
      role="status"
      data-testid="pairs-instance-gone"
    >
      <p>{{ t('discordBridge.pairs.instanceGone', { guild: bridge.discord_guild_name || bridge.discord_guild_id }) }}</p>
    </div>

    <div v-else-if="!guild" class="db-banner db-banner--warn" role="status">
      <p>{{ t('discordBridge.pairs.noGuild') }}</p>
    </div>

    <template v-else>
      <p class="db-muted">{{ t('discordBridge.pairs.lead', { guild: guild.name }) }}</p>

      <!-- Existing pairs -->
      <p v-if="pairs.length === 0" class="db-text empty" data-testid="pairs-empty">{{ t('discordBridge.pairs.empty') }}</p>
      <template v-else>
      <div v-if="importsSupported" class="import-toolbar" data-testid="import-toolbar">
        <p v-if="attachmentMode === 'mirror'" class="db-muted" data-testid="import-mirror-note">{{ t('discordBridge.import.mirrorNote') }}</p>
        <div class="db-actions">
          <button
            v-if="importAllIds.length > 0"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            data-testid="import-all"
            @click="askImport(importAllIds, false)"
          >
            {{ t('discordBridge.import.importAll') }}
          </button>
          <button
            v-if="importAgainIds.length > 0 && !pending"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            data-testid="import-all-again"
            @click="askImport(importAgainIds, true)"
          >
            {{ t('discordBridge.import.importAllAgain') }}
          </button>
          <button
            v-if="activeJobCount > 0"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            data-testid="cancel-all"
            @click="cancelImport(null)"
          >
            {{ t('discordBridge.import.cancelAll') }}
          </button>
        </div>
      </div>
      <div
        v-if="importsSupported && pending"
        ref="consentDialog"
        class="import-again-confirm"
        role="alertdialog"
        :aria-labelledby="`${uid}-import-consent`"
        :data-testid="pending.again ? 'import-all-again-confirm' : 'import-consent'"
      >
        <p :id="`${uid}-import-consent`" class="db-text">
          {{ pending.again
            ? t('discordBridge.import.importAllAgainConfirm', { count: pending.ids.length }, pending.ids.length)
            : t('discordBridge.import.consent.title', { count: pending.ids.length }, pending.ids.length) }}
        </p>
        <ul class="import-consent-list">
          <li>{{ t('discordBridge.import.consent.copies') }}</li>
          <li>{{ t('discordBridge.import.consent.skips') }}</li>
          <li>{{ t('discordBridge.import.consent.notice') }}</li>
        </ul>
        <label class="import-consent-check">
          <input v-model="consent" type="checkbox" data-testid="import-consent-check" />
          <span>{{ t('discordBridge.import.consent.confirm') }}</span>
        </label>
        <div v-if="pendingPrivateNames.length" class="import-private" data-testid="import-private">
          <p class="import-private-title">
            <Icon name="lock" :size="14" aria-hidden="true" />
            <span>{{ t('discordBridge.import.consent.privateTitle', { channels: pendingPrivateNames.join(', ') }, pendingPrivateNames.length) }}</span>
          </p>
          <p class="import-private-lead">{{ t('discordBridge.import.consent.privateLead') }}</p>
          <label class="import-consent-check">
            <input v-model="includePrivate" type="checkbox" data-testid="import-private-check" />
            <span>{{ t('discordBridge.import.consent.privateConfirm', pendingPrivateNames.length) }}</span>
          </label>
        </div>
        <div class="db-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy || !consent || pendingStartIds.length === 0"
            :data-testid="pending.again ? 'import-all-again-yes' : 'import-consent-start'"
            @click="confirmImport"
          >
            {{ pending.again ? t('discordBridge.import.importAllAgainYes') : t('discordBridge.import.consent.start') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" data-testid="import-consent-cancel" @click="pending = null">
            {{ t('discordBridge.import.cancel') }}
          </button>
        </div>
      </div>
      <p v-if="availability === 'needs_update'" class="db-muted" data-testid="import-update-bridge">
        {{ t(bridge.mode === 'self' ? 'discordBridge.import.needsUpdate' : 'discordBridge.import.needsUpdateHosted') }}
      </p>
      <p v-else-if="availability !== 'ok'" class="db-muted" data-testid="import-unavailable" :data-reason="availability">
        {{ t(`discordBridge.import.unavailable.${availability}`) }}
      </p>
      <ul class="pair-list" :aria-label="t('discordBridge.pairs.listLabel')">
        <li v-for="row in pairRows" :key="row.pair.id" class="pair" data-testid="pair-row" :data-harmony="row.pair.harmony_channel_id">
          <div class="pair-main">
            <span class="pair-channel">
              <span class="pair-platform">{{ t('discordBridge.pairs.harmony') }}</span>
              <span class="pair-name">#{{ row.harmonyName }}</span>
            </span>
            <span class="pair-arrow" :title="t(`discordBridge.pairs.direction.${row.pair.direction}`)" aria-hidden="true">
              {{ ARROWS[row.pair.direction] }}
            </span>
            <span class="pair-channel">
              <span class="pair-platform">{{ t('discordBridge.pairs.discord') }}</span>
              <span class="pair-name">
                #{{ row.discordName }}
                <span v-if="row.private" class="pair-private" :title="t('discordBridge.pairs.private')" data-testid="pair-private">
                  <Icon name="lock" :size="12" aria-hidden="true" />
                  <span class="sr-only">{{ t('discordBridge.pairs.private') }}</span>
                </span>
              </span>
            </span>
          </div>
          <div class="pair-meta">
            <span class="db-badge">{{ t(`discordBridge.pairs.direction.${row.pair.direction}`) }}</span>
            <span v-if="row.issues.length === 0 && row.discord" class="db-badge db-badge--ok">{{ t('discordBridge.pairs.ok') }}</span>
            <span v-if="!row.discord" class="db-badge db-badge--error">{{ t('discordBridge.pairs.discordGone') }}</span>
            <span
              v-for="issue in row.issues"
              :key="issue"
              :class="['db-badge', isBlockingIssue(issue) ? 'db-badge--error' : 'db-badge--warn']"
            >
              {{ t(`discordBridge.pairs.issue.${issue}.short`) }}
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-sm remove"
              :disabled="busy"
              :aria-label="t('discordBridge.pairs.removeLabel', { harmony: row.harmonyName, discord: row.discordName })"
              data-testid="pair-remove"
              @click="remove(row.pair)"
            >
              <Icon name="trash-2" :size="14" aria-hidden="true" />
              <span>{{ t('discordBridge.pairs.remove') }}</span>
            </button>
          </div>
          <BridgeImportControls
            v-if="importsSupported"
            :pair="row.pair"
            :job="row.job"
            :block="row.block"
            :channel-name="row.harmonyName"
            :busy="busy"
            @start="(id: string) => askImport([id], false)"
            @cancel="(job: ImportJob) => cancelImport(job.id)"
          />
          <ul v-if="row.issues.length || !row.discord" class="pair-fixes">
            <li v-if="!row.discord">{{ t('discordBridge.pairs.discordGoneFix') }}</li>
            <li v-for="issue in row.issues" :key="issue">{{ t(`discordBridge.pairs.issue.${issue}.fix`, { channel: `#${row.discordName}` }) }}</li>
          </ul>
        </li>
      </ul>
      </template>

      <!-- Same-name helper -->
      <div v-if="matches.length" class="match-box" data-testid="name-matches">
        <h4 class="db-card-sub">{{ t('discordBridge.pairs.match.title') }}</h4>
        <p class="db-muted">{{ t('discordBridge.pairs.match.lead') }}</p>
        <ul class="match-list">
          <li v-for="m in matches" :key="m.harmony.id">#{{ m.harmony.name }} ⇄ #{{ m.discord.name }}</li>
        </ul>
        <button type="button" class="btn btn-secondary" :disabled="busy" data-testid="pair-matches" @click="pairMatches">
          {{ t('discordBridge.pairs.match.action', { count: matches.length }, matches.length) }}
        </button>
      </div>

      <!-- Add a pair -->
      <form class="add-form" novalidate data-testid="pair-form" @submit.prevent="add">
        <h4 class="db-card-sub">{{ t('discordBridge.pairs.addTitle') }}</h4>
        <div class="add-grid">
          <BridgeChannelSelect :id="`${uid}-harmony`" v-model="harmonyId" :groups="harmonyGroups" />

          <div class="db-field">
            <label :for="`${uid}-discord`" class="db-label">{{ t('discordBridge.pairs.discordChannel') }}</label>
            <select
              :id="`${uid}-discord`"
              v-model="discordId"
              class="db-select"
              :aria-describedby="selectedIssues.length ? `${uid}-issues` : undefined"
              data-testid="select-discord"
            >
              <option value="">{{ t('discordBridge.pairs.choose') }}</option>
              <template v-for="group in discordGroups" :key="group.categoryName ?? ''">
                <optgroup v-if="group.categoryName" :label="group.categoryName">
                  <option v-for="c in group.channels" :key="c.id" :value="c.id">{{ discordOptionLabel(c) }}</option>
                </optgroup>
                <template v-else>
                  <option v-for="c in group.channels" :key="c.id" :value="c.id">{{ discordOptionLabel(c) }}</option>
                </template>
              </template>
            </select>
          </div>

          <div class="db-field">
            <label :for="`${uid}-direction`" class="db-label">{{ t('discordBridge.pairs.directionLabel') }}</label>
            <select :id="`${uid}-direction`" v-model="direction" class="db-select" data-testid="select-direction">
              <option v-for="d in PAIR_DIRECTIONS" :key="d" :value="d">{{ t(`discordBridge.pairs.direction.${d}`) }}</option>
            </select>
          </div>
        </div>

        <p v-if="harmonyGroups.length === 0" class="db-muted" data-testid="no-harmony-left">{{ t('discordBridge.pairs.noHarmonyLeft') }}</p>
        <p v-if="discordGroups.length === 0" class="db-muted" data-testid="no-discord-left">
          {{ t('discordBridge.pairs.noDiscordLeft', { guild: guild.name }) }}
        </p>

        <ul v-if="selectedIssues.length" :id="`${uid}-issues`" class="issue-list" data-testid="pair-issues">
          <li v-for="issue in selectedIssues" :key="issue" :class="isBlockingIssue(issue) ? 'blocking' : 'warning'">
            <strong>{{ t(`discordBridge.pairs.issue.${issue}.short`) }}.</strong>
            {{ t(`discordBridge.pairs.issue.${issue}.fix`, { channel: selectedDiscordLabel }) }}
          </li>
        </ul>
        <p v-if="formError" class="db-field-error" role="alert" data-testid="pair-error">{{ formError }}</p>

        <div class="db-actions">
          <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="pair-add">
            <Icon name="plus" :size="14" aria-hidden="true" />
            {{ t('discordBridge.pairs.add') }}
          </button>
        </div>
      </form>

      <p class="db-muted discord-side">
        <i18n-t keypath="discordBridge.pairs.fromDiscord" tag="span" scope="global">
          <template #command><code class="db-inline-code">/bridge link</code></template>
          <template #copyId><span class="db-ui">{{ t('channel.copyId') }}</span></template>
        </i18n-t>
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import {
  PAIR_DIRECTIONS,
  discordChannelIssues,
  groupDiscordTextChannels,
  groupHarmonyTextChannels,
  isBlockingIssue,
  matchChannelsByName,
  parseSnapshotGuilds,
  type BridgePairRow,
  type ChannelIssue,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
  type PairDirection,
  type SnapshotChannel,
} from '@/utils/discordBridgeSetup'
import { cancelImports, pairChannels, startImports, unpairChannel, type ImportJob } from './bridgeApi'
import BridgeChannelSelect from './BridgeChannelSelect.vue'
import BridgeImportControls from './BridgeImportControls.vue'
import { importAvailability, importBlock, isImportablePair } from './importProgress'
import { bridgeErrorKey } from './bridgeErrors'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairs: BridgePairRow[]
  harmonyChannels: HarmonyChannelOption[]
  imports?: ImportJob[]
  /** Harmony channels whose messages are end-to-end encrypted; they cannot import. */
  encryptedChannelIds?: string[]
  /** bridge_attachment_mode; null when the caller cannot read it. */
  attachmentMode?: string | null
  /** bridge_history_import: 'self_run' admits self-run bridges, 'all' every bridge; anything else is off. */
  importMode?: string | null
}>()

const emit = defineEmits<{ changed: [] }>()

const ARROWS: Record<PairDirection, string> = { both: '⇄', to_harmony: '←', to_discord: '→' }

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-pairs-${useId()}`

const harmonyId = ref('')
const discordId = ref('')
const direction = ref<PairDirection>('both')
const busy = ref(false)
const formError = ref('')

const guild = computed(() => {
  const guilds = parseSnapshotGuilds(props.bridge.snapshot)
  return guilds.find((g) => g.id === props.bridge.discord_guild_id) ?? null
})
const discordChannels = computed(() => guild.value?.channels ?? [])
const pairedHarmony = computed(() => new Set(props.pairs.map((p) => p.harmony_channel_id)))
const pairedDiscord = computed(() => new Set(props.pairs.map((p) => p.discord_channel_id)))

const harmonyGroups = computed(() => groupHarmonyTextChannels(props.harmonyChannels, pairedHarmony.value))

const discordGroups = computed(() =>
  groupDiscordTextChannels(guild.value)
    .map((g) => ({ ...g, channels: g.channels.filter((c) => !pairedDiscord.value.has(c.id)) }))
    .filter((g) => g.channels.length > 0),
)

function discordOptionLabel(channel: SnapshotChannel): string {
  const issues = discordChannelIssues(channel, direction.value)
  if (issues.length === 0) return `#${channel.name}`
  return t('discordBridge.pairs.optionWithIssue', { name: channel.name, issue: t(`discordBridge.pairs.issue.${issues[0]}.short`) })
}

const selectedDiscord = computed(() => discordChannels.value.find((c) => c.id === discordId.value) ?? null)
const selectedDiscordLabel = computed(() => (selectedDiscord.value ? `#${selectedDiscord.value.name}` : ''))
const selectedIssues = computed<ChannelIssue[]>(() =>
  selectedDiscord.value ? discordChannelIssues(selectedDiscord.value, direction.value) : [],
)

const availability = computed(() => importAvailability(props.bridge, props.importMode))
const importsSupported = computed(() => availability.value === 'ok')

/** The pair's newest job; a restarted job keeps its row, so there is normally one. */
function jobFor(pair: BridgePairRow): ImportJob | null {
  const jobs = (props.imports ?? []).filter((j) => j.harmony_channel_id === pair.harmony_channel_id)
  return jobs.reduce<ImportJob | null>((newest, j) => (!newest || j.created_at >= newest.created_at ? j : newest), null)
}

function channelFor(pair: BridgePairRow): { encrypted: boolean } {
  return { encrypted: (props.encryptedChannelIds ?? []).includes(pair.harmony_channel_id) }
}

// Import all queues importable pairs with no job or a failed, cancelled or paused one. A finished
// pair is re-run only by its own Import again: queueing it would reset its cursors and re-walk
// the whole history.
const importAllIds = computed(() =>
  props.pairs
    .filter((p) => isImportablePair(p, channelFor(p)))
    .filter((p) => {
      const state = jobFor(p)?.state
      return state === undefined || state === 'failed' || state === 'cancelled' || state === 'paused'
    })
    .map((p) => p.harmony_channel_id),
)
const activeJobCount = computed(
  () => (props.imports ?? []).filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'paused').length,
)
// Once nothing is left for Import all and nothing is running, Import all again re-runs every
// finished pair (as each one's Import again would), after a confirm: each re-walks its history,
// skipping messages already imported.
const importAgainIds = computed(() => {
  if (importAllIds.value.length > 0 || activeJobCount.value > 0) return []
  return props.pairs
    .filter((p) => isImportablePair(p, channelFor(p)) && jobFor(p)?.state === 'done')
    .map((p) => p.harmony_channel_id)
})
// Every start goes through the consent dialog: `again` adds the question of a second run.
const pending = ref<{ ids: string[]; again: boolean } | null>(null)
const consent = ref(false)
// Second consent, for Discord channels hidden from @everyone. Unticked, those are left out.
const includePrivate = ref(false)
const consentDialog = ref<HTMLElement | null>(null)

/** Harmony channels whose Discord side @everyone cannot read, as the bridge (2.8.0) reports it. */
const privateHarmonyIds = computed(() => {
  const ids = new Set<string>()
  for (const pair of props.pairs) {
    const discord = discordChannels.value.find((c) => c.id === pair.discord_channel_id)
    if (discord?.everyoneCanView === false) ids.add(pair.harmony_channel_id)
  }
  return ids
})
const pendingPrivateNames = computed(() =>
  (pending.value?.ids ?? [])
    .filter((id) => privateHarmonyIds.value.has(id))
    .map((id) => {
      const pair = props.pairs.find((p) => p.harmony_channel_id === id)
      const discord = discordChannels.value.find((c) => c.id === pair?.discord_channel_id)
      return `#${discord?.name ?? pair?.discord_channel_name ?? pair?.discord_channel_id ?? id}`
    }),
)
const pendingStartIds = computed(() =>
  (pending.value?.ids ?? []).filter((id) => includePrivate.value || !privateHarmonyIds.value.has(id)),
)

async function askImport(ids: string[], again: boolean) {
  if (ids.length === 0) return
  consent.value = false
  includePrivate.value = false
  pending.value = { ids, again }
  await nextTick()
  consentDialog.value?.scrollIntoView?.({ block: 'nearest' })
  consentDialog.value?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus()
}

async function confirmImport() {
  const ids = pendingStartIds.value
  if (!consent.value || ids.length === 0) return
  const withPrivate = includePrivate.value && pendingPrivateNames.value.length > 0
  pending.value = null
  await startImport(ids, withPrivate)
}

const pairRows = computed(() =>
  props.pairs.map((pair) => {
    const discord = discordChannels.value.find((c) => c.id === pair.discord_channel_id) ?? null
    const harmony = props.harmonyChannels.find((c) => c.id === pair.harmony_channel_id)
    return {
      pair,
      discord,
      job: jobFor(pair),
      block: importBlock(pair, channelFor(pair)),
      harmonyName: harmony?.name ?? pair.harmony_channel_id,
      discordName: discord?.name ?? pair.discord_channel_name ?? pair.discord_channel_id,
      private: discord?.everyoneCanView === false,
      issues: discord ? discordChannelIssues(discord, pair.direction) : [],
    }
  }),
)

const matches = computed(() => matchChannelsByName(props.harmonyChannels, discordChannels.value, props.pairs))

watch([harmonyId, discordId, direction], () => (formError.value = ''))

async function add() {
  formError.value = ''
  if (!harmonyId.value || !discordId.value) {
    formError.value = t('discordBridge.pairs.validation.both')
    return
  }
  const blocking = selectedIssues.value.find(isBlockingIssue)
  if (blocking) {
    formError.value = t('discordBridge.pairs.validation.blocked', { channel: selectedDiscordLabel.value })
    return
  }
  busy.value = true
  try {
    await pairChannels(props.bridge.id, harmonyId.value, discordId.value, direction.value)
    harmonyId.value = ''
    discordId.value = ''
    direction.value = 'both'
    emit('changed')
  } catch (error) {
    debug.error('discord_bridge_pair failed:', error)
    formError.value = t(bridgeErrorKey(error, 'discordBridge.errors.pair'))
  } finally {
    busy.value = false
  }
}

async function remove(pair: BridgePairRow) {
  busy.value = true
  try {
    await unpairChannel(props.bridge.id, pair.harmony_channel_id)
    emit('changed')
  } catch (error) {
    debug.error('discord_bridge_unpair failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.unpair')))
  } finally {
    busy.value = false
  }
}

async function startImport(harmonyChannelIds: string[] | null, includePrivateChannels = false) {
  busy.value = true
  try {
    await startImports(props.bridge.id, harmonyChannelIds, includePrivateChannels)
  } catch (error) {
    debug.error('discord_bridge_import_start failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.import')))
  } finally {
    busy.value = false
  }
  emit('changed')
}

async function cancelImport(importId: string | null) {
  busy.value = true
  try {
    await cancelImports(props.bridge.id, importId)
  } catch (error) {
    debug.error('discord_bridge_import_cancel failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.cancelImport')))
  } finally {
    busy.value = false
  }
  emit('changed')
}

async function pairMatches() {
  busy.value = true
  let done = 0
  let failed = 0
  for (const match of matches.value) {
    try {
      await pairChannels(props.bridge.id, match.harmony.id, match.discord.id, 'both')
      done++
    } catch (error) {
      debug.error('discord_bridge_pair failed:', error)
      failed++
    }
  }
  busy.value = false
  if (done) toast.success(t('discordBridge.pairs.match.done', { count: done }, done))
  if (failed) toast.error(t('discordBridge.pairs.match.failed', { count: failed }, failed))
  emit('changed')
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.empty {
  color: var(--text-secondary);
}

.import-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.import-toolbar .db-muted {
  margin: 0;
}

.import-again-confirm {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--text-primary);
}

.import-again-confirm p {
  margin: 0 0 8px;
}

.import-consent-list {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.import-consent-check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.import-consent-check input {
  margin-top: 3px;
  flex-shrink: 0;
}

.import-private {
  margin: 0 0 10px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--warning);
  background: var(--background-primary);
}

.import-private-title {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.import-private-title :deep(.icon-wrap) {
  margin-top: 3px;
  flex-shrink: 0;
}

.import-private-lead {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.import-private .import-consent-check {
  margin-bottom: 0;
}

.pair-private {
  display: inline-flex;
  vertical-align: -1px;
  margin-left: 4px;
  color: var(--text-secondary);
}

.match-box {
  padding: 14px;
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px dashed var(--harmony-primary);
}

.match-list {
  margin: 0 0 12px;
  padding-left: 18px;
  font-size: 14px;
  color: var(--text-primary);
}

.discord-side {
  margin-top: 16px;
}
</style>
