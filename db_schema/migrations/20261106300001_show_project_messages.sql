-- instance_funding.show_project_messages: the Harmony development tab of this instance's Support
-- window shows the Harmony project's approved supporter messages. Default on. The project
-- approves those messages, not this instance's admins; with the switch off the federation
-- backend's GET /funding/project serves the project's links and progress with no messages.
-- Instance admins write it (policy funding_modify_admin); the project's own instance ignores it.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.instance_funding
    ADD COLUMN IF NOT EXISTS show_project_messages boolean NOT NULL DEFAULT true;

GRANT SELECT (show_project_messages),
      INSERT (show_project_messages),
      UPDATE (show_project_messages)
   ON public.instance_funding TO authenticated;
GRANT SELECT ON public.instance_funding TO service_role;

COMMIT;
