/**
 * Text content processing for chat messages, DMs, ActivityPub posts, and
 * federation. Output is the shared MessagePart representation.
 */

import type { MessagePart } from '@/types';
import { getEmoji } from '@/services/emojiService';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'
import { resolveEmoji, loadEmojiData, isLoaded as unifiedEmojiLoaded } from '@/services/unifiedEmojiService'
import { stripTrackingParameters, isUrlTrackingStrippingEnabled } from '@/utils/urlTrackerStripper'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { parseUrlMatchContext, URL_TOKEN_REGEX } from '@/utils/urlSplitting'

// UUID-based emojis (legacy) and shortcode emojis are both supported.
import {
  createShortcodeRegex,
  parseEmojiShortcodeToken,
  findCustomEmojiInCache,
  getDbCachedEmoji,
  findCustomEmojiByToken,
  listCachedEmojisInDisambiguationOrder,
} from '@/services/emojiShortcodeResolver'

const emojiUuidRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/g;
// Module-scoped regex; reset lastIndex per use to avoid cross-call interference.
const emojiShortcodeRegex = createShortcodeRegex();

// Hoisted to module scope; these helpers run per-segment per message, so a
// fresh RegExp per call is hot-path waste (BUGS.md Pattern P-β, review M4).
// Stateful 'g' patterns require a lastIndex reset at each call site.
const MENTION_REGEX = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
const URL_PRESCAN_REGEX = URL_TOKEN_REGEX;
const URL_MATCH_REGEX = new RegExp(`(${URL_TOKEN_REGEX.source})`, 'g');
const COMBINED_MENTION_HASHTAG_REGEX = /(@role:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))|(@d!(\d+):([a-zA-Z0-9_.-]+))|(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)|(?<![&\w])#([\p{L}\p{N}_-]+)/gu;
const COMBINED_EMOJI_REGEX = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_+~-]+):/g;

/**
 * Batch-resolves @mention user data. Call before parseContentToMessageParts;
 * otherwise mentions render unresolved.
 */
