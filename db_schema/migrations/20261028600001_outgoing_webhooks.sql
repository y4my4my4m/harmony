-- Outgoing webhooks (ROADMAP 15): the events a bot's gateway connection receives, POSTed to a URL
-- that a bot's owner or a server's managers register. Replaces the unused bot_webhooks. Instance
-- limits and switches for outgoing and incoming webhooks.
--
--   outgoing_webhooks              one per URL: a bot's (bot_id) or a server's (server_id), the event
--                                  types it takes, its signing secret in Vault (secret_id; shown once
--                                  on create and rotate), and its delivery state:
--     verified_at                  set by the first 2xx answer to a PING. A webhook takes events once
--                                  verified; create and a URL change clear it and queue a PING.
--     consecutive_failures         failed attempts since the last success. At 10 new events are
--                                  dropped and one PING probes every 5 minutes (outgoing_webhook_probes).
--     failing_since                the first failure since the last success; three days of it
--                                  disable the webhook (disabled_reason 'failing') and tell its owner.
--     dropped_events               events not queued: over the webhook's rate, or while paused.
--     disabled_reason              'owner', 'failing', or 'staff' (an instance admin or moderator;
--                                  the owner cannot turn it back on).
--   outgoing_webhook_deliveries    one per event and webhook. Job 'deliver-outgoing-webhook'
--                                  {delivery_id} makes one attempt; a failure schedules the next (30 s,
--                                  2 min, 10 min, 30 min, 1 h, 3 h, 6 h), the eighth failure ends it.
--                                  The payload is dropped once delivered or failed; rows are kept
--                                  seven days.
--   outgoing_webhook_host_minutes  attempts per destination host and minute, for the host rate.
--   server_member_changes          joins and leaves of local servers, in order (id), for the bot
--                                  gateway; kept seven days.
--   instance_config 'webhook_settings'
--     outgoing_mode                'everyone' (bot owners, server webhook managers), 'staff' (instance
--                                  admins and moderators only), 'off' (nothing created or sent)
--     incoming_enabled             channel webhooks: false refuses creating and executing them
--     rate_per_minute              deliveries queued per webhook and minute (120)
--     host_rate_per_minute         attempts per destination host and minute, across webhooks (600)
--     per_user                     outgoing webhooks per creator, bots' and servers' together (10)
--     blocked_domains              destinations refused, the domain and its subdomains
--
-- Who receives an event: the bot gateway decides, as for its WebSocket connections
-- (EventDispatcher resolveReaders), and calls enqueue_outgoing_webhook_event with the bots that
-- read it. A server's webhook takes an event of a channel only while its creator can view the
-- channel and still manages the server's webhooks. Direct messages and end-to-end encrypted
-- messages never reach a webhook. Instance staff hold no power inside servers here: they act on
-- webhooks through the admin_* RPCs. The federation backend's worker signs (Standard Webhooks:
-- webhook-id, webhook-timestamp, webhook-signature v1) and sends, at most two at a time per webhook.
--
-- Error messages begin with a stable code the client reads:
--   OUTGOING_WEBHOOK_FORBIDDEN       42501  not the bot's owner, nor a manager of the server's webhooks
--   OUTGOING_WEBHOOK_DISABLED        42501  the instance does not let the caller create them
--   OUTGOING_WEBHOOK_STAFF_DISABLED  42501  instance staff turned this webhook off
--   OUTGOING_WEBHOOK_NOT_FOUND       P0002
--   OUTGOING_WEBHOOK_INVALID_NAME    22023  not 1 to 80 characters
--   OUTGOING_WEBHOOK_INVALID_URL     22023  not https (http only for localhost), or past 2048 characters
--   OUTGOING_WEBHOOK_BLOCKED_DOMAIN  22023  the destination is on the instance's blocked list
--   OUTGOING_WEBHOOK_INVALID_EVENTS  22023  none, or one this instance does not send
--   OUTGOING_WEBHOOK_LIMIT           54000  five per bot or per server
--   OUTGOING_WEBHOOK_LIMIT_USER      54000  the instance's cap per creator
--   OUTGOING_WEBHOOK_TOO_SOON        54000  a test event within the last 10 seconds
--   OUTGOING_WEBHOOK_UNAVAILABLE     0A000  Supabase Vault is not installed
--   WEBHOOK_DISABLED                 42501  incoming webhooks are turned off (assert_webhook_channel)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Present in supabase/postgres images; without it webhooks cannot be created.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'supabase_vault unavailable (%): outgoing webhooks are disabled', SQLERRM;
END;
$$;

