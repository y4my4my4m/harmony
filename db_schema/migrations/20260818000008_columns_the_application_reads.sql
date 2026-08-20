-- Eight columns the application selects that a fresh init/ build does not define.
--
-- Found by scripts/check-schema-usage.sh. All eight exist in production and nowhere else,
-- so a fresh install answers 42703 and PostgREST turns that into a 400 on the whole
-- request - an unknown column in a select list fails the statement, it does not return null.
--
-- Types and nullability are from the production dump verbatim. All are nullable with no
-- NOT NULL, so ADD COLUMN is catalog-only: no rewrite, no backfill.
--
-- public.bot_tokens is deliberately absent; its columns are owned by separate work.

BEGIN;

ALTER TABLE public.server_roles   ADD COLUMN IF NOT EXISTS icon_url text;
ALTER TABLE public.server_roles   ADD COLUMN IF NOT EXISTS unicode_emoji text;
ALTER TABLE public.server_roles   ADD COLUMN IF NOT EXISTS ap_id text;

ALTER TABLE public.thread_members ADD COLUMN IF NOT EXISTS last_read_message_id uuid;

ALTER TABLE public.user_servers   ADD COLUMN IF NOT EXISTS temporary boolean;

ALTER TABLE public.bot_presence   ADD COLUMN IF NOT EXISTS gateway_session_id text;
ALTER TABLE public.bot_presence   ADD COLUMN IF NOT EXISTS latency_ms integer;

ALTER TABLE public.bot_audit_log  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Every column named above must now exist. A silent miss here would leave the gate red and
-- the fresh install broken in exactly the way this file exists to fix.
DO $$
DECLARE
    v_missing text := '';
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('server_roles', 'icon_url'),
            ('server_roles', 'unicode_emoji'),
            ('server_roles', 'ap_id'),
            ('thread_members', 'last_read_message_id'),
            ('user_servers', 'temporary'),
            ('bot_presence', 'gateway_session_id'),
            ('bot_presence', 'latency_ms'),
            ('bot_audit_log', 'metadata')
        ) AS t(tbl, col)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
        ) THEN
            v_missing := v_missing || r.tbl || '.' || r.col || ' ';
        END IF;
    END LOOP;

    IF v_missing <> '' THEN
        RAISE EXCEPTION 'columns still absent after this migration: %', v_missing;
    END IF;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
