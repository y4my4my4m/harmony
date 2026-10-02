import { debug } from '@/utils/debug'
import { validateImageUpload } from '@/utils/uploadValidation'
import { uploadMessageMedia, type UploadedMessageMedia } from '@/services/privateMedia'

export interface UploadProgressCallback {
  (progress: number): void;
}

/**
 * Client-side pre-upload gate (BUGS.md H28). The bucket enforces size limits
 * server-side, but only after the whole upload. SVGs are rejected here: they can
 * embed script.
 */
async function validateChatUpload(file: File): Promise<void> {
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) {
        throw new Error('SVG uploads are not allowed (they can contain embedded scripts). Please convert to PNG or WebP.');
    }
    const validationError = await validateImageUpload(file, 'message_media');
    if (validationError) {
        throw new Error(validationError);
    }
}

/** Uploads a chat attachment into `room` (see privateMedia.ts). */
async function handleFileUploadWithProgress(
    userId: string,
    file: File,
    room: string | null,
    onProgress?: UploadProgressCallback
): Promise<UploadedMessageMedia> {
    try {
        await validateChatUpload(file);
        if (!room) throw new Error('Attachments need a channel or conversation');

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

        let uploaded: UploadedMessageMedia;
        try {
            uploaded = await uploadMessageMedia(room, userId, file, { fileName: file.name });
        } finally {
            clearInterval(progressInterval);
        }

        if (onProgress) onProgress(100);
        return uploaded;
    } catch (error) {
        debug.error('Error uploading file:', error);
        if (onProgress) onProgress(0);
        throw error;
    }
}

// Background upload manager
class BackgroundUploadManager {
    private uploads = new Map<string, Promise<UploadedMessageMedia | null>>();
    private callbacks = new Map<string, UploadProgressCallback>();

    async startUpload(
        uploadId: string,
        userId: string,
        file: File,
        room: string | null,
        onProgress?: UploadProgressCallback
    ): Promise<UploadedMessageMedia | null> {
        if (onProgress) {
            this.callbacks.set(uploadId, onProgress);
        }

        const uploadPromise = handleFileUploadWithProgress(
            userId,
            file,
            room,
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

export { handleFileUploadWithProgress };
