import { supabase } from '@/supabase'

/**
 * uploadStorageObject (services/uploads/storageUpload.ts) answered by the test's
 * `supabase.storage.from(bucket).upload` mock, with the options supabase-js upload takes.
 */
export async function uploadThroughStorageMock(
  bucket: string,
  path: string,
  file: Blob,
  options: { contentType?: string; cacheControl?: string; upsert?: boolean } = {},
) {
  const passed = Object.fromEntries(
    Object.entries({ contentType: options.contentType, cacheControl: options.cacheControl, upsert: options.upsert })
      .filter(([, value]) => value !== undefined),
  )
  return supabase.storage.from(bucket).upload(path, file, passed)
}
