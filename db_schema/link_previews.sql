-- Link preview helper functions (Postgres + pg_net/http)
-- Apply after ensuring the http/pg_net extension is installed.

create extension if not exists http with schema extensions;

create or replace function public.normalize_embed_url(p_url text)
returns text
language plpgsql
immutable
as $$
declare
  trimmed text := nullif(trim(p_url), '');
begin
  if trimmed is null then
    return null;
  end if;

  if trimmed !~* '^[a-z][a-z0-9+\.-]*://' then
    trimmed := 'https://' || trimmed;
  end if;

  return trimmed;
end;
$$;

create or replace function public.extract_url_host(p_url text)
returns text
language sql
immutable
as $$
  select lower(split_part(split_part(regexp_replace($1, '^https?://', ''), '/', 1), ':', 1));
$$;

create or replace function public.detect_embed_provider(p_url text)
returns text
language plpgsql
stable
as $$
declare
  host text;
  path text;
  instance_domain text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
begin
  host := public.extract_url_host(p_url);
  path := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');

  if (host = instance_domain or host = 'har.mony.lol') and path ~ '^/posts/[0-9a-fA-F-]{36}' then
    return 'harmony-post';
  elsif host ~ '(youtube\.com|youtu\.be)$' then
    return 'youtube';
  elsif host ~ 'spotify\.com$' then
    return 'spotify';
  else
    return 'generic';
  end if;
end;
$$;

create or replace function public.make_absolute_url(base_url text, candidate text)
returns text
language plpgsql
immutable
as $$
declare
  origin text;
begin
  if candidate is null or candidate = '' then
    return null;
  end if;

  if candidate ~* '^[a-z][a-z0-9+\.-]*://' then
    return candidate;
  elsif candidate like '//%' then
    return 'https:' || candidate;
  end if;

  origin := substring(base_url from '^(https?://[^/]+)');
  if origin is null then
    origin := base_url;
  end if;

  if candidate like '/%' then
    return origin || candidate;
  else
    return origin || '/' || candidate;
  end if;
end;
$$;

create or replace function public.fetch_oembed_preview(p_url text, p_endpoint text)
returns jsonb
language plpgsql
as $$
declare
  resp_status integer;
  resp_body text;
  body jsonb;
  headers jsonb := jsonb_build_object('Accept', 'application/json');
begin
  select status, body
  into resp_status, resp_body
  from net.http_get(
    p_endpoint,
    jsonb_build_object('url', p_url, 'format', 'json'),
    headers,
    8000
  );

  if resp_status between 200 and 299 then
    body := coalesce(resp_body::jsonb, '{}'::jsonb);
    return jsonb_strip_nulls(jsonb_build_object(
      'title', body->>'title',
      'description', body->>'author_name',
      'siteName', coalesce(body->>'provider_name', public.extract_url_host(p_url)),
      'image', body->>'thumbnail_url',
      'html', body->>'html',
      'width', body->>'width',
      'height', body->>'height'
    ));
  else
    raise exception 'oEmbed request to % failed (status %, body %)', p_endpoint, resp_status, left(resp_body, 256);
  end if;
end;
$$;

create or replace function public.fetch_generic_preview(p_url text)
returns jsonb
language plpgsql
as $$
declare
  resp_status integer;
  resp_body text;
  headers jsonb := jsonb_build_object('User-Agent', 'HarmonyLinkPreview(SQL)');
  html text;
  title text;
  description text;
  image text;
  icon text;
begin
  select status, body
  into resp_status, resp_body
  from net.http_get(
    p_url,
    '{}'::jsonb,
    headers,
    8000
  );

  if resp_status between 200 and 299 then
    html := coalesce(resp_body, '');
  else
    return jsonb_build_object(
      'title', p_url,
      'description', format('Request failed (%s)', resp_status)
    );
  end if;

  title := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:title["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']twitter:title["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<title[^>]*>(.*?)</title>', 'is'))[1],
    p_url
  );

  description := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:description["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']description["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1]
  );

  image := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:image["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']twitter:image["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1]
  );

  icon := coalesce(
    (regexp_match(html, '<link[^>]+rel=["''](?:shortcut )?icon["''][^>]+href=["'']([^"'']+)["'']', 'is'))[1]
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'title', title,
    'description', description,
    'siteName', public.extract_url_host(p_url),
    'image', public.make_absolute_url(p_url, image),
    'icon', public.make_absolute_url(p_url, icon)
  ));
end;
$$;

create or replace function public.build_harmony_embed(p_url text)
returns jsonb
language plpgsql
as $$
declare
  path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  post_id uuid;
  post_record record;
  summary text;
  first_image text;
begin
  post_id := substring(path from '/posts/([0-9a-fA-F-]{36})')::uuid;
  if post_id is null then
    raise exception 'Invalid Harmony post URL: %', p_url;
  end if;

  select
    p.id,
    p.content,
    p.media_attachments,
    p.visibility,
    p.is_deleted,
    p.is_local,
    p.metadata,
    pr.id as author_id,
    pr.username,
    pr.display_name,
    pr.domain,
    pr.avatar_url,
    pr.color
  into post_record
  from posts p
  join profiles pr on pr.id = p.author_id
  where p.id = post_id;

  if not found or post_record.is_deleted or post_record.visibility not in ('public', 'unlisted') then
    raise exception 'Post % unavailable for embedding', post_id;
  end if;

  summary := left(
    regexp_replace(public.convert_jsonb_to_ap(post_record.content), '<[^>]+>', '', 'g'),
    280
  );

  if jsonb_typeof(post_record.media_attachments) = 'array' then
    first_image := coalesce(
      post_record.media_attachments->0->>'preview_url',
      post_record.media_attachments->0->>'url'
    );
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'title', coalesce(post_record.display_name, post_record.username, 'Harmony Post'),
    'description', summary,
    'siteName', public.get_instance_domain(),
    'image', first_image,
    'icon', post_record.avatar_url,
    'color', post_record.color,
    'harmony', jsonb_build_object(
      'postId', post_record.id,
      'instanceDomain', public.get_instance_domain(),
      'visibility', post_record.visibility,
      'isLocal', post_record.is_local,
      'author', jsonb_build_object(
        'id', post_record.author_id,
        'username', post_record.username,
        'display_name', post_record.display_name,
        'domain', post_record.domain,
        'avatar_url', post_record.avatar_url,
        'color', post_record.color
      )
    )
  ));
end;
$$;

create or replace function public.fetch_link_preview(p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  provider text;
  payload jsonb;
begin
  if normalized_url is null then
    raise exception 'URL is required';
  end if;

  provider := public.detect_embed_provider(normalized_url);

  begin
    case provider
      when 'harmony-post' then
        payload := public.build_harmony_embed(normalized_url);
      when 'youtube' then
        payload := public.fetch_oembed_preview(normalized_url, 'https://www.youtube.com/oembed');
      when 'spotify' then
        payload := public.fetch_oembed_preview(normalized_url, 'https://open.spotify.com/oembed');
      else
        payload := public.fetch_generic_preview(normalized_url);
    end case;
  exception when others then
    payload := public.fetch_generic_preview(normalized_url);
  end;

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

