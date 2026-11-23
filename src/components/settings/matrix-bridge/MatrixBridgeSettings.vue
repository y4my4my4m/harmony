<template>
  <section class="matrix-bridge" :aria-labelledby="`${uid}-title`" data-testid="matrix-bridge">
    <div class="settings-section">
      <h3 :id="`${uid}-title`" class="section-title">{{ t('matrixBridge.title') }}</h3>
      <p class="section-description">{{ t('matrixBridge.description') }}</p>
    </div>

    <div v-if="loading" class="loading-state" role="status">
      <LoadingSpinner :size="32" />
      <span>{{ t('matrixBridge.loading') }}</span>
    </div>

    <div v-else-if="error === 'loadError'" class="db-banner db-banner--error" role="alert" data-testid="matrix-bridge-error">
      <p>{{ t('matrixBridge.loadError') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-testid="matrix-bridge-reload" @click="reload">
          {{ t('matrixBridge.reload') }}
        </button>
      </div>
    </div>

    <template v-else>
      <MatrixBridgeStatus :pairs="rows" />

      <section class="db-card" :aria-labelledby="`${uid}-pairs`">
        <h3 :id="`${uid}-pairs`" ref="pairsTitle" class="db-card-title focus-target" tabindex="-1">{{ t('matrixBridge.pairs.title') }}</h3>
        <div v-if="notice" class="db-banner db-banner--success" role="status" data-testid="matrix-bridge-notice">
          <p>{{ notice }}</p>
        </div>
        <div v-if="error === 'saveError'" class="db-banner db-banner--error" role="alert" data-testid="matrix-bridge-error">
          <p>{{ t('matrixBridge.saveError') }}</p>
        </div>

        <MatrixBridgePairs v-if="rows.length" :rows="rows" :saving="saving" :disabled="!!saving || !!error || busy" @mode="save" />
        <p v-else class="db-text empty" data-testid="matrix-bridge-empty">{{ t('matrixBridge.pairs.empty') }}</p>

        <div v-if="setupError" class="db-banner db-banner--warn" role="status" data-testid="matrix-setup-load-error">
          <p>{{ t('matrixBridge.errors.installs') }}</p>
        </div>
        <template v-else>
          <MatrixBridgeSetupForm
            v-if="formOpen"
            :key="formKey"
            :installs="usable"
            :channels="channels"
            :bound="bound"
            :initial-bot-id="initialBotId"
            :editing="rows.length > 0"
            :busy="busy"
            :error="formError"
            :autofocus="editing"
            @save="pair"
            @cancel="cancelEdit"
          />
          <div v-else-if="rows.length && usable.length" class="db-actions">
            <button ref="editButton" type="button" class="btn btn-secondary btn-sm" :disabled="busy || !!error" data-testid="matrix-edit" @click="openEdit">
              <Icon name="pencil" :size="14" aria-hidden="true" />
              {{ t('matrixBridge.pairs.edit') }}
            </button>
          </div>
          <p v-for="bot in notOwned" :key="bot.id" class="db-muted not-owner" data-testid="matrix-not-owner">
            {{ t('matrixBridge.pairs.notOwner', { bot: bot.name }) }}
          </p>
          <MatrixBridgeGuide
            v-if="!usable.length || !rows.length"
            :blocked="usable.length ? [] : blocked"
            :show-steps="!rows.length && !usable.length"
          />
        </template>

        <details v-if="rows.length" class="db-details modes" data-testid="matrix-modes">
          <summary>{{ t('matrixBridge.modes.title') }}</summary>
          <p class="db-muted">{{ t('matrixBridge.modes.ghost') }}</p>
          <p class="db-muted">{{ t('matrixBridge.modes.relay') }}</p>
          <p class="db-muted">{{ t('matrixBridge.modes.future') }}</p>
          <p class="db-muted">{{ t('matrixBridge.modes.verify') }}</p>
        </details>

        <div class="db-actions db-actions--end">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="!!saving || busy" data-testid="matrix-bridge-reload" @click="reload">
            {{ t('matrixBridge.reload') }}
          </button>
        </div>
      </section>

      <section v-if="rows.length" class="db-card" :aria-labelledby="`${uid}-privacy`">
        <h3 :id="`${uid}-privacy`" class="db-card-title">{{ t('discordBridge.privacy.title') }}</h3>
        <BridgePrivacyPanel :server-id="serverId" platform="matrix" />
      </section>

      <section v-if="rows.length" class="db-card danger" :aria-labelledby="`${uid}-unpair`" data-testid="matrix-unpair-card">
        <h3 :id="`${uid}-unpair`" class="db-card-title">{{ t('matrixBridge.unpair.title') }}</h3>
        <p class="db-muted">{{ t('matrixBridge.unpair.lead') }}</p>
        <div v-if="unpairError" class="db-banner db-banner--error" role="alert" data-testid="matrix-unpair-error">
          <p>{{ unpairError }}</p>
        </div>
        <ul class="unpair-list">
          <li v-for="bot in botsInUse" :key="bot.id">
            <span class="unpair-what">{{ t('matrixBridge.unpair.item', { bot: bot.name, count: bot.count }, bot.count) }}</span>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="busy || !!saving"
              :aria-label="t('matrixBridge.unpair.label', { bot: bot.name })"
              data-testid="matrix-unpair"
              @click="unpair(bot)"
            >
              {{ t('matrixBridge.unpair.button') }}
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfileStore } from '@/stores/useProfile'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import BridgePrivacyPanel from '@/components/settings/discord-bridge/BridgePrivacyPanel.vue'
import { fetchServerTextChannels } from '@/components/settings/discord-bridge/bridgeApi'
import type { HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import MatrixBridgeGuide from './MatrixBridgeGuide.vue'
import MatrixBridgePairs from './MatrixBridgePairs.vue'
import MatrixBridgeSetupForm from './MatrixBridgeSetupForm.vue'
import MatrixBridgeStatus from './MatrixBridgeStatus.vue'
import {
  configureMatrixBridge,
  fetchOwnedBotInstalls,
  fetchServerMatrixBridges,
  isMatrixSenderMode,
  matrixBotBlock,
  matrixBridgeErrorKey,
  matrixPairKey as pairKey,
  setMatrixBridgeSenderMode,
  unconfigureMatrixBridge,
  type MatrixBotBlock,
  type MatrixBotInstall,
  type MatrixBridgePair,
} from './matrixBridgeApi'

interface BotInUse {
  id: string
  name: string
  count: number
}

const props = defineProps<{ serverId: string }>()
const { t } = useI18n()
const profile = useProfileStore()
const { confirm } = useConfirmDialog()
const uid = `matrix-bridge-${useId()}`
const rows = ref<MatrixBridgePair[]>([])
/** The caller's bots installed in the server, and the server's text channels: the setup path. */
const installs = ref<MatrixBotInstall[]>([])
const channels = ref<HarmonyChannelOption[]>([])
const setupError = ref(false)
const loading = ref(false)
const saving = ref<string | null>(null)
/** A configure or unconfigure call is in flight. */
const busy = ref(false)
const error = ref<'loadError' | 'saveError' | null>(null)
const formError = ref('')
const unpairError = ref('')
const notice = ref('')
const editing = ref(false)
const formKey = ref(0)
const pairsTitle = ref<HTMLElement | null>(null)
const editButton = ref<HTMLButtonElement | null>(null)
/** Load generation; a response for an earlier server, profile or mount is dropped. */
let revision = 0

const textChannelIds = computed(() => channels.value.map(channel => channel.id))
const usable = computed(() => installs.value.filter(install => matrixBotBlock(install, textChannelIds.value) === null))
const blocked = computed(() => installs.value.flatMap((install) => {
  const block = matrixBotBlock(install, textChannelIds.value)
  return block ? [{ bot_id: install.bot_id, bot_display_name: install.bot_display_name, block: block as MatrixBotBlock }] : []
}))
const botsInUse = computed<BotInUse[]>(() => {
  const bots = new Map<string, BotInUse>()
  for (const row of rows.value) {
    const bot = bots.get(row.bot_id) ?? { id: row.bot_id, name: row.bot_display_name, count: 0 }
    bot.count++
    bots.set(row.bot_id, bot)
  }
  return [...bots.values()]
})
const bound = computed(() => {
  const byBot: Record<string, string[]> = {}
  for (const row of rows.value) (byBot[row.bot_id] ??= []).push(row.channel_id)
  return byBot
})
/** Bots in use that the caller does not own: configure_matrix_bridge is the owner's. */
const notOwned = computed(() => botsInUse.value.filter(bot => !installs.value.some(install => install.bot_id === bot.id)))
const initialBotId = computed(() => botsInUse.value.find(bot => usable.value.some(install => install.bot_id === bot.id))?.id ?? null)
const formOpen = computed(() => usable.value.length > 0 && (editing.value || rows.value.length === 0))

/** true when this load is still the current one at its end. */
async function load(): Promise<boolean> {
  const request = ++revision
  rows.value = []
  installs.value = []
  channels.value = []
  saving.value = null
  busy.value = false
  error.value = null
  setupError.value = false
  formError.value = ''
  unpairError.value = ''
  editing.value = false
  loading.value = true
  const profileId = profile.profileId
  const [pairs, owned, textChannels] = await Promise.allSettled([
    fetchServerMatrixBridges(props.serverId),
    profileId ? fetchOwnedBotInstalls(props.serverId, profileId) : Promise.resolve([]),
    fetchServerTextChannels(props.serverId),
  ])
  if (request !== revision) return false
  if (pairs.status === 'fulfilled') rows.value = pairs.value
  else error.value = 'loadError'
  if (owned.status === 'fulfilled' && textChannels.status === 'fulfilled') {
    installs.value = owned.value
    channels.value = textChannels.value
  } else {
    setupError.value = true
  }
  formKey.value++
  loading.value = false
  return true
}

function reload(): void {
  notice.value = ''
  void load()
}

async function focusPairs(): Promise<void> {
  await nextTick()
  pairsTitle.value?.focus()
}

function openEdit(): void {
  notice.value = ''
  formError.value = ''
  formKey.value++
  editing.value = true
}

async function cancelEdit(): Promise<void> {
  editing.value = false
  formError.value = ''
  await nextTick()
  editButton.value?.focus()
}

/** configure_matrix_bridge replaces the bot's channels in the server with `channelIds`. */
async function pair(botId: string, channelIds: string[]): Promise<void> {
  if (busy.value || loading.value) return
  const request = revision
  busy.value = true
  formError.value = ''
  notice.value = ''
  try {
    await configureMatrixBridge(botId, props.serverId, channelIds)
  } catch (err) {
    if (request === revision) {
      formError.value = t(`matrixBridge.errors.${matrixBridgeErrorKey(err)}`)
      busy.value = false
    }
    return
  }
  if (request !== revision || !(await load())) return
  notice.value = t('matrixBridge.setup.saved', { count: channelIds.length }, channelIds.length)
  await focusPairs()
}

async function unpair(bot: BotInUse): Promise<void> {
  if (busy.value || loading.value) return
  const request = revision
  const confirmed = await confirm({
    title: t('matrixBridge.unpair.confirmTitle', { bot: bot.name }),
    message: t('matrixBridge.unpair.confirmMessage', { bot: bot.name, count: bot.count }, bot.count),
    confirmButtonText: t('matrixBridge.unpair.button'),
    dangerAction: true,
  })
  if (!confirmed || request !== revision || busy.value) return
  busy.value = true
  notice.value = ''
  unpairError.value = ''
  try {
    await unconfigureMatrixBridge(bot.id, props.serverId)
  } catch {
    if (request === revision) {
      unpairError.value = t('matrixBridge.errors.unpair')
      busy.value = false
    }
    return
  }
  if (request !== revision || !(await load())) return
  notice.value = t('matrixBridge.unpair.done', { bot: bot.name })
  await focusPairs()
}

/** The select shows the saved mode until the server confirms another. */
async function save(row: MatrixBridgePair, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const mode = select.value
  select.value = row.sender_mode
  if (loading.value || busy.value || saving.value || error.value || !isMatrixSenderMode(mode)) return
  const request = revision
  const key = pairKey(row)
  saving.value = key
  try {
    const updated = await setMatrixBridgeSenderMode(row.bot_id, row.channel_id, mode)
    if (request === revision) rows.value = rows.value.map(item => (pairKey(item) === key ? updated : item))
  } catch {
    if (request === revision) error.value = 'saveError'
  } finally {
    if (request === revision) saving.value = null
  }
}

watch([() => props.serverId, () => profile.profileId], reload, { immediate: true })
onBeforeUnmount(() => { revision++ })
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.matrix-bridge {
  margin-bottom: 32px;
  max-width: 860px;
}

.settings-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  color: var(--text-secondary);
}

.focus-target:focus {
  outline: none;
}

.focus-target:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.empty {
  color: var(--text-secondary);
}

.not-owner {
  margin-top: 12px;
}

.modes {
  margin-top: 16px;
}

.modes .db-muted:last-child {
  margin-bottom: 0;
}

.danger {
  border-color: color-mix(in srgb, var(--error) 40%, var(--background-quaternary));
}

.unpair-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.unpair-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.unpair-what {
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
