/**
 * Server template documents (db_schema/migrations/20261011000001_server_templates.sql).
 *
 * parseServerTemplate mirrors server_template_canonical's structural checks so a bad file is
 * refused before upload; create_server_from_template validates again and also checks what only
 * the database knows (welcome rules, AutoMod config).
 */
import { isServerCategory } from '@/utils/serverDiscovery'

export const SERVER_TEMPLATE_FORMAT = 'harmony.server-template'
export const SERVER_TEMPLATE_VERSION = 1
export const SERVER_TEMPLATE_EXTENSION = '.harmony-template.json'

/** Limits as server_template_canonical's. */
export const SERVER_TEMPLATE_LIMITS = {
  bytes: 2_000_000,
  roles: 250,
  categories: 25,
  channels: 100,
} as const

/** Bits 0..29, PERMISSION_BITS in RoleService and permission_bit_names() in SQL. */
const PERMISSION_MASK_MAX = 2 ** 30 - 1

/** Permissions that make @everyone more than a member: ADMINISTRATOR, MANAGE_CHANNELS,
 *  MANAGE_ROLES, MANAGE_SERVER, KICK_MEMBERS, BAN_MEMBERS, MANAGE_MESSAGES (bits 0, 2, 3, 7, 9,
 *  10, 21). */
const ELEVATED_MASK = 1 | 4 | 8 | 128 | 512 | 1024 | 2 ** 21

const REF_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/
const MASK_PATTERN = /^[0-9]{1,19}$/

export interface ServerTemplateRole {
  ref: string
  name: string
  color?: string | null
  position?: number
  permissions?: string | number
  is_default?: boolean
  is_admin?: boolean
  mentionable?: boolean
  hoist?: boolean
  unicode_emoji?: string | null
}

export interface ServerTemplateCategory {
  ref: string
  name: string
  order?: number
}

export interface ServerTemplateOverride {
  role: string
  allow?: string | number
  deny?: string | number
}

export interface ServerTemplateChannel {
  ref: string
  name: string
  description?: string | null
  type?: number
  order?: number
  slowmode_seconds?: number
  category?: string | null
  private?: boolean
  overrides?: ServerTemplateOverride[]
}

export interface ServerTemplate {
  format: typeof SERVER_TEMPLATE_FORMAT
  version: typeof SERVER_TEMPLATE_VERSION
  exported_at?: string
  server?: {
    name?: string
    description?: string | null
    public?: boolean
    allow_cross_server_emojis?: boolean
    rules?: string[]
    category?: string | null
  }
  roles?: ServerTemplateRole[]
  categories?: ServerTemplateCategory[]
  channels?: ServerTemplateChannel[]
  settings?: Record<string, unknown> | null
  welcome?: Record<string, unknown> | null
  automod?: Record<string, unknown> | null
}

export interface ServerTemplateSummary {
  name: string
  /** Roles other than @everyone and Admin, which every server has. */
  roles: number
  categories: number
  channels: number
  /** @everyone, or the default role, holds a moderation or administration permission. */
  elevatedEveryone: boolean
}

export type ServerTemplateErrorCode =
  | 'tooLarge'
  | 'notJson'
  | 'notTemplate'
  | 'unsupportedVersion'
  | 'tooManyRoles'
  | 'tooManyCategories'
  | 'tooManyChannels'
  | 'invalid'

export class ServerTemplateError extends Error {
  constructor(public code: ServerTemplateErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ServerTemplateError'
  }
}

export type ParsedServerTemplate =
  | { ok: true; template: ServerTemplate; summary: ServerTemplateSummary }
  | { ok: false; error: ServerTemplateError }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const invalid = (detail: string) => new ServerTemplateError('invalid', detail)

function list(value: unknown, path: string, max: number, tooMany?: ServerTemplateErrorCode): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`${path} is an array`)
  if (value.length > max) throw tooMany ? new ServerTemplateError(tooMany) : invalid(`${path} holds at most ${max} items`)
  return value
}

