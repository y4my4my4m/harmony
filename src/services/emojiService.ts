// emojiService.ts
import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';

const cleanFileName = (originalName:string) => {
    // Remove unwanted characters and trim leading/trailing spaces
    let name = originalName.replace(/[^\w\s.-]/gi, '').trim();

    // Remove leading/trailing periods and extra spaces
    name = name.replace(/^[.]+|[.]+$/g, "").replace(/\s+/g, ' ');

    // Handle multiple extensions: keep the last part after splitting by '.'
    const parts = name.split('.');
    const extension = parts.pop(); // Extract the extension
    let fileNameWithoutExtension = parts.join('.').trim();

    // Avoid empty filenames
    if (!fileNameWithoutExtension) {
        fileNameWithoutExtension = 'emoji';
    }

    return { name: fileNameWithoutExtension, extension };
};
async function getEmoji(emojiId: string) {
    const { data, error } = await supabase
        .from('emojis')
        .select()
        .eq('id', emojiId)
        .single();

    if (error) {
        console.error('Error getting emoji:', error);
        throw error;
    }
    return data;
};
async function uploadEmoji(serverId: string, userId: string, file: File) {
    try {
        const { name: cleanedName, extension } = cleanFileName(file.name);
        // Check if the emoji name already exists and find a unique name
        let uniqueName = cleanedName;
        let counter = 1;
        while (await doesEmojiNameExist(serverId, uniqueName)) {
            uniqueName = `${cleanedName}~${counter}`;
            counter++;
        }

        const uniqueEmojiName = `${uuidv4()}.${extension}`;
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
            name: uniqueName,
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
async function doesEmojiNameExist(serverId: string, name: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('emojis')
        .select('id')
        .eq('server_id', serverId)
        .eq('name', name);

    if (error) {
        console.error('Error checking emoji name existence:', error);
        throw error;
    }
    return data.length > 0; // Return true if there's at least one row
}

export { uploadEmoji, getEmoji };
