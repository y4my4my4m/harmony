-- Attaches messages_bot_id_fkey, which only production has.
--
-- messages.bot_id and idx_messages_bot_id exist everywhere; the FOREIGN KEY does not.
-- init/04_tables_servers.sql declares bot_id without REFERENCES because public.bots is
-- created two files later, and the constraint was never added back.
--
-- PostgREST resolves an embed written `bots!messages_bot_id_fkey` by constraint NAME, not
-- by column, so without it five bot message routes answer PGRST200.
--
-- ON DELETE CASCADE matches production. Adding the constraint validates existing rows, so a
-- bot_id pointing at a deleted bot aborts this migration; the check below reports the count
-- rather than leaving a bare 23503 to interpret.

BEGIN;

DO $$
DECLARE
    v_orphans bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.messages'::regclass
           AND conname = 'messages_bot_id_fkey'
    ) THEN
        RAISE NOTICE 'messages_bot_id_fkey already present';
        RETURN;
    END IF;

    SELECT count(*) INTO v_orphans
      FROM public.messages m
     WHERE m.bot_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.bots b WHERE b.id = m.bot_id);

    IF v_orphans > 0 THEN
        RAISE EXCEPTION
            'cannot add messages_bot_id_fkey: % message(s) carry a bot_id with no matching row in public.bots. Resolve them first - each is a message attributed to a bot that no longer exists.', v_orphans;
    END IF;

    ALTER TABLE public.messages
        ADD CONSTRAINT messages_bot_id_fkey
        FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;

    RAISE NOTICE 'messages_bot_id_fkey added';
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
