<template>
  <form
    ref="formRef"
    class="bot-command-bar"
    data-testid="bot-command-bar"
    :aria-label="t('bots.commands.bar.label', { command: `/${command.fullName}` })"
    :aria-busy="busy ? 'true' : undefined"
    novalidate
    @submit.prevent="submit"
    @keydown="onKeydown"
  >
    <div class="bot-command-head">
      <span class="bot-command-badge">
        <Avatar :src="botAvatar" size="mini" class="bot-command-avatar" />
        <span class="bot-command-name">/{{ command.fullName }}</span>
      </span>
      <span class="bot-command-bot">{{ botName }}</span>
      <span v-if="leafDescription" class="bot-command-description">{{ leafDescription }}</span>
      <button
        type="button"
        class="bot-command-close"
        data-testid="bot-command-close"
        :aria-label="t('bots.commands.bar.close')"
        :title="t('bots.commands.bar.close')"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>

    <div class="bot-command-fields">
      <div
        v-for="option in command.options"
        :key="option.name"
        class="bot-command-field"
        :class="{ 'is-invalid': !!shownProblem(option) }"
      >
        <label
          v-if="option.type !== BotOptionType.BOOLEAN"
          class="bot-command-label"
          :for="fieldId(option)"
        >
          <span class="bot-command-option-name">{{ option.name }}</span>
          <span v-if="option.required" class="bot-command-required" aria-hidden="true">*</span>
          <span v-if="option.required" class="sr-only">{{ t('bots.commands.bar.required') }}</span>
        </label>
        <span v-else :id="`${fieldId(option)}-label`" class="bot-command-label">
          <span class="bot-command-option-name">{{ option.name }}</span>
          <span v-if="option.required" class="bot-command-required" aria-hidden="true">*</span>
          <span v-if="option.required" class="sr-only">{{ t('bots.commands.bar.required') }}</span>
        </span>

        <!-- Choice list -->
        <select
          v-if="hasChoices(option)"
          :id="fieldId(option)"
          v-model="fields[option.name].text"
          class="bot-command-input"
          :data-testid="`bot-command-option-${option.name}`"
          :aria-invalid="shownProblem(option) ? 'true' : 'false'"
          :aria-required="option.required ? 'true' : undefined"
          :aria-describedby="describedBy(option)"
          @change="touch(option)"
        >
          <option value="">{{ t('bots.commands.bar.choose') }}</option>
          <option v-for="(choice, index) in option.choices!" :key="index" :value="String(index)">{{ choice.name }}</option>
        </select>

        <!-- Text -->
        <input
          v-else-if="option.type === BotOptionType.STRING"
          :id="fieldId(option)"
          v-model="fields[option.name].text"
          type="text"
          class="bot-command-input"
          autocomplete="off"
          :data-testid="`bot-command-option-${option.name}`"
          :minlength="option.min_length ?? undefined"
          :maxlength="option.max_length ?? undefined"
          :aria-invalid="shownProblem(option) ? 'true' : 'false'"
          :aria-required="option.required ? 'true' : undefined"
          :aria-describedby="describedBy(option)"
          @blur="touch(option)"
        />

        <!-- Whole number or number -->
        <input
          v-else-if="option.type === BotOptionType.INTEGER || option.type === BotOptionType.NUMBER"
          :id="fieldId(option)"
          v-model="fields[option.name].text"
          type="number"
          class="bot-command-input bot-command-number"
          :inputmode="option.type === BotOptionType.INTEGER ? 'numeric' : 'decimal'"
          :step="option.type === BotOptionType.INTEGER ? 1 : 'any'"
          :min="option.min_value ?? undefined"
          :max="option.max_value ?? undefined"
          :data-testid="`bot-command-option-${option.name}`"
          :aria-invalid="shownProblem(option) ? 'true' : 'false'"
          :aria-required="option.required ? 'true' : undefined"
          :aria-describedby="describedBy(option)"
          @blur="touch(option)"
        />

        <!-- True / false -->
        <button
          v-else-if="option.type === BotOptionType.BOOLEAN"
          :id="fieldId(option)"
          type="button"
          role="switch"
          class="bot-command-switch"
          :class="{ on: fields[option.name].bool === true }"
          :aria-checked="fields[option.name].bool === true ? 'true' : 'false'"
          :aria-labelledby="`${fieldId(option)}-label`"
          :aria-describedby="describedBy(option)"
          :data-testid="`bot-command-option-${option.name}`"
          @click="toggle(option)"
        >
          <span class="bot-command-switch-track" aria-hidden="true"><span class="bot-command-switch-thumb"></span></span>
          <span class="bot-command-switch-text">{{ fields[option.name].bool === true ? t('bots.commands.bar.true') : t('bots.commands.bar.false') }}</span>
        </button>

        <!-- Member -->
        <div v-else-if="option.type === BotOptionType.USER" class="bot-command-member">
          <input
            :id="fieldId(option)"
            v-model="fields[option.name].text"
            type="text"
            role="combobox"
            class="bot-command-input"
            autocomplete="off"
            aria-autocomplete="list"
            :placeholder="t('bots.commands.bar.searchMembers')"
            :aria-expanded="memberListFor === option.name && memberMatches.length > 0 ? 'true' : 'false'"
            :aria-controls="`${fieldId(option)}-list`"
            :aria-activedescendant="memberListFor === option.name && memberMatches[memberIndex] ? `${fieldId(option)}-opt-${memberIndex}` : undefined"
            :data-testid="`bot-command-option-${option.name}`"
            :aria-invalid="shownProblem(option) ? 'true' : 'false'"
            :aria-required="option.required ? 'true' : undefined"
            :aria-describedby="describedBy(option)"
            @input="onMemberInput(option)"
            @focus="openMembers(option)"
            @blur="onMemberBlur(option)"
            @keydown="onMemberKeydown(option, $event)"
          />
          <ul
            v-show="memberListFor === option.name && memberMatches.length > 0"
            :id="`${fieldId(option)}-list`"
            role="listbox"
            class="bot-command-member-list"
            @mousedown.prevent
          >
            <li
              v-for="(member, index) in memberMatches"
              :id="`${fieldId(option)}-opt-${index}`"
              :key="member.id"
              role="option"
              class="bot-command-member-option"
              :class="{ selected: index === memberIndex }"
              :aria-selected="index === memberIndex ? 'true' : 'false'"
              @click="pickMember(option, member)"
              @mouseenter="memberIndex = index"
            >
              <Avatar :src="member.avatarUrl" size="xs" />
              <span class="bot-command-member-name">{{ member.displayName || member.username }}</span>
              <span class="bot-command-member-handle">{{ member.username }}</span>
            </li>
          </ul>
        </div>

        <!-- Channel or role -->
        <select
          v-else
          :id="fieldId(option)"
          v-model="fields[option.name].pick"
          class="bot-command-input"
          :data-testid="`bot-command-option-${option.name}`"
          :aria-invalid="shownProblem(option) ? 'true' : 'false'"
          :aria-required="option.required ? 'true' : undefined"
          :aria-describedby="describedBy(option)"
          @change="touch(option)"
        >
          <option :value="null">{{ option.type === BotOptionType.CHANNEL ? t('bots.commands.bar.chooseChannel') : t('bots.commands.bar.chooseRole') }}</option>
          <template v-if="option.type === BotOptionType.CHANNEL">
            <option v-for="channel in channelChoices" :key="channel.id" :value="channel.id">#{{ channel.name }}</option>
          </template>
          <template v-else>
            <option v-for="role in roleChoices" :key="role.id" :value="role.id">@{{ role.name }}</option>
          </template>
        </select>

        <span v-if="option.description" :id="`${fieldId(option)}-hint`" class="bot-command-hint">{{ option.description }}</span>
        <span
          v-if="shownProblem(option)"
          :id="`${fieldId(option)}-error`"
          class="bot-command-field-error"
        >{{ problemText(shownProblem(option)!) }}</span>
      </div>

      <button
        ref="sendRef"
        type="submit"
        class="bot-command-send"
        data-testid="bot-command-send"
        :disabled="busy"
        :aria-label="t('bots.commands.bar.send')"
        :title="t('bots.commands.bar.send')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
    </div>

    <p v-if="invokeError" class="bot-command-error" role="alert" data-testid="bot-command-error">{{ invokeError }}</p>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, useId, watch } from 'vue'
