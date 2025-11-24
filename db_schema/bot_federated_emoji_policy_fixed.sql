-- Drop existing policies if they exist
DROP POLICY IF EXISTS bot_create_federated_emoji_policy ON public.emojis;
DROP POLICY IF EXISTS bot_read_federated_emoji_policy ON public.emojis;
DROP POLICY IF EXISTS federated_emoji_public_access_policy ON public.emojis;

-- Allow bots to create federated/global emojis (same as ActivityPub does)
-- Federated emojis have server_id = NULL and can be used across all servers

-- Policy to allow bots to INSERT federated emojis (server_id IS NULL)
CREATE POLICY bot_create_federated_emoji_policy ON public.emojis
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Only allow bots to create emojis with server_id = NULL (federated emojis)
    -- Check if the authenticated user is a bot
    server_id IS NULL 
    AND EXISTS (SELECT 1 FROM public.bots WHERE id = auth.uid())
  );

-- Policy to allow bots to SELECT federated emojis they created
CREATE POLICY bot_read_federated_emoji_policy ON public.emojis
  FOR SELECT
  TO authenticated
  USING (
    -- Bots can read federated emojis they created
    server_id IS NULL 
    AND uploader = auth.uid()
    AND EXISTS (SELECT 1 FROM public.bots WHERE id = auth.uid())
  );

-- Also allow everyone to SELECT federated emojis (they're global)
CREATE POLICY federated_emoji_public_access_policy ON public.emojis
  FOR SELECT
  TO authenticated
  USING (server_id IS NULL);

