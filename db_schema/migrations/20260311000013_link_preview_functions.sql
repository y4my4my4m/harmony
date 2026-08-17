BEGIN;

-- =============================================================================
-- Link Preview Pipeline
-- =============================================================================
-- Local Harmony post URLs: resolved in pure SQL via build_harmony_embed
-- External URLs: handled by the federation backend (no HTTP from the database)
-- =============================================================================

-- Classify URL into provider type
CREATE OR REPLACE FUNCTION public.detect_embed_provider(p_url text) RETURNS text
    LANGUAGE plpgsql STABLE AS $_$
declare
  host text;
  path text;
  instance_domain text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
begin
  host := public.extract_url_host(p_url);
  path := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  if (host = instance_domain or host = 'har.mony.lol') and path ~ '^/posts/[0-9a-fA-F-]{36}' then
    return 'harmony-post';
  elsif host ~ '(youtube\.com|youtu\.be)$' then return 'youtube';
  elsif host ~ 'spotify\.com$' then return 'spotify';
  else return 'generic';
  end if;
end;
$_$;

-- Build embed payload for local Harmony posts (pure SQL, no HTTP)
CREATE OR REPLACE FUNCTION public.build_harmony_embed(p_url text) RETURNS jsonb
    LANGUAGE plpgsql AS $$
declare
  path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  post_id uuid;
  post_record record;
  summary text;
  first_image text;
begin
  post_id := substring(path from '/posts/([0-9a-fA-F-]{36})')::uuid;
  if post_id is null then raise exception 'Invalid Harmony post URL: %', p_url; end if;

  select p.id, p.content, p.media_attachments, p.visibility, p.is_deleted, p.is_local, p.metadata,
         pr.id as author_id, pr.username, pr.display_name, pr.domain, pr.avatar_url, pr.color
  into post_record
  from posts p join profiles pr on pr.id = p.author_id where p.id = post_id;

  if not found or post_record.is_deleted or post_record.visibility not in ('public', 'unlisted') then
    raise exception 'Post % unavailable for embedding', post_id;
  end if;

  summary := left(regexp_replace(public.convert_jsonb_to_ap(post_record.content), '<[^>]+>', '', 'g'), 280);

  if jsonb_typeof(post_record.media_attachments) = 'array' then
    first_image := coalesce(post_record.media_attachments->0->>'preview_url', post_record.media_attachments->0->>'url');
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'title', coalesce(post_record.display_name, post_record.username, 'Harmony Post'),
    'description', summary, 'siteName', public.get_instance_domain(),
    'image', first_image, 'icon', post_record.avatar_url, 'color', post_record.color,
    'harmony', jsonb_build_object(
      'postId', post_record.id, 'instanceDomain', public.get_instance_domain(),
      'visibility', post_record.visibility, 'isLocal', post_record.is_local,
      'author', jsonb_build_object('id', post_record.author_id, 'username', post_record.username,
        'display_name', post_record.display_name, 'domain', post_record.domain,
        'avatar_url', post_record.avatar_url, 'color', post_record.color)
    )
  ));
end;
$$;

-- Dispatcher for local URLs (only harmony-post; external URLs handled by federation backend)
CREATE OR REPLACE FUNCTION public.fetch_link_preview(p_url text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  provider text;
  payload jsonb;
begin
  if normalized_url is null then raise exception 'URL is required'; end if;
  provider := public.detect_embed_provider(normalized_url);
  if provider = 'harmony-post' then
    payload := public.build_harmony_embed(normalized_url);
  else
    return null;
  end if;
  return payload || jsonb_build_object(
    'url', normalized_url, 'normalizedUrl', normalized_url, 'provider', provider,
    'fetchedAt', now(), 'expiresAt', now() + interval '24 hours');
end;
$$;

-- RPC: federation backend calls this to write embeds back after enrichment
CREATE OR REPLACE FUNCTION public.update_message_embeds(p_message_id uuid, p_embeds jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
begin
  update public.messages
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds',
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_message_id;
end;
$$;

GRANT EXECUTE ON FUNCTION public.update_message_embeds(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- TRIGGER: handle local Harmony URLs synchronously (BEFORE INSERT)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_local_link_previews()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $$
declare
  v_instance_domain text;
  v_embed_map jsonb := coalesce(NEW.metadata->'embeds', '{}'::jsonb);
  v_original_map jsonb := v_embed_map;
  v_part jsonb; v_normalized_url text; v_embed jsonb;
begin
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then return NEW; end if;
  if jsonb_typeof(NEW.content) <> 'array' then return NEW; end if;

  select trim(both '"' from config_value::text) into v_instance_domain
    from public.instance_config where config_key = 'domain' limit 1;

  for v_part in select value from jsonb_array_elements(NEW.content) loop
    if coalesce(v_part->>'type', '') <> 'url' then continue; end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then continue; end if;
    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    if v_normalized_url is null or v_embed_map ? v_normalized_url then continue; end if;
    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
        if v_embed is not null then
          v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
        end if;
      end if;
    exception when others then
      raise notice 'Failed to fetch local preview for %: %', v_normalized_url, SQLERRM;
    end;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;
  return NEW;
end;
$$;

-- Drop the old external URL trigger (HTTP from DB doesn't work)
DROP TRIGGER IF EXISTS trg_process_message_link_previews ON public.messages;
-- Also drop the webhook trigger if it exists
DROP TRIGGER IF EXISTS trg_webhook_external_link_previews ON public.messages;

-- Drop HTTP-based functions that relied on pgsql-http extension
DROP FUNCTION IF EXISTS public.fetch_remote_link_preview(text, text);
DROP FUNCTION IF EXISTS public.process_message_link_previews();
DROP FUNCTION IF EXISTS public.fetch_generic_preview(text);
DROP FUNCTION IF EXISTS public.fetch_oembed_preview(text, text);
DROP FUNCTION IF EXISTS public.webhook_external_link_previews();

-- Add link_preview_backend_url to federation_settings if missing
UPDATE public.instance_config
SET config_value = config_value || '{"link_preview_backend_url": ""}'::jsonb
WHERE config_key = 'federation_settings'
  AND NOT (config_value ? 'link_preview_backend_url');

COMMIT;
