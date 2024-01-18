// emojiService.ts
import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';

async function uploadEmoji(serverId: string, userId: string, file: File) {
    try {
        const uniqueEmojiName = `${uuidv4()}.${file.name.split('.').pop()}`;
        const filePath = `${serverId}/${userId}/${uniqueEmojiName}`;

        // upload the file
        const { error } = await supabase.storage
            .from('emojis')
            .upload(filePath, file);

        if (error) throw error;

        // retrieve the file
        const { data } = await supabase.storage
            .from('emojis')
            .getPublicUrl(filePath);

        console.log("Emoji uploaded successfully");

        // Add entry to database (assuming you have an 'emojis' table)
        const newEmoji = {
            name: file.name,
            url: data.publicUrl,
            server_id: serverId,
            uploader: userId,
            created_at: new Date()
        };
    
        const { data: emojiData, error: fetchError } = await supabase
            .from('emojis')
            .insert([newEmoji])
            .select()
            .single();
    
        if (fetchError) throw fetchError;
    
        return emojiData; // Return the newly created emoji data
    } catch (error) {
        console.error('Error uploading emoji:', error);
        return null;
    }
}

export { uploadEmoji };
