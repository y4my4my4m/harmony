-- RLS Policy for Server Deletion
-- Only allows the server owner to delete their own server

CREATE POLICY "server_delete_policy"
ON "public"."servers"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (
    auth.uid() = owner
);