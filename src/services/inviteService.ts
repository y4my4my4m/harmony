import { supabase } from '@/supabase';

async function generateInviteUrl(serverId: string, userId: string): Promise<string | null> {
    try {
        // Generate a unique code // TODO: make it better (use UUID package?)
        const code = Math.random().toString(36).substr(2, 9);

        // Insert the invite code into the database
        // TODO: fix RLS for people with permissions to do so
        // TODO: also just copy an already existing one if it exists
        const { data, error } = await supabase
            .from('invites')
            .insert([{ code, server_id: serverId, created_by: userId, expires_at: new Date(new Date().getTime() + 24*60*60*1000) }]) // Expires in 24 hours
            .single();

        if (error) throw error;

        // Construct the invite URL
        return `${import.meta.env.VITE_APP_URL}/invite/${code}`; // TODO: replace with env URL
    } catch (error) {
        console.error('Error generating invite URL:', error);
        return null;
    }
}
async function acceptInvite(code: string, userId: string): Promise<boolean> {
    try {
        const { data: invite, error: inviteError } = await supabase
            .from('invites')
            .select('*')
            .eq('code', code)
            .single();

        if (inviteError || !invite || invite.used || new Date() > new Date(invite.expires_at)) throw new Error('Invalid invite');

        // Add user to the server
        const { error: userServerError } = await supabase
            .from('user_servers')
            .insert([{ user_id: userId, server_id: invite.server_id }]);
    

        if (userServerError) throw userServerError;

        // Mark invite as used
        await supabase.from('invites').update({ used: true }).eq('id', invite.id);
        return true;
    } catch (error) {
        console.error('Error accepting invite:', error);
        return false;
    }
};

export { generateInviteUrl, acceptInvite}
