-- PostgREST fails a request whose select list names an unknown column, and resolves an
-- embed by constraint name (PGRST200 otherwise). Constraint names here match the ones
-- Postgres auto-generates for init/'s inline references.
-- Orphan counts precede each ADD CONSTRAINT so a validation failure names the data
-- instead of a bare 23503.

BEGIN;

ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE public.channel_categories
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

DO $$
DECLARE
    v_orphans bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.conversation_participants'::regclass
           AND conname = 'conversation_participants_conversation_id_fkey'
    ) THEN
        SELECT count(*) INTO v_orphans
          FROM public.conversation_participants p
         WHERE NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p.conversation_id);
        IF v_orphans > 0 THEN
            RAISE EXCEPTION
                'cannot add conversation_participants_conversation_id_fkey: % row(s) reference a conversation that no longer exists', v_orphans;
        END IF;

        ALTER TABLE public.conversation_participants
            ADD CONSTRAINT conversation_participants_conversation_id_fkey
            FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
        RAISE NOTICE 'conversation_participants_conversation_id_fkey added';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.conversation_participants'::regclass
           AND conname = 'conversation_participants_user_id_fkey'
    ) THEN
        SELECT count(*) INTO v_orphans
          FROM public.conversation_participants p
         WHERE NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p.user_id);
        IF v_orphans > 0 THEN
            RAISE EXCEPTION
                'cannot add conversation_participants_user_id_fkey: % row(s) reference a profile that no longer exists', v_orphans;
        END IF;

        ALTER TABLE public.conversation_participants
            ADD CONSTRAINT conversation_participants_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
        RAISE NOTICE 'conversation_participants_user_id_fkey added';
    END IF;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
