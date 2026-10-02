import { supabase } from '@/supabase';
import { debug } from '@/utils/debug'
import { getBucketLimits, imageSourceError, validateImageUpload, humanizeUploadError } from '@/utils/uploadValidation'
import {
  immutableObjectPath,
  immutableUploadOptions,
  prepareImageUpload,
  type ImageUploadKind,
} from '@/utils/imageResize'

export interface UploadResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  apng: 'image/apng',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
};

export function getMimeTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return EXTENSION_MIME[ext] || 'application/octet-stream';
}

/**
 * Uploads an image to `bucket` under a new `<folder>/<stem>-<ms>.<ext>` name;
 * existing objects are never overwritten. The file goes up as picked unless it
 * exceeds the bucket's limits (see prepareImageUpload).
 */
export async function uploadImageObject(
  file: File,
  kind: ImageUploadKind,
  bucket: string,
  folder: string,
  stem: string
): Promise<UploadResult> {
  try {
    const sourceError = imageSourceError(file);
    if (sourceError) {
      return { success: false, error: sourceError };
    }
    const prepared = await prepareImageUpload(file, kind, await getBucketLimits(bucket));
    const validationError = await validateImageUpload(prepared.file, bucket);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const path = immutableObjectPath(folder, stem, prepared.extension);
    debug.log(`Uploading ${bucket}/${path} (${file.size} -> ${prepared.file.size} bytes)`);

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, prepared.file, immutableUploadOptions(prepared));

    if (error) {
      debug.error('Upload error:', error);
      return { success: false, path, error: humanizeUploadError(error, bucket) };
    }

    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(data.path);

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

// Avatar upload lives here rather than in ProfileService.ts.
export function uploadAvatar(file: File, userId: string): Promise<UploadResult> {
  return uploadImageObject(file, 'avatar', 'avatars', userId, 'avatar');
}

export function uploadServerIcon(file: File, serverId: string): Promise<UploadResult> {
  return uploadImageObject(file, 'server_icon', 'server_icons', serverId, 'icon');
}

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
      const urlExt = imageUrl.split('.').pop()?.split('?')[0]?.toLowerCase();
      if (urlExt && ['png', 'gif', 'webp', 'jpg', 'jpeg'].includes(urlExt)) {
        fileExt = urlExt === 'jpeg' ? 'jpg' : urlExt;
      }
    }

    const fileName = `${type}_${Date.now()}.${fileExt}`;
    const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });

    if (type === 'avatar') {
      return await uploadAvatar(file, userId);
    } else {
      // Dynamic import breaks a circular import with bannerUtils.
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