export async function resolveMentionsUserData(content: string): Promise<Record<string, { userId: string; isLocal: boolean }>> {
  const userDataMap: Record<string, { userId: string; isLocal: boolean }> = {};
  
  // URL ranges are excluded so @mentions inside URLs are not resolved.
  const urlRanges: Array<{ start: number; end: number }> = [];
  URL_PRESCAN_REGEX.lastIndex = 0;
  let urlScan;
  while ((urlScan = URL_PRESCAN_REGEX.exec(content)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  let match;
  const uniqueUsernames = new Set<string>();
  
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (isInsideUrl(match.index)) continue;
    const username = match[1];
    const domain = match[2];
    const mentionKey = domain ? `${username}@${domain}` : username;
    uniqueUsernames.add(mentionKey);
  }
  
  if (uniqueUsernames.size === 0) return userDataMap;
  
  try {
    const usernameList = Array.from(uniqueUsernames);
    const localUsernames = usernameList.filter(u => !u.includes('@'));
    const remoteUsernames = usernameList.filter(u => u.includes('@'));
    
    if (localUsernames.length > 0) {
      const { data: localUsers } = await supabase
        .from('profiles')
        .select('id, username, display_name, is_local')
        .in('username', localUsernames);
      
      if (localUsers) {
        localUsers.forEach(user => {
          userDataMap[user.username] = {
            userId: user.id,
            isLocal: user.is_local
          };
        });
      }
    }
    
    // Remote users (username@domain). One PostgREST .or() filter unions all
    // (username, domain) pairs into a single request.
    //
    // MENTION_REGEX constrains the charsets to `[a-zA-Z0-9_-]+` and
    // `[a-zA-Z0-9.-]+`; neither admits commas, parens, or quotes, so the
    // values interpolate into PostgREST filter syntax without escaping.
    if (remoteUsernames.length > 0) {
      try {
        const pairs = remoteUsernames
          .map(ud => {
            const [username, domain] = ud.split('@');
            if (!username || !domain) return null;
            // Defence in depth: re-validate charset before interpolation.
            if (!/^[a-zA-Z0-9_-]+$/.test(username)) return null;
            if (!/^[a-zA-Z0-9.-]+$/.test(domain)) return null;
            return { username, domain };
          })
          .filter((p): p is { username: string; domain: string } => p !== null);

        if (pairs.length > 0) {
          const orFilter = pairs
            .map(p => `and(username.eq.${p.username},domain.eq.${p.domain})`)
            .join(',');

          const { data: remoteUsers, error } = await supabase
            .from('profiles')
            .select('id, username, domain, display_name, is_local')
            .or(orFilter);

          if (error && error.code !== 'PGRST116') {
            debug.warn('Error batch-fetching remote users:', error);
          }

          if (remoteUsers) {
            remoteUsers.forEach(user => {
              const key = `${user.username}@${user.domain}`;
              userDataMap[key] = {
                userId: user.id,
                isLocal: user.is_local
              };
            });
          }
        }
      } catch (error) {
        debug.warn('Error batch-resolving remote mentions:', error);
      }
    }
  } catch (error) {
    debug.warn('Error resolving mention user data:', error);
  }
  
  return userDataMap;
}

/**
 * Looks up name and colour for every @role:UUID in content. Scoped to
 * serverId when given.
 */
export async function resolveRoleMentionsData(
  content: string,
  serverId?: string
): Promise<Record<string, { name: string; color: string | null }>> {
  const roleRegex = /@role:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  const roleIds = new Set<string>();
  let match;
  while ((match = roleRegex.exec(content)) !== null) {
    roleIds.add(match[1]);
  }
  if (roleIds.size === 0) return {};

  const map: Record<string, { name: string; color: string | null }> = {};
  try {
    let query = supabase
      .from('server_roles')
      .select('id, name, color')
      .in('id', Array.from(roleIds));
    if (serverId) query = query.eq('server_id', serverId);
    const { data } = await query;
    if (data) {
      for (const role of data) {
        map[role.id] = { name: role.name.replace(/^@/, ''), color: role.color };
      }
    }
  } catch (err) {
    debug.warn('Error resolving role mention data:', err);
  }
  return map;
}

/**
 * Batch-resolves emoji data: UUID emojis, shortcode emojis, and the unified
 * emoji pack. Resolution order is cache, then database, then unified pack.
 */
export async function resolveEmojisData(content: string): Promise<Record<string, any>> {
  const emojiDataMap: Record<string, any> = {};
  
  let match;
  const uniqueEmojiIds = new Set<string>();
  /** Full inner tokens as they appear in content (e.g. har_wink~1). */
  const uniqueEmojiTokens = new Set<string>();
  
  // UUID-based emojis (legacy format).
  emojiUuidRegex.lastIndex = 0;
  while ((match = emojiUuidRegex.exec(content)) !== null) {
    const emojiId = match[1];
    if (emojiId) {
      uniqueEmojiIds.add(emojiId);
    }
  }
  
  emojiShortcodeRegex.lastIndex = 0;
  while ((match = emojiShortcodeRegex.exec(content)) !== null) {
    const token = match[1];
    if (token) {
      uniqueEmojiTokens.add(token);
    }
  }
  
  if (uniqueEmojiIds.size === 0 && uniqueEmojiTokens.size === 0) return emojiDataMap;

  // Phase 1: in-memory emoji cache. Works offline.
  try {
    const emojiCacheStore = useEmojiCacheStore();
    if (emojiCacheStore.isInitialized) {
      for (const emojiId of uniqueEmojiIds) {
        const cached = emojiCacheStore.getEmojiById(emojiId);
        if (cached) {
          emojiDataMap[emojiId] = cached;
        }
      }
      for (const token of uniqueEmojiTokens) {
        const fromCache = findCustomEmojiInCache(token) ?? getDbCachedEmoji(token);
        if (fromCache) {
          emojiDataMap[token] = fromCache;
        } else {
          const parsed = parseEmojiShortcodeToken(token);
          const ordered = listCachedEmojisInDisambiguationOrder(parsed.baseName);
          const index = parsed.disambiguator ?? 0;
          const picked = ordered[index] ?? ordered[0];
          if (picked) emojiDataMap[token] = picked;
        }
      }
    }
  } catch {
    // Cache probe is best-effort; fall through to the DB query.
  }

  // Phase 2: database, for anything the cache missed.
  const uncachedIds = Array.from(uniqueEmojiIds).filter(id => !emojiDataMap[id]);
  const uncachedTokens = Array.from(uniqueEmojiTokens).filter(token => !emojiDataMap[token]);

  try {
    if (uncachedIds.length > 0) {
      const { data: emojisByIds } = await supabase
        .from('emojis')
        .select('*')
        .in('id', uncachedIds);
      
      if (emojisByIds) {
        emojisByIds.forEach(emoji => {
          emojiDataMap[emoji.id] = emoji;
        });
      }
    }
    
    if (uncachedTokens.length > 0) {
      const baseNames = [...new Set(uncachedTokens.map(t => parseEmojiShortcodeToken(t).baseName))];
      const { data: emojisByNames } = await supabase
        .from('emojis')
        .select('*')
        .in('name', baseNames)
        .order('server_id', { ascending: true })
        .order('id', { ascending: true });

      if (emojisByNames) {
        const byBaseName = new Map<string, typeof emojisByNames>();
        for (const emoji of emojisByNames) {
          if (!byBaseName.has(emoji.name)) byBaseName.set(emoji.name, []);
          byBaseName.get(emoji.name)!.push(emoji);
        }
        for (const token of uncachedTokens) {
          const parsed = parseEmojiShortcodeToken(token);
          const rows = byBaseName.get(parsed.baseName);
          if (!rows?.length) continue;
          const index = parsed.disambiguator ?? 0;
          const picked = rows[index] ?? rows[0];
          if (picked) emojiDataMap[token] = picked;
        }
      }
    }
  } catch (error) {
    debug.warn('Error resolving emoji data from database (offline?):', error);
  }

  // Phase 3: unified emoji pack, for tokens still unresolved.
  const unresolvedEmojis = Array.from(uniqueEmojiTokens).filter(token => !emojiDataMap[token]);
  
  if (unresolvedEmojis.length > 0) {
    try {
      if (!unifiedEmojiLoaded.value) {
        await loadEmojiData()
      }

      if (unifiedEmojiLoaded.value) {
        for (const token of unresolvedEmojis) {
          const parsed = parseEmojiShortcodeToken(token);
          const resolved = resolveEmoji(parsed.baseName);
          
          const hasValidSvg = resolved.display.type === 'svg' && resolved.display.content;
          const hasValidUnicode = resolved.unicode && resolved.unicode !== token;
          const hasShortcodeMatch = resolved.shortcode && resolved.shortcode.toLowerCase() === parsed.baseName.toLowerCase();
          
          if (hasValidUnicode || (hasShortcodeMatch && hasValidSvg)) {
            emojiDataMap[token] = {
              id: resolved.unicode || token,
              name: token,
              unicode: resolved.unicode || null,
              _inlineAsText: !!resolved.unicode,
              source: 'unified'
            };
          }
        }
      }
    } catch (error) {
      debug.warn('Error resolving unified emoji data:', error);
    }
  }
  
  return emojiDataMap;
}

/**
 * Batch-resolves hashtag rows. Call before parseContentToMessageParts;
 * hashtags absent from the map get the 'new' placeholder id.
 */
export async function resolveHashtagsData(content: string): Promise<Record<string, { id: string; count: number; last_updated: string; normalized: string }>> {
  // Unicode-aware: \p{L} any letter, \p{N} any number, so CJK tags match.
  const hashtagRegex = /(?<![&\w])#([\p{L}\p{N}_-]+)/gu;
  const hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {};
  
  let match;
  const uniqueHashtags = new Set<string>();
  
  while ((match = hashtagRegex.exec(content)) !== null) {
    const hashtag = match[1].toLowerCase();
    uniqueHashtags.add(hashtag);
  }
  
  if (uniqueHashtags.size === 0) {
    return hashtagDataMap;
  }
  
  const { data, error } = await supabase
    .from('hashtags')
    .select('id, tag, normalized_tag, total_uses, last_used_at')
    .in('normalized_tag', Array.from(uniqueHashtags));
    
  if (error) {
    debug.warn('Error fetching hashtag data:', error);
    return hashtagDataMap;
  }
  
  data?.forEach(hashtag => {
    hashtagDataMap[hashtag.normalized_tag] = {
      id: hashtag.id,
      count: hashtag.total_uses || 0,
      last_updated: hashtag.last_used_at || new Date().toISOString(),
      normalized: hashtag.normalized_tag
    };
  });
  
  return hashtagDataMap;
}

/** Fenced code blocks must stay intact - URL/mention parsing inside them breaks view-mode markdown. */
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

/**
 * Matches an own-instance /chat/<serverId>/<channelId> URL against known
 * channels. Share links (?messageId=...) keep the message id so the rendered
 * reference jumps to that message.
 */
function matchChannelUrl(
  url: string,
  channelsById: Map<string, { id: string; serverId: string; name: string }>,
): { id: string; serverId: string; name: string; messageId?: string } | null {
  try {
    const parsed = new URL(url);
    // Share links use https://VITE_DOMAIN, which differs from the dev window
    // origin; either is accepted.
    const configuredDomain = (import.meta as any).env?.VITE_DOMAIN as string | undefined;
    const sameOrigin =
      (typeof window !== 'undefined' && parsed.origin === window.location.origin) ||
      (configuredDomain && parsed.host === configuredDomain);
    if (!sameOrigin) return null;

    const m = parsed.pathname.match(/^\/chat\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/?$/i);
    if (!m) return null;
    const channel = channelsById.get(m[2]);
    if (!channel || channel.serverId !== m[1]) return null;

    const messageId = parsed.searchParams.get('messageId') || undefined;
    return messageId ? { ...channel, messageId } : channel;
  } catch {
    return null;
  }
}

// Parses one segment of content lying outside fenced code blocks.
async function parseContentSegment(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean }>,
  emojiDataMap: Record<string, any>,
  hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }>,
  roleDataMap: Record<string, { name: string; color: string | null }>,
  parseOptions: ContentParseOptions = {},
): Promise<MessagePart[]> {
  if (!content) return [];

  // URL ranges are skipped when matching @mentions and #hashtags
  // (e.g. https://mastodon.social/@user/12345).
  const urlRanges: Array<{ start: number; end: number }> = [];
  URL_PRESCAN_REGEX.lastIndex = 0;
  let urlScan;
  while ((urlScan = URL_PRESCAN_REGEX.exec(content)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  // COMBINED_MENTION_HASHTAG_REGEX alternatives, in group order:
  //   @role:UUID        role mention
  //   @d!ID:username    Discord bridged user
  //   @username[@domain] user mention
  //   #hashtag
  // Stateful 'g' regex hoisted to module scope; lastIndex reset per call.
  COMBINED_MENTION_HASHTAG_REGEX.lastIndex = 0;
  const parts: MessagePart[] = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = COMBINED_MENTION_HASHTAG_REGEX.exec(content)) !== null) {
    // Matches inside a URL belong to the URL; parseTextForUrls handles them
    // (e.g. mastodon.social/@user/123).
    if (isInsideUrl(match.index)) continue;

    if (match.index > lastIndex) {
      const textBefore = content.substring(lastIndex, match.index);
      parts.push(...await parseTextForUrls(textBefore, emojiDataMap));
    }
    
    if (match[1]) {
      // Role mention: @role:UUID
      const roleId = match[2];
      const roleData = roleDataMap[roleId];
      parts.push({
        type: 'role_mention',
        roleId,
        roleName: roleData?.name || 'Unknown Role',
        roleColor: roleData?.color || null,
      } as MessagePart);
    } else if (match[3]) {
      // Discord bridged mention: @d!ID:username (compact format)
      const discordId = match[4];
      const discordUsername = match[5];
      
      parts.push({
        type: 'mention',
        userId: discordId,
        username: discordUsername,
        domain: 'discord.com',
        isLocal: false,
        displayName: discordUsername,
        isBridged: true,
        bridgeSource: 'discord'
      } as MessagePart);
    } else if (match[6]) {
      // Regular mention (@username or @username@domain)
      const username = match[7];
      const domain = match[8];
      
      const mentionKey = domain ? `${username}@${domain}` : username;
      const userData = usernameToUserDataMap[mentionKey] || usernameToUserDataMap[username];
      
      const currentDomain = import.meta.env.VITE_DOMAIN as string;
      const isLocal = userData?.isLocal ?? (!domain || domain === currentDomain);
      const userId = userData?.userId ?? `unresolved-${username}${domain ? '@' + domain : ''}`;
      
      const finalDomain = domain || currentDomain;
      
      parts.push({
        type: 'mention',
        userId: userId,
        username: username,
        domain: finalDomain,
        isLocal: isLocal
      });
    } else if (match[9]) {
      // '#word' meaning depends on parseOptions.hashtags:
      //   'social'   (default) ActivityPub hashtag part
      //   'channels' server chat: #name of an accessible channel becomes a
      //              channel_mention, anything else is plain text
      //   'none'     DMs: always plain text
      const hashtagName = match[9];
      const normalizedName = hashtagName.toLowerCase();
      const hashtagMode = parseOptions.hashtags ?? 'social';

      if (hashtagMode === 'channels') {
        const channel = parseOptions.channelDataMap?.[normalizedName];
        if (channel) {
          parts.push({
            type: 'channel_mention',
            channelId: channel.id,
            serverId: channel.serverId,
            name: hashtagName,
          });
        } else {
          parts.push({ type: 'text', text: match[0] });
        }
      } else if (hashtagMode === 'none') {
        parts.push({ type: 'text', text: match[0] });
      } else {
        const hashtagData = hashtagDataMap[normalizedName];

        if (hashtagData) {
          parts.push({
            type: 'hashtag',
            name: hashtagName, // preserve original case
            id: hashtagData.id,
            count: hashtagData.count,
            last_updated: hashtagData.last_updated,
            normalized: hashtagData.normalized
          });
        } else {
          // Not yet in the database; the row is created on post save.
          parts.push({
            type: 'hashtag',
            name: hashtagName,
            id: 'new', // placeholder for new hashtags
            normalized: normalizedName
          });
        }
      }
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    parts.push(...await parseTextForUrls(remainingText, emojiDataMap));
  }

  return parts;
}

/**
 * Context-dependent parsing behaviour.
 *
 * hashtags:
 *   'social'   (default) '#word' becomes an ActivityPub hashtag part
 *   'channels' server chat: '#name' of a channel in channelDataMap becomes a
 *              clickable channel_mention; unknown names stay plain text
 *   'none'     DMs: '#word' is always plain text
 *
 * channelDataMap: lowercase channel name → channel. The caller restricts it
 * to channels the sender can access.
 */
export interface ContentParseOptions {
  hashtags?: 'social' | 'channels' | 'none';
  channelDataMap?: Record<string, { id: string; serverId: string; name: string }>;
}

export async function parseContentToMessageParts(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean }> = {},
  emojiDataMap: Record<string, any> = {},
  hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {},
  roleDataMap: Record<string, { name: string; color: string | null }> = {},
  parseOptions: ContentParseOptions = {}
): Promise<MessagePart[]> {
  if (!content) return [{ type: 'text', text: '' }];

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  FENCED_CODE_BLOCK_REGEX.lastIndex = 0;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = FENCED_CODE_BLOCK_REGEX.exec(content)) !== null) {
    if (fenceMatch.index > lastIndex) {
      parts.push(...await parseContentSegment(
        content.slice(lastIndex, fenceMatch.index),
        usernameToUserDataMap,
        emojiDataMap,
        hashtagDataMap,
        roleDataMap,
        parseOptions,
      ));
    }
    parts.push({ type: 'text', text: fenceMatch[0] });
    lastIndex = fenceMatch.index + fenceMatch[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(...await parseContentSegment(
      content.slice(lastIndex),
      usernameToUserDataMap,
      emojiDataMap,
      hashtagDataMap,
      roleDataMap,
      parseOptions,
    ));
  }

  // Own-origin channel links become channel references:
  // <origin>/chat/<serverId>/<channelId> renders as "#channel-name" when the
  // channel is one the sender can access.
  if (parseOptions.hashtags === 'channels' && parseOptions.channelDataMap) {
    const byId = new Map(
      Object.values(parseOptions.channelDataMap).map(c => [c.id, c]),
    );
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type !== 'url') continue;
      const linked = matchChannelUrl(part.url, byId);
      if (linked) {
        parts[i] = {
          type: 'channel_mention',
          channelId: linked.id,
          serverId: linked.serverId,
          name: linked.name,
          messageId: linked.messageId,
        };
      }
    }
  }

  return trimTrailingWhitespace(parts);
}

