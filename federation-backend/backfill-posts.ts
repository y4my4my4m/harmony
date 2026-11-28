/**
 * Backfill script: re-fetch federated posts to fix line breaks and add link previews.
 *
 * What it does:
 *   1. Finds all live (not deleted) non-local posts with an ap_id
 *   2. Re-fetches each from its ap_id; the document must be that post, served from that id,
 *      by the stored author (backfillPostContent.ts)
 *   3. Re-converts content with noteToContent()
 *   4. Runs link preview enrichment on live posts with URLs
 *
 * Usage:
 *   cd federation-backend
 *   npx tsx backfill-posts.ts [--dry-run] [--limit N] [--link-previews-only]
 *
 * Flags:
 *   --dry-run            Print what would change without writing to DB
 *   --limit N            Process at most N posts (default: all)
 *   --link-previews-only Skip content re-fetch, only enrich link previews for existing URL parts
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getSupabaseClient } from './src/config/supabase.js';
import { ActivityProcessor } from './src/activitypub/ActivityProcessor.js';
import { backfillPostContent } from './src/activitypub/backfillPostContent.js';
import { enrichPostLinkPreviews } from './src/listeners/DatabaseListener.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LINK_PREVIEWS_ONLY = args.includes('--link-previews-only');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const BATCH_SIZE = 50;
const FETCH_DELAY_MS = 500;

const supabase = getSupabaseClient();

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillContent() {
  console.log('=== Backfill: Re-fetch federated post content ===');
  if (DRY_RUN) console.log('(DRY RUN - no writes)');

  // ActivityProcessor.fetchApDocument: signed GET through safeFetch, blocked hosts refused,
  // ActivityPub media type required.
  const totals = await backfillPostContent(supabase, {
    dryRun: DRY_RUN,
    limit: LIMIT,
    batchSize: BATCH_SIZE,
    delayMs: FETCH_DELAY_MS,
    fetchDoc: (url) => ActivityProcessor.fetchApDocument(url),
    log: (line) => console.log(line),
  });

  console.log(`\n--- Content backfill complete ---`);
  console.log(`  Processed: ${totals.processed}`);
  console.log(`  Updated:   ${totals.updated}`);
  console.log(`  Failed:    ${totals.failed}`);
}

async function backfillLinkPreviews() {
  console.log('\n=== Backfill: Link previews for posts ===');
  if (DRY_RUN) console.log('(DRY RUN - no writes)');

  let offset = 0;
  let totalProcessed = 0;
  let totalEnriched = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Find posts that have url parts in content but no embeds in metadata
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, content, metadata')
      .eq('is_deleted', false)
      .or('metadata->embeds.is.null,metadata.is.null')
      .order('created_at', { ascending: false })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('Error fetching posts:', error.message);
      break;
    }

    if (!posts || posts.length === 0) break;

    for (const post of posts) {
      if (LIMIT > 0 && totalProcessed >= LIMIT) break;

      const content = post.content;
      if (!Array.isArray(content)) continue;

      const hasUrls = content.some((p: any) => p.type === 'url' && typeof p.url === 'string');
      if (!hasUrls) continue;

      totalProcessed++;
      console.log(`[${totalProcessed}] Enriching post ${post.id}`);

      if (!DRY_RUN) {
        try {
          await enrichPostLinkPreviews(post);
          totalEnriched++;
        } catch (err: any) {
          console.error(`  Enrichment failed:`, err.message);
        }
      } else {
        const urls = content.filter((p: any) => p.type === 'url').map((p: any) => p.url);
        console.log(`  Would enrich URLs: ${urls.join(', ')}`);
        totalEnriched++;
      }

      await sleep(FETCH_DELAY_MS);
    }

    if (LIMIT > 0 && totalProcessed >= LIMIT) break;
    if (posts.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log(`\n--- Link preview backfill complete ---`);
  console.log(`  Candidates: ${totalProcessed}`);
  console.log(`  Enriched:   ${totalEnriched}`);
}

async function main() {
  console.log('Harmony Post Backfill Script');
  console.log('============================\n');

  if (LINK_PREVIEWS_ONLY) {
    await backfillLinkPreviews();
  } else {
    await backfillContent();
    await backfillLinkPreviews();
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
