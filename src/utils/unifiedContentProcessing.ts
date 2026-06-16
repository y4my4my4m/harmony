/**
 * Unified content processing system for ALL text content in Harmony
 * Used by: chat messages, DMs, ActivityPub posts, and federation
 * 
 * This replaces the fragmented approach and uses the existing MessagePart types
 * for consistency across the entire application.
 */

import type { MessagePart } from '@/types';
import { getEmoji } from '@/services/emojiService';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'
import { resolveEmoji, loadEmojiData, isLoaded as unifiedEmojiLoaded } from '@/services/unifiedEmojiService'
import { stripTrackingParameters, isUrlTrackingStrippingEnabled } from '@/utils/urlTrackerStripper'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { parseUrlMatchContext, URL_TOKEN_REGEX } from '@/utils/urlSplitting'

// Support both UUID-based emojis (legacy) and shortcode emojis (new)
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

// Hoisted to module scope; stateful 'g' patterns need lastIndex reset at
// the call site before each use. Allocating a fresh RegExp inside every
// `parseContentToMessageParts` / `parseTextForUrls` / `parseTextForEmojis`
// call was a hot-path waste because these helpers run per-segment per
// message (BUGS.md Pattern P-β + code-review M4).
const MENTION_REGEX = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
const URL_PRESCAN_REGEX = URL_TOKEN_REGEX;
const URL_MATCH_REGEX = new RegExp(`(${URL_TOKEN_REGEX.source})`, 'g');
const COMBINED_MENTION_HASHTAG_REGEX = /(@role:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))|(@d!(\d+):([a-zA-Z0-9_.-]+))|(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)|(?<![&\w])#([\p{L}\p{N}_-]+)/gu;
const COMBINED_EMOJI_REGEX = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_+~-]+):/g;

/**
 * Helper function to efficiently resolve mention user data in batch
 * This should be called before parseContentToMessageParts for optimal performance
 */
