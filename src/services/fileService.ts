import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';
import { debug } from '@/utils/debug'
import { validateImageUpload } from '@/utils/uploadValidation'

export interface UploadProgressCallback {
  (progress: number): void;
}

/**
 * Client-side pre-upload gate (BUGS.md H28). The bucket enforces size limits
 * server-side, but only after the whole upload, and applies no MIME check.
 * SVGs are rejected here: they can embed script and are served same-origin.
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
        const uniqueFileName = `${uuidv4()}.${file.name.split('.').pop()}`;
        const filePath = `${userId}/${uniqueFileName}`;

        const { error } = await supabase.storage
        .from('user_media')
        .upload(filePath, file);

        if (error) throw error;

        const { data } = await supabase.storage
        .from('user_media')
        .getPublicUrl(filePath);

        debug.log(data);

        return data.publicUrl;
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
        const uniqueFileName = `${uuidv4()}.${file.name.split('.').pop()}`;
        const filePath = `${userId}/${uniqueFileName}`;

        let uploadedBytes = 0;
        const totalBytes = file.size;

        // Synthetic progress; Supabase exposes no upload progress callback.
        const progressInterval = setInterval(() => {
            if (onProgress && uploadedBytes < totalBytes) {
                uploadedBytes = Math.min(uploadedBytes + (totalBytes * 0.1), totalBytes * 0.9);
                const progress = (uploadedBytes / totalBytes) * 100;
                onProgress(progress);
            }
        }, 200);

        const { error } = await supabase.storage
            .from('user_media')
            .upload(filePath, file);

        clearInterval(progressInterval);

        if (error) {
            if (onProgress) onProgress(0);
            throw error;
        }

        if (onProgress) onProgress(100);

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