import { memberDirectory } from '@/services/memberDirectory'
import Avatar from '@/components/common/Avatar.vue'
import { useT } from '@/composables/useT'
import type { ActiveBotCommand } from '@/composables/useAutoSuggest'
import {
  BotCommandError,
  BotOptionType,
  invokeBotCommand,
  type BotCommandOption,
} from '@/services/botCommandService'
import { userDataService } from '@/services/userDataService'
import { roleService } from '@/services/RoleService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useBotInteractionsStore } from '@/stores/useBotInteractions'
import {
  botOptionProblem,
  botOptionValues,
  emptyBotOptionField,
  type BotOptionField,
  type BotOptionProblem,
} from '@/utils/botCommandOptions'
import { isImeKeyEvent } from '@/utils/editorShortcuts'
import { normalizeSearchText } from '@/utils/searchTokens'

const props = defineProps<{
  command: ActiveBotCommand
  /** Server of the channel; members, channels and roles of the pickers come from it. */
  serverId: string | null
}>()

const emit = defineEmits<{
  close: []
  invoked: [id: string]
}>()

const { t } = useT()
const serverChannelStore = useServerChannelStore()
const interactions = useBotInteractionsStore()

const formRef = ref<HTMLFormElement | null>(null)
const sendRef = ref<HTMLButtonElement | null>(null)
const busy = ref(false)
const invokeError = ref('')
const submitted = ref(false)
const touched = reactive<Record<string, boolean>>({})
const fields = reactive<Record<string, BotOptionField>>({})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const barId = `bot-command-${useId()}`