/**
 * Strips trailing whitespace parts left by the composer's auto-inserted space
 * after emoji/mention selection.
 *
 * Required for single-emoji detection: a trailing space part suppresses the
 * 2x render of a message ending in one emoji.
 */
export function trimTrailingWhitespace(parts: MessagePart[]): MessagePart[] {
  if (!parts || parts.length === 0) return parts;
  
  const result = [...parts];
  
  while (result.length > 0) {
    const lastPart = result[result.length - 1];
    
    if (lastPart.type !== 'text') break;
    
    const text = lastPart.text || '';
    const trimmed = text.trimEnd();
    
    if (trimmed === '') {
      result.pop();
    } else if (trimmed !== text) {
      result[result.length - 1] = { ...lastPart, text: trimmed };
      break;
    } else {
      break;
    }
  }
  
  return result;
}

/**
 * Splits text into url and emoji parts. URL tracking-parameter stripping
 * happens here so every caller (ActivityPub, DMs, chat) gets it.
 */
async function parseTextForUrls(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];
  
  URL_MATCH_REGEX.lastIndex = 0;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match;
  
  const shouldStripTrackers = isUrlTrackingStrippingEnabled();
  
  while ((match = URL_MATCH_REGEX.exec(text)) !== null) {
    const { url: rawUrl, preview, segmentStart, segmentEnd } = parseUrlMatchContext(
      text,
      match.index,
      match[0].length
    );

    if (segmentStart > lastIndex) {
      const textBefore = text.substring(lastIndex, segmentStart);
      parts.push(...await parseTextForEmojis(textBefore, emojiDataMap));
    }

    let url = rawUrl;
    if (shouldStripTrackers) {
      url = stripTrackingParameters(url);
    }

    parts.push({ type: 'url', url, preview });
    lastIndex = segmentEnd;
  }
  
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    parts.push(...await parseTextForEmojis(remainingText, emojiDataMap));
  }
  
  if (parts.length === 0) {
    return await parseTextForEmojis(text, emojiDataMap);
  }
  
  return parts;
}

