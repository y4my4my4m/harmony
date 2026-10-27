/**
 * The copy of a server hosted elsewhere, brought to what its Group says (activitypub/copyMirror.ts):
 * its roles, its members' roles and its channels' pins. Written with the service role; a client
 * writes none of these on a copy (migration 20261027200001).
 *
 * Roles on a copy are display-only: permissions 0, no administrator flag. get_user_permissions holds
 * member bits only on a copy, and the host enforces its own roles.
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { redis } from './RedisService.js';
import type { MemberRoles, ParsedRole } from '../activitypub/copyMirror.js';

/** Ids per `in` filter: the query string stays under 8 KB with URLs of 80 characters. */
const CHUNK = 80;
/** Rows per read; PostgREST answers at most max-rows (1000 on Supabase) to one request. */
const PAGE = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Redis hash of a copy's last applied pins adverts: channel id -> pinsAdvertKey. */
const PIN_ADVERTS_KEY = (serverId: string) => `copy-pin-adverts:${serverId}`;

/** The same, for writes Redis did not take. */
const pinAdvertsInProcess = new Map<string, Map<string, string>>();

const LOCAL_ACTOR = () => new RegExp(`^https://${config.INSTANCE_DOMAIN.replace(/\./g, '\\.')}/users/([A-Za-z0-9_]+)$`, 'i');

export class CopyMirrorService {
  /**
   * The Group's roles on its copy: each stored under its id (the host's UUID where free) with the
   * host's name, colour, position, hoist, mentionable and emoji; a role under the Group that the
   * list no longer names is deleted, with its assignments, and so is a role the copy made itself
   * (the Admin role create_default_server_role adds). The default role stays.
   */
  static async applyGroupRoles(serverId: string, groupUrl: string, roles: ParsedRole[]): Promise<void> {
    const supabase = getSupabaseClient();
    const prefix = `${groupUrl}/roles/`;
    const { data: current, error } = await supabase
      .from('server_roles')
      .select('id, ap_id, is_default, name, color, position, hoist, mentionable, unicode_emoji, permissions, is_admin')
      .eq('server_id', serverId);
    if (error) {
      logger.warn(`Roles of copy ${serverId} not read: ${error.message}`);
      return;
    }
    const byApId = new Map((current || []).filter((r: any) => typeof r.ap_id === 'string').map((r: any) => [r.ap_id, r]));

    for (const role of roles) {
      const fields = {
        name: role.name,
        color: role.color,
        position: role.position,
        hoist: role.hoist,
        mentionable: role.mentionable,
        unicode_emoji: role.unicodeEmoji,
        permissions: 0,
        is_admin: false,
        is_default: false,
      };
      const row = byApId.get(role.apId);
      if (row) {
        const same = (Object.keys(fields) as (keyof typeof fields)[])
          .every((k) => (k === 'permissions' ? Number(row[k] ?? 0) === 0 : row[k] === fields[k]));
        if (!same) {
          const { error: updateError } = await supabase.from('server_roles').update(fields).eq('id', row.id);
          if (updateError) logger.warn(`Role ${role.apId} not updated: ${updateError.message}`);
        }
        continue;
      }
      const insert = { server_id: serverId, ap_id: role.apId, ...fields };
      let { error: insertError } = await supabase.from('server_roles').insert({ id: role.uuid, ...insert });
      // The host's UUID names a row of another server here: the role takes a new id.
      if (insertError?.code === '23505') {
        ({ error: insertError } = await supabase.from('server_roles').insert(insert));
      }
      if (insertError) logger.warn(`Role ${role.apId} not stored: ${insertError.message}`);
    }

    const listed = new Set(roles.map((r) => r.apId));
    const gone = (current || [])
      .filter((r: any) => r.is_default !== true
        && (r.ap_id === null || (typeof r.ap_id === 'string' && r.ap_id.startsWith(prefix) && !listed.has(r.ap_id))))
      .map((r: any) => r.id as string);
    for (const ids of chunks(gone)) {
      const { error: deleteError } = await supabase.from('server_roles').delete().eq('server_id', serverId).in('id', ids);
      if (deleteError) logger.warn(`Roles of copy ${serverId} not deleted: ${deleteError.message}`);
    }
  }