function resetFields() {
  for (const key of Object.keys(fields)) delete fields[key]
  for (const key of Object.keys(touched)) delete touched[key]
  for (const option of props.command.options) fields[option.name] = emptyBotOptionField()
  submitted.value = false
  invokeError.value = ''
}
resetFields()

const botName = computed(() => props.command.bot.display_name?.trim() || props.command.bot.username)
const botAvatar = computed(() => props.command.bot.avatar_url || '/default_avatar.webp')
const leafDescription = computed(() => {
  const path = props.command.path
  let options: BotCommandOption[] = props.command.command.options ?? []
  let description = props.command.command.description ?? ''
  for (const name of path) {
    const next = options.find((o) => o.name === name)
    if (!next) break
    if (next.description) description = next.description
    options = next.options ?? []
  }
  return description
})

const hasChoices = (option: BotCommandOption) => Array.isArray(option.choices) && option.choices.length > 0
const fieldId = (option: BotCommandOption) => `${barId}-${props.command.options.indexOf(option)}`

const problem = (option: BotCommandOption): BotOptionProblem | null =>
  botOptionProblem(option, fields[option.name] ?? emptyBotOptionField())

/** Problems show once the field was left or a send was tried. */
const shownProblem = (option: BotCommandOption): BotOptionProblem | null =>
  submitted.value || touched[option.name] ? problem(option) : null

function problemText(p: BotOptionProblem): string {
  return t(`bots.commands.validation.${p.key}`, p.params ?? {})
}

function describedBy(option: BotCommandOption): string | undefined {
  const ids: string[] = []
  if (option.description) ids.push(`${fieldId(option)}-hint`)
  if (shownProblem(option)) ids.push(`${fieldId(option)}-error`)
  return ids.length ? ids.join(' ') : undefined
}

function touch(option: BotCommandOption) {
  touched[option.name] = true
}

function toggle(option: BotCommandOption) {
  const field = fields[option.name]
  field.bool = field.bool !== true
  touch(option)
}

// --- Channels and roles ---

const channelChoices = computed(() =>
  serverChannelStore.channels.filter((c) => c.type === 0 && (!c.server_id || c.server_id === props.serverId)))

const roleChoices = ref<Array<{ id: string; name: string }>>([])
const needsRoles = computed(() => props.command.options.some((o) => o.type === BotOptionType.ROLE))
watch([() => props.serverId, needsRoles], async ([serverId, needed]) => {
  roleChoices.value = []
  if (!serverId || !needed) return
  try {
    const roles = await roleService.getRolesForServer(serverId)
    if (props.serverId === serverId) roleChoices.value = roles.map((r) => ({ id: r.id, name: r.name }))
  } catch {
    roleChoices.value = []
  }
}, { immediate: true })

// --- Members: the composer's '@' source, members of this server known to the client ---

interface MemberChoice {
  id: string
  username: string
  displayName: string
  avatarUrl?: string
}

const memberListFor = ref<string | null>(null)
const memberIndex = ref(0)
const MEMBER_LIMIT = 8

