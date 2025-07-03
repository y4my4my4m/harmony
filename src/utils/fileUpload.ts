import { supabase } from '@/supabase';

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

    console.log(`Uploading file to ${bucket}/${path}...`);

    // Upload file to Supabase storage (Supabase will auto-generate UUID if needed)
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false // Don't overwrite, let Supabase handle unique naming
      });

    if (error) {
      console.error('Upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(data.path);

    console.log(`File uploaded successfully: ${urlData.publicUrl}`);

    return {
      success: true,
      url: urlData.publicUrl,
      path: data.path
    };
  } catch (error: any) {
    console.error('Upload error:', error);
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
export async function uploadAvatar(file: File, userId: string): Promise<UploadResult> {
  const fileExt = file.name.split('.').pop() || 'jpg';
  // Let Supabase auto-generate the UUID, just provide the folder structure
  const filePath = `${userId}/avatar.${fileExt}`;
  
  return uploadFile(file, 'avatars', filePath);
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
      console.error('Delete error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Delete error:', error);
    return false;
  }
}