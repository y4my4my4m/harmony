import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'

export interface UploadResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

/**
 * Upload a file to Supabase storage
 * @param file The file to upload
 * @param bucket The storage bucket name
 * @param path The file path in the bucket
 * @returns Promise<UploadResult>
 */
export async function uploadFile(
  file: File,
  bucket: string,
  path: string
): Promise<UploadResult> {
  try {
    // Check file size (5MB limit)
    if (file.size > 5 * 1024 * 1024) {
      return {
        success: false,
        error: 'File size must be less than 5MB'
      };
    }

    // Check file type
    if (!file.type.startsWith('image/')) {
      return {
        success: false,
        error: 'Only image files are allowed'
      };
    }

    debug.log(`Uploading file to ${bucket}/${path}...`);

    // Upload file to Supabase storage
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: true // Allow overwriting existing files (e.g., avatar updates)
      });

    if (error) {
      debug.error('Upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(data.path);

    debug.log(`File uploaded successfully: ${urlData.publicUrl}`);

    return {
      success: true,
      url: urlData.publicUrl,
      path: data.path
    };
  } catch (error: any) {
    debug.error('Upload error:', error);
    return {
      success: false,
      error: error.message || 'Upload failed'
    };
  }
}

/**
 * Upload user avatar
 * @param file The avatar file
 * @param userId The user ID
 * @returns Promise<UploadResult>
 */
// TODO: profileService.ts should handle avatar uploads, not this file
export async function uploadAvatar(file: File, userId: string): Promise<UploadResult> {
  // const fileExt = file.name.split('.').pop() || 'jpg';
  // Let Supabase auto-generate the UUID, just provide the folder structure
  const filePath = `${userId}/${file.name}`;

  const processedFile: UploadResult = await uploadFile(file, 'avatars', filePath);
  if (!processedFile.success) {
    processedFile.path = filePath; // Include path even if upload failed
  }
  return processedFile;
}

/**
 * Upload server icon
 * @param file The icon file
 * @param serverId The server ID
 * @returns Promise<UploadResult>
 */
export async function uploadServerIcon(file: File, serverId: string): Promise<UploadResult> {
  const fileExt = file.name.split('.').pop() || 'jpg';
  // Let Supabase auto-generate the UUID, just provide the folder structure
  const filePath = `${serverId}/icon.${fileExt}`;
  
  return uploadFile(file, 'server_icons', filePath);
}

/**
 * Delete a file from storage
 * @param bucket The storage bucket name
 * @param path The file path
 * @returns Promise<boolean>
 */
export async function deleteFile(bucket: string, path: string): Promise<boolean> {
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([path]);

    if (error) {
      debug.error('Delete error:', error);
      return false;
    }

    return true;
  } catch (error) {
    debug.error('Delete error:', error);
    return false;
  }
}