/**
 * Splits text on emoji tokens: UUID form and shortcode form.
 */
async function parseTextForEmojis(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  // COMBINED_EMOJI_REGEX is module-scoped and stateful 'g'; reset per call.
  COMBINED_EMOJI_REGEX.lastIndex = 0;
  
  let emojiMatch;
  while ((emojiMatch = COMBINED_EMOJI_REGEX.exec(text)) !== null) {
    const emojiIndex = emojiMatch.index;
    
    if (emojiIndex > lastIndex) {
      const textPart = text.substring(lastIndex, emojiIndex);
      if (textPart) {
        parts.push({ type: 'text', text: textPart });
      }
    }
    
    const emojiIdentifier = emojiMatch[1];
    
    // emojiDataMap is keyed by both id and token.
    let emojiData = emojiDataMap[emojiIdentifier];
    
    if (!emojiData) {
      emojiData =
        findCustomEmojiInCache(emojiIdentifier) ??
        getDbCachedEmoji(emojiIdentifier) ??
        (await findCustomEmojiByToken(emojiIdentifier)) ??
        undefined;

      if (!emojiData && emojiIdentifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        emojiData = await getEmoji(emojiIdentifier);
      }
    }
    
    if (emojiData) {
      // Unified-pack emoji carries a unicode codepoint; emit it as text.
      if (emojiData._inlineAsText && emojiData.unicode) {
        debug.log('Inlining unified emoji as text:', emojiData.unicode);
        parts.push({ type: 'text', text: emojiData.unicode });
      } else {
        // Server custom emoji: the full row is needed for URL lookup.
        parts.push({ type: 'emoji', emoji: emojiData });
      }
    } else {
      debug.warn('Emoji not resolved, showing as text:', emojiMatch[0]);
      parts.push({ type: 'text', text: emojiMatch[0] });
    }
    
    lastIndex = emojiIndex + emojiMatch[0].length;
  }

  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    if (remainingText) {
      parts.push({ type: 'text', text: remainingText });
    }
  }

  if (parts.length === 0 && text) {
    return [{ type: 'text', text: text }];
  }

  return parts;
}