export async function resolveMentionsUserData(content: string): Promise<Record<string, { userId: string; isLocal: boolean }>> {
  const userDataMap: Record<string, { userId: string; isLocal: boolean }> = {};
  
  // Pre-scan for URLs to avoid resolving @mentions inside them
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
  
  // Extract all unique usernames from content, skipping those inside URLs
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (isInsideUrl(match.index)) continue;
    const username = match[1];
    const domain = match[2];
    const mentionKey = domain ? `${username}@${domain}` : username;
    uniqueUsernames.add(mentionKey);
  }
  
  // If no mentions, return empty map
  if (uniqueUsernames.size === 0) return userDataMap;
  
  try {
    // Build a single query to get all mentioned users at once
    const usernameList = Array.from(uniqueUsernames);
    const localUsernames = usernameList.filter(u => !u.includes('@'));
    const remoteUsernames = usernameList.filter(u => u.includes('@'));
    
    // Query for local users
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
    
    // Query for remote users (username@domain format).
    //
    // Previously this issued one query per remote mention (Promise.all of N
    // round-trips). Replaced with a single PostgREST .or() filter that
    // unions the (username, domain) pairs into one request. Username and
    // domain charsets are constrained by MENTION_REGEX above
    // (`[a-zA-Z0-9_-]+` and `[a-zA-Z0-9.-]+`) - neither contains commas,
    // parens, or quotes, so the values are safe to interpolate directly
    // into PostgREST filter syntax without escaping.
    if (remoteUsernames.length > 0) {
      try {
        const pairs = remoteUsernames
          .map(ud => {
            const [username, domain] = ud.split('@');
            if (!username || !domain) return null;
            // Defense in depth: re-validate charset before string-interpolating.
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
 * Extract role UUIDs from @role:UUID mentions and look up their name/color
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
 * Helper function to efficiently resolve emoji data in batch
 * Supports both UUID-based emojis, shortcode emojis, and unified emoji pack
 */
export async function resolveEmojisData(content: string): Promise<Record<string, any>> {
  const emojiDataMap: Record<string, any> = {};
  
  let match;
  const uniqueEmojiIds = new Set<string>();
  /** Full inner tokens as they appear in content (e.g. har_wink~1). */
  const uniqueEmojiTokens = new Set<string>();
  
  // Extract UUID-based emojis (legacy format)
  emojiUuidRegex.lastIndex = 0;
  while ((match = emojiUuidRegex.exec(content)) !== null) {
    const emojiId = match[1];
    if (emojiId) {
      uniqueEmojiIds.add(emojiId);
    }
  }
  
  // Extract shortcode emojis (current format)
  emojiShortcodeRegex.lastIndex = 0;
  while ((match = emojiShortcodeRegex.exec(content)) !== null) {
    const token = match[1];
    if (token) {
      uniqueEmojiTokens.add(token);
    }
  }
  
  // If no emojis, return empty map
  if (uniqueEmojiIds.size === 0 && uniqueEmojiTokens.size === 0) return emojiDataMap;

  // Phase 1: Resolve from in-memory emoji cache (instant, works offline)
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
    // Store not ready yet, fall through to DB
  }

  // Phase 2: Query database for any emojis not found in cache
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

  // Phase 3: For emojis still unresolved, check unified emoji pack
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
 * Helper function to efficiently resolve hashtag data in batch
 * This should be called before parseContentToMessageParts for optimal performance
 */
export async function resolveHashtagsData(content: string): Promise<Record<string, { id: string; count: number; last_updated: string; normalized: string }>> {
  // Unicode-aware hashtag regex: supports Japanese, Chinese, Korean, etc.
  // \p{L} = any letter, \p{N} = any number, includes CJK characters
  const hashtagRegex = /(?<![&\w])#([\p{L}\p{N}_-]+)/gu;
  const hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {};
  
  let match;
  const uniqueHashtags = new Set<string>();
  
  // Extract all unique hashtags from content
  while ((match = hashtagRegex.exec(content)) !== null) {
    const hashtag = match[1].toLowerCase(); // normalize to lowercase
    uniqueHashtags.add(hashtag);
  }
  
  if (uniqueHashtags.size === 0) {
    return hashtagDataMap;
  }
  
  // Batch query for all hashtags
  const { data, error } = await supabase
    .from('hashtags')
    .select('id, tag, normalized_tag, total_uses, last_used_at')
    .in('normalized_tag', Array.from(uniqueHashtags));
    
  if (error) {
    debug.warn('Error fetching hashtag data:', error);
    return hashtagDataMap;
  }
  
  // Map results by normalized name for quick lookup
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

/** Fenced code blocks must stay intact — URL/mention parsing inside them breaks view-mode markdown. */
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

/**
 * Parse one content segment (outside fenced code blocks) into MessageParts.
 */
async function parseContentSegment(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean }>,
  emojiDataMap: Record<string, any>,
  hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }>,
  roleDataMap: Record<string, { name: string; color: string | null }>,
): Promise<MessagePart[]> {
  if (!content) return [];

  // Pre-scan for URLs so we can skip @mentions and #hashtags that appear
  // inside them (e.g., https://mastodon.social/@user/12345)
  const urlRanges: Array<{ start: number; end: number }> = [];
  URL_PRESCAN_REGEX.lastIndex = 0;
  let urlScan;
  while ((urlScan = URL_PRESCAN_REGEX.exec(content)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  // Parse role mentions, Discord bridged mentions, user mentions, and hashtags
  // @role:UUID - role mention
  // @d!ID:username - Discord bridged user
  // @username or @username@domain - user mention
  // #hashtag - hashtag
  // Pattern hoisted to module scope (COMBINED_MENTION_HASHTAG_REGEX); reset
  // lastIndex per-call since this is a stateful 'g' regex.
  COMBINED_MENTION_HASHTAG_REGEX.lastIndex = 0;
  const parts: MessagePart[] = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = COMBINED_MENTION_HASHTAG_REGEX.exec(content)) !== null) {
    // Skip mentions and hashtags that fall inside a URL - they'll be handled
    // as part of the URL by parseTextForUrls (e.g., mastodon.social/@user/123)
    if (isInsideUrl(match.index)) continue;

    // Add text before current match (if any)
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
      // Hashtag (#tagname)
      const hashtagName = match[9];
      const normalizedName = hashtagName.toLowerCase();
      
      // Look up hashtag data from provided map
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
        // Hashtag not in database yet, create placeholder (will be created on post save)
        parts.push({
          type: 'hashtag',
          name: hashtagName,
          id: 'new', // placeholder for new hashtags
          normalized: normalizedName
        });
      }
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text (if any)
  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    parts.push(...await parseTextForUrls(remainingText, emojiDataMap));
  }

  return parts;
}

/**
 * Parse content string into unified MessagePart format
 * This is the SINGLE source of truth for all content parsing
 * Used by: chat, DMs, ActivityPub posts, and any text input
 */
export async function parseContentToMessageParts(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean }> = {},
  emojiDataMap: Record<string, any> = {},
  hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {},
  roleDataMap: Record<string, { name: string; color: string | null }> = {}
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
    ));
  }

  // Clean up trailing whitespace from message parts
  return trimTrailingWhitespace(parts);
}

