import { PERMISSION_BIT, type PermissionName } from '../auth/botPermissions.js'

// Application command limits, Discord's. COMMAND_NAME lacks Discord's \p{sc=Deva} and \p{sc=Thai}
// classes, so combining marks of those scripts are refused.
export const COMMAND_NAME = /^[-_\p{L}\p{N}]{1,32}$/u
export const MAX_COMMANDS = 100
export const MAX_OPTIONS = 25
export const MAX_CHOICES = 25
export const DESCRIPTION_MAX = 100
export const CHOICE_NAME_MAX = 100
export const CHOICE_STRING_MAX = 100
export const STRING_LENGTH_MAX = 6000
// Names, descriptions and choice names and values of one command, summed.
export const COMBINED_TEXT_MAX = 8000
// INTEGER and NUMBER values lie within ±2^53.
const NUMBER_BOUND = 2 ** 53

export const OPTION_TYPE = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11,
} as const

const SUPPORTED_TYPES = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 10])
const UNSUPPORTED_TYPES: Readonly<Record<number, string>> = { 9: 'MENTIONABLE', 11: 'ATTACHMENT' }
const NUMERIC_TYPES = new Set<number>([OPTION_TYPE.INTEGER, OPTION_TYPE.NUMBER])
const CHOICE_TYPES = new Set<number>([OPTION_TYPE.STRING, OPTION_TYPE.INTEGER, OPTION_TYPE.NUMBER])

export const DEFAULT_MEMBER_PERMISSIONS_ERROR =
  'default_member_permissions is not supported; use required_permissions with Harmony permission names'

export interface CommandChoice {
  name: string
  value: string | number
}

export interface CommandOption {
  type: number
  name: string
  description: string
  required?: boolean
  choices?: CommandChoice[]
  min_value?: number
  max_value?: number
  min_length?: number
  max_length?: number
  options?: CommandOption[]
}