/**
 * Renders MessagePart[] as the ActivityPub HTML sent to remote instances.
 */
export function convertMessagePartsToActivityPubHTML(parts: MessagePart[]): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text':
        return part.text || '';
        
      case 'mention': {
        const currentDomain = import.meta.env.VITE_DOMAIN as string;
        const username = (part.username || '').replace(/^@+/, ''); // prevent @@
        const domain = part.domain || currentDomain;
        const href = `https://${domain}/users/${username}`;
        const displayName = part.isLocal ? `@${username}` : `@${username}@${part.domain}`;
        return `<span class="h-card"><a href="${href}" class="u-url mention">${displayName}</a></span>`;
      }
      
      case 'url':
        return `<a href="${part.url}" target="_blank" rel="noopener">${part.url}</a>`;
        
      case 'hashtag': {
        const currentDomain = import.meta.env.VITE_DOMAIN as string;
        const href = `https://${currentDomain}/tags/${part.name}`;
        return `<a href="${href}" class="mention hashtag" rel="tag">#<span>${part.name}</span></a>`;
      }
        
      case 'emoji': {
        // Misskey format: content carries the shortcode only; emoji data goes
        // in the ActivityPub tag array (see extractActivityPubEmojiTags).
        if (part.emoji && part.emoji.name) {
          return `:${part.emoji.name}:`;
        }
        return `:emoji:`;
      }
      
      case 'file': {
        // Files federate as attachments, not inline content
        // (see extractActivityPubAttachments).
        return '';
      }
      
      case 'system':
        // System messages are not federated.
        return '';
        
      default:
        return '';
    }
  }).join('');
}