// A server whose member list is windowed holds the members near the sidebar's viewport: the
// instance finds the rest as the option is typed.
const foundMembers = ref<{ query: string; members: MemberChoice[] } | null>(null)
let memberSearchTimer: ReturnType<typeof setTimeout> | null = null
let memberSearchSeq = 0
watch(() => (memberListFor.value ? String(fields[memberListFor.value]?.text ?? '').trim() : ''), (text) => {
  if (memberSearchTimer) clearTimeout(memberSearchTimer)
  memberSearchTimer = null
  const seq = ++memberSearchSeq
  const serverId = props.serverId
  if (!text || !serverId || memberDirectory.serverId !== serverId || memberDirectory.mode !== 'windowed') {
    foundMembers.value = null
    return
  }
  memberSearchTimer = setTimeout(async () => {
    memberSearchTimer = null
    const found = await memberDirectory.searchMembers(serverId, text, MEMBER_LIMIT).catch(() => null)
    if (seq !== memberSearchSeq || !found) return
    foundMembers.value = {
      query: text,
      members: found.map(m => ({ id: m.id, username: m.username ?? '', displayName: m.display_name ?? m.username ?? '', avatarUrl: m.avatar_url ?? undefined })),
    }
  }, 150)
})

const memberMatches = computed<MemberChoice[]>(() => {
  const name = memberListFor.value
  if (!name || !props.serverId) return []
  const typed = String(fields[name]?.text ?? '').trim()
  const found = foundMembers.value
  if (found && found.query === typed) return found.members.slice(0, MEMBER_LIMIT)
  const query = normalizeSearchText(String(fields[name]?.text ?? ''))
  const seen = new Set<string>()
  const matches: MemberChoice[] = []
  for (const user of userDataService.getUsersInContext(props.serverId)) {
    if (!user?.id || seen.has(user.id) || !UUID_RE.test(user.id)) continue
    seen.add(user.id)
    const display = normalizeSearchText(user.displayName || '')
    const username = normalizeSearchText(user.username || '')
    if (query && !display.includes(query) && !username.includes(query)) continue
    matches.push({ id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl })
    if (matches.length >= MEMBER_LIMIT) break
  }
  return matches
})

function openMembers(option: BotCommandOption) {
  memberListFor.value = option.name
  memberIndex.value = 0
}

function onMemberInput(option: BotCommandOption) {
  fields[option.name].pick = null
  openMembers(option)
}

function onMemberBlur(option: BotCommandOption) {
  if (memberListFor.value === option.name) memberListFor.value = null
  touch(option)
}

function pickMember(option: BotCommandOption, member: MemberChoice) {
  const field = fields[option.name]
  field.pick = member.id
  field.text = member.displayName || member.username
  memberListFor.value = null
  touch(option)
}

function onMemberKeydown(option: BotCommandOption, event: KeyboardEvent) {
  if (isImeKeyEvent(event)) return
  const open = memberListFor.value === option.name && memberMatches.value.length > 0
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!open) openMembers(option)
    else memberIndex.value = Math.min(memberMatches.value.length - 1, memberIndex.value + 1)
  } else if (event.key === 'ArrowUp' && open) {
    event.preventDefault()
    memberIndex.value = Math.max(0, memberIndex.value - 1)
  } else if ((event.key === 'Enter' || event.key === 'Tab') && open && !fields[option.name].pick) {
    const member = memberMatches.value[memberIndex.value]
    if (!member) return
    event.preventDefault()
    event.stopPropagation()
    pickMember(option, member)
  } else if (event.key === 'Escape' && open) {
    event.preventDefault()
    event.stopPropagation()
    memberListFor.value = null
  }
}

// --- Keys and focus ---

