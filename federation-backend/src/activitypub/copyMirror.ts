/**
 * A server hosted elsewhere as its member instances show it: its pins, its roles and the instance
 * staff of accounts (migration 20261030100001).
 *
 * Group document (GroupService.ts):
 *   "harmony:roles": [{ "type": "harmony:Role", "id": "<group>/roles/<uuid>", "name", "color",
 *                       "position", "hoist", "mentionable", "unicodeEmoji"? }]
 *       every role but the default one, highest position first. No permission bits: permissions
 *       are enforced on the host, and a copy stores its roles display-only. Absent when the roles
 *       cannot be read: an empty list deletes a copy's roles.
 *   "harmony:channels"[i]["harmony:pins"]:
 *       { "type": "OrderedCollection", "id": "<channel>/pins", "totalItems", "updated"? }
 *       totalItems counts the Notes <channel>/pins serves; updated is the newest non-null
 *       harmony:pinnedAt. Absent for a channel the signer reads from a history cutoff on, and on
 *       every channel when the pins cannot be read.
 * <channel>/pins: OrderedCollection of the pinned Notes, newest pin first, each with
 *   "harmony:pinnedAt" (null for a pin with no time). 5xx when the pins cannot be read.
 * Members page: "harmony:memberRoles": [{ "member": "<actor>", "roles": ["<role id>"] }]
 *   the members of that page holding a role; absent when the assignments cannot be read.
 * Live, the Group's activities, signed with its key:
 *   Update(Group) with "harmony:roles"     the whole list; a role absent from it is deleted
 *   Update { "type": "harmony:MemberRoles", "id", "member", "roles" }   all of the member's roles
 *   Add | Remove { "object": "<Note id>", "target": "<channel>/pins" }
 * Actor: "harmony:instanceRole": "admin" | "moderator", staff of the actor's own instance; taken
 *   only from the actor's own document or its own Update.
 *
 * Harmony before 1.9.1 ignores each of these: unknown properties, an Update of an unknown type,
 * and an Add or Remove whose target is not /featured, /members or a channel of the Group.
 */

export const HARMONY_ROLES = 'harmony:roles';
export const HARMONY_MEMBER_ROLES = 'harmony:memberRoles';
export const HARMONY_PINS = 'harmony:pins';
export const HARMONY_PINNED_AT = 'harmony:pinnedAt';
export const HARMONY_INSTANCE_ROLE = 'harmony:instanceRole';
export const ROLE_TYPE = 'harmony:Role';
export const MEMBER_ROLES_TYPE = 'harmony:MemberRoles';

/** Roles read from one Group, as Discord caps a server. */
export const MAX_ROLES = 250;
/** Pinned Notes read from one channel; the host holds 50 (pin_message). */
export const MAX_PINS = 100;
/** Roles read for one member. */
export const MAX_MEMBER_ROLES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 100;
const MAX_EMOJI = 32;
const MAX_URL = 2048;
const MAX_POSITION = 1_000_000;

export type InstanceRole = 'admin' | 'moderator';

export interface RoleRow {
  id: string;
  name: string | null;
  color?: string | null;
  position?: number | null;
  hoist?: boolean | null;
  mentionable?: boolean | null;
  unicode_emoji?: string | null;
  is_default?: boolean | null;
}

export interface ApRole {
  type: typeof ROLE_TYPE;
  id: string;
  name: string;
  color: string | null;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  unicodeEmoji?: string;
}

export interface ParsedRole {
  uuid: string;
  apId: string;
  name: string;
  color: string | null;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  unicodeEmoji: string | null;
}

export interface MemberRoles {
  member: string;
  roles: string[];
}

export interface PinsAdvert {
  id: string;
  totalItems: number;
  updated: string | null;
}

/** Pins a channel's collection serves: how many, and the newest pin time. */
export interface PinSummary {
  total: number;
  newest: string | null;
}

export function roleApId(serverUrl: string, roleId: string): string {
  return `${serverUrl}/roles/${roleId}`;
}

export function pinsCollectionId(channelUrl: string): string {
  return `${channelUrl}/pins`;
}

/** harmony:roles of a server's role rows. */
export function rolesToAp(serverUrl: string, rows: RoleRow[]): ApRole[] {
  return rows
    .filter((r) => r.is_default !== true && typeof r.name === 'string')
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => {
      const role: ApRole = {
        type: ROLE_TYPE,
        id: roleApId(serverUrl, r.id),
        name: r.name as string,
        color: typeof r.color === 'string' && COLOR.test(r.color) ? r.color.toLowerCase() : null,
        position: r.position ?? 0,
        hoist: r.hoist === true,
        mentionable: r.mentionable !== false,
      };
      if (typeof r.unicode_emoji === 'string' && r.unicode_emoji) role.unicodeEmoji = r.unicode_emoji;
      return role;
    });
}