/**
 * Remove trailing whitespace from message parts array
 * This is called after parsing to clean up spaces added for typing convenience
 * (e.g., auto-inserted space after emoji/mention selection)
 * 
 * Benefits:
 * 1. Emojis at the end of messages display at 2x size (single-emoji detection works)
 * 2. Smaller JSON payloads (no unnecessary {"type":"text","text":" "})
 * 3. Cleaner message storage
 */
export function trimTrailingWhitespace(parts: MessagePart[]): MessagePart[] {
  if (!parts || parts.length === 0) return parts;
  
  // Work backwards through the array
  const result = [...parts];
  
  while (result.length > 0) {
    const lastPart = result[result.length - 1];
    
    // Only process text parts
    if (lastPart.type !== 'text') break;
    
    const text = lastPart.text || '';
    const trimmed = text.trimEnd();
    
    if (trimmed === '') {
      // Last part is whitespace-only, remove it entirely
      result.pop();
    } else if (trimmed !== text) {
      // Last part has trailing whitespace, trim it
      result[result.length - 1] = { ...lastPart, text: trimmed };
      break;
    } else {
      // No trailing whitespace, we're done
      break;
    }
  }
  
  return result;
}

/**
 * Parse text for URLs and emojis
 * URL tracking parameter stripping is handled here to cover the entire app (ActivityPub, DMs, chat, etc.)
 */
async function parseTextForUrls(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];
  
  URL_MATCH_REGEX.lastIndex = 0;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match;
  
  // Check if URL tracking stripping is enabled (respects user privacy setting)
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
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    parts.push(...await parseTextForEmojis(remainingText, emojiDataMap));
  }
  
  // If no URLs found, just parse for emojis
  if (parts.length === 0) {
    return await parseTextForEmojis(text, emojiDataMap);
  }
  
  return parts;
}

/**
 * Parse text for emoji shortcodes and return MessageParts
 * Handles both UUID-based emojis and shortcode emojis
 */
async function parseTextForEmojis(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  // Combined regex hoisted to module scope (COMBINED_EMOJI_REGEX); reset
  // lastIndex per-call since this is a stateful 'g' regex.
  COMBINED_EMOJI_REGEX.lastIndex = 0;
  
  let emojiMatch;
  while ((emojiMatch = COMBINED_EMOJI_REGEX.exec(text)) !== null) {
    const emojiIndex = emojiMatch.index;
    
    // Add text before emoji
    if (emojiIndex > lastIndex) {
      const textPart = text.substring(lastIndex, emojiIndex);
      if (textPart) {
        parts.push({ type: 'text', text: textPart });
      }
    }
    
    // Add emoji
    const emojiIdentifier = emojiMatch[1];
    
    // Try to get emoji from data map (by ID or name)
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
      // SIMPLIFIED: If emoji is from unified pack (has unicode), just output as text!
      // This makes emojis portable and pack-agnostic in storage
      if (emojiData._inlineAsText && emojiData.unicode) {
        debug.log('✅ Inlining unified emoji as text:', emojiData.unicode);
        parts.push({ type: 'text', text: emojiData.unicode });
      } else {
        // Server custom emoji - needs the full object for URL lookup
        parts.push({ type: 'emoji', emoji: emojiData });
      }
    } else {
      debug.warn('⚠️ Emoji not resolved, showing as text:', emojiMatch[0]);
      parts.push({ type: 'text', text: emojiMatch[0] });
    }
    
    lastIndex = emojiIndex + emojiMatch[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    if (remainingText) {
      parts.push({ type: 'text', text: remainingText });
    }
  }

  // If no emojis found, return as single text part
  if (parts.length === 0 && text) {
    return [{ type: 'text', text: text }];
  }

  return parts;
}

/**
 * Convert MessagePart[] to ActivityPub HTML for federation
 * This is used when sending posts/messages to remote instances
 */
