import type { SupabaseClient } from '@supabase/supabase-js';
import { asNoteObject, isPostObjectType, normalizeActor, noteToContent } from './converters/fromActivityPub.js';
import { sameUrl, type FetchedDocument } from '../utils/apOrigin.js';

export interface BackfillContentOptions {
  dryRun: boolean;
  /** 0: no limit. */
  limit: number;
  fetchDoc: (url: string) => Promise<FetchedDocument | null>;
  batchSize?: number;
  delayMs?: number;
  log?: (line: string) => void;
}

export interface BackfillContentTotals {
  processed: number;
  updated: number;
  failed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Content of a stored remote post re-read from its origin. Null unless the document is a post
 * type, has the stored ap_id as its id, was served from that id, and is attributed to the
 * stored author.
 */
export function refetchedPostContent(
  apId: string,
  authorFederatedId: string | null | undefined,
  fetched: FetchedDocument | null,
): any[] | null {
  const doc = fetched?.doc;
  if (!doc || !isPostObjectType(doc.type)) return null;
  if (!sameUrl(doc.id, apId) || !sameUrl(fetched!.finalUrl, apId)) return null;
  if (!authorFederatedId || normalizeActor(doc.attributedTo) !== authorFederatedId) return null;
  const note = asNoteObject(doc);
  return note.content ? noteToContent(note) : null;
}

/**
 * Re-reads each live stored remote post from its ap_id and rewrites `content` when it differs.
 * Deleted posts are skipped: a moderator removal is not reverted by the origin still serving it.
 */
export async function backfillPostContent(
  supabase: SupabaseClient,
  options: BackfillContentOptions,
): Promise<BackfillContentTotals> {
  const { dryRun, limit, fetchDoc, batchSize = 50, delayMs = 500, log = () => {} } = options;
  const totals: BackfillContentTotals = { processed: 0, updated: 0, failed: 0 };
  let offset = 0;

  for (;;) {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, ap_id, content, author:profiles!posts_author_id_fkey(federated_id)')
      .eq('is_local', false)
      .eq('is_deleted', false)
      .not('ap_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + batchSize - 1);

    if (error) {
      log(`Error fetching posts: ${error.message}`);
      break;
    }
    if (!posts || posts.length === 0) break;

    for (const post of posts as any[]) {
      if (limit > 0 && totals.processed >= limit) break;
      totals.processed++;
      log(`[${totals.processed}] Processing post ${post.id} (ap_id: ${post.ap_id})`);

      const newContent = refetchedPostContent(post.ap_id, post.author?.federated_id, await fetchDoc(post.ap_id));
      if (!newContent) {
        log('  No post at this ap_id by its stored author, skipping');
        totals.failed++;
        await sleep(delayMs);
        continue;
      }

      if (JSON.stringify(post.content) === JSON.stringify(newContent)) {
        log('  Content unchanged, skipping');
      } else if (dryRun) {
        log('  Content differs - would update');
        totals.updated++;
      } else {
        const { error: updateError } = await supabase
          .from('posts')
          .update({ content: newContent })
          .eq('id', post.id);
        if (updateError) {
          log(`  Update failed: ${updateError.message}`);
          totals.failed++;
        } else {
          log('  Content differs - updated');
          totals.updated++;
        }
      }

      await sleep(delayMs);
    }

    if (limit > 0 && totals.processed >= limit) break;
    if (posts.length < batchSize) break;
    offset += batchSize;
  }

  return totals;
}