/**
 * Renders MessagePart[] back to the plain-text source form.
 */
export function convertMessagePartsToText(parts: MessagePart[]): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text':
        return part.text;
        
      case 'mention':
        return part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
        
      case 'hashtag':
        return `#${part.name}`;
        
      case 'url':
        return part.url;
        
      case 'emoji':
        return `:${part.emoji.name}:`;
        
      case 'file':
        return `[${part.fileType} file]`;
        
      case 'system':
        return `[${part.event_type}]`;
        
      default:
        return '';
    }
  }).join('');
}

/**
 * Mention entries for the ActivityPub tag array.
 */
export function extractMentionsFromMessageParts(parts: MessagePart[]): Array<{
  username: string;
  domain: string;
  isLocal: boolean;
  userId?: string;
  href: string;
  name: string;
}> {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'mention' }> => part.type === 'mention')
    .map(part => {
      const currentDomain = import.meta.env.VITE_DOMAIN as string;
      const domain = part.domain || currentDomain;
      const href = `https://${domain}/users/${part.username}`;  // /users/ form, not /@user
      const name = part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
      
      return {
        username: part.username,
        domain: domain,
        isLocal: part.isLocal,
        userId: part.userId,
        href: href,
        name: name
      };
    });
}

/**
 * Parses inbound federated ActivityPub HTML into MessagePart[]. Inverse of
 * convertMessagePartsToActivityPubHTML.
 */
