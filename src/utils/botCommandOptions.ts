// Option values of a bot command as the options bar holds them, checked as invoke_bot_command
// checks them (20261110400001_bot_slash_commands.sql): types, required, choices, ranges, lengths.

import { BotOptionType, type BotCommandOption, type BotCommandValues } from '@/services/botCommandService'

/**
 * What one field holds. Text and number inputs use `text`; a choice list holds the choice index
 * in `text`. v-model on a number input stores a number there.
 */
export interface BotOptionField {
  text: string | number
  bool: boolean | null
  /** Picked member, channel or role id. */
  pick: string | null
}

export interface BotOptionProblem {
  /** Key under bots.commands.validation. */
  key: 'required' | 'integer' | 'number' | 'min' | 'max' | 'minLength' | 'maxLength' | 'choice' | 'pick'
  params?: Record<string, string | number>
}

export const emptyBotOptionField = (): BotOptionField => ({ text: '', bool: null, pick: null })

const INTEGER_RE = /^-?\d+$/

const isPicker = (option: BotCommandOption) =>
  option.type === BotOptionType.USER || option.type === BotOptionType.CHANNEL || option.type === BotOptionType.ROLE

const hasChoices = (option: BotCommandOption) => Array.isArray(option.choices) && option.choices.length > 0

/** Postgres char_length: code points. */
const codePoints = (text: string) => [...text].length

const textOf = (field: BotOptionField) => String(field.text ?? '')

/** Whether the field holds no value: an untouched optional option is left out of p_options. */
export function isBotOptionEmpty(option: BotCommandOption, field: BotOptionField): boolean {
  if (option.type === BotOptionType.BOOLEAN) return field.bool === null
  if (isPicker(option)) return field.pick === null && textOf(field).trim() === ''
  return textOf(field).trim() === ''
}

export function botOptionProblem(option: BotCommandOption, field: BotOptionField): BotOptionProblem | null {
  // A required true/false switch left alone reads false, as it shows.
  if (option.type === BotOptionType.BOOLEAN) return null
  if (isBotOptionEmpty(option, field)) return option.required ? { key: 'required' } : null

  if (isPicker(option)) return field.pick ? null : { key: 'pick' }

  if (hasChoices(option)) {
    const index = Number(field.text)
    return Number.isInteger(index) && option.choices![index] !== undefined ? null : { key: 'choice' }
  }

  if (option.type === BotOptionType.STRING) {
    const length = codePoints(textOf(field))
    if (typeof option.min_length === 'number' && length < option.min_length) return { key: 'minLength', params: { min: option.min_length } }
    if (typeof option.max_length === 'number' && length > option.max_length) return { key: 'maxLength', params: { max: option.max_length } }
    return null
  }

  const raw = textOf(field).trim()
  let value: number
  if (option.type === BotOptionType.INTEGER) {
    if (!INTEGER_RE.test(raw)) return { key: 'integer' }
    value = Number(raw)
    if (!Number.isSafeInteger(value)) return { key: 'integer' }
  } else {
    value = Number(raw)
    if (!Number.isFinite(value)) return { key: 'number' }
  }
  if (typeof option.min_value === 'number' && value < option.min_value) return { key: 'min', params: { min: option.min_value } }
  if (typeof option.max_value === 'number' && value > option.max_value) return { key: 'max', params: { max: option.max_value } }
  return null
}

/** p_options of invoke_bot_command: the leaf's options by name, empty optional ones left out. */
export function botOptionValues(options: readonly BotCommandOption[], fields: Record<string, BotOptionField>): BotCommandValues {
  const values: BotCommandValues = {}
  for (const option of options) {
    const field = fields[option.name] ?? emptyBotOptionField()
    if (option.type === BotOptionType.BOOLEAN) {
      if (field.bool !== null) values[option.name] = field.bool
      else if (option.required) values[option.name] = false
      continue
    }
    if (isBotOptionEmpty(option, field)) continue
    if (isPicker(option)) {
      if (field.pick) values[option.name] = field.pick
      continue
    }
    if (hasChoices(option)) {
      const choice = option.choices![Number(field.text)]
      if (choice) values[option.name] = choice.value
      continue
    }
    if (option.type === BotOptionType.STRING) values[option.name] = textOf(field)
    else values[option.name] = Number(textOf(field).trim())
  }
  return values
}
