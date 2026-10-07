<template>
  <div data-testid="guild-picker">
    <template v-if="guilds.length === 0">
      <div class="db-banner db-banner--warn" role="status" data-testid="guild-none">
        <p>{{ t('discordBridge.guild.none') }}</p>
      </div>
      <div class="db-actions">
        <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
          <Icon name="external-link" :size="14" aria-hidden="true" />
          {{ t('discordBridge.actions.invite') }}
        </a>
      </div>
    </template>

    <template v-else-if="locked">
      <p class="db-text" data-testid="guild-locked">
        {{ t('discordBridge.guild.current', { name: currentName }) }}
      </p>
      <p class="db-muted">{{ t('discordBridge.guild.lockedHint') }}</p>
    </template>

    <template v-else-if="guilds.length === 1">
      <p class="db-text" data-testid="guild-single">
        {{ bridge.discord_guild_id === guilds[0].id
          ? t('discordBridge.guild.current', { name: guilds[0].name })
          : t('discordBridge.guild.selecting', { name: guilds[0].name }) }}
      </p>
      <p class="db-muted">{{ t('discordBridge.guild.onlyOne') }}</p>
      <div v-if="error" class="db-banner db-banner--error" role="alert">
        <p>{{ error }}</p>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="choose(guilds[0].id)">{{ t('discordBridge.common.retry') }}</button>
        </div>
      </div>
    </template>

    <form v-else @submit.prevent="choose(selected)">
      <fieldset class="guild-fieldset">
        <legend class="db-text">{{ t('discordBridge.guild.pick') }}</legend>
        <label
          v-for="guild in guilds"
          :key="guild.id"
          :class="['guild-option', { selected: selected === guild.id }]"
          :data-testid="`guild-${guild.id}`"
        >
          <input v-model="selected" type="radio" name="discord-guild" :value="guild.id" />
          <span class="guild-name">{{ guild.name }}</span>
          <span v-if="bridge.discord_guild_id === guild.id" class="db-badge db-badge--ok">{{ t('discordBridge.guild.chosen') }}</span>
        </label>
      </fieldset>
      <div v-if="error" class="db-banner db-banner--error" role="alert"><p>{{ error }}</p></div>
      <div class="db-actions">
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="busy || !selected || selected === bridge.discord_guild_id"
          data-testid="guild-save"
        >
          {{ t('discordBridge.guild.use') }}
        </button>
      </div>
    </form>

    <p v-if="guilds.length > 0 && inviteUrl" class="db-muted other-server">
      {{ t('discordBridge.guild.missing') }}
      <a :href="inviteUrl" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.actions.invite') }}</a>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { buildDiscordInviteUrl, parseSnapshotGuilds, type DiscordBridgeRow } from '@/utils/discordBridgeSetup'
import { setGuild } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairCount: number
}>()

const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const guilds = computed(() => parseSnapshotGuilds(props.bridge.snapshot))
const inviteUrl = computed(() => buildDiscordInviteUrl(props.bridge.discord_application_id))
const selected = ref(props.bridge.discord_guild_id ?? '')
const busy = ref(false)
const error = ref('')
let autoPicked = false

/** Pairs belong to the chosen guild's channels; switching under them would orphan them. */
const locked = computed(() => !!props.bridge.discord_guild_id && props.pairCount > 0)
const currentName = computed(
  () =>
    guilds.value.find((g) => g.id === props.bridge.discord_guild_id)?.name ??
    props.bridge.discord_guild_name ??
    props.bridge.discord_guild_id ??
    '',
)

async function choose(guildId: string) {
  if (!guildId) return
  busy.value = true
  error.value = ''
  try {
    await setGuild(props.bridge.id, guildId)
    emit('changed')
  } catch (err) {
    debug.error('discord_bridge_set_guild failed:', err)
    error.value = t(bridgeErrorKey(err, 'discordBridge.errors.setGuild'))
  } finally {
    busy.value = false
  }
}

/** The gateway also selects a sole guild on the next heartbeat; picking here skips the wait. */
function autoPick() {
  if (autoPicked || props.bridge.discord_guild_id || guilds.value.length !== 1) return
  autoPicked = true
  void choose(guilds.value[0].id)
}

watch(guilds, autoPick)
watch(
  () => props.bridge.discord_guild_id,
  (id) => {
    if (id) selected.value = id
  },
)
onMounted(autoPick)
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.guild-fieldset {
  border: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guild-fieldset legend {
  padding: 0;
  margin-bottom: 8px;
}

.guild-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-primary);
  cursor: pointer;
  min-height: 44px;
}

.guild-option.selected {
  border-color: var(--harmony-primary);
}

.guild-option:focus-within {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.guild-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.other-server {
  margin-top: 12px;
}
</style>