/** PinSummary of pin times; a pin with no time counts and is never the newest. */
export function summarizePins(pinnedAt: (string | null | undefined)[]): PinSummary {
  let newest: number | null = null;
  for (const at of pinnedAt) {
    const t = typeof at === 'string' ? Date.parse(at) : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return { total: pinnedAt.length, newest: newest === null ? null : new Date(newest).toISOString() };
}

export function pinsAdvert(channelUrl: string, pins: PinSummary): PinsAdvert & { type: 'OrderedCollection' } {
  return {
    type: 'OrderedCollection',
    id: pinsCollectionId(channelUrl),
    totalItems: pins.total,
    updated: pins.newest,
  };
}

/** The part of an advert a copy compares: totalItems and updated. */
export function pinsAdvertKey(advert: Pick<PinsAdvert, 'totalItems' | 'updated'>): string {
  return `${advert.totalItems}|${advert.updated ?? ''}`;
}

export function memberRolesObject(serverUrl: string, userId: string, member: string, roleIds: string[]) {
  return {
    type: MEMBER_ROLES_TYPE,
    id: `${serverUrl}/members/${userId}/roles`,
    member,
    roles: roleIds.map((id) => roleApId(serverUrl, id)),
  };
}

/** harmony:instanceRole of a local account, or null for an account that is not staff. */
export function instanceRoleOf(profile: { is_admin?: boolean | null; is_moderator?: boolean | null }): InstanceRole | null {
  if (profile.is_admin === true) return 'admin';
  if (profile.is_moderator === true) return 'moderator';
  return null;
}

// PARSING

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** UUID of `<groupUrl>/roles/<uuid>`, or null for an id under anything else. */
export function roleUuidOf(apId: unknown, groupUrl: string): string | null {
  if (typeof apId !== 'string') return null;
  const prefix = `${groupUrl}/roles/`;
  if (!apId.startsWith(prefix)) return null;
  const rest = apId.slice(prefix.length);
  return UUID.test(rest) ? rest.toLowerCase() : null;
}

/**
 * harmony:roles of a Group, each role under that Group; null when the Group carries none
 * (Harmony before 1.9.1), which leaves a copy's roles as they are.
 */
export function parseGroupRoles(value: unknown, groupUrl: string): ParsedRole[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const roles: ParsedRole[] = [];
  for (const entry of value.slice(0, MAX_ROLES)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const uuid = roleUuidOf(e.id, groupUrl);
    const name = text(e.name, MAX_NAME);
    if (!uuid || !name || seen.has(uuid)) continue;
    seen.add(uuid);
    const position = typeof e.position === 'number' && Number.isFinite(e.position)
      ? Math.max(-MAX_POSITION, Math.min(MAX_POSITION, Math.trunc(e.position)))
      : 0;
    roles.push({
      uuid,
      apId: e.id as string,
      name,
      color: typeof e.color === 'string' && COLOR.test(e.color) ? e.color.toLowerCase() : null,
      position,
      hoist: e.hoist === true,
      mentionable: e.mentionable !== false,
      unicodeEmoji: text(e.unicodeEmoji, MAX_EMOJI),
    });
  }
  return roles;
}

function memberRolesEntry(value: unknown, groupUrl: string): MemberRoles | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  const member = httpUrl(e.member);
  if (!member || !Array.isArray(e.roles)) return null;
  const roles = [...new Set(e.roles.slice(0, MAX_MEMBER_ROLES)
    .filter((r): r is string => roleUuidOf(r, groupUrl) !== null))];
  return { member, roles };
}

/** harmony:memberRoles of a members page; null when the page carries none. */
export function parseMemberRoles(value: unknown, groupUrl: string): MemberRoles[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((e) => memberRolesEntry(e, groupUrl)).filter((e): e is MemberRoles => e !== null);
}

/** The object of an Update(harmony:MemberRoles), or null. */
export function parseMemberRolesObject(object: unknown, groupUrl: string): MemberRoles | null {
  if (!object || typeof object !== 'object' || (object as any).type !== MEMBER_ROLES_TYPE) return null;
  return memberRolesEntry(object, groupUrl);
}

export function parseInstanceRole(value: unknown): InstanceRole | null {
  return value === 'admin' || value === 'moderator' ? value : null;
}

export function parsePinnedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** harmony:pins of a Group's channel entry, naming that channel's collection; null otherwise. */
export function parsePinsAdvert(value: unknown, channelApId: string): PinsAdvert | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.id !== pinsCollectionId(channelApId)) return null;
  const total = typeof v.totalItems === 'number' && Number.isFinite(v.totalItems) && v.totalItems >= 0
    ? Math.trunc(v.totalItems)
    : null;
  if (total === null) return null;
  return { id: v.id as string, totalItems: total, updated: parsePinnedAt(v.updated) };
}

/** A target naming some channel's pins collection. */
export function isPinsTarget(target: unknown): target is string {
  return typeof target === 'string' && /\/channels\/[0-9a-f-]{36}\/pins$/i.test(target);
}

/** The channel id `<groupUrl>/channels/<uuid>` whose pins `target` names, or null. */
export function pinsTargetChannel(target: unknown, groupUrl: string): string | null {
  if (typeof target !== 'string') return null;
  const prefix = `${groupUrl}/channels/`;
  if (!target.startsWith(prefix) || !target.endsWith('/pins')) return null;
  const uuid = target.slice(prefix.length, -'/pins'.length);
  return UUID.test(uuid) ? `${prefix}${uuid}` : null;
}

/**
 * Position of a channel or category on the wire. order repeats position: a receiver before 1.9.1
 * reads `position || order`, which drops position 0 and keeps order 0.
 */
export function channelPosition(order: unknown): { position: number; order: number } {
  const n = typeof order === 'number' && Number.isFinite(order) ? order : 0;
  return { position: n, order: n };
}

/**
 * Position of a channel or category object: position, else order (a 1.9.1 host sends both),
 * 0 included. Undefined when neither is a number, which leaves a stored order as it is.
 */
export function parseChannelPosition(object: { position?: unknown; order?: unknown }): number | undefined {
  for (const value of [object.position, object.order]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(-MAX_POSITION, Math.min(MAX_POSITION, Math.trunc(value)));
    }
  }
  return undefined;
}
