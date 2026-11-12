import { open } from 'node:fs/promises'
import { mediaStripPatches, type ByteSource } from './stripMetadata.js'

/**
 * Node-only companions of stripMetadata.ts, which is shared byte for byte with the frontend and
 * federation-backend and so cannot import node:fs.
 */

/** A file on disk as a ByteSource; every read returns fresh bytes. */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    return {
      size,
      read: async (start, end) => {
        const buffer = Buffer.alloc(Math.max(0, end - start))
        let filled = 0
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        return buffer.subarray(0, filled)
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Strips an ISOBMFF file (MP4, MOV, 3GP) on disk by overwriting its metadata boxes in place, as
 * `free` boxes of the same size; no byte moves and the file is never held whole. True when bytes
 * changed.
 */
export async function stripMediaFileInPlace(path: string): Promise<boolean> {
  const source = await fileSource(path)
  let patches
  try {
    patches = await mediaStripPatches(source)
  } finally {
    await source.close()
  }
  if (!patches) return false
  const handle = await open(path, 'r+')
  try {
    for (const { at, bytes } of patches) await handle.write(bytes, 0, bytes.length, at)
  } finally {
    await handle.close()
  }
  return true
}