export function convertActivityPubHTMLToMessageParts(html: string): MessagePart[] {
  if (!html) return [{ type: 'text', text: '' }];
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const parts: MessagePart[] = [];
  
  const walkNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text.trim()) {
        // Mentions belong in <a> tags. Unwrapped text is passed through
        // verbatim rather than re-parsed.
        parts.push({ type: 'text', text });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      
      // h-card is a wrapper; descend into its children.
      if (element.classList.contains('h-card')) {
        node.childNodes.forEach(walkNode);
        return;
      }
      
      // Mention link form: <span class="h-card"><a class="u-url mention">@user@domain</a></span>
      if (element.tagName === 'A' && element.classList.contains('mention')) {
        const href = element.getAttribute('href') || '';
        const text = element.textContent || '';
        
        const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?$/);
        if (mentionMatch) {
          const username = mentionMatch[1];
          let domain = mentionMatch[2];
          
          // Domain absent from the text: take it from href
          // (e.g. https://misskey.io/users/rec8bit).
          if (!domain && href) {
            try {
              const hrefDomain = new URL(href).hostname;
              const currentDomain = import.meta.env.VITE_DOMAIN as string;
              if (hrefDomain && hrefDomain !== currentDomain) {
                domain = hrefDomain;
              }
            } catch { /* ignore invalid URLs */ }
          }
          
          const currentDomain = import.meta.env.VITE_DOMAIN as string;
          
          parts.push({
            type: 'mention',
            userId: href,
            username: username,
            domain: domain || currentDomain,
            isLocal: !domain || domain === currentDomain,
            displayName: username
          });
          return;
        }
      }
      
      if (element.tagName === 'A' && element.classList.contains('hashtag')) {
        const text = element.textContent || '';
        // Unicode-aware: matches CJK and other non-Latin scripts.
        const tagMatch = text.match(/^#([\p{L}\p{N}_-]+)$/u);
        if (tagMatch) {
          parts.push({
            type: 'hashtag',
            name: tagMatch[1]
          } as any);
          return;
        }
      }
      
      // Plain links become url parts so YouTube/Spotify embeds render.
      if (element.tagName === 'A' && !element.classList.contains('mention') && !element.classList.contains('hashtag')) {
        const href = element.getAttribute('href');
        if (href && /^https?:\/\//i.test(href)) {
          parts.push({ type: 'url', url: href, preview: true });
          return;
        }
      }
      
      if (element.tagName === 'BR') {
        parts.push({ type: 'text', text: '\n' });
        return;
      }
      
      if (element.tagName === 'P') {
        node.childNodes.forEach(walkNode);
        // Trailing paragraph gets no newline.
        if (element.nextSibling) {
          parts.push({ type: 'text', text: '\n' });
        }
        return;
      }
      
      node.childNodes.forEach(walkNode);
    }
  };
  
  walkNode(doc.body);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: html }];
}

