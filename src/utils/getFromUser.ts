// import type { Profile } from '@/types';

import { supabase } from '@/supabase';

export const GetUserIdFromUsername = async (username: string): Promise<string> => {
    // fetch from supabase's profiles table
    const { data, error } = await supabase.from('profiles').select('id').eq('username', username);
    if (error || !data) {
        console.error('Error fetching user id from username', error);
        return '';
    }
    if (data.length === 0) {
        console.error('No user found with username', username);
        return '';
    }
    return data[0].id;
}