  /**
   * Members' roles on a copy, as the Group names them. Each entry replaces the member's roles of
   * the Group; with `complete` (every members page read) a member no entry names holds none. Roles
   * the copy does not store, actors it holds no profile of and profiles that are not members of the
   * copy are skipped. Returns the rows written.
   */
  static async applyMemberRoles(
    serverId: string,
    groupUrl: string,
    entries: MemberRoles[],
    opts: { complete: boolean },
  ): Promise<number> {
    const supabase = getSupabaseClient();
    const prefix = `${groupUrl}/roles/`;
    const { data: roleRows, error: rolesError } = await supabase
      .from('server_roles')
      .select('id, ap_id')
      .eq('server_id', serverId);
    if (rolesError) {
      logger.warn(`Roles of copy ${serverId} not read: ${rolesError.message}`);
      return 0;
    }
    const roleIdOf = new Map((roleRows || [])
      .filter((r: any) => typeof r.ap_id === 'string' && r.ap_id.startsWith(prefix))
      .map((r: any) => [r.ap_id as string, r.id as string]));
    const mirrored = new Set(roleIdOf.values());
    if (mirrored.size === 0) return 0;

    const profileOf = await this.membersOf(serverId, entries.map((e) => e.member));
    const desired = new Map<string, Set<string>>();
    for (const entry of entries) {
      const userId = profileOf.get(entry.member);
      if (!userId) continue;
      const roles = desired.get(userId) ?? new Set<string>();
      for (const apId of entry.roles) {
        const id = roleIdOf.get(apId);
        if (id) roles.add(id);
      }
      desired.set(userId, roles);
    }

    const held: { id: string; user_id: string; role_id: string }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('user_roles')
        .select('id, user_id, role_id')
        .eq('server_id', serverId)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) {
        logger.warn(`Role assignments of copy ${serverId} not read: ${error.message}`);
        return 0;
      }
      held.push(...(data || []).filter((r: any) => mirrored.has(r.role_id)));
      if ((data || []).length < PAGE) break;
    }

    const stale = held
      .filter((r) => (desired.has(r.user_id) ? !desired.get(r.user_id)!.has(r.role_id) : opts.complete))
      .map((r) => r.id);
    const holding = new Set(held.map((r) => `${r.user_id}:${r.role_id}`));
    const missing = [...desired].flatMap(([userId, roles]) =>
      [...roles].filter((roleId) => !holding.has(`${userId}:${roleId}`))
        .map((roleId) => ({ user_id: userId, role_id: roleId, server_id: serverId })));

    for (const ids of chunks(stale)) {
      const { error } = await supabase.from('user_roles').delete().eq('server_id', serverId).in('id', ids);
      if (error) logger.warn(`Role assignments of copy ${serverId} not removed: ${error.message}`);
    }
    for (const rows of chunks(missing, 500)) {
      const { error } = await supabase.from('user_roles').upsert(rows, { onConflict: 'user_id,role_id', ignoreDuplicates: true });
      if (error) logger.warn(`Role assignments of copy ${serverId} not stored: ${error.message}`);
    }
    return stale.length + missing.length;
  }

  /** Ids among `roleApIds` naming no role the copy stores; null when its roles cannot be read. */
  static async unknownRoles(serverId: string, roleApIds: string[]): Promise<string[] | null> {
    const wanted = [...new Set(roleApIds)];
    if (wanted.length === 0) return [];
    const stored = new Set<string>();
    for (const ids of chunks(wanted)) {
      const { data, error } = await getSupabaseClient()
        .from('server_roles')
        .select('ap_id')
        .eq('server_id', serverId)
        .in('ap_id', ids);
      if (error) {
        logger.warn(`Roles of copy ${serverId} not read: ${error.message}`);
        return null;
      }
      for (const r of data || []) stored.add(r.ap_id);
    }
    return wanted.filter((id) => !stored.has(id));
  }

  /** Profile ids of the actors that are members of the copy, by actor id. Nothing is fetched. */
  private static async membersOf(serverId: string, actors: string[]): Promise<Map<string, string>> {
    const supabase = getSupabaseClient();
    const found = new Map<string, string>();
    const unique = [...new Set(actors)];
    for (const urls of chunks(unique)) {
      const { data } = await supabase.from('profiles').select('id, federated_id').in('federated_id', urls);
      for (const p of data || []) found.set(p.federated_id, p.id);
    }
    // A local account whose federated_id was never written is named by its /users/ path.
    const localName = LOCAL_ACTOR();
    const byName = new Map<string, string>();
    for (const url of unique) {
      const name = found.has(url) ? null : localName.exec(url)?.[1];
      if (name) byName.set(name.toLowerCase(), url);
    }
    for (const names of chunks([...byName.keys()])) {
      const { data } = await supabase.from('profiles').select('id, username').eq('is_local', true).in('username', names);
      for (const p of data || []) {
        const url = byName.get(String(p.username).toLowerCase());
        if (url) found.set(url, p.id);
      }
    }

    const members = new Map<string, string>();
    const ids = [...new Set(found.values())];
    const accepted = new Set<string>();
    for (const chunk of chunks(ids)) {
      const { data } = await supabase
        .from('user_servers')
        .select('user_id')
        .eq('server_id', serverId)
        .eq('status', 'accepted')
        .in('user_id', chunk);
      for (const m of data || []) accepted.add(m.user_id);
    }
    for (const [url, id] of found) if (accepted.has(id)) members.set(url, id);
    return members;
  }

  /**
   * Pins or unpins one message of a copy's channel. A pin's time may be null: a host serves
   * harmony:pinnedAt null for a pin it holds no time of. False when the row is not written.
   */
  static async setPinned(channelId: string, messageId: string, pinned: boolean, pinnedAt: string | null = null): Promise<boolean> {
    const { error } = await getSupabaseClient()
      .from('messages')
      .update({ is_pinned: pinned, pinned_at: pinned ? pinnedAt : null, pinned_by: null })
      .eq('id', messageId)
      .eq('channel_id', channelId);
    if (error) logger.warn(`Pin of message ${messageId} not set: ${error.message}`);
    return !error;
  }

  /**
   * A copy's channel pinned exactly as `pinned` (row id -> pinned at) says: other pinned rows of
   * the channel are unpinned. A null time keeps the time of a row already pinned. Returns the rows
   * changed, or null when the pins cannot be read or a write fails.
   */
  static async applyChannelPins(channelId: string, pinned: Map<string, string | null>): Promise<number | null> {
    const supabase = getSupabaseClient();
    const { data: current, error } = await supabase
      .from('messages')
      .select('id, pinned_at')
      .eq('channel_id', channelId)
      .eq('is_pinned', true);
    if (error) {
      logger.warn(`Pins of channel ${channelId} not read: ${error.message}`);
      return null;
    }
    let changed = 0;
    let failed = false;
    const was = new Map((current || []).map((m: any) => [m.id as string, m.pinned_at as string | null]));
    for (const [id] of was) {
      if (pinned.has(id)) continue;
      if (await this.setPinned(channelId, id, false)) changed++;
      else failed = true;
    }
    for (const [id, at] of pinned) {
      if (was.has(id)) {
        const before = was.get(id) ?? null;
        if (at === null) continue;
        if (before !== null && Date.parse(before) === Date.parse(at)) continue;
      }
      if (await this.setPinned(channelId, id, true, at)) changed++;
      else failed = true;
    }
    return failed ? null : changed;
  }

  /** The pins advert last applied to each channel of a copy (pinsAdvertKey), by channel id. */
  static async pinAdvertsSeen(serverId: string): Promise<Map<string, string>> {
    const stored = await redis.hgetall(PIN_ADVERTS_KEY(serverId));
    return new Map([...(pinAdvertsInProcess.get(serverId) ?? []), ...Object.entries(stored ?? {})]);
  }

  static async notePinAdvert(serverId: string, channelId: string, key: string): Promise<void> {
    if (await redis.hset(PIN_ADVERTS_KEY(serverId), channelId, key)) {
      pinAdvertsInProcess.get(serverId)?.delete(channelId);
      return;
    }
    const seen = pinAdvertsInProcess.get(serverId) ?? new Map<string, string>();
    seen.set(channelId, key);
    pinAdvertsInProcess.set(serverId, seen);
  }
}
