import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';

async function handleFileDrop(userId: string, file: any) {
    try {
        // Generate a unique filename
        const uniqueFileName = `${uuidv4()}.${file.name.split('.').pop()}`;
        const filePath = `${userId}/${uniqueFileName}`;

        // Upload the file
        const { error } = await supabase.storage
        .from('user_media')
        .upload(filePath, file);

        if (error) throw error;

        // Get public URL
        const { data } = await supabase.storage
        .from('user_media')
        .getPublicUrl(filePath);

        // TODO: error handling?
        // if (urlError) throw urlError;

        console.log(data);

        return data.publicUrl; // Return the public URL of the uploaded file
    } catch (error) {
        console.error('Error uploading file:', error);
        return null;
    }
}

export { handleFileDrop };