DROP TABLE IF EXISTS public.bot_webhooks;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outgoing_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid REFERENCES public.bots(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    name text NOT NULL CONSTRAINT outgoing_webhooks_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    url text NOT NULL CONSTRAINT outgoing_webhooks_url_check CHECK (char_length(url) <= 2048),
    host text NOT NULL,
    events text[] NOT NULL CONSTRAINT outgoing_webhooks_events_check CHECK (cardinality(events) > 0),
    secret_id uuid,
    secret_hint text,
    is_active boolean NOT NULL DEFAULT true,
    disabled_reason text CONSTRAINT outgoing_webhooks_disabled_reason_check
        CHECK (disabled_reason IS NULL OR disabled_reason IN ('owner', 'failing', 'staff')),
    verified_at timestamptz,
    consecutive_failures integer NOT NULL DEFAULT 0,
    failing_since timestamptz,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_status integer,
    last_error text,
    dropped_events integer NOT NULL DEFAULT 0,
    last_dropped_at timestamptz,
    last_drop_reason text CONSTRAINT outgoing_webhooks_drop_reason_check
        CHECK (last_drop_reason IS NULL OR last_drop_reason IN ('rate_limited', 'paused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outgoing_webhooks_owner_check CHECK ((bot_id IS NULL) <> (server_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_bot ON public.outgoing_webhooks (bot_id) WHERE bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_server ON public.outgoing_webhooks (server_id) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_created_by ON public.outgoing_webhooks (created_by);
COMMENT ON TABLE public.outgoing_webhooks IS
    'URLs a bot''s owner or a server''s managers registered for events; secrets in Vault.';

CREATE TABLE IF NOT EXISTS public.outgoing_webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id uuid NOT NULL REFERENCES public.outgoing_webhooks(id) ON DELETE CASCADE,
    event text NOT NULL,
    payload jsonb,
    status text NOT NULL DEFAULT 'pending'
        CONSTRAINT outgoing_webhook_deliveries_status_check CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    last_status integer,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    CONSTRAINT outgoing_webhook_deliveries_payload_check CHECK (status <> 'pending' OR payload IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_due
    ON public.outgoing_webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_webhook
    ON public.outgoing_webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_created
    ON public.outgoing_webhook_deliveries (created_at);

CREATE TABLE IF NOT EXISTS public.outgoing_webhook_host_minutes (
    host text NOT NULL,
    minute timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    PRIMARY KEY (host, minute)
);

CREATE TABLE IF NOT EXISTS public.server_member_changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    change text NOT NULL CONSTRAINT server_member_changes_change_check CHECK (change IN ('join', 'leave')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_server_member_changes_server ON public.server_member_changes (server_id);
CREATE INDEX IF NOT EXISTS idx_server_member_changes_created ON public.server_member_changes (created_at);

REVOKE ALL ON public.outgoing_webhooks, public.outgoing_webhook_deliveries,
              public.outgoing_webhook_host_minutes, public.server_member_changes
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outgoing_webhooks, public.outgoing_webhook_deliveries,
             public.outgoing_webhook_host_minutes, public.server_member_changes
    TO service_role;
ALTER TABLE public.outgoing_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outgoing_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outgoing_webhook_host_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_member_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outgoing_webhooks_service_role ON public.outgoing_webhooks;
CREATE POLICY outgoing_webhooks_service_role ON public.outgoing_webhooks
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS outgoing_webhook_deliveries_service_role ON public.outgoing_webhook_deliveries;
CREATE POLICY outgoing_webhook_deliveries_service_role ON public.outgoing_webhook_deliveries
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS outgoing_webhook_host_minutes_service_role ON public.outgoing_webhook_host_minutes;
CREATE POLICY outgoing_webhook_host_minutes_service_role ON public.outgoing_webhook_host_minutes
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS server_member_changes_service_role ON public.server_member_changes;
CREATE POLICY server_member_changes_service_role ON public.server_member_changes
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Member changes
-- ---------------------------------------------------------------------------

-- An accepted membership of a local server begins or ends.
CREATE OR REPLACE FUNCTION public.record_server_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_was boolean := TG_OP <> 'INSERT' AND OLD.status = 'accepted';
    v_is boolean := TG_OP <> 'DELETE' AND NEW.status = 'accepted';
    v_server uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.server_id ELSE NEW.server_id END;
    v_user uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
    IF v_was = v_is THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_server AND s.is_local_server IS NOT FALSE) THEN
        RETURN NULL;
    END IF;
    INSERT INTO public.server_member_changes (server_id, user_id, change)
    VALUES (v_server, v_user, CASE WHEN v_is THEN 'join' ELSE 'leave' END);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_user_servers_member_changes ON public.user_servers;
CREATE TRIGGER z_user_servers_member_changes
    AFTER INSERT OR DELETE OR UPDATE OF status ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.record_server_member_change();

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- The stored settings over their defaults; values out of range fall back to the default.
CREATE OR REPLACE FUNCTION public.webhook_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v jsonb;
    v_mode text;
BEGIN
    SELECT CASE WHEN jsonb_typeof(c.config_value) = 'object' THEN c.config_value END INTO v
      FROM public.instance_config c WHERE c.config_key = 'webhook_settings';
    v := COALESCE(v, '{}'::jsonb);
    v_mode := v ->> 'outgoing_mode';
    RETURN jsonb_build_object(
        'outgoing_mode', CASE WHEN v_mode IN ('everyone', 'staff', 'off') THEN v_mode ELSE 'everyone' END,
        'incoming_enabled', COALESCE(public.instance_config_flag(v -> 'incoming_enabled'), true),
        'rate_per_minute', CASE WHEN jsonb_typeof(v -> 'rate_per_minute') = 'number'
                                 AND (v ->> 'rate_per_minute')::numeric BETWEEN 1 AND 10000
                                THEN (v ->> 'rate_per_minute')::numeric::integer ELSE 120 END,
        'host_rate_per_minute', CASE WHEN jsonb_typeof(v -> 'host_rate_per_minute') = 'number'
                                      AND (v ->> 'host_rate_per_minute')::numeric BETWEEN 1 AND 100000
                                     THEN (v ->> 'host_rate_per_minute')::numeric::integer ELSE 600 END,
        'per_user', CASE WHEN jsonb_typeof(v -> 'per_user') = 'number'
                          AND (v ->> 'per_user')::numeric BETWEEN 0 AND 1000
                         THEN (v ->> 'per_user')::numeric::integer ELSE 10 END,
        'blocked_domains', CASE WHEN jsonb_typeof(v -> 'blocked_domains') = 'array'
                                THEN v -> 'blocked_domains' ELSE '[]'::jsonb END);
END;
$$;

CREATE OR REPLACE FUNCTION public.is_active_instance_staff(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = p_profile_id AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE)
                      AND p.is_suspended IS NOT TRUE)
$$;

-- What the app shows the caller: the switches, and whether it may create outgoing webhooks.
CREATE OR REPLACE FUNCTION public.webhook_availability()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'outgoing_mode', s ->> 'outgoing_mode',
        'incoming_enabled', (s ->> 'incoming_enabled')::boolean,
        'can_create_outgoing', CASE s ->> 'outgoing_mode'
            WHEN 'everyone' THEN true
            WHEN 'staff' THEN public.is_active_instance_staff(public.get_current_profile_id())
            ELSE false END,
        'per_user', (s ->> 'per_user')::integer)
      FROM public.webhook_settings() s
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.outgoing_webhook_event_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE',
        'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
        'SERVER_MEMBER_ADD', 'SERVER_MEMBER_REMOVE', 'SERVER_MEMBER_KICK',
        'SERVER_BAN_ADD', 'SERVER_BAN_REMOVE']
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_assert_vault()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regprocedure('vault.create_secret(text, text, text, uuid)') IS NULL
       OR to_regclass('vault.decrypted_secrets') IS NULL THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_UNAVAILABLE: Supabase Vault (supabase_vault) is not installed'
            USING ERRCODE = '0A000';
    END IF;
END;
$$;

-- The caller may manage webhooks of the bot (its owner) or of the server (its owner, or a member
-- holding MANAGE_WEBHOOKS), on a server hosted here.
CREATE OR REPLACE FUNCTION public.can_manage_outgoing_webhooks(p_bot_id uuid, p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.get_current_profile_id() IS NOT NULL AND CASE
        WHEN p_bot_id IS NOT NULL THEN EXISTS (
            SELECT 1 FROM public.bots b WHERE b.id = p_bot_id AND b.owner_id = public.get_current_profile_id())
        WHEN p_server_id IS NOT NULL THEN EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE
               AND (s.owner = public.get_current_profile_id()
                    OR (EXISTS (SELECT 1 FROM public.user_servers us
                                 WHERE us.server_id = s.id AND us.user_id = public.get_current_profile_id()
                                   AND us.status = 'accepted')
                        AND public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_WEBHOOKS'))))
        ELSE false
    END
$$;

-- A server webhook's creator still manages the server's webhooks and views the channel.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_creator_reads(p_webhook public.outgoing_webhooks, p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_webhook.created_by IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.servers s
            WHERE s.id = p_webhook.server_id
              AND (s.owner = p_webhook.created_by
                   OR (EXISTS (SELECT 1 FROM public.user_servers us
                                WHERE us.server_id = s.id AND us.user_id = p_webhook.created_by
                                  AND us.status = 'accepted')
                       AND public.has_permission(p_webhook.created_by, s.id, 'MANAGE_WEBHOOKS'))))
       AND (p_channel_id IS NULL OR public.can_view_channel(p_webhook.created_by, p_channel_id))
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', w.id, 'bot_id', w.bot_id, 'server_id', w.server_id, 'name', w.name, 'url', w.url,
        'events', to_jsonb(w.events), 'secret_hint', w.secret_hint, 'is_active', w.is_active,
        'disabled_reason', w.disabled_reason, 'verified_at', w.verified_at,
        'paused', w.consecutive_failures >= 10, 'failing_since', w.failing_since,
        'last_success_at', w.last_success_at, 'last_failure_at', w.last_failure_at,
        'last_status', w.last_status, 'last_error', w.last_error,
        'dropped_events', w.dropped_events, 'last_dropped_at', w.last_dropped_at,
        'last_drop_reason', w.last_drop_reason,
        'created_by', w.created_by, 'created_at', w.created_at)
      FROM public.outgoing_webhooks w WHERE w.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_valid_url(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_url IS NOT NULL AND char_length(p_url) <= 2048 AND p_url !~ '\s'
       AND (p_url ~* '^https://[^/?#@]+(/|$|\?)'
            OR p_url ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$|\?)')
$$;

-- The URL's host, lowercased, without port or brackets.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_host(p_url text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT lower(btrim(substring(p_url FROM '^[a-zA-Z]+://(\[[^\]]+\]|[^/:?#]+)'), '[]'))
$$;

-- The host is a blocked domain or one of its subdomains.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_host_blocked(p_host text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text((public.webhook_settings()) -> 'blocked_domains') d(domain)
         WHERE lower(btrim(d.domain)) <> ''
           AND (p_host = lower(btrim(d.domain)) OR p_host LIKE '%.' || lower(btrim(d.domain))))
$$;

-- A new secret in Standard Webhooks form (whsec_ + base64 of 32 random bytes), stored in Vault.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_new_secret(p_webhook_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_secret text := 'whsec_' || encode(extensions.gen_random_bytes(32), 'base64');
    v_old uuid;
    v_new uuid;
BEGIN
    PERFORM public.outgoing_webhook_assert_vault();
    v_new := vault.create_secret(v_secret, NULL, 'Outgoing webhook ' || p_webhook_id || ': signing secret');
    SELECT w.secret_id INTO v_old FROM public.outgoing_webhooks w WHERE w.id = p_webhook_id FOR UPDATE;
    UPDATE public.outgoing_webhooks
       SET secret_id = v_new, secret_hint = right(v_secret, 4), updated_at = now()
     WHERE id = p_webhook_id;
    IF v_old IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_old;
    END IF;
    RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhooks_purge_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.secret_id IS NOT NULL AND to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = OLD.secret_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS outgoing_webhooks_purge_secret ON public.outgoing_webhooks;
CREATE TRIGGER outgoing_webhooks_purge_secret
    AFTER DELETE ON public.outgoing_webhooks
    FOR EACH ROW EXECUTE FUNCTION public.outgoing_webhooks_purge_secret();

-- The webhook, locked, when the caller may manage it.
CREATE OR REPLACE FUNCTION public.lock_managed_outgoing_webhook(p_webhook_id uuid)
RETURNS public.outgoing_webhooks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks;
BEGIN
    SELECT * INTO v_row FROM public.outgoing_webhooks WHERE id = p_webhook_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_NOT_FOUND: no such webhook' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_outgoing_webhooks(v_row.bot_id, v_row.server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage this webhook' USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.outgoing_webhook_check_fields(p_name text, p_url text, p_events text[])
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_name IS NOT NULL AND char_length(btrim(p_name)) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_NAME: 1 to 80 characters' USING ERRCODE = '22023';
    END IF;
    IF p_url IS NOT NULL AND NOT public.outgoing_webhook_valid_url(p_url) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_URL: an https URL of at most 2048 characters' USING ERRCODE = '22023';
    END IF;
    IF p_url IS NOT NULL AND public.outgoing_webhook_host_blocked(public.outgoing_webhook_host(p_url)) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_BLOCKED_DOMAIN: this instance does not send to that domain' USING ERRCODE = '22023';
    END IF;
    IF p_events IS NOT NULL AND (cardinality(p_events) = 0 OR NOT p_events <@ public.outgoing_webhook_event_types()) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_EVENTS: choose events this instance sends' USING ERRCODE = '22023';
    END IF;
END;
$$;

-- A PING delivery, queued. Verifies the webhook on its first 2xx.
CREATE OR REPLACE FUNCTION public.queue_outgoing_webhook_ping(p_webhook public.outgoing_webhooks)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
    VALUES (p_webhook.id, 'PING', jsonb_build_object(
        'webhook_id', p_webhook.id, 'bot_id', p_webhook.bot_id, 'server_id', p_webhook.server_id))
    RETURNING id INTO v_id;
    PERFORM public.queue_federation_job('deliver-outgoing-webhook', jsonb_build_object('delivery_id', v_id));
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- Exactly one of p_bot_id and p_server_id. Returns the webhook with its secret, shown this once,
-- and queues the PING that verifies it.
CREATE OR REPLACE FUNCTION public.create_outgoing_webhook(
    p_bot_id uuid, p_server_id uuid, p_name text, p_url text, p_events text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_settings jsonb := public.webhook_settings();
    v_row public.outgoing_webhooks;
    v_secret text;
BEGIN
    IF (p_bot_id IS NULL) = (p_server_id IS NULL) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: name a bot or a server' USING ERRCODE = '22023';
    END IF;
    IF NOT public.can_manage_outgoing_webhooks(p_bot_id, p_server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage these webhooks' USING ERRCODE = '42501';
    END IF;
    IF v_settings ->> 'outgoing_mode' = 'off'
       OR (v_settings ->> 'outgoing_mode' = 'staff' AND NOT public.is_active_instance_staff(v_caller)) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_DISABLED: this instance does not let you create outgoing webhooks'
            USING ERRCODE = '42501';
    END IF;
    IF p_name IS NULL OR p_url IS NULL OR p_events IS NULL THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_INVALID_NAME: name, URL and events are required' USING ERRCODE = '22023';
    END IF;
    PERFORM public.outgoing_webhook_check_fields(p_name, p_url, p_events);
    PERFORM public.outgoing_webhook_assert_vault();

    PERFORM pg_advisory_xact_lock(hashtextextended('outgoing_webhooks:' || COALESCE(p_bot_id, p_server_id)::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('outgoing_webhooks_creator:' || v_caller::text, 0));
    IF (SELECT count(*) FROM public.outgoing_webhooks w
         WHERE w.bot_id IS NOT DISTINCT FROM p_bot_id AND w.server_id IS NOT DISTINCT FROM p_server_id) >= 5 THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_LIMIT: five webhooks at most' USING ERRCODE = '54000';
    END IF;
    IF (SELECT count(*) FROM public.outgoing_webhooks w
         WHERE w.created_by = v_caller
            OR w.bot_id IN (SELECT b.id FROM public.bots b WHERE b.owner_id = v_caller))
       >= (v_settings ->> 'per_user')::integer THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_LIMIT_USER: % webhooks per person on this instance', v_settings ->> 'per_user'
            USING ERRCODE = '54000';
    END IF;

    INSERT INTO public.outgoing_webhooks (bot_id, server_id, created_by, name, url, host, events)
    VALUES (p_bot_id, p_server_id, v_caller, btrim(p_name), p_url, public.outgoing_webhook_host(p_url),
            ARRAY(SELECT DISTINCT e FROM unnest(p_events) e ORDER BY e))
    RETURNING * INTO v_row;
    v_secret := public.outgoing_webhook_new_secret(v_row.id);
    PERFORM public.queue_outgoing_webhook_ping(v_row);
    RETURN public.outgoing_webhook_json(v_row.id) || jsonb_build_object('secret', v_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_outgoing_webhooks(p_bot_id uuid, p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (p_bot_id IS NULL) = (p_server_id IS NULL) OR NOT public.can_manage_outgoing_webhooks(p_bot_id, p_server_id) THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: you cannot manage these webhooks' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(public.outgoing_webhook_json(w.id) ORDER BY w.created_at, w.id)
          FROM public.outgoing_webhooks w
         WHERE w.bot_id IS NOT DISTINCT FROM p_bot_id AND w.server_id IS NOT DISTINCT FROM p_server_id), '[]'::jsonb);
END;
$$;

-- NULL keeps a field. A new URL needs a new PING's 2xx before events flow again. Turning a webhook
-- on clears its failure state; one staff turned off stays off.
CREATE OR REPLACE FUNCTION public.update_outgoing_webhook(
    p_webhook_id uuid, p_name text DEFAULT NULL, p_url text DEFAULT NULL,
    p_events text[] DEFAULT NULL, p_active boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
    v_new_url boolean := p_url IS NOT NULL AND p_url IS DISTINCT FROM v_row.url;
    v_on boolean := p_active IS TRUE AND NOT v_row.is_active;
BEGIN
    IF v_row.disabled_reason = 'staff' AND p_active IS TRUE THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_STAFF_DISABLED: instance staff turned this webhook off' USING ERRCODE = '42501';
    END IF;
    PERFORM public.outgoing_webhook_check_fields(p_name, p_url, p_events);
    UPDATE public.outgoing_webhooks
       SET name = COALESCE(btrim(p_name), name),
           url = COALESCE(p_url, url),
           host = CASE WHEN v_new_url THEN public.outgoing_webhook_host(p_url) ELSE host END,
           events = CASE WHEN p_events IS NULL THEN events
                         ELSE ARRAY(SELECT DISTINCT e FROM unnest(p_events) e ORDER BY e) END,
           is_active = COALESCE(p_active, is_active),
           disabled_reason = CASE
               WHEN p_active IS TRUE THEN NULL
               WHEN p_active IS FALSE AND is_active THEN 'owner'
               ELSE disabled_reason END,
           verified_at = CASE WHEN v_new_url THEN NULL ELSE verified_at END,
           failing_since = CASE WHEN v_new_url OR v_on THEN NULL ELSE failing_since END,
           consecutive_failures = CASE WHEN v_new_url OR v_on THEN 0 ELSE consecutive_failures END,
           updated_at = now()
     WHERE id = v_row.id
    RETURNING * INTO v_row;
    IF v_row.is_active AND (v_new_url OR (v_on AND v_row.verified_at IS NULL)) THEN
        PERFORM public.queue_outgoing_webhook_ping(v_row);
    END IF;
    RETURN public.outgoing_webhook_json(v_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_outgoing_webhook_secret(p_webhook_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
    v_secret text := public.outgoing_webhook_new_secret(v_row.id);
BEGIN
    RETURN public.outgoing_webhook_json(v_row.id) || jsonb_build_object('secret', v_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_outgoing_webhook(p_webhook_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    DELETE FROM public.outgoing_webhooks WHERE id = v_row.id;
END;
$$;

-- The webhook's latest deliveries, newest first; payloads left out.
CREATE OR REPLACE FUNCTION public.list_outgoing_webhook_deliveries(p_webhook_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', d.id, 'event', d.event, 'status', d.status, 'attempts', d.attempts,
                   'last_status', d.last_status, 'last_error', d.last_error,
                   'created_at', d.created_at, 'delivered_at', d.delivered_at,
                   'next_attempt_at', CASE WHEN d.status = 'pending' THEN d.next_attempt_at END)
                   ORDER BY d.created_at DESC, d.id)
          FROM (SELECT * FROM public.outgoing_webhook_deliveries x
                 WHERE x.webhook_id = v_row.id
                 ORDER BY x.created_at DESC, x.id
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) d), '[]'::jsonb);
END;
$$;

-- A PING delivery, whatever events the webhook takes; one per 10 seconds.
CREATE OR REPLACE FUNCTION public.test_outgoing_webhook(p_webhook_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.outgoing_webhooks := public.lock_managed_outgoing_webhook(p_webhook_id);
BEGIN
    IF NOT v_row.is_active THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_FORBIDDEN: turn the webhook on first' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.outgoing_webhook_deliveries d
                WHERE d.webhook_id = v_row.id AND d.event = 'PING' AND d.created_at > now() - interval '10 seconds') THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_TOO_SOON: one test event per 10 seconds' USING ERRCODE = '54000';
    END IF;
    RETURN public.queue_outgoing_webhook_ping(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff RPCs: instance admins and moderators; settings and deletion are admins' only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_get_webhook_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_active_instance_staff(public.get_current_profile_id()) THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    RETURN public.webhook_settings();
END;
$$;

-- Keys left out keep their value. Returns the settings as stored.
CREATE OR REPLACE FUNCTION public.admin_update_webhook_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_new jsonb;
    v_domains jsonb;
BEGIN
    SELECT p.id INTO v_actor FROM public.profiles p
     WHERE p.id = public.get_current_profile_id() AND p.is_admin IS TRUE AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
        RAISE EXCEPTION 'Settings must be an object' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'outgoing_mode' AND COALESCE(p_settings ->> 'outgoing_mode', '') NOT IN ('everyone', 'staff', 'off') THEN
        RAISE EXCEPTION 'outgoing_mode is everyone, staff or off' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'incoming_enabled' AND jsonb_typeof(p_settings -> 'incoming_enabled') <> 'boolean' THEN
        RAISE EXCEPTION 'incoming_enabled is a boolean' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'rate_per_minute' AND (jsonb_typeof(p_settings -> 'rate_per_minute') <> 'number'
       OR (p_settings ->> 'rate_per_minute')::numeric NOT BETWEEN 1 AND 10000) THEN
        RAISE EXCEPTION 'rate_per_minute is 1 to 10000' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'host_rate_per_minute' AND (jsonb_typeof(p_settings -> 'host_rate_per_minute') <> 'number'
       OR (p_settings ->> 'host_rate_per_minute')::numeric NOT BETWEEN 1 AND 100000) THEN
        RAISE EXCEPTION 'host_rate_per_minute is 1 to 100000' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'per_user' AND (jsonb_typeof(p_settings -> 'per_user') <> 'number'
       OR (p_settings ->> 'per_user')::numeric NOT BETWEEN 0 AND 1000) THEN
        RAISE EXCEPTION 'per_user is 0 to 1000' USING ERRCODE = '22023';
    END IF;
    IF p_settings ? 'blocked_domains' THEN
        IF jsonb_typeof(p_settings -> 'blocked_domains') <> 'array' OR jsonb_array_length(p_settings -> 'blocked_domains') > 500 THEN
            RAISE EXCEPTION 'blocked_domains is a list of at most 500 domains' USING ERRCODE = '22023';
        END IF;
        SELECT COALESCE(jsonb_agg(DISTINCT lower(btrim(d))), '[]'::jsonb) INTO v_domains
          FROM jsonb_array_elements_text(p_settings -> 'blocked_domains') d
         WHERE btrim(d) ~ '^[A-Za-z0-9.-]{1,253}$';
    END IF;

    v_new := public.webhook_settings()
             || (p_settings - 'blocked_domains')
             || CASE WHEN v_domains IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('blocked_domains', v_domains) END;
    v_new := (SELECT jsonb_object_agg(k, v) FROM jsonb_each(v_new) e(k, v)
               WHERE k IN ('outgoing_mode', 'incoming_enabled', 'rate_per_minute', 'host_rate_per_minute',
                           'per_user', 'blocked_domains'));
    INSERT INTO public.instance_config (config_key, config_value, updated_by, updated_at)
    VALUES ('webhook_settings', v_new, v_actor, now())
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_by = EXCLUDED.updated_by, updated_at = now();
    PERFORM public.log_admin_action(v_actor, 'webhook_settings_updated', 'instance', 'webhook_settings', v_new);
    RETURN public.webhook_settings();
END;
$$;

-- Every outgoing webhook, busiest first: whose, where to, state and the last day's deliveries.
CREATE OR REPLACE FUNCTION public.admin_list_outgoing_webhooks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_active_instance_staff(public.get_current_profile_id()) THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(x.row ORDER BY (x.row ->> 'deliveries_24h')::integer DESC, x.row ->> 'created_at')
          FROM (
            SELECT public.outgoing_webhook_json(w.id) || jsonb_build_object(
                       'host', w.host,
                       'bot_name', b.display_name,
                       'server_name', s.name,
                       'owner_username', COALESCE(bo.username, c.username),
                       'deliveries_24h', (SELECT count(*) FROM public.outgoing_webhook_deliveries d
                                           WHERE d.webhook_id = w.id AND d.created_at > now() - interval '1 day'),
                       'failed_24h', (SELECT count(*) FROM public.outgoing_webhook_deliveries d
                                       WHERE d.webhook_id = w.id AND d.created_at > now() - interval '1 day'
                                         AND d.status = 'failed')) AS row
              FROM public.outgoing_webhooks w
              LEFT JOIN public.bots b ON b.id = w.bot_id
              LEFT JOIN public.profiles bo ON bo.id = b.owner_id
              LEFT JOIN public.servers s ON s.id = w.server_id
              LEFT JOIN public.profiles c ON c.id = w.created_by) x), '[]'::jsonb);
END;
$$;

-- Staff turn a webhook off (its owner cannot turn it back on) or on again.
CREATE OR REPLACE FUNCTION public.admin_set_outgoing_webhook_active(p_webhook_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid := public.get_current_profile_id();
    v_row public.outgoing_webhooks;
BEGIN
    IF NOT public.is_active_instance_staff(v_actor) THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    IF p_active IS NULL THEN
        RAISE EXCEPTION 'p_active is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_row FROM public.outgoing_webhooks WHERE id = p_webhook_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_NOT_FOUND: no such webhook' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.outgoing_webhooks
       SET is_active = p_active,
           disabled_reason = CASE WHEN p_active THEN NULL ELSE 'staff' END,
           failing_since = CASE WHEN p_active THEN NULL ELSE failing_since END,
           consecutive_failures = CASE WHEN p_active THEN 0 ELSE consecutive_failures END,
           updated_at = now()
     WHERE id = v_row.id;
    PERFORM public.log_admin_action(v_actor,
        CASE WHEN p_active THEN 'outgoing_webhook_enabled' ELSE 'outgoing_webhook_disabled' END,
        'outgoing_webhook', v_row.id::text,
        jsonb_build_object('name', v_row.name, 'host', v_row.host, 'bot_id', v_row.bot_id, 'server_id', v_row.server_id));
    RETURN public.outgoing_webhook_json(v_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_outgoing_webhook(p_webhook_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_row public.outgoing_webhooks;
BEGIN
    SELECT p.id INTO v_actor FROM public.profiles p
     WHERE p.id = public.get_current_profile_id() AND p.is_admin IS TRUE AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.outgoing_webhooks WHERE id = p_webhook_id RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'OUTGOING_WEBHOOK_NOT_FOUND: no such webhook' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.log_admin_action(v_actor, 'outgoing_webhook_deleted', 'outgoing_webhook', v_row.id::text,
        jsonb_build_object('name', v_row.name, 'host', v_row.host, 'bot_id', v_row.bot_id, 'server_id', v_row.server_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- Incoming webhooks: the instance switch
-- ---------------------------------------------------------------------------

-- 20261010800001_channel_webhooks.sql's, refusing everything while incoming webhooks are off.
CREATE OR REPLACE FUNCTION public.assert_webhook_channel(p_channel_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel record;
BEGIN
    IF NOT (public.webhook_settings() ->> 'incoming_enabled')::boolean THEN
        RAISE EXCEPTION 'WEBHOOK_DISABLED: webhooks are turned off on this instance'
            USING ERRCODE = '42501';
    END IF;
    SELECT c.server_id, c.type, c.is_remote, s.is_local_server INTO v_channel
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_channel.is_remote IS TRUE OR v_channel.is_local_server IS FALSE
       OR COALESCE(v_channel.type, 0) <> 0 THEN
        RAISE EXCEPTION 'WEBHOOK_CHANNEL_UNSUPPORTED: webhooks post to text channels of this instance''s servers'
            USING ERRCODE = '22023';
    END IF;
    IF public.channel_messages_encrypted(p_channel_id) THEN
        RAISE EXCEPTION 'WEBHOOK_CHANNEL_ENCRYPTED: this channel is end-to-end encrypted'
            USING ERRCODE = '42501';
    END IF;
    RETURN v_channel.server_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Service RPCs: the bot gateway and the federation backend's worker
-- ---------------------------------------------------------------------------

-- Webhooks taking events now and what they take, for the bot gateway's cache.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_routes()
RETURNS TABLE (bot_id uuid, server_id uuid, events text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT w.bot_id, w.server_id, w.events FROM public.outgoing_webhooks w
     WHERE w.is_active AND w.verified_at IS NOT NULL
       AND public.webhook_settings() ->> 'outgoing_mode' <> 'off'
$$;

-- One delivery for each verified, active webhook taking p_event: a bot's, when the bot is among
-- p_bot_ids (the gateway's readers of the event); a server's, for an event of p_server_id whose
-- channel its creator reads. A paused webhook, or one at its rate, drops the event and counts it.
-- Returns the number queued.
CREATE OR REPLACE FUNCTION public.enqueue_outgoing_webhook_event(
    p_event text, p_server_id uuid, p_channel_id uuid, p_bot_ids uuid[], p_payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_settings jsonb := public.webhook_settings();
    v_rate integer := (v_settings ->> 'rate_per_minute')::integer;
    v_webhook public.outgoing_webhooks;
    v_drop text;
    v_id uuid;
    v_count integer := 0;
BEGIN
    IF NOT p_event = ANY (public.outgoing_webhook_event_types()) OR v_settings ->> 'outgoing_mode' = 'off' THEN
        RETURN 0;
    END IF;
    FOR v_webhook IN
        SELECT w.* FROM public.outgoing_webhooks w
         WHERE w.is_active AND w.verified_at IS NOT NULL AND p_event = ANY (w.events)
           AND ((w.bot_id IS NOT NULL AND w.bot_id = ANY (COALESCE(p_bot_ids, '{}'::uuid[])))
                OR (w.server_id IS NOT NULL AND w.server_id = p_server_id))
    LOOP
        IF v_webhook.server_id IS NOT NULL AND NOT public.outgoing_webhook_creator_reads(v_webhook, p_channel_id) THEN
            CONTINUE;
        END IF;
        IF public.outgoing_webhook_host_blocked(v_webhook.host) THEN
            CONTINUE;
        END IF;
        v_drop := CASE
            WHEN v_webhook.consecutive_failures >= 10 THEN 'paused'
            WHEN (SELECT count(*) FROM public.outgoing_webhook_deliveries d
                   WHERE d.webhook_id = v_webhook.id AND d.created_at > now() - interval '1 minute'
                     AND d.event <> 'PING') >= v_rate THEN 'rate_limited'
        END;
        IF v_drop IS NOT NULL THEN
            UPDATE public.outgoing_webhooks
               SET dropped_events = dropped_events + 1, last_dropped_at = now(), last_drop_reason = v_drop
             WHERE id = v_webhook.id;
            CONTINUE;
        END IF;
        INSERT INTO public.outgoing_webhook_deliveries (webhook_id, event, payload)
        VALUES (v_webhook.id, p_event, p_payload)
        RETURNING id INTO v_id;
        PERFORM public.queue_federation_job('deliver-outgoing-webhook', jsonb_build_object('delivery_id', v_id));
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

-- Claims a pending, due delivery of an active webhook for one attempt; the next claim waits two
-- minutes, so a job and the sweep never send it twice. With two attempts of the webhook in flight,
-- or the destination host at its rate for this minute, nothing is claimed and defer_ms says when to
-- try again. No row when there is nothing to send.
CREATE OR REPLACE FUNCTION public.claim_outgoing_webhook_delivery(p_delivery_id uuid)
RETURNS TABLE (delivery_id uuid, webhook_id uuid, url text, secret text, event text, payload jsonb,
               attempts integer, created_at timestamptz, defer_ms integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delivery public.outgoing_webhook_deliveries;
    v_webhook public.outgoing_webhooks;
    v_minute timestamptz := date_trunc('minute', now());
    v_attempts integer;
BEGIN
    PERFORM public.outgoing_webhook_assert_vault();
    SELECT d.* INTO v_delivery FROM public.outgoing_webhook_deliveries d WHERE d.id = p_delivery_id;
    IF NOT FOUND OR v_delivery.status <> 'pending' OR v_delivery.next_attempt_at > now() THEN
        RETURN;
    END IF;
    -- Serialises the claims of one webhook.
    SELECT w.* INTO v_webhook FROM public.outgoing_webhooks w WHERE w.id = v_delivery.webhook_id FOR UPDATE;
    IF NOT v_webhook.is_active OR public.outgoing_webhook_host_blocked(v_webhook.host) THEN
        RETURN;
    END IF;
    SELECT d.* INTO v_delivery FROM public.outgoing_webhook_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
    IF v_delivery.status <> 'pending' OR v_delivery.next_attempt_at > now() THEN
        RETURN;
    END IF;

    IF (SELECT count(*) FROM public.outgoing_webhook_deliveries d
         WHERE d.webhook_id = v_webhook.id AND d.status = 'pending' AND d.id <> v_delivery.id
           AND d.claimed_at > now() - interval '15 seconds') >= 2 THEN
        UPDATE public.outgoing_webhook_deliveries SET next_attempt_at = now() + interval '2 seconds' WHERE id = v_delivery.id;
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::integer,
                            NULL::timestamptz, 2000;
        RETURN;
    END IF;

    INSERT INTO public.outgoing_webhook_host_minutes AS m (host, minute, attempts)
    VALUES (v_webhook.host, v_minute, 1)
    ON CONFLICT (host, minute) DO UPDATE SET attempts = m.attempts + 1
    RETURNING m.attempts INTO v_attempts;
    IF v_attempts > (public.webhook_settings() ->> 'host_rate_per_minute')::integer THEN
        UPDATE public.outgoing_webhook_host_minutes AS m SET attempts = m.attempts - 1
         WHERE m.host = v_webhook.host AND m.minute = v_minute;
        UPDATE public.outgoing_webhook_deliveries SET next_attempt_at = v_minute + interval '1 minute' WHERE id = v_delivery.id;
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::integer,
                            NULL::timestamptz,
                            GREATEST(ceil(extract(epoch FROM (v_minute + interval '1 minute' - now())) * 1000)::integer, 100);
        RETURN;
    END IF;

    UPDATE public.outgoing_webhook_deliveries
       SET claimed_at = now(), next_attempt_at = now() + interval '2 minutes'
     WHERE id = v_delivery.id;
    RETURN QUERY
    SELECT v_delivery.id, v_webhook.id, v_webhook.url, s.decrypted_secret, v_delivery.event, v_delivery.payload,
           v_delivery.attempts, v_delivery.created_at, NULL::integer
      FROM vault.decrypted_secrets s WHERE s.id = v_webhook.secret_id;
END;
$$;

-- The outcome of one attempt. A failure schedules the next attempt or ends the delivery; three
-- days of failures since the last success disable the webhook and tell its owner. A delivery that
-- ends drops its payload. A PING's 2xx verifies the webhook.
CREATE OR REPLACE FUNCTION public.record_outgoing_webhook_attempt(
    p_delivery_id uuid, p_ok boolean, p_status integer, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delay CONSTANT interval[] := ARRAY['30 seconds', '2 minutes', '10 minutes', '30 minutes',
                                         '1 hour', '3 hours', '6 hours']::interval[];
    v_delivery public.outgoing_webhook_deliveries;
    v_webhook public.outgoing_webhooks;
    v_attempts integer;
    v_error text := left(p_error, 300);
    v_status text;
BEGIN
    SELECT * INTO v_delivery FROM public.outgoing_webhook_deliveries WHERE id = p_delivery_id FOR UPDATE;
    IF NOT FOUND OR v_delivery.status <> 'pending' THEN
        RETURN NULL;
    END IF;
    v_attempts := v_delivery.attempts + 1;
    v_status := CASE WHEN p_ok THEN 'delivered' WHEN v_attempts > cardinality(v_delay) THEN 'failed' ELSE 'pending' END;

    UPDATE public.outgoing_webhook_deliveries
       SET attempts = v_attempts, status = v_status, last_status = p_status, claimed_at = NULL,
           last_error = CASE WHEN p_ok THEN NULL ELSE v_error END,
           delivered_at = CASE WHEN p_ok THEN now() END,
           payload = CASE WHEN v_status = 'pending' THEN payload END,
           next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + v_delay[v_attempts] ELSE next_attempt_at END
     WHERE id = p_delivery_id;

    SELECT * INTO v_webhook FROM public.outgoing_webhooks WHERE id = v_delivery.webhook_id FOR UPDATE;
    IF p_ok THEN
        UPDATE public.outgoing_webhooks
           SET last_success_at = now(), failing_since = NULL, consecutive_failures = 0,
               last_status = p_status, last_error = NULL,
               verified_at = CASE WHEN v_delivery.event = 'PING' THEN COALESCE(verified_at, now()) ELSE verified_at END
         WHERE id = v_webhook.id;
    ELSE
        UPDATE public.outgoing_webhooks
           SET last_failure_at = now(), failing_since = COALESCE(failing_since, now()),
               consecutive_failures = consecutive_failures + 1,
               last_status = p_status, last_error = v_error
         WHERE id = v_webhook.id
        RETURNING * INTO v_webhook;
        IF v_webhook.is_active AND v_webhook.failing_since < now() - interval '3 days' THEN
            UPDATE public.outgoing_webhooks SET is_active = false, disabled_reason = 'failing' WHERE id = v_webhook.id;
            INSERT INTO public.notifications (user_id, type, data)
            SELECT DISTINCT r.user_id, 'outgoing_webhook_disabled', jsonb_build_object(
                       'webhook', jsonb_build_object('id', v_webhook.id, 'name', v_webhook.name),
                       'bot_id', v_webhook.bot_id, 'server_id', v_webhook.server_id,
                       'last_error', v_error)
              FROM (SELECT b.owner_id AS user_id FROM public.bots b WHERE b.id = v_webhook.bot_id
                    UNION SELECT v_webhook.created_by WHERE v_webhook.server_id IS NOT NULL) r
             WHERE r.user_id IS NOT NULL;
        END IF;
    END IF;
    RETURN v_status;
END;
$$;

-- Pending deliveries due now: retries, deferred attempts, and first attempts whose job was lost.
CREATE OR REPLACE FUNCTION public.due_outgoing_webhook_deliveries(p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT d.id FROM public.outgoing_webhook_deliveries d
     WHERE d.status = 'pending' AND d.next_attempt_at <= now()
       AND (d.attempts > 0 OR d.created_at < now() - interval '1 minute')
     ORDER BY d.next_attempt_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;

-- One PING for each paused webhook with nothing pending and no attempt in five minutes. Returns
-- the deliveries queued.
CREATE OR REPLACE FUNCTION public.outgoing_webhook_probes()
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_webhook public.outgoing_webhooks;
BEGIN
    FOR v_webhook IN
        SELECT w.* FROM public.outgoing_webhooks w
         WHERE w.is_active AND w.consecutive_failures >= 10
           AND COALESCE(w.last_failure_at, w.created_at) < now() - interval '5 minutes'
           AND NOT EXISTS (SELECT 1 FROM public.outgoing_webhook_deliveries d
                            WHERE d.webhook_id = w.id AND d.status = 'pending')
         LIMIT 200
    LOOP
        RETURN NEXT public.queue_outgoing_webhook_ping(v_webhook);
    END LOOP;
END;
$$;

-- Deliveries and member changes older than seven days, host counters older than an hour. Returns
-- the rows removed.
CREATE OR REPLACE FUNCTION public.prune_outgoing_webhook_records()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deliveries integer;
    v_changes integer;
    v_minutes integer;
BEGIN
    DELETE FROM public.outgoing_webhook_deliveries WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_deliveries = ROW_COUNT;
    DELETE FROM public.server_member_changes WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_changes = ROW_COUNT;
    DELETE FROM public.outgoing_webhook_host_minutes WHERE minute < now() - interval '1 hour';
    GET DIAGNOSTICS v_minutes = ROW_COUNT;
    RETURN v_deliveries + v_changes + v_minutes;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.record_server_member_change()'::regprocedure,
        'public.webhook_settings()'::regprocedure,
        'public.is_active_instance_staff(uuid)'::regprocedure,
        'public.outgoing_webhook_event_types()'::regprocedure,
        'public.outgoing_webhook_assert_vault()'::regprocedure,
        'public.can_manage_outgoing_webhooks(uuid, uuid)'::regprocedure,
        'public.outgoing_webhook_creator_reads(public.outgoing_webhooks, uuid)'::regprocedure,
        'public.outgoing_webhook_json(uuid)'::regprocedure,
        'public.outgoing_webhook_valid_url(text)'::regprocedure,
        'public.outgoing_webhook_host(text)'::regprocedure,
        'public.outgoing_webhook_host_blocked(text)'::regprocedure,
        'public.outgoing_webhook_new_secret(uuid)'::regprocedure,
        'public.outgoing_webhooks_purge_secret()'::regprocedure,
        'public.lock_managed_outgoing_webhook(uuid)'::regprocedure,
        'public.outgoing_webhook_check_fields(text, text, text[])'::regprocedure,
        'public.queue_outgoing_webhook_ping(public.outgoing_webhooks)'::regprocedure,
        'public.assert_webhook_channel(uuid)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.webhook_availability()'::regprocedure,
        'public.create_outgoing_webhook(uuid, uuid, text, text, text[])'::regprocedure,
        'public.list_outgoing_webhooks(uuid, uuid)'::regprocedure,
        'public.update_outgoing_webhook(uuid, text, text, text[], boolean)'::regprocedure,
        'public.rotate_outgoing_webhook_secret(uuid)'::regprocedure,
        'public.delete_outgoing_webhook(uuid)'::regprocedure,
        'public.list_outgoing_webhook_deliveries(uuid, integer)'::regprocedure,
        'public.test_outgoing_webhook(uuid)'::regprocedure,
        'public.admin_get_webhook_settings()'::regprocedure,
        'public.admin_update_webhook_settings(jsonb)'::regprocedure,
        'public.admin_list_outgoing_webhooks()'::regprocedure,
        'public.admin_set_outgoing_webhook_active(uuid, boolean)'::regprocedure,
        'public.admin_delete_outgoing_webhook(uuid)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.outgoing_webhook_routes()'::regprocedure,
        'public.enqueue_outgoing_webhook_event(text, uuid, uuid, uuid[], jsonb)'::regprocedure,
        'public.claim_outgoing_webhook_delivery(uuid)'::regprocedure,
        'public.record_outgoing_webhook_attempt(uuid, boolean, integer, text)'::regprocedure,
        'public.due_outgoing_webhook_deliveries(integer)'::regprocedure,
        'public.outgoing_webhook_probes()'::regprocedure,
        'public.prune_outgoing_webhook_records()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