function text(value: unknown, path: string, max: number, required: boolean): void {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${path} is required`)
    return
  }
  if (typeof value !== 'string') throw invalid(`${path} is a string`)
  if ([...value].length > max) throw invalid(`${path} is at most ${max} characters`)
  if (required && value.trim() === '') throw invalid(`${path} must not be blank`)
}

function integer(value: unknown, path: string, min: number, max: number): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${path} is an integer from ${min} to ${max}`)
  }
}

function bool(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== 'boolean') throw invalid(`${path} is true or false`)
}

/** A permission mask as server_template_bits reads it; NaN when malformed. */
export function readPermissionMask(value: unknown): number {
  if (value === undefined || value === null) return 0
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && MASK_PATTERN.test(value)) n = Number(value)
  else return Number.NaN
  return Number.isInteger(n) && n >= 0 && n <= PERMISSION_MASK_MAX ? n : Number.NaN
}

function mask(value: unknown, path: string): void {
  if (Number.isNaN(readPermissionMask(value))) throw invalid(`${path} is a permission mask of bits 0 to 29`)
}

function ref(value: unknown, path: string): string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) throw invalid(`${path} is a ref`)
  return value
}

/** Throws ServerTemplateError for a document create_server_from_template would refuse on shape. */
export function validateServerTemplate(doc: unknown): asserts doc is ServerTemplate {
  if (!isObject(doc) || doc.format !== SERVER_TEMPLATE_FORMAT) throw new ServerTemplateError('notTemplate')
  if (doc.version !== SERVER_TEMPLATE_VERSION) throw new ServerTemplateError('unsupportedVersion', String(doc.version))

  const kinds = new Map<string, 'role' | 'category' | 'channel'>()
  const claim = (r: string, kind: 'role' | 'category' | 'channel') => {
    if (kinds.has(r)) throw invalid(`ref "${r}" is used more than once`)
    kinds.set(r, kind)
  }

  if (doc.server !== undefined && doc.server !== null) {
    if (!isObject(doc.server)) throw invalid('server is an object')
    const s = doc.server
    text(s.description, 'server.description', 500, false)
    bool(s.public, 'server.public')
    bool(s.allow_cross_server_emojis, 'server.allow_cross_server_emojis')
    list(s.rules, 'server.rules', 25).forEach((r, i) => text(r, `server.rules[${i}]`, 500, true))
    if (s.category !== undefined && s.category !== null && !isServerCategory(s.category)) {
      throw invalid('server.category is not a discovery category')
    }
  }

  let defaults = 0
  let admins = 0
  list(doc.roles, 'roles', SERVER_TEMPLATE_LIMITS.roles, 'tooManyRoles').forEach((role, i) => {
    const path = `roles[${i}]`
    if (!isObject(role)) throw invalid(`${path} is an object`)
    claim(ref(role.ref, `${path}.ref`), 'role')
    text(role.name, `${path}.name`, 100, true)
    if (role.color !== undefined && role.color !== null
        && (typeof role.color !== 'string' || !/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(role.color))) {
      throw invalid(`${path}.color is a hex color`)
    }
    integer(role.position, `${path}.position`, -2147483647, 2147483647)
    mask(role.permissions, `${path}.permissions`)
    bool(role.is_default, `${path}.is_default`)
    bool(role.is_admin, `${path}.is_admin`)
    bool(role.mentionable, `${path}.mentionable`)
    bool(role.hoist, `${path}.hoist`)
    text(role.unicode_emoji, `${path}.unicode_emoji`, 64, false)
    if (role.is_default && role.is_admin) throw invalid(`${path} is not both @everyone and the Admin role`)
    if (role.is_default) defaults++
    if (role.is_admin) admins++
  })
  if (defaults > 1) throw invalid('only one role is @everyone')
  if (admins > 1) throw invalid('only one role is the Admin role')

  list(doc.categories, 'categories', SERVER_TEMPLATE_LIMITS.categories, 'tooManyCategories').forEach((cat, i) => {
    const path = `categories[${i}]`
    if (!isObject(cat)) throw invalid(`${path} is an object`)
    claim(ref(cat.ref, `${path}.ref`), 'category')
    text(cat.name, `${path}.name`, 100, true)
    integer(cat.order, `${path}.order`, -2147483647, 2147483647)
  })

  list(doc.channels, 'channels', SERVER_TEMPLATE_LIMITS.channels, 'tooManyChannels').forEach((ch, i) => {
    const path = `channels[${i}]`
    if (!isObject(ch)) throw invalid(`${path} is an object`)
    claim(ref(ch.ref, `${path}.ref`), 'channel')
    text(ch.name, `${path}.name`, 100, true)
    text(ch.description, `${path}.description`, 1024, false)
    integer(ch.type, `${path}.type`, 0, 1)
    integer(ch.order, `${path}.order`, -2147483647, 2147483647)
    integer(ch.slowmode_seconds, `${path}.slowmode_seconds`, 0, 21600)
    bool(ch.private, `${path}.private`)
    if (ch.category !== undefined && ch.category !== null
        && kinds.get(ref(ch.category, `${path}.category`)) !== 'category') {
      throw invalid(`${path}.category names no category`)
    }
    const seen = new Set<string>()
    list(ch.overrides, `${path}.overrides`, SERVER_TEMPLATE_LIMITS.roles).forEach((o, j) => {
      const opath = `${path}.overrides[${j}]`
      if (!isObject(o)) throw invalid(`${opath} is an object`)
      const role = ref(o.role, `${opath}.role`)
      if (kinds.get(role) !== 'role') throw invalid(`${opath}.role names no role`)
      if (seen.has(role)) throw invalid(`${path} has more than one override for role "${role}"`)
      seen.add(role)
      mask(o.allow, `${opath}.allow`)
      mask(o.deny, `${opath}.deny`)
    })
  })

  for (const key of ['settings', 'welcome', 'automod'] as const) {
    if (doc[key] !== undefined && doc[key] !== null && !isObject(doc[key])) throw invalid(`${key} is an object`)
  }
}

