import JSZip from 'jszip'
import {
  ALL_ACTION_IDS,
  PACK_FORMAT,
  PACK_MAX_BYTES,
  PACK_VERSION,
  type AudioActionId,
} from './soundSlots'

export interface ThemeMeta {
  id: string
  name: string
  description: string
  author: string
  version: string
}

export type SlotFiles = Partial<Record<AudioActionId, File>>

export interface PackDraft {
  meta: ThemeMeta
  files: SlotFiles
  banner: File | null
}

export interface ParsedManifest {
  meta: ThemeMeta
  soundsMap: Record<string, string>
  bannerFilename?: string
  /** False when format field is missing or not harmony-audio-pack (still imported). */
  formatRecognized: boolean
}

export function defaultMeta(): ThemeMeta {
  return {
    id: 'my-pack',
    name: 'My Sound Pack',
    description: '',
    author: '',
    version: '1.0.0',
  }
}

function slugFromName(name: unknown): string {
  const s = String(name ?? 'imported-pack')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'imported-pack'
}

export function parseManifestJson(text: string): ParsedManifest {
  const manifest = JSON.parse(text) as {
    format?: string
    version?: number
    theme?: {
      id?: string
      name?: string
      description?: string
      author?: string
      version?: string
      sounds?: Record<string, string>
      banner?: string
    }
  }

  const t = manifest.theme
  if (!t || typeof t.sounds !== 'object' || t.sounds === null) {
    throw new Error('Invalid manifest.json: missing theme.sounds')
  }

  const name = String(t.name ?? '').trim() || 'Imported Pack'
  const id = String(t.id ?? '').trim() || slugFromName(name)

  return {
    meta: {
      id,
      name,
      description: String(t.description ?? ''),
      author: String(t.author ?? ''),
      version: String(t.version ?? '').trim() || '1.0.0',
    },
    soundsMap: t.sounds,
    bannerFilename: typeof t.banner === 'string' ? t.banner : undefined,
    formatRecognized: manifest.format === PACK_FORMAT,
  }
}

function zipFindEntry(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  const direct = zip.file(filename)
  if (direct) return direct

  const base = filename.replace(/^.*\//, '')
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path]?.dir) continue
    if (path === base || path.endsWith(`/${base}`)) {
      return zip.file(path)
    }
  }
  return null
}

function extForBlob(blob: Blob): string {
  if (blob.type.includes('ogg')) return 'ogg'
  if (blob.type.includes('wav')) return 'wav'
  if (blob.type.includes('webm')) return 'webm'
  return 'mp3'
}

export async function exportPack(draft: PackDraft): Promise<Blob> {
  const zip = new JSZip()
  const soundsMap: Record<string, string> = {}

  for (const [action, file] of Object.entries(draft.files) as [AudioActionId, File][]) {
    if (!file) continue
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : extForBlob(file)
    const filename = `${action}.${ext}`
    soundsMap[action] = filename
    zip.file(filename, file)
  }

  let bannerFilename: string | undefined
  if (draft.banner) {
    const ext =
      draft.banner.name.split('.').pop()?.toLowerCase() ||
      (draft.banner.type.includes('png') ? 'png' : draft.banner.type.includes('jpeg') ? 'jpg' : 'webp')
    bannerFilename = `banner.${ext}`
    zip.file(bannerFilename, draft.banner)
  }

  const manifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    theme: {
      id: draft.meta.id.trim() || 'my-pack',
      name: draft.meta.name.trim() || 'Untitled Pack',
      description: draft.meta.description,
      author: draft.meta.author,
      version: draft.meta.version || '1.0.0',
      isBuiltIn: false,
      sounds: soundsMap,
      ...(bannerFilename && { banner: bannerFilename }),
    },
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  if (blob.size > PACK_MAX_BYTES) {
    throw new Error(`Pack is ${(blob.size / 1024 / 1024).toFixed(1)}MB (max 10MB)`)
  }
  return blob
}

export async function importPack(zipData: ArrayBuffer): Promise<PackDraft> {
  if (zipData.byteLength > PACK_MAX_BYTES) {
    throw new Error('ZIP exceeds 10MB limit')
  }

  const zip = await JSZip.loadAsync(zipData)

  let manifestEntry: JSZip.JSZipObject | null = zip.file('manifest.json')
  if (!manifestEntry) {
    for (const path of Object.keys(zip.files)) {
      if (!zip.files[path]?.dir && path.endsWith('manifest.json')) {
        manifestEntry = zip.file(path)
        break
      }
    }
  }
  if (!manifestEntry) throw new Error('Missing manifest.json')

  const parsed = parseManifestJson(await manifestEntry.async('string'))
  const files: SlotFiles = {}

  for (const [action, filename] of Object.entries(parsed.soundsMap)) {
    if (!ALL_ACTION_IDS.has(action as AudioActionId)) continue
    const entry = zipFindEntry(zip, filename)
    if (!entry) continue
    const blob = await entry.async('blob')
    files[action as AudioActionId] = new File([blob], filename.replace(/^.*\//, ''), {
      type: blob.type || 'audio/mpeg',
    })
  }

  let banner: File | null = null
  if (parsed.bannerFilename) {
    const bannerEntry = zipFindEntry(zip, parsed.bannerFilename)
    if (bannerEntry) {
      const blob = await bannerEntry.async('blob')
      const name = parsed.bannerFilename.replace(/^.*\//, '')
      banner = new File([blob], name, { type: blob.type || 'image/webp' })
    }
  }

  return {
    meta: parsed.meta,
    files,
    banner,
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
