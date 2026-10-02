/**
 * The heart reaction is the favourite.
 *
 * Mastodon has no reactions: every Like is a favourite. Misskey stores its like as the
 * reaction U+2764 with variation selectors stripped (ReactionService.normalize) and maps a
 * Like carrying no `_misskey_reaction` to it. A post therefore holds one heart per actor,
 * stored as a `favorite` row; `emoji_reaction` rows carry every other emoji.
 *
 * Mirrors public.is_heart_reaction and src/utils/heartReaction.ts.
 */

/** U+2764 HEAVY BLACK HEART and U+2665 BLACK HEART SUIT, variation selectors removed. */
const HEART_BASES = new Set(['\u2764', '\u2665']);

/** U+FE0E (text presentation) and U+FE0F (emoji presentation). */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

/** ❤, ❤️, ❤︎, ♥, ♥️, ♥︎. 💗 and the other coloured hearts are distinct reactions. */
export function isHeartReaction(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  return HEART_BASES.has(content.trim().replace(VARIATION_SELECTORS, ''));
}

/**
 * True when an inbound Like / EmojiReact is a favourite: no reaction named, or a unicode
 * heart. An image emoji is a reaction whatever its shortcode.
 */
export function isFavouriteLike(like: { emoji?: string; emojiUrl?: string; emojiName?: string }): boolean {
  if (like.emojiUrl && like.emojiName) return false;
  return !like.emoji || isHeartReaction(like.emoji);
}

/**
 * Inserts the actor's favourite on a post, or makes an implied one explicit: a plain Like
 * is a favourite the actor gave, which their last reaction's removal leaves standing.
 * idx_post_interactions_unique holds one `favorite` row per (user, post); 23505 is a
 * concurrent insert of the same row.
 */
export async function storeFavourite(
  supabase: any,
  postId: string,
  userId: string,
  fields: { ap_id?: string | null } = {},
): Promise<'inserted' | 'exists' | 'failed'> {
  const { data: existing } = await supabase
    .from('post_interactions')
    .select('id, implied_by_reaction')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .eq('interaction_type', 'favorite')
    .maybeSingle();

  if (existing) {
    if (existing.implied_by_reaction) {
      const { error } = await supabase
        .from('post_interactions')
        .update({ implied_by_reaction: false })
        .eq('id', existing.id);
      if (error) return 'failed';
    }
    return 'exists';
  }

  const row: Record<string, unknown> = {
    post_id: postId,
    user_id: userId,
    interaction_type: 'favorite',
    is_local: false,
  };
  if (fields.ap_id) row.ap_id = fields.ap_id;

  const { error } = await supabase.from('post_interactions').insert(row);
  if (!error) return 'inserted';
  return error.code === '23505' ? 'exists' : 'failed';
}
