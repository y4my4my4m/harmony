-- Link preview helpers (Harmony-local + remote backend proxy)

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
    pr.id as author_id,
    pr.username,
    pr.display_name,
    pr.domain,
    pr.avatar_url,
    pr.color
  into post_record
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
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
  normalized_url	text := public.normalize_embed_url(p_url);
  instance_domain	text := lower(public.get_instance_domain());
  host text;
begin
  if normalized_url is null then
    raise exception 'URL is required';
  end if;

  host := public.extract_url_host(normalized_url);
  if host is null or host <> instance_domain then
    raise exception 'fetch_link_preview only handles local Harmony URLs';
  end if;

  return public.build_harmony_embed(normalized_url)
    || jsonb_build_object(
      'url', normalized_url,
      'normalizedUrl', normalized_url,
      'provider', 'harmony-post',
      'fetchedAt', now(),
      'expiresAt', now() + interval '5 minutes'
    );
end;
$$;

create or replace function public.fetch_remote_link_preview(p_backend_base_url text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  request_url text;
  resp net.http_response;
begin
  if normalized_url is null then
    return null;
  end if;

  if p_backend_base_url is null or trim(p_backend_base_url) = '' then
    raise exception 'federation_backend_url is not configured';
  end if;

  request_url := rtrim(p_backend_base_url, '/') || '/link-preview';

  select *
  into resp
  from net.http_request(
    url => request_url,
    method => 'POST',
    headers => jsonb_build_object('Content-Type', 'application/json'),
    body => jsonb_build_object('url', normalized_url),
    timeout_milliseconds => 10000
  );

  if resp.status_code between 200 and 299 then
    return resp.response_body::jsonb;
  else
    raise exception 'Backend preview failed (%).', resp.status_code;
  end if;
end;
$$;

revoke all on function public.fetch_link_preview(text) from public;
grant execute on function public.fetch_link_preview(text) to authenticated, service_role;

