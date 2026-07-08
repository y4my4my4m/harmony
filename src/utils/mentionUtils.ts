/**
 * Professional mention extraction and processing utilities
 * Handles both local (@username) and remote (@username@domain) mentions
 */

import { supabase } from '@/supabase';
import type { UserData, FederatedUser } from '@/types';
import { debug } from '@/utils/debug'
import { getEmojiUrl } from '@/utils/emojiUtils';
import { sanitizeInlineHtml } from '@/utils/sanitize';

export interface MentionMatch {
  full: string;          // "@tester004@mastodon.social"
  username: string;      // "tester004"
  domain?: string;       // "mastodon.social" or undefined for local
  startIndex: number;
  endIndex: number;
}

export interface ResolvedMention {
  mention: MentionMatch;
  user?: UserData;
  inboxUrl?: string;
  actorUrl?: string;
}

/**
 * Parse display_name or bio that may be plain string, JSON (Misskey MFM), or MessagePart[]
 * Returns safe HTML string for v-html rendering.
 *
 * Every branch HTML-escapes the underlying user text before generating any
 * markup, and the final result is run through `sanitizeInlineHtml` as
 * defense-in-depth - if a future change to `parseMfmOrMessagePartsToHtml`
 * accidentally splices unescaped content, the sanitizer still strips
 * `<style>`, `<script>`, inline event handlers, and `<a>` (bios/display
 * names should never contain links injected by the user; legitimate URLs
 * are surfaced via separate profile-fields / PropertyValue rendering).
 */
export function parseDisplayNameOrBioForDisplay(raw: any, fallback: string = ''): string {
  if (raw == null || raw === '') return sanitizeInlineHtml(escapeHtml(fallback));
  if (typeof raw === 'string' && !raw.trim()) return sanitizeInlineHtml(escapeHtml(fallback));

  let html: string;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        html = parseMfmOrMessagePartsToHtml(parsed);
      } else {
        html = escapeHtml(raw);
      }
    } catch {
      html = escapeHtml(raw);
    }
  } else if (Array.isArray(raw)) {
    html = parseMfmOrMessagePartsToHtml(raw);
  } else {
    html = escapeHtml(String(raw));
  }

  return sanitizeInlineHtml(html);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Convert Misskey MFM or MessagePart[] array to HTML */
function parseMfmOrMessagePartsToHtml(parts: any[]): string {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const html: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text != null) {
      html.push(escapeHtml(String(p.text)));
    } else if ((p.type === 'emoji' || p.type === 'emotion') && (p.emoji?.url || p.url)) {
      const rawUrl = p.emoji?.url ?? p.url;
      const url = rawUrl ? getEmojiUrl(rawUrl, 48) : rawUrl;
      const name = p.emoji?.name ?? p.name ?? 'emoji';
      // The fallback handler was previously inlined as an `onerror` attribute
      // that spliced the (user-controlled) emoji `name` into a JavaScript
      // string - a JS-context injection vector. The DOMPurify sanitizer
      // applied at the consumer (display-name / bio v-html bindings) now
      // strips `onerror`; if the image fails to load the browser shows the
      // alt text, which is sufficient.
      html.push(`<img class="inline-emoji" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" />`);
    } else if (p.type === 'emoji' && p.name && !p.url) {
      html.push(escapeHtml(`:${p.name}:`));
    }
  }
  return html.join('') || '';
}

/**
 * Parse bio text with custom emojis and convert to MessagePart[]
 * Replaces :emoji: patterns with proper emoji parts
 */
export function parseBioWithEmojis(bio: string, emojis: Array<{name: string, url: string}>): any[] {
  if (!bio || emojis.length === 0) {
    return [{ type: 'text', text: bio || '' }];
  }

  const emojiMap = new Map(emojis.map(e => [e.name, e.url]));
  
  const parts: any[] = [];
  
  // Regex to find :emoji: patterns (including zero-width space that Misskey uses)
  const emojiRegex = /\u200b?:([a-zA-Z0-9_]+):\u200b?/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = emojiRegex.exec(bio)) !== null) {
    const emojiName = match[1];
    const emojiUrl = emojiMap.get(emojiName);
    
    // Add text before this emoji
    if (match.index > lastIndex) {
      const textBefore = bio.substring(lastIndex, match.index);
      if (textBefore) {
        parts.push({ type: 'text', text: textBefore });
      }
    }
    
    if (emojiUrl) {
      parts.push({
        type: 'emoji',
        emoji: {
          id: `remote-${emojiName}`,
          name: emojiName,
          url: emojiUrl,
          server_id: 'remote'
        }
      });
    } else {
      // No URL found, keep as text
      parts.push({ type: 'text', text: match[0] });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < bio.length) {
    const remainingText = bio.substring(lastIndex);
    if (remainingText) {
      parts.push({ type: 'text', text: remainingText });
    }
  }
  
  return parts.length > 0 ? parts : [{ type: 'text', text: bio }];
}

