/**
 * Backfill script: re-fetch federated posts to fix line breaks and add link previews.
 *
 * What it does:
 *   1. Finds all non-local posts with an ap_id (federated posts)
 *   2. Re-fetches the original Note from the remote server
 *   3. Re-converts content using the fixed noteToContent() (preserves line breaks)
 *   4. Runs link preview enrichment on posts with URLs
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
import { noteToContent } from './src/activitypub/converters/fromActivityPub.js';
import { SignatureService } from './src/activitypub/SignatureService.js';
import { enrichPostLinkPreviews } from './src/listeners/DatabaseListener.js';
import { safeFetch } from './src/utils/ssrfProtection.js';

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

async function fetchApObject(url: string): Promise<any | null> {
  try {
    // BUGS.md M35: `url` comes from `posts.ap_id` which originated from remote
    // ActivityPub responses (attacker-influenced). safeFetch validates URL/DNS
    // per hop and bounds the attempt with the timeout.
    let response = await safeFetch(url, {
      headers: { 'Accept': 'application/activity+json, application/ld+json' },
      timeoutMs: 10000,
    });

    if (response.status === 401 || response.status === 403) {
      response = await SignatureService.signedApFetch(url);
    }

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function backfillContent() {
  console.log('=== Backfill: Re-fetch federated post content ===');
  if (DRY_RUN) console.log('(DRY RUN - no writes)');

  let offset = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalFailed = 0;

  while (true) {
    const query = supabase
      .from('posts')
      .select('id, ap_id, content, metadata')
      .eq('is_local', false)
      .not('ap_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + BATCH_SIZE - 1);

    const { data: posts, error } = await query;

    if (error) {
      console.error('Error fetching posts:', error.message);
      break;
    }

    if (!posts || posts.length === 0) break;

    for (const post of posts) {
      if (LIMIT > 0 && totalProcessed >= LIMIT) break;
      totalProcessed++;

      console.log(`[${totalProcessed}] Processing post ${post.id} (ap_id: ${post.ap_id})`);

      const remoteObject = await fetchApObject(post.ap_id);
      if (!remoteObject || !remoteObject.content) {
        console.log(`  ⏭️ Could not fetch remote Note, skipping`);
        totalFailed++;
        await sleep(FETCH_DELAY_MS);
        continue;
      }

      const newContent = noteToContent(remoteObject);
      const oldText = JSON.stringify(post.content);
      const newText = JSON.stringify(newContent);

      if (oldText === newText) {
        console.log(`  ✅ Content unchanged, skipping`);
      } else {
        console.log(`  📝 Content differs - updating`);
        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from('posts')
            .update({ content: newContent })
            .eq('id', post.id);

          if (updateError) {
            console.error(`  ❌ Update failed:`, updateError.message);
            totalFailed++;
          } else {
            totalUpdated++;
          }
        } else {
          totalUpdated++;
        }
      }

      await sleep(FETCH_DELAY_MS);
    }

    if (LIMIT > 0 && totalProcessed >= LIMIT) break;
    if (posts.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log(`\n--- Content backfill complete ---`);
  console.log(`  Processed: ${totalProcessed}`);
  console.log(`  Updated:   ${totalUpdated}`);
  console.log(`  Failed:    ${totalFailed}`);
}

async function backfillLinkPreviews() {
  console.log('\n=== Backfill: Link previews for posts ===');
  if (DRY_RUN) console.log('(DRY RUN - no writes)');

  let offset = 0;
  let totalProcessed = 0;
  let totalEnriched = 0;

  while (true) {
    // Find posts that have url parts in content but no embeds in metadata
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, content, metadata')
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
          console.error(`  ❌ Enrichment failed:`, err.message);
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
