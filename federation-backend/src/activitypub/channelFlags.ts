/**
 * A channel as its home instance describes it to member instances (migration 20261109900001).
 *
 * On a harmony:channels entry, the channel document and a channel's Add or Update object:
 *   "harmony:encryption": { "messages": true, "voice": true }
 *       a key is absent when false, the property when both are; voice on a voice channel alone
 *   "harmony:private": true     @everyone cannot view it; absent when false
 * A category's entry and its Add or Update object carry harmony:private alone.
 *
 * A copy stores them as channels.host_flags and channel_categories.host_flags:
 *   { "messages": true, "voice": true, "private": true }, a key absent when false.
 * Every channel document of a Group replaces the stored value: a flag turned off is an absent
 * property. A host before 1.9.5 sends neither, so its copies stay '{}'. A receiver before 1.9.5
 * copies a fixed field list and ignores both.
 *
 * A read failure throws: a document without the properties would clear a copy's flags.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const HARMONY_ENCRYPTION = 'harmony:encryption';
export const HARMONY_PRIVATE = 'harmony:private';

export interface HostFlags {
  messages?: true;
  voice?: true;
  private?: true;
}

interface FlagValues {
  messages?: boolean;
  voice?: boolean;
  is_private?: boolean;
}

/** The properties a document carries for these values. */
export function flagProperties(values: FlagValues | undefined): Record<string, unknown> {
  const encryption = {
    ...(values?.messages === true ? { messages: true } : {}),
    ...(values?.voice === true ? { voice: true } : {}),
  };
  return {
    ...(Object.keys(encryption).length > 0 ? { [HARMONY_ENCRYPTION]: encryption } : {}),
    ...(values?.is_private === true ? { [HARMONY_PRIVATE]: true } : {}),
  };
}

/** channels.host_flags of a Group's channel entry or object; a category reads private alone. */
export function hostFlagsOf(object: unknown): HostFlags {
  const doc = (object ?? {}) as Record<string, unknown>;
  const encryption = (doc[HARMONY_ENCRYPTION] ?? {}) as Record<string, unknown>;
  return {
    ...(encryption.messages === true ? { messages: true as const } : {}),
    ...(encryption.voice === true ? { voice: true as const } : {}),
    ...(doc[HARMONY_PRIVATE] === true ? { private: true as const } : {}),
  };
}

/** Properties per channel id; a channel with no flag maps to an empty object. */
export async function channelFlagProperties(
  supabase: SupabaseClient,
  channelIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (channelIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc('channel_host_flags', { p_channel_ids: channelIds });
  if (error) throw new Error(`Channel flags not read: ${error.message}`);
  return new Map(((data ?? []) as Array<FlagValues & { channel_id: string }>)
    .map((row) => [row.channel_id, flagProperties(row)]));
}

/** Properties per category id; a category with no flag maps to an empty object. */
export async function categoryFlagProperties(
  supabase: SupabaseClient,
  categoryIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (categoryIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc('category_host_flags', { p_category_ids: categoryIds });
  if (error) throw new Error(`Category flags not read: ${error.message}`);
  return new Map(((data ?? []) as Array<{ category_id: string; is_private?: boolean }>)
    .map((row) => [row.category_id, flagProperties({ is_private: row.is_private })]));
}