/**
 * Extract all mentions from text content
 * Supports both @username (local) and @username@domain (remote) formats
 */
export function extractMentions(text: string): MentionMatch[] {
  // Pre-scan for URLs to avoid matching @mentions inside them
  // (e.g., https://mastodon.social/@user/12345)
  const urlRanges: Array<{ start: number; end: number }> = [];
  const preUrlRegex = /\bhttps?:\/\/\S+/g;
  let urlScan;
  while ((urlScan = preUrlRegex.exec(text)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  const mentionRegex = /@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/g;
  const mentions: MentionMatch[] = [];
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (isInsideUrl(match.index)) continue;
    mentions.push({
      full: match[0],
      username: match[1],
      domain: match[2],
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  return mentions;
}

/**
 * Resolve mentions to actual users and their federation details
 */
export async function resolveMentions(mentions: MentionMatch[]): Promise<ResolvedMention[]> {
  const resolved: ResolvedMention[] = [];
  const currentDomain = import.meta.env.VITE_DOMAIN as string;

  for (const mention of mentions) {
    try {
      const domain = mention.domain || currentDomain;
      const isLocal = domain === currentDomain;

      // Query database for user
      const { data: user, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', mention.username)
        .eq('domain', domain)
        .eq('is_local', isLocal)
        .single();

      if (error || !user) {
        debug.log(`Mention ${mention.full} not found in database`);
        resolved.push({ mention });
        continue;
      }

      const federatedUser: FederatedUser = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        domain: user.domain,
        avatar_url: user.avatar_url,
        handle: domain === currentDomain 
          ? `@${user.username}`
          : `@${user.username}@${domain}`,
        is_local: user.is_local,
        bio: user.bio || '',
        verified: false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: user.created_at,
        updated_at: user.updated_at,
        federated_id: user.federated_id,
        public_key: user.public_key,
        inbox_url: user.inbox_url,
        outbox_url: user.outbox_url,
        followers_url: user.followers_url,
        following_url: user.following_url,
        featured_url: user.featured_url,
        last_synced_at: user.last_synced_at
      };

      let inboxUrl: string | undefined;
      let actorUrl: string | undefined;

      if (isLocal) {
        actorUrl = `https://${currentDomain}/users/${user.username}`;
        inboxUrl = `${actorUrl}/inbox`;
      } else {
        actorUrl = user.federated_id || `https://${domain}/users/${user.username}`;
        inboxUrl = user.inbox_url || `${actorUrl}/inbox`;
      }

      // Cast through `any`: `ResolvedMention.user` is typed as `UserData`
      // (camelCase) but we actually pass the snake_case row from the
      // `profiles` table. Tightening the type would be a larger refactor.
      resolved.push({
        mention,
        user: federatedUser as any,
        inboxUrl,
        actorUrl,
      });

    } catch (error) {
      debug.error(`Failed to resolve mention ${mention.full}:`, error);
      resolved.push({ mention });
    }
  }

  return resolved;
}

/**
 * Generate ActivityPub-compatible mention tags for activities
 */
export function generateMentionTags(resolvedMentions: ResolvedMention[]): any[] {
  return resolvedMentions
    .filter(rm => rm.user && rm.actorUrl)
    .map(rm => ({
      type: 'Mention',
      href: rm.actorUrl,
      name: rm.mention.full
    }));
}

/**
 * Get unique inbox URLs from resolved mentions for federation delivery
 */
export function getDeliveryInboxes(resolvedMentions: ResolvedMention[]): string[] {
  const inboxes = new Set<string>();
  
  resolvedMentions.forEach(rm => {
    // `ResolvedMention.user` is typed as `UserData` but the actual data is a
    // snake_case `FederatedUser`/profile row, so read via `any`.
    if (rm.inboxUrl && rm.user && !(rm.user as any).is_local) {
      inboxes.add(rm.inboxUrl);
    }
  });

  return Array.from(inboxes);
}

/**
 * Convert plain text with mentions to ActivityPub HTML format
 */
export function formatMentionsForActivityPub(
  text: string, 
  resolvedMentions: ResolvedMention[]
): string {
  let formatted = text;
  
  const sortedMentions = [...resolvedMentions].sort(
    (a, b) => b.mention.startIndex - a.mention.startIndex
  );

  sortedMentions.forEach(rm => {
    if (rm.user && rm.actorUrl) {
      const before = formatted.substring(0, rm.mention.startIndex);
      const after = formatted.substring(rm.mention.endIndex);
      const mentionHtml = `<a href="${rm.actorUrl}" class="mention">${rm.mention.full}</a>`;
      formatted = before + mentionHtml + after;
    }
  });

  return formatted;
}

/**
 * Attempt to resolve remote mention via backend WebFinger proxy
 * Uses the federation backend to bypass CORS restrictions
 */
export async function resolveRemoteMention(username: string, domain: string, forceRefresh: boolean = false): Promise<FederatedUser | null> {
  try {
    // Use relative URL - federation backend is proxied through the same domain
    const lookupUrl = '/api/federation/lookup-user';
    
    debug.log(`Looking up remote user via backend: ${username}@${domain}${forceRefresh ? ' (force refresh)' : ''}`);
    
    const response = await fetch(lookupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        handle: `${username}@${domain}`,
        forceRefresh
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      debug.warn(`Remote user lookup failed: ${errorData.error || response.statusText}`);
      return null;
    }

    const result = await response.json();
    
    if (!result.success || !result.user) {
      debug.warn(`Remote user lookup returned no user`);
      return null;
    }

    const savedUser = result.user;
    debug.log(`${result.refreshed ? 'Refreshed' : (result.cached ? 'Found cached' : 'Created')} remote user: ${username}@${domain}`);

    let bioEmojis: Array<{name: string, url: string}> = [];
    let displayNameEmojis: Array<{name: string, url: string}> = [];
    if (savedUser.federation_metadata) {
      try {
        const metadata = typeof savedUser.federation_metadata === 'string' 
          ? JSON.parse(savedUser.federation_metadata)
          : savedUser.federation_metadata;
        if (metadata.bio_emojis) {
          bioEmojis = metadata.bio_emojis;
        }
        if (metadata.display_name_emojis) {
          displayNameEmojis = metadata.display_name_emojis;
        }
      } catch (e) {
        debug.warn('Failed to parse federation_metadata:', e);
      }
    }

    let bio: string | any[] = savedUser.bio || '';
    if (bioEmojis.length > 0 && typeof bio === 'string') {
      bio = parseBioWithEmojis(bio, bioEmojis);
    }

    let display_name: string | any[] = savedUser.display_name || savedUser.username;
    if (displayNameEmojis.length > 0 && typeof display_name === 'string') {
      display_name = parseBioWithEmojis(display_name, displayNameEmojis);
    }

    return {
      id: savedUser.id,
      username: savedUser.username,
      // `display_name` is typed as `string | undefined` on `Profile`, but in
      // practice may be either a string or a `MessagePart[]` carrying inline
      // emoji parts. Cast at the field boundary.
      display_name: display_name as any,
      domain: savedUser.domain,
      avatar_url: savedUser.avatar_url,
      banner_url: savedUser.banner_url,
      handle: `@${username}@${domain}`,
      is_local: false,
      // Same `bio` shape concern as `display_name` above.
      bio: bio as any,
      verified: false,
      followers_count: savedUser.followers_count || 0,
      following_count: savedUser.following_count || 0,
      posts_count: savedUser.posts_count || 0,
      created_at: savedUser.created_at,
      updated_at: savedUser.updated_at,
      federated_id: savedUser.federated_id,
      public_key: savedUser.public_key,
      inbox_url: savedUser.inbox_url,
      outbox_url: savedUser.outbox_url,
      followers_url: savedUser.followers_url,
      following_url: savedUser.following_url,
      featured_url: savedUser.featured_url,
      last_synced_at: savedUser.last_synced_at
    };

  } catch (error) {
    debug.error(`Failed to resolve remote mention ${username}@${domain}:`, error);
    return null;
  }
}
