import { activityPubService, type QuoteResolution } from '@/services/activityPubService'

const asked = new Set<string>()

/**
 * Second read of the quoted post of a stored remote quote, once per post per session. A post whose
 * read failed when it arrived otherwise shows a link to the quoted post for good.
 */
export async function retryQuotedPost(postId: string): Promise<QuoteResolution | null> {
  if (asked.has(postId)) return null
  asked.add(postId)
  return activityPubService.resolveQuotedPost(postId)
}
