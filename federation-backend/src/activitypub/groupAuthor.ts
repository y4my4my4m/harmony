/**
 * The author of a channel message no profile wrote, on the Note its server's Group sends:
 *
 *   "attributedTo": "https://<host>/servers/<server>",
 *   "harmony:author": {
 *     "kind": "bot" | "webhook" | "bridge",
 *     "id": "<bot uuid>" | "<webhook uuid>" | "discord:<user id>",
 *     "name": "…",                       at most 100 characters
 *     "icon": "https://…",               optional, at most 2048 characters
 *     "source": "discord"                bridge only
 *   }
 *
 * A bot, a channel webhook and a person a bridge relays have no actor; the Group speaks for
 * them. A copy shows the message under this name and picture (metadata.remote_author; a bridged
 * Discord person also as metadata.discord_user, as the bridge writes it on the host).
 */

import { getFullAvatarUrl } from '../utils/urlUtils.js';

export const HARMONY_AUTHOR = 'harmony:author';

export type GroupAuthorKind = 'bot' | 'webhook' | 'bridge';

export interface GroupAuthor {
  kind: GroupAuthorKind;
  id: string;
  name: string;
  icon?: string;
  source?: string;
}

const MAX_NAME = 100;
const MAX_ID = 128;
const MAX_ICON = 2048;
const KINDS = new Set<GroupAuthorKind>(['bot', 'webhook', 'bridge']);

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** An absolute https URL, or null: the default avatar and relative paths are left out. */
function httpsIcon(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const full = /^https?:\/\//i.test(value) ? value : value.startsWith('/default') ? null : getFullAvatarUrl(value);
  if (!full || full.length > MAX_ICON) return null;
  try {
    return new URL(full).protocol === 'https:' ? full : null;
  } catch {
    return null;
  }
}

/**
 * The author of a host's bot row (bot_id set, no user_id): its webhook (metadata.webhook), the
 * bridged person (metadata.discord_user), else the bot. Null when nothing names it.
 */
export function groupAuthorOf(
  message: { bot_id?: string | null; metadata?: any },
  bot: { id?: string; username?: string | null; display_name?: string | null; avatar_url?: string | null } | null | undefined,
): GroupAuthor | null {
  const metadata = message.metadata ?? {};
  const webhook = metadata.webhook;
  if (webhook && typeof webhook === 'object') {
    const name = text(webhook.name, MAX_NAME) ?? text(bot?.display_name, MAX_NAME);
    const id = text(webhook.id, MAX_ID);
    if (!name || !id) return null;
    const icon = httpsIcon(webhook.avatar_url) ?? httpsIcon(bot?.avatar_url);
    return { kind: 'webhook', id, name, ...(icon ? { icon } : {}) };
  }
  const discord = metadata.discord_user;
  if (discord && typeof discord === 'object') {
    const name = text(discord.display_name, MAX_NAME) ?? text(discord.username, MAX_NAME);
    const userId = text(discord.id, MAX_ID - 'discord:'.length);
    if (!name || !userId) return null;
    const icon = httpsIcon(discord.avatar_url);
    return { kind: 'bridge', id: `discord:${userId}`, name, ...(icon ? { icon } : {}), source: 'discord' };
  }
  const botId = text(bot?.id ?? message.bot_id, MAX_ID);
  const name = text(bot?.display_name, MAX_NAME) ?? text(bot?.username, MAX_NAME);
  if (!botId || !name) return null;
  const icon = httpsIcon(bot?.avatar_url);
  return { kind: 'bot', id: botId, name, ...(icon ? { icon } : {}) };
}

/** A received harmony:author, bounded; null for anything else. */
export function parseGroupAuthor(value: unknown): GroupAuthor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as GroupAuthorKind;
  if (!KINDS.has(kind)) return null;
  const id = text(raw.id, MAX_ID);
  const name = text(raw.name, MAX_NAME);
  if (!id || !name) return null;
  if (kind === 'bridge' && !id.startsWith('discord:')) return null;
  const icon = httpsIcon(raw.icon);
  return {
    kind,
    id,
    name,
    ...(icon ? { icon } : {}),
    ...(kind === 'bridge' ? { source: 'discord' } : {}),
  };
}

/**
 * The metadata a copy stores for such a message: remote_author, and for a bridged Discord
 * person discord_user too, which the app already shows with its Discord badge.
 */
export function remoteAuthorMetadata(author: GroupAuthor): Record<string, unknown> {
  const remote = {
    kind: author.kind,
    id: author.id,
    name: author.name,
    avatar_url: author.icon ?? null,
    ...(author.source ? { source: author.source } : {}),
  };
  if (author.kind !== 'bridge') return { remote_author: remote };
  return {
    remote_author: remote,
    discord_user: {
      id: author.id.slice('discord:'.length),
      username: author.name,
      display_name: author.name,
      avatar_url: author.icon ?? null,
    },
    bridge_source: 'discord',
  };
}
