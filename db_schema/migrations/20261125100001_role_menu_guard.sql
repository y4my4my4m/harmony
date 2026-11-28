-- Role menus: posted with Manage Roles, never edited.
--
-- A role menu is a channel message whose content is
--   [{type 'role_menu', serverId, group, title}, {type 'text', text '<title>: <role> · <role>'}]
-- (src/utils/roleMenu.ts). Its card lists the server's self-assignable roles and picks through
-- set_my_self_assignable_role, which decides each pick whoever posted the card.
--
-- guard_message_role_menu, on writes of the client roles:
--   a_messages_role_menu_guard       an insert holding a role_menu part needs MANAGE_ROLES in the
--                                    channel's server, as /rolemenu asks; a conversation takes none.
--                                    'Missing permission: MANAGE_ROLES', as
--                                    enforce_message_content_permissions names one.
--   a_messages_role_menu_edit_guard  a content edit of a message that holds a role_menu part, or
--                                    would, is refused, soft deletion aside, as
--                                    guard_message_poll_parts does for polls (20261010700001).
--                                    ROLE_MENU_IMMUTABLE.
-- An end-to-end encrypted message carries its parts inside the ciphertext: neither trigger sees them.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.guard_message_role_menu()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.conversation_id IS NULL
           AND public.has_permission(public.get_current_profile_id(),
                                     (SELECT c.server_id FROM public.channels c WHERE c.id = NEW.channel_id),
                                     'MANAGE_ROLES') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Missing permission: MANAGE_ROLES' USING ERRCODE = '42501';
    END IF;

    -- Soft deletion replaces the content.
    IF NEW.is_deleted IS TRUE AND OLD.is_deleted IS NOT TRUE
       AND NOT NEW.content @> '[{"type": "role_menu"}]'::jsonb THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_message_role_menu() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_message_role_menu() TO service_role;

-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on messages; DROP TRIGGER would take ACCESS
-- EXCLUSIVE and stop reads too. WHEN holds the tests: no other message calls the function.
CREATE OR REPLACE TRIGGER a_messages_role_menu_guard
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon')
          AND NEW.content @> '[{"type": "role_menu"}]'::jsonb)
    EXECUTE FUNCTION public.guard_message_role_menu();

CREATE OR REPLACE TRIGGER a_messages_role_menu_edit_guard
    BEFORE UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon')
          AND NEW.content IS DISTINCT FROM OLD.content
          AND (NEW.content @> '[{"type": "role_menu"}]'::jsonb
               OR OLD.content @> '[{"type": "role_menu"}]'::jsonb))
    EXECUTE FUNCTION public.guard_message_role_menu();

COMMIT;
