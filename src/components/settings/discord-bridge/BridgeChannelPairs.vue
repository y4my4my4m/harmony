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
      <ul v-else class="pair-list" :aria-label="t('discordBridge.pairs.listLabel')">
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
              <span class="pair-name">#{{ row.discordName }}</span>
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
          <ul v-if="row.issues.length || !row.discord" class="pair-fixes">
            <li v-if="!row.discord">{{ t('discordBridge.pairs.discordGoneFix') }}</li>
            <li v-for="issue in row.issues" :key="issue">{{ t(`discordBridge.pairs.issue.${issue}.fix`, { channel: `#${row.discordName}` }) }}</li>
          </ul>
        </li>
      </ul>

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
          <div class="db-field">
            <label :for="`${uid}-harmony`" class="db-label">{{ t('discordBridge.pairs.harmonyChannel') }}</label>
            <select :id="`${uid}-harmony`" v-model="harmonyId" class="db-select" data-testid="select-harmony">
              <option value="">{{ t('discordBridge.pairs.choose') }}</option>
              <template v-for="group in harmonyGroups" :key="group.label">
                <optgroup v-if="group.label" :label="group.label">
                  <option v-for="c in group.channels" :key="c.id" :value="c.id">#{{ c.name }}</option>
                </optgroup>
                <template v-else>
                  <option v-for="c in group.channels" :key="c.id" :value="c.id">#{{ c.name }}</option>
                </template>
              </template>
            </select>
          </div>

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
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import {
  PAIR_DIRECTIONS,
  discordChannelIssues,
  groupDiscordTextChannels,
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
import { pairChannels, unpairChannel } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairs: BridgePairRow[]
  harmonyChannels: HarmonyChannelOption[]
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

const harmonyGroups = computed(() => {
  const groups: { label: string; channels: HarmonyChannelOption[] }[] = []
  for (const channel of props.harmonyChannels) {
    if (pairedHarmony.value.has(channel.id)) continue
    const label = channel.categoryName ?? ''
    let group = groups.find((g) => g.label === label)
    if (!group) groups.push((group = { label, channels: [] }))
    group.channels.push(channel)
  }
  return groups
})

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

const pairRows = computed(() =>
  props.pairs.map((pair) => {
    const discord = discordChannels.value.find((c) => c.id === pair.discord_channel_id) ?? null
    const harmony = props.harmonyChannels.find((c) => c.id === pair.harmony_channel_id)
    return {
      pair,
      discord,
      harmonyName: harmony?.name ?? pair.harmony_channel_id,
      discordName: discord?.name ?? pair.discord_channel_name ?? pair.discord_channel_id,
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

.pair-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pair {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-primary);
  min-width: 0;
}

.pair-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.pair-channel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pair-platform {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.pair-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.pair-arrow {
  font-size: 18px;
  color: var(--harmony-primary);
}

.pair-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.pair-meta .remove {
  margin-left: auto;
}

.pair-fixes {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.5;
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

.add-form {
  padding-top: 4px;
}

.add-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.issue-list {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}

.issue-list li {
  padding: 8px 10px;
  border-radius: 6px;
}

.issue-list .blocking {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}

.issue-list .warning {
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

.discord-side {
  margin-top: 16px;
}

@media (max-width: 720px) {
  .add-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
