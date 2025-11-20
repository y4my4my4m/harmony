-- Message link preview processing (webhook-based architecture)
-- Applies on top of TRUE_LATEST_DB_SCHEMA_BACKUP.sql
--
-- ARCHITECTURE:
-- 1. BEFORE INSERT: Synchronously enrich local Harmony post URLs (fast, no HTTP)
-- 2. AFTER INSERT: Fire webhook to federated backend for external URLs (async)
-- 3. Backend fetches previews, then updates message.metadata via Supabase REST API

-- =====================================================
-- BEFORE INSERT: Handle local Harmony URLs only
-- =====================================================

create or replace function public.process_local_link_previews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_instance_domain text;
  v_embed_map jsonb := coalesce(NEW.metadata->'embeds', '{}'::jsonb);
  v_original_map jsonb := v_embed_map;
  v_part jsonb;
  v_normalized_url text;
  v_embed jsonb;
begin
  -- Skip inbound federated messages
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    if v_normalized_url is null or v_embed_map ? v_normalized_url then
      continue;
    end if;

    -- Only process LOCAL Harmony URLs here (synchronous, fast)
    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
        
        if v_embed is not null then
          v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
        end if;
      end if;
    exception
      when others then
        raise notice 'Failed to fetch local preview for %: %', v_normalized_url, SQLERRM;
    end;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_process_local_link_previews on public.messages;
create trigger trg_process_local_link_previews
before insert on public.messages
for each row
when ((NEW.metadata->>'federated') is distinct from 'true')
execute function public.process_local_link_previews();

-- =====================================================
-- AFTER INSERT: Webhook for external URLs
-- =====================================================

create or replace function public.webhook_external_link_previews()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_instance_domain text;
  v_backend_url text;
  v_external_urls text[] := array[]::text[];
  v_part jsonb;
  v_normalized_url text;
  v_webhook_payload jsonb;
  v_request_id bigint;
begin
  -- Skip inbound federated messages
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  select (config_value::jsonb->>'link_preview_backend_url')
    into v_backend_url
    from public.instance_config
    where config_key = 'federation_settings'
    limit 1;

  if v_backend_url is null or v_backend_url = '' then
    return NEW;
  end if;

  -- Collect external URLs
  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    
    -- Skip if already has embed (local URL was handled in BEFORE INSERT)
    if v_normalized_url is null or (NEW.metadata->'embeds' ? v_normalized_url) then
      continue;
    end if;

    -- Only collect EXTERNAL URLs (not our domain)
    if v_instance_domain is not null
       and public.extract_url_host(v_normalized_url) <> lower(v_instance_domain) then
      v_external_urls := array_append(v_external_urls, v_normalized_url);
    end if;
  end loop;

  -- Fire webhook if we have external URLs
  if array_length(v_external_urls, 1) > 0 then
    v_webhook_payload := jsonb_build_object(
      'messageId', NEW.id,
      'urls', to_jsonb(v_external_urls)
    );

    -- Use pg_net async (fire and forget)
    select net.http_post(
      url := rtrim(v_backend_url, '/') || '/webhooks/enrich-message-previews',
      body := v_webhook_payload::text
    ) into v_request_id;

    raise notice 'Fired webhook for message % with % external URLs (request_id: %)', 
      NEW.id, array_length(v_external_urls, 1), v_request_id;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_webhook_external_link_previews on public.messages;
create trigger trg_webhook_external_link_previews
after insert on public.messages
for each row
when ((NEW.metadata->>'federated') is distinct from 'true')
execute function public.webhook_external_link_previews();

-- =====================================================
-- RPC endpoint for backend to update message metadata
-- =====================================================

create or replace function public.update_message_embeds(
  p_message_id uuid,
  p_embeds jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds', 
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_message_id;
end;
$$;

-- Grant execute to service_role so backend can call it
revoke all on function public.update_message_embeds(uuid, jsonb) from public;
grant execute on function public.update_message_embeds(uuid, jsonb) to service_role;

comment on function public.update_message_embeds is 
  'Called by federated backend webhook to enrich message with external link previews';
