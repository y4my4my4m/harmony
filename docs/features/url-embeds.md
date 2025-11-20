# URL Embed Previews

This document describes the Supabase edge function, storage cache, and client integrations that power rich URL previews inside chat, DM, and search results.

## Overview

- `supabase/functions/link-preview`: edge function that normalizes URLs, detects providers, and returns cached embed metadata from the `link-embeds` storage bucket.
- Client-side `LinkPreviewService` manages Supabase Function invocation, TTL-aware caching, and helpers to hydrate Harmony posts.
- `ensureMessageEmbeds` utility scans incoming message parts and wires embed payloads into `message.metadata.embeds`.
- `ProviderEmbedSwitch` renders provider-specific embeds (Harmony posts, YouTube/Spotify players, generic cards) inside `UnifiedMessageContent`.

## Supabase Setup

1. **Storage bucket**  
   - Create a public bucket named `link-embeds`.  
   - Enable `public` access so the edge function can re-use cached JSON without signed URLs.  
   - No additional policies are required; the edge function uses the service role key.

2. **Environment variables**  
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: already required by other functions.  
   - `DOMAIN`: primary Harmony domain (used to detect local post URLs).  
   - `HARMONY_ALT_DOMAINS` *(optional)*: comma-delimited list of additional hostnames that should be treated as Harmony instances when generating embeds.  
   - `VITE_DOMAIN` / `VITE_HARMONY_ALT_DOMAINS`: client-side mirrors for provider detection.

3. **Secrets for external providers**  
   - YouTube + Spotify rely on their public oEmbed endpoints, so no API keys are required today.  
   - If you later need authenticated APIs, extend the edge function to read `YOUTUBE_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, etc., and document the flow here.

4. **Deploying the function**  
   - `supabase functions deploy link-preview --project-ref <project>`  
   - Ensure the project’s `supabase.toml` exposes the function at `/link-preview`. Chat clients invoke it via `supabase.functions.invoke('link-preview', { body: { url } })`.

## Cache & TTL Policy

| Provider        | TTL               | Notes                                                |
|-----------------|-------------------|------------------------------------------------------|
| Harmony posts   | 5 minutes         | Keeps embeds fresh so replies/metrics stay current. |
| YouTube/Spotify | 6 hours           | oEmbed rarely changes; balances freshness with cost.|
| Generic links   | 24 hours          | Metadata is mostly static; long-lived cache is fine.|

Each payload stores `fetchedAt`, `expiresAt`, and a `cacheKey` derived from the normalized URL so both the edge function and client can respect TTLs.

## Client Integration

1. **Detection & fetching**  
   - `normalizeEmbedUrl` + `detectEmbedProviderFromUrl` prevent duplicate regex logic.  
   - `ensureMessageEmbeds(messages)` scans every `UrlContent`, attaches an `embedId`, and asynchronously fetches/refreshes metadata via `linkPreviewService`.  
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

1. **Bucket + function**
   - Upload a test object to `storage/v1/object/public/link-embeds/...` to confirm you have write access.
   - Run `supabase functions serve link-preview` locally, hit `POST /link-preview` with `{ "url": "https://har.mony.lol/posts/<id>" }`, and ensure a JSON payload returns and the bucket stores a cache file.

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
   - Manually edit a cached object’s `expiresAt` in Storage (set to past), reload the client, and confirm it refetches the preview.

## Known Limitations / Future Enhancements

- Only Harmony URLs matching `/posts/<uuid>` are treated as interactive embeds today. Extend the detection helpers if you add other canonical routes (e.g., `/@user/<id>`).  
- Spotify embed dimensions are fixed; expose component props if you need smaller players.  
- Consider background refresh jobs for high-volume channels so embeds stay warm without waiting for the next view.

