# URL Embed Previews

This document describes the Postgres function and client integrations that power rich URL previews inside chat, DM, and search results — no Supabase edge functions or Storage buckets required.

## Overview

- `db_schema/link_previews.sql` registers `fetch_link_preview(url text)` plus helper functions that normalize URLs, detect providers, and fetch metadata via `net.http_get`.
- Client-side `LinkPreviewService` calls that RPC, caches responses locally for 24h, and hydrates Harmony posts by reusing `useActivityPubStore`.
- `ensureMessageEmbeds` scans incoming message parts and wires embed payloads into `message.metadata.embeds`.
- `ProviderEmbedSwitch` renders provider-specific embeds (Harmony posts, YouTube/Spotify players, generic cards) inside `UnifiedMessageContent`.

## Database Setup

All server-side logic lives in Postgres. The new SQL lives in `db_schema/link_previews.sql` and should be run after `http` (or `pg_net`) is enabled:

```sql
create extension if not exists http with schema extensions;

create or replace function public.fetch_link_preview(p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  provider text := public.detect_embed_provider(normalized_url);
  payload jsonb;
begin
  if normalized_url is null then
    raise exception 'URL is required';
  end if;

  case provider
    when 'harmony-post' then
      select public.build_harmony_embed(normalized_url) into payload;
    when 'youtube' then
      select public.fetch_oembed_preview(normalized_url, 'https://www.youtube.com/oembed') into payload;
    when 'spotify' then
      select public.fetch_oembed_preview(normalized_url, 'https://open.spotify.com/oembed') into payload;
    else
      select public.fetch_generic_preview(normalized_url) into payload;
  end case;

  return payload
    || jsonb_build_object(
      'url', normalized_url,
      'normalizedUrl', normalized_url,
      'provider', provider,
      'fetchedAt', now(),
      'expiresAt', now() + interval '24 hours'
    );
end;
$$;

revoke all on function public.fetch_link_preview(text) from public;
grant execute on function public.fetch_link_preview(text) to authenticated, service_role;
```

Helper SQL in the same file (`normalize_embed_url`, `detect_embed_provider`, `fetch_oembed_preview`, `fetch_generic_preview`, `build_harmony_embed`) encapsulates URL normalization, regex-based provider detection, and meta-tag parsing via the `http_get` response body. No new tables or RLS policies are required.

## Cache & TTL Policy

The database returns `expiresAt = now() + 24h` for every provider; the frontend honors that timestamp and keeps a local in-memory cache only. There is no server-side persistence.

## Client Integration

1. **Detection & fetching**  
   - `normalizeEmbedUrl` + `detectEmbedProviderFromUrl` prevent duplicate regex logic.  
   - `ensureMessageEmbeds(messages)` scans every `UrlContent`, attaches an `embedId`, and asynchronously fetches/refreshes metadata via `linkPreviewService`, which now calls `supabase.rpc('fetch_link_preview', { p_url: url })`.  
   - Results live inside `message.metadata.embeds[embedId]` so edits/real-time updates keep embeds with the message.

2. **Rendering**  
   - `UnifiedMessageContent` passes `message.metadata?.embeds` into `ProviderEmbedSwitch`.  
   - Harmony posts reuse `MonyPost.vue`, so reply/reblog/react/bookmark actions work from inside the embed.  
   - YouTube/Spotify render responsive iframes (using canonical `embed/` URLs).  
   - Generic links fall back to `LinkEmbedCard.vue`. Styling is centralized in `src/assets/embed-previews.css`.

3. **Stores & search**  
   - `useChat`, `useDM`, and `useMessageSearch` call `ensureMessageEmbeds` whenever they load or mutate messages (including optimistic sends and edits).  
   - Metadata is trimmed automatically when message content no longer includes a URL.

## Verification Checklist

1. **Database function**
   - Run the SQL from `db_schema/link_previews.sql` in your project (ensure `http` extension is enabled).  
   - Test locally with `select public.fetch_link_preview('https://har.mony.lol/posts/<id>');` and verify JSON output.

2. **Chat preview flow**
   - Send a chat message with a Harmony post URL -> embed should hydrate and allow reply/reblog/reactions inline.  
   - Edit the message and remove the URL -> embed disappears (metadata trimmed).  
   - Send the same URL again -> preview should load immediately from cache (check console for cache hits).

3. **External providers**
   - Paste a YouTube video link -> iframe player renders with hide/show controls.  
   - Paste a Spotify track link -> audio embed renders.  
   - Paste a generic article link -> card shows favicon, title, and description.

4. **DM + search coverage**
   - Verify the same URLs inside DMs produce embeds.  
   - Search for older messages with URLs; thumbnails should populate once the search results load.

5. **TTL refresh**
   - Call `linkPreviewService.getPreview(url, { forceRefresh: true })` or clear the in-memory cache and confirm the RPC is invoked again after `expiresAt` passes.

## Known Limitations / Future Enhancements

- Only Harmony URLs matching `/posts/<uuid>` are treated as interactive embeds today. Extend the detection helpers if you add other canonical routes (e.g., `/@user/<id>`).  
- Spotify embed dimensions are fixed; expose component props if you need smaller players.  
- Consider background refresh jobs for high-volume channels so embeds stay warm without waiting for the next view.

