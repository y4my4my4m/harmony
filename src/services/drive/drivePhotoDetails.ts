import type { DriveFile } from '@/services/drive/driveService'
import { storedObjectBytes } from '@/services/privateMedia'
import { isPhotoOrVideo, readSourceDetails, type MediaDetails } from '@/utils/stripMetadata'

export type DrivePhotoFile = Pick<DriveFile, 'bucket' | 'path' | 'name' | 'mime_type' | 'size_bytes' | 'photo_details' | 'photo_location'>

/** A file whose details could not be read: treated as carrying some, without a known location. */
const UNREAD: MediaDetails = { container: null, location: false, details: true }

/**
 * What a Drive photo's or video's stored bytes carry: the upload's record
 * (drive_files.photo_details), else, for files uploaded before it, the object itself read by
 * range (a video's box headers and moov, an image whole). Null for other files and for post media,
 * which is public already.
 */
export async function driveFileDetails(file: DrivePhotoFile): Promise<MediaDetails | null> {
  if (file.bucket !== 'message_media') return null
  if (!isPhotoOrVideo({ type: file.mime_type ?? undefined, name: file.name ?? file.path })) return null
  if (file.photo_details) {
    const kept = file.photo_details === 'kept'
    return { container: null, location: kept && !!file.photo_location, details: kept }
  }
  try {
    const details = await readSourceDetails(storedObjectBytes(file.path, file.size_bytes))
    return details.container ? details : null
  } catch {
    return UNREAD
  }
}
