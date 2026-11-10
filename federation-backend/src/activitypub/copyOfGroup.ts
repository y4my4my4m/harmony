import type { SupabaseClient } from '@supabase/supabase-js';
import { SignatureService } from './SignatureService.js';

const GROUP_URL = /\/servers\/([a-f0-9-]{36})$/i;

/**
 * The copy of the Group at `groupUrl`. Found by ap_id: a row of another Group can hold the UUID in
 * the URL, and the copy then has an id of its own. Null for a URL that is no /servers/<uuid>.
 */
export async function copyOfGroup(
  supabase: SupabaseClient,
  groupUrl: unknown,
  columns = 'id, ap_id',
): Promise<any | null> {
  const uuid = typeof groupUrl === 'string' ? groupUrl.match(GROUP_URL)?.[1] : undefined;
  if (!uuid) return null;

  const { data: byApId } = await supabase
    .from('servers')
    .select(columns)
    .eq('ap_id', groupUrl as string)
    .eq('is_local_server', false)
    .maybeSingle();
  if (byApId) return byApId;

  // A row whose ap_id differs from the URL only in form.
  const { data: byId } = await supabase
    .from('servers')
    .select(columns)
    .eq('id', uuid)
    .eq('is_local_server', false)
    .maybeSingle();
  const rowApId = (byId as any)?.ap_id;
  return rowApId && SignatureService.verifyActorMatch(groupUrl as string, rowApId) ? byId : null;
}
