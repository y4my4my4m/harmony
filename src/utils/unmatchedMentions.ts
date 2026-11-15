import type { MessagePart, MentionContent } from '@/types';

/** A local handle stored as a mention while naming no account: userId `unresolved-<user>`. */
const UNMATCHED_LOCAL_MENTION_ID = /^unresolved-[^@]+$/;

function unmatchedMentionText(part: MessagePart): string | null {
  if (!part || typeof part !== 'object' || part.type !== 'mention') return null;
  const mention = part as MentionContent & { isBridged?: boolean };
  if (mention.isBridged || mention.domain === 'discord.com') return null;
  if (typeof mention.userId !== 'string' || !UNMATCHED_LOCAL_MENTION_ID.test(mention.userId)) return null;
  const username = String(mention.username ?? '').replace(/^@+/, '');
  return username ? `@${username}` : null;
}

/**
 * Stored mentions of local handles that named no account read as the text
 * typed, joined to the text around them: the parts parseContentToMessageParts
 * stores for such a handle. Returns `parts` itself when none is present.
 */
export function withUnmatchedMentionsAsText(parts: MessagePart[]): MessagePart[] {
  if (!Array.isArray(parts) || !parts.some((part) => unmatchedMentionText(part) !== null)) return parts;

  const result: MessagePart[] = [];
  let joinNext = false;
  for (const part of parts) {
    const text = unmatchedMentionText(part);
    const last = result[result.length - 1];
    if (text !== null) {
      if (last?.type === 'text') result[result.length - 1] = { ...last, text: (last.text || '') + text };
      else result.push({ type: 'text', text });
      joinNext = true;
    } else if (joinNext && part?.type === 'text' && last?.type === 'text') {
      result[result.length - 1] = { ...last, text: (last.text || '') + (part.text || '') };
      joinNext = false;
    } else {
      result.push(part);
      joinNext = false;
    }
  }
  return result;
}