function onKeydown(event: KeyboardEvent) {
  if (isImeKeyEvent(event)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  // Enter sends from every field; a focused button keeps its own Enter.
  if (event.key === 'Enter' && !event.shiftKey) {
    if (event.target instanceof HTMLButtonElement) return
    event.preventDefault()
    void submit()
  }
}

function focusFirst() {
  const first = formRef.value?.querySelector<HTMLElement>('.bot-command-field input, .bot-command-field select, .bot-command-field button')
  ;(first ?? sendRef.value)?.focus()
}

onMounted(() => nextTick(focusFirst))

watch(() => props.command, () => {
  resetFields()
  void nextTick(focusFirst)
})

// --- Invoke ---

function refusalText(error: BotCommandError): string {
  switch (error.code) {
    case 'forbidden': return t('bots.commands.errors.forbidden')
    case 'timed_out': return t('bots.commands.errors.timedOut')
    case 'thread_locked': return t('bots.commands.errors.threadLocked')
    case 'slowmode': return error.seconds !== null
      ? t('bots.commands.errors.slowmode', { seconds: error.seconds })
      : t('bots.commands.errors.slowmodeNoTime')
    case 'rate_limited': return error.seconds !== null
      ? t('bots.commands.errors.rateLimited', { seconds: error.seconds })
      : t('bots.commands.errors.rateLimitedNoTime')
    case 'invalid_option': return error.option
      ? t('bots.commands.errors.invalidOption', { name: error.option })
      : t('bots.commands.errors.invalidOptions')
    case 'unavailable': return t('bots.commands.errors.unavailable')
    default: return t('bots.commands.errors.failed')
  }
}

async function submit() {
  if (busy.value) return
  submitted.value = true
  invokeError.value = ''
  const invalid = props.command.options.find((option) => problem(option))
  if (invalid) {
    await nextTick()
    document.getElementById(fieldId(invalid))?.focus()
    return
  }
  const command = props.command
  busy.value = true
  try {
    const result = await invokeBotCommand({
      channelId: command.channelId,
      threadId: command.threadId,
      commandId: command.command.id,
      path: command.path,
      options: botOptionValues(command.options, fields),
    })
    interactions.addInvoked({
      result,
      bot: command.bot,
      channelId: command.channelId,
      threadId: command.threadId,
      commandName: command.fullName,
    })
    emit('invoked', result.id)
  } catch (error) {
    const refusal = error instanceof BotCommandError ? error : new BotCommandError('failed', String(error))
    if (refusal.code === 'bot_offline') {
      interactions.addLocalFailure({
        bot: command.bot,
        channelId: command.channelId,
        threadId: command.threadId,
        commandName: command.fullName,
        error: 'offline',
      })
      emit('close')
      return
    }
    invokeError.value = refusalText(refusal)
  } finally {
    busy.value = false
  }
}

defineExpose({ submit, focusFirst })
</script>

<style scoped>
.bot-command-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 10px;
  background: var(--background-quaternary);
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
  margin-bottom: 6px;
}

.bot-command-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bot-command-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 2px 4px;
  border-radius: 4px;
  background: var(--harmony-primary-alpha, color-mix(in srgb, var(--harmony-primary) 15%, transparent));
  color: var(--text-link);
  font-size: 12px;
  font-weight: 600;
  min-width: 0;
  flex-shrink: 1;
}

.bot-command-avatar {
  flex-shrink: 0;
  border-radius: 50%;
}

.bot-command-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-command-bot {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.bot-command-description {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.bot-command-close {
  margin-left: auto;
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: var(--text-muted);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bot-command-close:hover {
  background: color-mix(in srgb, var(--text-primary) 15%, transparent);
  color: var(--text-primary);
}

.bot-command-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
}

.bot-command-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
  flex: 1 1 160px;
  max-width: 100%;
}

.bot-command-label {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-command-required {
  color: var(--text-danger);
}

.bot-command-input {
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
}

.bot-command-input:focus-visible,
.bot-command-switch:focus-visible,
.bot-command-send:focus-visible,
.bot-command-close:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.bot-command-field.is-invalid .bot-command-input {
  border-color: var(--text-danger);
}

.bot-command-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.bot-command-field-error {
  font-size: 12px;
  color: var(--text-danger);
}

.bot-command-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  align-self: flex-start;
}

.bot-command-switch-track {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--background-modifier-active);
  border: 1px solid var(--border-color);
  transition: background-color 0.15s ease;
}

.bot-command-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: transform 0.15s ease, background-color 0.15s ease;
}

.bot-command-switch.on .bot-command-switch-track {
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border-color: transparent;
}

.bot-command-switch.on .bot-command-switch-thumb {
  transform: translateX(16px);
  background: var(--text-on-primary);
}

.bot-command-member {
  position: relative;
}

.bot-command-member-list {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quinary);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-large);
}

.bot-command-member-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  min-width: 0;
}

.bot-command-member-option.selected {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.bot-command-member-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-command-member-handle {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-command-member-option.selected .bot-command-member-handle {
  color: color-mix(in srgb, var(--text-on-primary) 80%, transparent);
}

.bot-command-send {
  flex-shrink: 0;
  margin-left: auto;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--harmony-primary-fill, var(--harmony-primary));
  color: var(--text-on-primary);
  cursor: pointer;
}

.bot-command-send:hover {
  background-color: var(--harmony-primary-fill-hover, var(--harmony-primary-fill, var(--harmony-primary)));
}

.bot-command-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.bot-command-send svg {
  margin-left: 2px;
}

.bot-command-error {
  margin: 0;
  font-size: 13px;
  color: var(--text-danger);
}

@media (max-width: 768px) {
  .bot-command-field {
    flex-basis: 100%;
  }

  .bot-command-send {
    width: 40px;
    height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bot-command-switch-track,
  .bot-command-switch-thumb {
    transition: none;
  }
}
</style>
