import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';
import { debug } from '@/utils/debug'
import { validateImageUpload } from '@/utils/uploadValidation'

export interface UploadProgressCallback {
  (progress: number): void;
}

/**
 * Client-side pre-upload gate (BUGS.md H28). The bucket enforces size limits
 * server-side, but without this the user only saw a generic failure after the
 * whole upload - and SVGs (which can embed script and are served from our
 * origin) sailed through with no MIME check at all.
 */
async function validateChatUpload(file: File): Promise<void> {
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) {
        throw new Error('SVG uploads are not allowed (they can contain embedded scripts). Please convert to PNG or WebP.');
    }
    const validationError = await validateImageUpload(file, 'user_media');
    if (validationError) {
        throw new Error(validationError);
    }
}

async function handleFileDrop(userId: string, file: any) {
    try {
        await validateChatUpload(file);
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

        debug.log(data);

        return data.publicUrl; // Return the public URL of the uploaded file
    } catch (error) {
        debug.error('Error uploading file:', error);
        return null;
    }
}

async function handleFileUploadWithProgress(
    userId: string, 
    file: File, 
    onProgress?: UploadProgressCallback
): Promise<string | null> {
    try {
        await validateChatUpload(file);
        // Generate a unique filename
        const uniqueFileName = `${uuidv4()}.${file.name.split('.').pop()}`;
        const filePath = `${userId}/${uniqueFileName}`;

        // Create a progress tracking wrapper
        let uploadedBytes = 0;
        const totalBytes = file.size;

        // Simulate progress for now (Supabase doesn't provide native progress callbacks)
        const progressInterval = setInterval(() => {
            if (onProgress && uploadedBytes < totalBytes) {
                uploadedBytes = Math.min(uploadedBytes + (totalBytes * 0.1), totalBytes * 0.9);
                const progress = (uploadedBytes / totalBytes) * 100;
                onProgress(progress);
            }
        }, 200);

        // Upload the file
        const { error } = await supabase.storage
            .from('user_media')
            .upload(filePath, file);

        clearInterval(progressInterval);

        if (error) {
            if (onProgress) onProgress(0);
            throw error;
        }

        // Complete the progress
        if (onProgress) onProgress(100);

        // Get public URL
        const { data } = await supabase.storage
            .from('user_media')
            .getPublicUrl(filePath);

        return data.publicUrl;
    } catch (error) {
        debug.error('Error uploading file:', error);
        if (onProgress) onProgress(0);
        throw error;
    }
}

// Background upload manager
class BackgroundUploadManager {
    private uploads = new Map<string, Promise<string | null>>();
    private callbacks = new Map<string, UploadProgressCallback>();

    async startUpload(
        uploadId: string,
        userId: string,
        file: File,
        onProgress?: UploadProgressCallback
    ): Promise<string | null> {
        if (onProgress) {
            this.callbacks.set(uploadId, onProgress);
        }

        const uploadPromise = handleFileUploadWithProgress(
            userId,
            file,
            (progress) => {
                const callback = this.callbacks.get(uploadId);
                if (callback) callback(progress);
            }
        ).finally(() => {
            this.uploads.delete(uploadId);
            this.callbacks.delete(uploadId);
        });

        this.uploads.set(uploadId, uploadPromise);
        return uploadPromise;
    }

    cancelUpload(uploadId: string): void {
        this.uploads.delete(uploadId);
        this.callbacks.delete(uploadId);
    }

    hasActiveUploads(): boolean {
        return this.uploads.size > 0;
    }

    getActiveUploadCount(): number {
        return this.uploads.size;
    }
}

export const backgroundUploadManager = new BackgroundUploadManager();

export { handleFileDrop, handleFileUploadWithProgress };