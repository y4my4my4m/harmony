import { open } from 'node:fs/promises'
import { mediaStripPatches, type ByteSource } from './stripMetadata.js'

/**
 * Node-only companions of stripMetadata.ts, which is shared byte for byte with the frontend and
 * federation-backend and so cannot import node:fs.
 */

export type SniffedContainer = 'jpeg' | 'png' | 'webp' | 'gif' | 'isobmff'

/** Type of the first box of an ISOBMFF file, at offset 4. ISOBMFF_FIRST in stripMetadata.ts. */
const ISOBMFF_FIRST = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])

/**
 * The container a file's leading bytes name, by the signatures plan() in stripMetadata.ts
 * dispatches on; null for anything else, and for fewer than 8 bytes. JPEG: FF D8 FF. PNG: 89 'PNG'.
 * WebP: 'RIFF', 4 size bytes, 'WEBP'. GIF: 'GIF8'. ISOBMFF (MP4, MOV, 3GP, HEIF, AVIF, M4A): a
 * first box type in ISOBMFF_FIRST. 12 bytes decide.
 */
export function sniffContainer(head: Uint8Array): SniffedContainer | null {
  if (head.length < 8) return null
  const text = (offset: number, length: number) => Buffer.from(head.subarray(offset, offset + length)).toString('latin1')
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head[0] === 0x89 && text(1, 3) === 'PNG') return 'png'
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'webp'
  if (text(0, 4) === 'GIF8') return 'gif'
  return ISOBMFF_FIRST.has(text(4, 4)) ? 'isobmff' : null
}

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
