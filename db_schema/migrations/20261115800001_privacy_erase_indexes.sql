-- harmony:no-transaction
--
-- Indexes for bridge_privacy_erase_core (20261115900001):
--   messages_discord_relayed_channel  a server's relayed messages, when it erases every relayed
--                                     author of a server ("Remove all bridged messages"): each batch
--                                     reads this index instead of every message of the server.
--   messages_automod_alert_event      AutoMod alert messages by the event they report
--                                     (metadata.automod.event_id, automod_post_alert): an erased
--                                     author's alerts go with their events.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build takes no
-- lock that blocks writes. An interrupted build leaves an invalid index; it is dropped before the
-- next build, and the file fails while an index is not valid.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['messages_discord_relayed_channel', 'messages_automod_alert_event'] LOOP
        IF EXISTS (SELECT 1
                     FROM pg_index x
                     JOIN pg_class c ON c.oid = x.indexrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relname = v_name
                      AND NOT x.indisvalid) THEN
            EXECUTE format('DROP INDEX public.%I', v_name);
        END IF;
    END LOOP;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_discord_relayed_channel
    ON public.messages (channel_id)
    WHERE metadata ? 'discord_user';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_automod_alert_event
    ON public.messages ((metadata #>> '{automod,event_id}'))
    WHERE metadata ->> 'type' = 'automod_alert';

RESET lock_timeout;

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['messages_discord_relayed_channel', 'messages_automod_alert_event'] LOOP
        IF NOT EXISTS (SELECT 1
                         FROM pg_index x
                        WHERE x.indexrelid = to_regclass('public.' || v_name)
                          AND x.indisvalid) THEN
            RAISE EXCEPTION '% is not valid; run 20261115800001 again', v_name;
        END IF;
    END LOOP;
END
$$;
