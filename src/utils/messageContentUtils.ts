import type { MessagePart, MentionContent } from '@/types';

/**
 * Absolute hard ceiling on the number of text characters in a single
 * message or post - enforced by a CHECK constraint on `messages.content`
 * / `posts.content`. This is purely a safety net: the user-facing limit
 * is the admin's `instance_config.max_message_length` (or
 * `max_post_length`), which the DB-side `enforce_message_length` /
 * `enforce_post_length` triggers also enforce at the storage boundary
 * by reading the live config row. The CHECK ceiling here only kicks in
 * if (a) the admin sets a wildly unreasonable value, or (b) the trigger
 * is somehow disabled. Keep in sync with the CHECK constraint value in
 * `db_schema/init/10_functions_core.sql`.
 */
export const MESSAGE_TEXT_HARD_CEILING = 50000;

/**
 * Default soft limit on message text length, used as the fallback before
 * `instance_config.max_message_length` has been loaded. The admin config
 * value (loaded by `useInstanceSettings`) is the authoritative soft cap
 * once available. This default matches the seed value shipped in
 * `db_schema/init/96_seed_data.sql`.
 */
export const DEFAULT_MAX_MESSAGE_TEXT_LENGTH = 2000;

/**
 * Default soft limit on ActivityPub post text length. Same semantics as
 * `DEFAULT_MAX_MESSAGE_TEXT_LENGTH`; mirrors the seed value of
 * `instance_config.max_post_length`.
 */
export const DEFAULT_MAX_POST_TEXT_LENGTH = 500;

/**
 * Sum the length of all `text` parts in a message. Non-text parts
 * (mentions, emojis, files, urls, embeds) are not counted because their
 * payload is structurally bounded by other validation (file count limit,
 * URL parsing, mention resolution, ...).
 */
export function messageTextLength(parts: MessagePart[]): number {
  if (!Array.isArray(parts)) return 0;
  let total = 0;
  for (const part of parts) {
    if (part && typeof part === 'object' && part.type === 'text') {
      total += (part.text || '').length;
    }
  }
  return total;
}

/**
 * Throw a user-readable error if message text exceeds `limit`.
 * Pass the admin-configured `instance_config.max_message_length` value
 * here; the function itself doesn't know about the config, so it can be
 * reused for posts (`max_post_length`) too.
 */
export function assertMessageTextWithinLimit(
  parts: MessagePart[],
  limit: number,
): void {
  const len = messageTextLength(parts);
  if (len > limit) {
    throw new Error(
      `Message is too long (${len.toLocaleString()} / ${limit.toLocaleString()} characters).`,
    );
  }
}

/**
 * Convert MessagePart[] to markdown text for rendering with MarkdownContent
 */
export function messagePartsToMarkdown(parts: MessagePart[]): string {
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map(part => {
    if (!part || typeof part !== 'object') {
      return '';
    }

    switch (part.type) {
      case 'text':
        return part.text || '';
      
      case 'emoji':
        return part.emoji?.name ? `:${part.emoji.name}:` : '';
      
      case 'mention':
        // `MentionContent` has `username` / `displayName`, not `mention`; this
        // is a legacy field name kept around for back-compat by some code paths.
        return (part as any).mention || (part.username ? `@${part.username}` : '');

      case 'role_mention':
        return part.roleId ? `@role:${part.roleId}` : '';

      case 'url':
        return part.url || '';

      case 'embed':
        return part.url || '';

      case 'file':
        return `[${part.fileType || 'file'}: attachment]`;
      
      default:
        return '';
    }
  }).join('');
}

/**
 * Extract plain text from MessagePart[] for previews
 */
export function messagePartsToPlainText(parts: MessagePart[]): string {
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map(part => {
    if (!part || typeof part !== 'object') {
      return '';
    }

    switch (part.type) {
      case 'text':
        return part.text || '';
      
      case 'emoji':
        return part.emoji?.name ? `:${part.emoji.name}:` : '';
      
      case 'mention':
        return (part as any).mention || (part.username ? `@${part.username}` : '');

      case 'role_mention':
        return part.roleName ? `@${part.roleName}` : '';
      
      case 'url':
        return part.url || '';
      
      case 'file':
        return '[file]';
      
      default:
        return '';
    }
  }).join('').trim();
}

/**
 * Strip a leading @mention of the current user from federated messages.
 * ActivityPub clients prepend @recipient on replies/DMs by convention - this
 * makes federated messages look awkward in a chat-style UI.  If the very first
 * content part is a mention of `currentUsername` (local), we remove it and trim
 * any whitespace that directly followed it.  When the mention is the *only*
 * meaningful content we leave the message untouched so it still renders.
 */
export function stripLeadingSelfMention(
  content: MessagePart[],
  currentUsername: string,
): MessagePart[] {
  if (!content?.length || !currentUsername) return content;

  const first = content[0];
  if (!first || typeof first !== 'object' || first.type !== 'mention') return content;

  const mention = first as MentionContent;
  if (!mention.isLocal) return content;
  if (mention.username.toLowerCase() !== currentUsername.toLowerCase()) return content;

  const rest = content.slice(1);

  const hasSubstantiveContent = rest.some(
    p => p.type !== 'text' || (p as { text: string }).text.trim().length > 0,
  );
  if (!hasSubstantiveContent) return content;

  const result = [...rest];
  if (result[0]?.type === 'text') {
    const trimmed = (result[0] as { type: 'text'; text: string }).text.replace(/^\s+/, '');
    if (!trimmed) {
      result.splice(0, 1);
    } else {
      result[0] = { type: 'text', text: trimmed };
    }
  }

  return result;
}

/**
 * Check if message content contains only a single emoji
 */
export function isSingleEmojiMessage(parts: MessagePart[]): boolean {
  if (!Array.isArray(parts) || parts.length !== 1) {
    return false;
  }

  const part = parts[0];
  if (!part || typeof part !== 'object') {
    return false;
  }
  
  // Traditional emoji type
  if (part.type === 'emoji') {
    return true;
  }
  
  // Check if single text part is just one emoji (with optional whitespace)
  if (part.type === 'text') {
    const trimmed = (part.text || '').trim();
    // Unicode emoji regex - must be ONLY an emoji (flags, ZWJ sequences, or standard emojis)
    // Includes Regional Indicator Symbol pairs for flags (U+1F1E6-U+1F1FF)
    const singleEmojiRegex = /^([\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*)$/u;
    return singleEmojiRegex.test(trimmed);
  }
  
  return false;
}
