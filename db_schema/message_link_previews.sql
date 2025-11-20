-- Message link preview processing
-- Applies on top of TRUE_LATEST_DB_SCHEMA_BACKUP.sql

create or replace function public.process_message_link_previews()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_instance_domain text;
  v_backend_url text;
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

  select (config_value::jsonb->>'link_preview_backend_url')
    into v_backend_url
    from public.instance_config
    where config_key = 'federation_settings'
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

    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
      elsif v_backend_url is not null and v_backend_url <> '' then
        v_embed := public.fetch_remote_link_preview(v_backend_url, v_normalized_url);
      else
        v_embed := null;
      end if;
    exception
      when others then
        v_embed := null;
    end;

    if v_embed is not null then
      v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
    end if;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_process_message_link_previews on public.messages;
create trigger trg_process_message_link_previews
before insert on public.messages
for each row
when ((NEW.metadata->>'federated') is distinct from 'true')
execute function public.process_message_link_previews();