/**
 * ActivityPub Document attachments for the file parts.
 */
export function extractActivityPubAttachments(parts: MessagePart[]): any[] {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'file' }> => part.type === 'file')
    .map(part => ({
      type: 'Document',
      url: part.url,
      mediaType: part.fileType === 'image' ? 'image/jpeg' : 
                part.fileType === 'video' ? 'video/mp4' : 
                part.fileType === 'audio' ? 'audio/mpeg' : 'application/octet-stream',
      ...(part.fileName && { name: part.fileName })
    }));
}

/**
 * Emoji tag objects for the ActivityPub tag array, in Misskey's shape.
 */
export function extractActivityPubEmojiTags(parts: MessagePart[], baseUrl?: string): any[] {
  const currentDomain = import.meta.env.VITE_DOMAIN as string;
  const defaultBaseUrl = `https://${currentDomain}`;
  const finalBaseUrl = baseUrl || defaultBaseUrl;
  
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'emoji' }> => part.type === 'emoji')
    .map(part => ({
      id: part.emoji.url || `${finalBaseUrl}/emojis/${part.emoji.id}`,
      type: 'Emoji',
      name: `:${part.emoji.name}:`,
      icon: {
        type: 'Image',
        url: part.emoji.url || `${finalBaseUrl}/emojis/${part.emoji.id}.png`
      }
    }));
}

// Legacy names, retained for existing call sites.
export const parseContentToUnifiedFormat = parseContentToMessageParts;
export const convertUnifiedToActivityPubHTML = convertMessagePartsToActivityPubHTML;
export const reconstructContentToText = convertMessagePartsToText;

/**
 * Hashtag rows for post_hashtags insertion.
 */
export function extractHashtagsFromMessageParts(parts: MessagePart[]): Array<{
  name: string;
  normalized: string;
  id?: string;
}> {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'hashtag' }> => part.type === 'hashtag')
    .map(part => ({
      name: part.name,
      normalized: part.normalized || part.name.toLowerCase(),
      id: part.id !== 'new' ? part.id : undefined, // exclude placeholder IDs
    }));
}