export interface CommandDefinition {
  name: string
  description: string
  options: CommandOption[]
  required_permissions: PermissionName[]
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

class DefinitionError extends Error {
  constructor(path: string, problem: string) {
    super(path ? `${path}: ${problem}` : problem)
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Characters as code points, as Postgres char_length counts them.
function chars(value: string): number {
  return [...value].length
}

function at(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key
}

function name(value: unknown, path: string): string {
  if (typeof value !== 'string' || !COMMAND_NAME.test(value)) {
    throw new DefinitionError(path, 'must be 1-32 letters, digits, - or _')
  }
  if (value !== value.toLowerCase()) throw new DefinitionError(path, 'must be lowercase')
  return value
}

function description(value: unknown, path: string): string {
  if (typeof value !== 'string' || chars(value) < 1 || chars(value) > DESCRIPTION_MAX) {
    throw new DefinitionError(path, `must be 1-${DESCRIPTION_MAX} characters`)
  }
  return value
}

function bound(value: unknown, path: string, integer: boolean): number {
  if (integer ? !Number.isSafeInteger(value) : typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DefinitionError(path, integer ? 'must be an integer' : 'must be a number')
  }
  if (Math.abs(value as number) > NUMBER_BOUND) throw new DefinitionError(path, 'must lie within ±2^53')
  return value as number
}

function length(value: unknown, path: string, min: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > STRING_LENGTH_MAX) {
    throw new DefinitionError(path, `must be an integer from ${min} to ${STRING_LENGTH_MAX}`)
  }
  return value as number
}

function choice(input: unknown, type: number, path: string): CommandChoice {
  if (!isObject(input)) throw new DefinitionError(path, 'must be an object')
  const label = input.name
  if (typeof label !== 'string' || chars(label) < 1 || chars(label) > CHOICE_NAME_MAX) {
    throw new DefinitionError(at(path, 'name'), `must be 1-${CHOICE_NAME_MAX} characters`)
  }
  const value = input.value
  if (type === OPTION_TYPE.STRING) {
    if (typeof value !== 'string' || chars(value) > CHOICE_STRING_MAX) {
      throw new DefinitionError(at(path, 'value'), `must be a string of at most ${CHOICE_STRING_MAX} characters`)
    }
    return { name: label, value }
  }
  return { name: label, value: bound(value, at(path, 'value'), type === OPTION_TYPE.INTEGER) }
}

type Level = 'command' | 'group' | 'subcommand'

function option(input: unknown, level: Level, path: string): CommandOption {
  if (!isObject(input)) throw new DefinitionError(path, 'must be an object')
  const type = input.type
  if (typeof type !== 'number' || !Number.isInteger(type)) {
    throw new DefinitionError(at(path, 'type'), 'must be an option type number')
  }
  if (UNSUPPORTED_TYPES[type]) {
    throw new DefinitionError(at(path, 'type'), `${type} (${UNSUPPORTED_TYPES[type]}) is not supported`)
  }
  if (!SUPPORTED_TYPES.has(type)) throw new DefinitionError(at(path, 'type'), `${type} is not an option type`)
  if (input.autocomplete !== undefined && input.autocomplete !== false) {
    throw new DefinitionError(at(path, 'autocomplete'), 'is not supported')
  }

  const out: CommandOption = {
    type,
    name: name(input.name, at(path, 'name')),
    description: description(input.description, at(path, 'description')),
  }

  if (type === OPTION_TYPE.SUB_COMMAND || type === OPTION_TYPE.SUB_COMMAND_GROUP) {
    if (type === OPTION_TYPE.SUB_COMMAND_GROUP && level !== 'command') {
      throw new DefinitionError(path, 'a subcommand group sits only at the top level of a command')
    }
    if (type === OPTION_TYPE.SUB_COMMAND && level === 'subcommand') {
      throw new DefinitionError(path, 'a subcommand holds no subcommands')
    }
    for (const key of ['choices', 'min_value', 'max_value', 'min_length', 'max_length']) {
      if (input[key] !== undefined) throw new DefinitionError(at(path, key), 'applies to value options only')
    }
    const childLevel: Level = type === OPTION_TYPE.SUB_COMMAND_GROUP ? 'group' : 'subcommand'
    out.options = options(input.options, childLevel, at(path, 'options'))
    if (type === OPTION_TYPE.SUB_COMMAND_GROUP && out.options.length === 0) {
      throw new DefinitionError(at(path, 'options'), 'a subcommand group holds at least one subcommand')
    }
    return out
  }

  if (level === 'group') throw new DefinitionError(path, 'a subcommand group holds only subcommands')
  if (input.options !== undefined) {
    throw new DefinitionError(at(path, 'options'), 'only subcommands and subcommand groups take options')
  }
  if (input.required !== undefined && typeof input.required !== 'boolean') {
    throw new DefinitionError(at(path, 'required'), 'must be a boolean')
  }
  out.required = input.required === true

  if (input.choices !== undefined) {
    if (!CHOICE_TYPES.has(type)) {
      throw new DefinitionError(at(path, 'choices'), 'only STRING, INTEGER and NUMBER options take choices')
    }
    if (!Array.isArray(input.choices) || input.choices.length > MAX_CHOICES) {
      throw new DefinitionError(at(path, 'choices'), `must be an array of at most ${MAX_CHOICES}`)
    }
    out.choices = input.choices.map((c, i) => choice(c, type, at(at(path, 'choices'), i)))
  }

  for (const key of ['min_value', 'max_value'] as const) {
    if (input[key] === undefined) continue
    if (!NUMERIC_TYPES.has(type)) throw new DefinitionError(at(path, key), 'applies to INTEGER and NUMBER options only')
    out[key] = bound(input[key], at(path, key), type === OPTION_TYPE.INTEGER)
  }
  if (out.min_value !== undefined && out.max_value !== undefined && out.min_value > out.max_value) {
    throw new DefinitionError(at(path, 'min_value'), 'exceeds max_value')
  }

  for (const key of ['min_length', 'max_length'] as const) {
    if (input[key] === undefined) continue
    if (type !== OPTION_TYPE.STRING) throw new DefinitionError(at(path, key), 'applies to STRING options only')
    out[key] = length(input[key], at(path, key), key === 'min_length' ? 0 : 1)
  }
  if (out.min_length !== undefined && out.max_length !== undefined && out.min_length > out.max_length) {
    throw new DefinitionError(at(path, 'min_length'), 'exceeds max_length')
  }
  return out
}

function options(input: unknown, level: Level, path: string): CommandOption[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input) || input.length > MAX_OPTIONS) {
    throw new DefinitionError(path, `must be an array of at most ${MAX_OPTIONS}`)
  }
  const out = input.map((o, i) => option(o, level, at(path, i)))

