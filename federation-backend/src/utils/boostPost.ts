/**
 * A boost row: `metadata.reblog_of` without `is_quote`. A quote carries the same
 * reference and `ap_type` 'Announce' (guard_post_client_write) but is a Note of its own.
 * jsonb decodes `is_quote` to a boolean; rows written as text carry 'true'.
 */
export function isBoostPost(post: any): boolean {
  const meta = post?.metadata;
  if (!meta?.reblog_of) return false;
  return !(meta.is_quote === true || meta.is_quote === 'true');
}
