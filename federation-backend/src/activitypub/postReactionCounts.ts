/**
 * Emoji reaction counts of a post, as its Note carries them:
 *
 *   "harmony:reactions": [
 *     { "content": "🔥", "count": 2 },
 *     { "content": ":blobcat:", "count": 1,
 *       "tag": { "type": "Emoji", "name": ":blobcat:", "icon": { "type": "Image", "url": "https://…" } } }
 *   ]
 *
 * One entry per emoji, in first-reaction order. content is the unicode emoji or `:name:`; an
 * image emoji names its image in an Emoji tag, as an EmojiReact does (FEP-c0e0). Hearts are
 * favourites, counted by the likes collection, and absent.
 *
 * Mastodon, Pleroma and GoToSocial publish no reaction totals; Misskey's live in its API
 * (notes/reactions). The reader stores entries as posts.metadata.remote_reactions, keyed as
 * aggregateRemoteReactions keys them.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { HARMONY_NS } from './harmonyContext.js';
import { getFullEmojiUrl } from '../utils/urlUtils.js';
import { isHeartReaction } from '../utils/heartReaction.js';
import { logger } from '../utils/logger.js';

export const REACTIONS_PROPERTY = 'harmony:reactions';

/** Entries a Note carries and a reader keeps. */
const MAX_ENTRIES = 64;
const MAX_CONTENT_LENGTH = 128;
const MAX_COUNT = 10_000_000;

export interface ReactionCount {
  content: string;
  count: number;
  tag?: { type: 'Emoji'; name: string; icon: { type: 'Image'; url: string } };
}

export interface RemoteReactionEntry {
  count: number;
  url?: string;
  reactors: never[];
}

/** `:name@domain:` → `:name:`. */
function bareShortcode(name: string): string {
  return `:${name.replace(/^:+|:+$/g, '').replace(/@[^@:]*$/, '')}:`;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reaction counts of a local post (get_post_emoji_reactions); empty on failure. */
export async function postReactionCounts(postId: string): Promise<ReactionCount[]> {
  const { data, error } = await getSupabaseClient().rpc('get_post_emoji_reactions', {
    p_post_id: postId,
    p_user_limit: 0,
  });
  if (error) {
    logger.warn(`Reaction counts of post ${postId}: ${error.message}`);
    return [];
  }
  const out: ReactionCount[] = [];
  for (const row of (data ?? []) as Array<Record<string, any>>) {
    const count = Number(row.reaction_count);
    if (!Number.isFinite(count) || count < 1) continue;
    const url = row.emoji_url ? httpUrl(getFullEmojiUrl(row.emoji_url) ?? row.emoji_url) : null;
    const name = row.emoji_name || row.custom_emoji_content;
    if (url && name) {
      const shortcode = bareShortcode(String(name));
      out.push({ content: shortcode, count, tag: { type: 'Emoji', name: shortcode, icon: { type: 'Image', url } } });
    } else if (typeof row.custom_emoji_content === 'string' && row.custom_emoji_content) {
      if (isHeartReaction(row.custom_emoji_content)) continue;
      out.push({ content: row.custom_emoji_content, count });
    }
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Adds the counts and the `harmony` term to a Note. A post without reactions carries an empty
 * list: a reader holding older counts drops them.
 */
export function withReactionCounts<T extends Record<string, any>>(note: T, counts: ReactionCount[]): T {
  const context = note['@context'];
  const terms = Array.isArray(context) ? context.find((c: unknown) => c && typeof c === 'object') : null;
  if (terms) terms.harmony = HARMONY_NS;
  return { ...note, [REACTIONS_PROPERTY]: counts };
}

/**
 * A fetched Note's counts as remote_reactions; null when the Note carries none, so other
 * sources (the likes collection) apply. Malformed entries are skipped.
 */
export function remoteReactionsFromNote(note: unknown): Record<string, RemoteReactionEntry> | null {
  const entries = (note as Record<string, unknown> | null)?.[REACTIONS_PROPERTY];
  if (!Array.isArray(entries)) return null;
  const out: Record<string, RemoteReactionEntry> = {};
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const { content, count, tag } = entry as { content?: unknown; count?: unknown; tag?: any };
    if (typeof content !== 'string' || !content || content.length > MAX_CONTENT_LENGTH) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) continue;
    const icon = tag && tag.type === 'Emoji' ? httpUrl(tag.icon?.url) : null;
    if (/^:[^:\s]+:$/.test(content)) {
      if (!icon) continue;
      out[bareShortcode(content)] = { count, url: icon, reactors: [] };
    } else {
      if (isHeartReaction(content)) continue;
      out[content] = { count, reactors: [] };
    }
  }
  return out;
}

/** Stores a Note's counts as the post's remote_reactions, the other metadata kept. */
export async function storeRemoteReactions(
  supabase: ReturnType<typeof getSupabaseClient>,
  postId: string,
  reactions: Record<string, RemoteReactionEntry>,
): Promise<void> {
  const { data: row } = await supabase.from('posts').select('metadata').eq('id', postId).maybeSingle();
  const { error } = await supabase
    .from('posts')
    .update({
      metadata: {
        ...((row?.metadata as Record<string, unknown> | null) ?? {}),
        remote_reactions: reactions,
        remote_reactions_fetched_at: new Date().toISOString(),
      },
    })
    .eq('id', postId);
  if (error) logger.warn(`Remote reactions of post ${postId}: ${error.message}`);
}