export function convertMessagePartsToActivityPubHTML(parts: MessagePart[]): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text':
        return part.text || '';
        
      case 'mention': {
        // Build proper ActivityPub mention with h-card structure
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
        // Convert hashtag to ActivityPub-compatible format
        // ActivityPub hashtags are usually rendered as clickable links
        const currentDomain = import.meta.env.VITE_DOMAIN as string;
        const href = `https://${currentDomain}/tags/${part.name}`;
        return `<a href="${href}" class="mention hashtag" rel="tag">#<span>${part.name}</span></a>`;
      }
        
      case 'emoji': {
        // Convert emoji to Misskey-compatible format (shortcode only in content)
        // The actual emoji data will be in the ActivityPub tag array
        if (part.emoji && part.emoji.name) {
          return `:${part.emoji.name}:`;
        }
        return `:emoji:`;
      }
      
      case 'file': {
        // Files are handled as ActivityPub attachments, not inline content
        // Return empty string as files are added to the attachment array separately
        return '';
      }
      
      case 'system':
        // System messages shouldn't be federated
        return '';
        
      default:
        return '';
    }
  }).join('');
}

/**
 * Convert MessagePart[] to plain text for display/reconstruction
 * This ensures proper ordering and clean text output
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
 * Extract mentions from MessagePart[] for federation processing
 * Returns mention data needed for ActivityPub tag generation
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
      const href = `https://${domain}/users/${part.username}`;  // ✅ FIX: Use /users/ format
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
 * Convert ActivityPub HTML content back to MessagePart[] format
 * This is used when receiving federated content from remote instances
 * Properly parses ActivityPub HTML with mentions, hashtags, and text
 */
export function convertActivityPubHTMLToMessageParts(html: string): MessagePart[] {
  if (!html) return [{ type: 'text', text: '' }];
  
  // Create a DOM parser to extract structured content
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const parts: MessagePart[] = [];
  
  // Walk through the DOM and extract parts
  const walkNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text.trim()) {
        // Don't parse mentions in plain text - they should be in <a> tags
        // If they're not in tags, it means the sender didn't properly format them
        // Just pass through as text
        parts.push({ type: 'text', text });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      
      // Skip h-card wrapper - process its children directly
      if (element.classList.contains('h-card')) {
        node.childNodes.forEach(walkNode);
        return;
      }
      
      // Check if this is a mention link (ActivityPub format: <span class="h-card"><a class="u-url mention">@user@domain</a></span>)
      if (element.tagName === 'A' && element.classList.contains('mention')) {
        const href = element.getAttribute('href') || '';
        const text = element.textContent || '';
        
        // Parse @username@domain format
        const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?$/);
        if (mentionMatch) {
          const username = mentionMatch[1];
          let domain = mentionMatch[2];
          
          // If domain not in text, extract from href (e.g. https://misskey.io/users/rec8bit)
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
      
      // Check if this is a hashtag
      if (element.tagName === 'A' && element.classList.contains('hashtag')) {
        const text = element.textContent || '';
        // Unicode-aware hashtag regex for CJK and other scripts
        const tagMatch = text.match(/^#([\p{L}\p{N}_-]+)$/u);
        if (tagMatch) {
          parts.push({
            type: 'hashtag',
            name: tagMatch[1]
          } as any);
          return;
        }
      }
      
      // Regular links (not mentions/hashtags) - preserve as URL parts
      // so YouTube, Spotify, etc. embeds render properly
      if (element.tagName === 'A' && !element.classList.contains('mention') && !element.classList.contains('hashtag')) {
        const href = element.getAttribute('href');
        if (href && /^https?:\/\//i.test(href)) {
          parts.push({ type: 'url', url: href, preview: true });
          return;
        }
      }
      
      // Handle line breaks
      if (element.tagName === 'BR') {
        parts.push({ type: 'text', text: '\n' });
        return;
      }
      
      // Handle paragraphs
      if (element.tagName === 'P') {
        node.childNodes.forEach(walkNode);
        // Add newline after paragraph if not the last element
        if (element.nextSibling) {
          parts.push({ type: 'text', text: '\n' });
        }
        return;
      }
      
      // Process children recursively for other elements
      node.childNodes.forEach(walkNode);
    }
  };
  
  walkNode(doc.body);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: html }];
}

/**
 * Extract ActivityPub attachments from MessagePart content
 * Returns properly formatted ActivityPub attachment objects
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
 * Extract emoji tags for ActivityPub federation (Misskey compatibility)
 * Returns properly formatted emoji tag objects
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

// Re-export for backward compatibility (during transition)
export const parseContentToUnifiedFormat = parseContentToMessageParts;
export const convertUnifiedToActivityPubHTML = convertMessagePartsToActivityPubHTML;
export const reconstructContentToText = convertMessagePartsToText;

/**
 * Extract hashtags from MessagePart[] for database processing
 * Returns hashtag data needed for post_hashtags table insertion
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