export function summarizeServerTemplate(template: ServerTemplate): ServerTemplateSummary {
  const roles = template.roles ?? []
  const defaultRef = typeof template.settings?.default_role === 'string' ? template.settings.default_role : null
  const elevated = roles.some(r =>
    (r.is_default || (defaultRef !== null && r.ref === defaultRef))
    && (readPermissionMask(r.permissions) & ELEVATED_MASK) !== 0)

  return {
    name: template.server?.name?.trim() ?? '',
    roles: roles.filter(r => !r.is_default && !r.is_admin).length,
    categories: (template.categories ?? []).length,
    channels: (template.channels ?? []).length,
    elevatedEveryone: elevated,
  }
}

/** Reads a template file's text. */
export function parseServerTemplate(source: string): ParsedServerTemplate {
  try {
    if (new TextEncoder().encode(source).length > SERVER_TEMPLATE_LIMITS.bytes) {
      throw new ServerTemplateError('tooLarge')
    }
    let doc: unknown
    try {
      doc = JSON.parse(source)
    } catch {
      throw new ServerTemplateError('notJson')
    }
    validateServerTemplate(doc)
    return { ok: true, template: doc, summary: summarizeServerTemplate(doc) }
  } catch (error) {
    if (error instanceof ServerTemplateError) return { ok: false, error }
    throw error
  }
}

const REJECTION = /^(?:TEMPLATE_INVALID|TEMPLATE_VERSION|AUTOMOD_INVALID_RULE|AUTOMOD_INVALID_SETTINGS|WELCOME_INVALID): (.+)$/s

/** Why create_server_from_template refused the template, or null for any other failure. */
export function templateRejection(error: unknown): string | null {
  const message = isObject(error) ? error.message : undefined
  return typeof message === 'string' ? REJECTION.exec(message)?.[1] ?? null : null
}

/** `<server name>.harmony-template.json`, with characters file systems refuse replaced. */
export function serverTemplateFileName(serverName: string): string {
  const base = serverName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80)
  return `${base || 'server'}${SERVER_TEMPLATE_EXTENSION}`
}

/** The template with the server fields the create form edits replaced. */
export function withServerFields(
  template: ServerTemplate,
  fields: { description: string | null; public: boolean; category: string | null },
): ServerTemplate {
  return { ...template, server: { ...(template.server ?? {}), ...fields } }
}
