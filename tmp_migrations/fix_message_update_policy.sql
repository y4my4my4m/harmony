-- Fix message update policy to allow both message owner and server owner to edit messages
-- This should match the delete policy behavior

-- Drop the existing restrictive update policy
DROP POLICY IF EXISTS "Only message owner can update" ON public.messages;

-- Create new update policy that allows both message owner and server owner
CREATE POLICY "Message owner or server owner can update" ON public.messages FOR UPDATE USING (
  (auth.uid() = user_id) OR 
  (auth.uid() = (
    SELECT servers.owner 
    FROM servers 
    JOIN channels ON servers.id = channels.server_id 
    WHERE channels.id = messages.channel_id
  ))
);