  const seen = new Set<string>()
  out.forEach((o, i) => {
    if (seen.has(o.name)) throw new DefinitionError(at(at(path, i), 'name'), `duplicate option name ${o.name}`)
    seen.add(o.name)
  })

  const nested = out.filter((o) => o.type === OPTION_TYPE.SUB_COMMAND || o.type === OPTION_TYPE.SUB_COMMAND_GROUP)
  if (nested.length > 0 && nested.length < out.length) {
    throw new DefinitionError(path, 'a command with subcommands takes no other options at its top level')
  }

  let optionalSeen = false
  out.forEach((o, i) => {
    if (o.required === undefined) return
    if (o.required && optionalSeen) {
      throw new DefinitionError(at(path, i), 'required options come before optional ones')
    }
    if (!o.required) optionalSeen = true
  })
  return out
}

function permissions(input: unknown, path: string): PermissionName[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new DefinitionError(path, 'must be an array of Harmony permission names')
  const out: PermissionName[] = []
  for (const value of input) {
    if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(PERMISSION_BIT, value)) {
      throw new DefinitionError(path, `unknown permission ${String(value)}`)
    }
    if (!out.includes(value as PermissionName)) out.push(value as PermissionName)
  }
  return out
}

function optionText(o: CommandOption): number {
  let total = chars(o.name) + chars(o.description)
  for (const c of o.choices ?? []) total += chars(c.name) + chars(String(c.value))
  for (const child of o.options ?? []) total += optionText(child)
  return total
}

function command(input: unknown, path: string): CommandDefinition {
  if (!isObject(input)) throw new DefinitionError(path, 'must be a command object')
  // null is what Discord command builders send when no permission is set; it gates nothing.
  if (input.default_member_permissions !== undefined && input.default_member_permissions !== null) {
    throw new DefinitionError('', DEFAULT_MEMBER_PERMISSIONS_ERROR)
  }
  if (input.type !== undefined && input.type !== 1) {
    throw new DefinitionError(at(path, 'type'), 'only chat input commands (type 1) are supported')
  }
  const out: CommandDefinition = {
    name: name(input.name, at(path, 'name')),
    description: description(input.description, at(path, 'description')),
    options: options(input.options, 'command', at(path, 'options')),
    required_permissions: permissions(input.required_permissions, at(path, 'required_permissions')),
  }
  const text = chars(out.name) + chars(out.description) + out.options.reduce((sum, o) => sum + optionText(o), 0)
  if (text > COMBINED_TEXT_MAX) {
    throw new DefinitionError(path, `names, descriptions and choices exceed ${COMBINED_TEXT_MAX} characters`)
  }
  return out
}

function run<T>(fn: () => T): Validation<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    if (error instanceof DefinitionError) return { ok: false, error: error.message }
    throw error
  }
}

/** One command of POST /commands, normalized: unknown fields dropped, defaults filled. */
export function validateCommand(input: unknown): Validation<CommandDefinition> {
  return run(() => command(input, ''))
}

/** The array of PUT /commands, normalized as validateCommand; names unique. */
export function validateCommands(input: unknown): Validation<CommandDefinition[]> {
  return run(() => {
    if (!Array.isArray(input)) throw new DefinitionError('', 'Body must be an array of commands')
    if (input.length > MAX_COMMANDS) throw new DefinitionError('', `At most ${MAX_COMMANDS} commands`)
    const out = input.map((c, i) => command(c, `[${i}]`))
    const seen = new Set<string>()
    for (const c of out) {
      if (seen.has(c.name)) throw new DefinitionError('', `Duplicate command name: ${c.name}`)
      seen.add(c.name)
    }
    return out
  })
}
