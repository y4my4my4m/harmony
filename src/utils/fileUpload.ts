import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'
import { validateImageUpload, humanizeUploadError } from '@/utils/uploadValidation'

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
    // Validate against the bucket's real size/type limits so the user gets a
    // precise reason (e.g. "too large - max 2 MB") instead of a generic failure.
    const validationError = await validateImageUpload(file, bucket);
    if (validationError) {
      return { success: false, error: validationError };
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
        error: humanizeUploadError(error, bucket)
      };
    }

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
      error: humanizeUploadError(error, bucket)
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
 * Download an image from a URL and upload it to Supabase storage
 * @param imageUrl The URL of the image to download
 * @param userId The user ID
 * @param type 'avatar' or 'banner'
 * @returns Promise<UploadResult>
 */
export async function downloadAndUploadImage(
  imageUrl: string,
  userId: string,
  type: 'avatar' | 'banner' = 'avatar'
): Promise<UploadResult> {
  try {
    debug.log(`Downloading ${type} from ${imageUrl}...`);
    
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const blob = await response.blob();
    
    let fileExt = 'jpg';
    if (blob.type) {
      if (blob.type.includes('png')) fileExt = 'png';
      else if (blob.type.includes('gif')) fileExt = 'gif';
      else if (blob.type.includes('webp')) fileExt = 'webp';
    } else {
      // Try to get extension from URL
      const urlExt = imageUrl.split('.').pop()?.split('?')[0]?.toLowerCase();
      if (urlExt && ['png', 'gif', 'webp', 'jpg', 'jpeg'].includes(urlExt)) {
        fileExt = urlExt === 'jpeg' ? 'jpg' : urlExt;
      }
    }

    const fileName = `${type}_${Date.now()}.${fileExt}`;
    const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });

    // Upload to Supabase storage
    if (type === 'avatar') {
      return await uploadAvatar(file, userId);
    } else {
      // Import uploadBanner dynamically to avoid circular imports
      const { uploadBanner } = await import('@/utils/bannerUtils');
      const result = await uploadBanner(file, userId);
      return {
        success: result.success,
        url: result.url,
        error: result.error
      };
    }
  } catch (error: any) {
    debug.error(`Failed to download and upload ${type}:`, error);
    return {
      success: false,
      error: error.message || `Failed to download and upload ${type}`
    };
  }
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