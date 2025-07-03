-- RLS Policy 1: User can read messages from channels they have access to OR conversations they participate in
(EXISTS ( SELECT 1
   FROM (channels
     JOIN user_servers ON ((channels.server_id = user_servers.server_id)))
  WHERE ((user_servers.user_id = uid()) AND (messages.channel_id = channels.id))))
OR 
(EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = messages.conversation_id) AND ((conversations.user1 = uid()) OR (conversations.user2 = uid())))))

-- RLS Policy 2: User can modify messages if they own the message OR own the server OR participate in the conversation
((uid() = user_id) OR (uid() = ( SELECT servers.owner
   FROM servers
  WHERE (servers.id = ( SELECT channels.server_id
           FROM channels
          WHERE (channels.id = messages.channel_id)))))
OR 
(EXISTS ( SELECT 1
   FROM conversations
  WHERE ((conversations.id = messages.conversation_id) AND ((conversations.user1 = uid()) OR (conversations.user2 = uid()))))))