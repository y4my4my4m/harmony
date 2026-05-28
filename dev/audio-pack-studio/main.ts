import {
  ALL_ACTION_IDS,
  CATEGORY_LABELS,
  matchFilenameToAction,
  PACK_MAX_BYTES,
  SOUND_SLOTS,
  type AudioActionId,
  type SoundCategory,
} from './soundSlots'
import {
  defaultMeta,
  downloadBlob,
  exportPack,
  importPack,
  parseManifestJson,
  type PackDraft,
} from './packIo'

const STORAGE_KEY = 'harmony-audio-pack-studio-draft-v1'

let draft: PackDraft = {
  meta: defaultMeta(),
  files: {},
  banner: null,
}

const previewUrls = new Map<AudioActionId, string>()
let bannerPreviewUrl: string | null = null
let statusMessage = ''
let statusError = false

const app = document.getElementById('app')!
const audio = new Audio()

function fileBasename(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  const path = rel || file.name
  return path.split('/').pop() || file.name
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|ogg|wav|webm|m4a|flac)$/i.test(file.name)
}

function isBannerImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(webp|png|jpe?g|gif)$/i.test(file.name)
}

function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'my-pack'
  )
}

function revokePreview(id: AudioActionId): void {
  const url = previewUrls.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    previewUrls.delete(id)
  }
}

function clearAllSounds(): void {
  for (const slot of SOUND_SLOTS) revokePreview(slot.id)
  draft.files = {}
}

function clearBanner(): void {
  if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl)
  bannerPreviewUrl = null
  draft.banner = null
}

function assignSlotFile(id: AudioActionId, file: File): void {
  revokePreview(id)
  draft.files[id] = file
  previewUrls.set(id, URL.createObjectURL(file))
}

function applyDraftToUi(next: PackDraft): void {
  previewUrls.forEach((u) => URL.revokeObjectURL(u))
  previewUrls.clear()
  if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl)
  bannerPreviewUrl = null

  draft = next
  for (const [id, f] of Object.entries(draft.files) as [AudioActionId, File][]) {
    if (f) previewUrls.set(id, URL.createObjectURL(f))
  }
  if (draft.banner) bannerPreviewUrl = URL.createObjectURL(draft.banner)
}

function setSlotFile(id: AudioActionId, file: File | null): void {
  if (file) assignSlotFile(id, file)
  else {
    revokePreview(id)
    delete draft.files[id]
  }
  render()
}

function firstAudioFromDataTransfer(dt: DataTransfer): File | null {
  return Array.from(dt.files).find(isAudioFile) ?? null
}

function assignAudioToSlot(slotId: AudioActionId, file: File): void {
  if (!isAudioFile(file)) {
    statusMessage = `Not an audio file: ${file.name}`
    statusError = true
    render()
    return
  }
  assignSlotFile(slotId, file)
  statusMessage = `Assigned ${file.name} → ${slotId}`
  statusError = false
  render()
}

function setBanner(file: File | null): void {
  clearBanner()
  if (file) {
    draft.banner = file
    bannerPreviewUrl = URL.createObjectURL(file)
  }
  render()
}

function filesByBasename(files: File[]): Map<string, File> {
  const map = new Map<string, File>()
  for (const f of files) {
    map.set(fileBasename(f), f)
  }
  return map
}

/**
 * @param replace When true (folder import), clear existing sounds/banner first so only
 *                files from this import remain — autofill defaults won't stick around.
 */
async function importFromFileList(
  files: FileList | File[],
  options: { replace: boolean },
): Promise<{ matched: number; skipped: string[]; metaFromManifest: boolean }> {
  const fileArr = Array.from(files)
  let matched = 0
  const skipped: string[] = []
  let metaFromManifest = false

  if (options.replace) {
    clearAllSounds()
    clearBanner()
  }

  const byBase = filesByBasename(fileArr)
  const manifestFile = fileArr.find((f) => fileBasename(f) === 'manifest.json')

  let manifestSounds: Record<string, string> | null = null
  let manifestBanner: string | undefined

  if (manifestFile) {
    try {
      const parsed = parseManifestJson(await manifestFile.text())
      draft.meta = parsed.meta
      manifestSounds = parsed.soundsMap
      manifestBanner = parsed.bannerFilename
      metaFromManifest = true
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Could not parse manifest.json')
    }
  }

  const assigned = new Set<AudioActionId>()

  if (manifestSounds) {
    for (const [action, filename] of Object.entries(manifestSounds)) {
      if (!ALL_ACTION_IDS.has(action as AudioActionId)) continue
      const base = filename.replace(/^.*\//, '')
      const file = byBase.get(base)
      if (!file || !isAudioFile(file)) continue
      assignSlotFile(action as AudioActionId, file)
      assigned.add(action as AudioActionId)
      matched++
    }
  }

  if (manifestBanner) {
    const bannerBase = manifestBanner.replace(/^.*\//, '')
    const bannerFile = byBase.get(bannerBase)
    if (bannerFile && isBannerImage(bannerFile)) {
      draft.banner = bannerFile
      bannerPreviewUrl = URL.createObjectURL(bannerFile)
      matched++
    }
  }

  for (const file of fileArr) {
    if (file === manifestFile) continue

    if (isBannerImage(file) && /banner|preview/i.test(fileBasename(file))) {
      if (!draft.banner) {
        draft.banner = file
        bannerPreviewUrl = URL.createObjectURL(file)
        matched++
      }
      continue
    }

    if (!isAudioFile(file)) {
      if (fileBasename(file) !== 'manifest.json') skipped.push(fileBasename(file))
      continue
    }

    const action = matchFilenameToAction(fileBasename(file))
    if (!action) {
      skipped.push(fileBasename(file))
      continue
    }

    if (assigned.has(action)) continue

    assignSlotFile(action, file)
    assigned.add(action)
    matched++
  }

  return { matched, skipped, metaFromManifest }
}

function estimatedPackBytes(): number {
  let total = 512
  for (const f of Object.values(draft.files)) {
    if (f) total += f.size
  }
  if (draft.banner) total += draft.banner.size
  return total
}

function saveDraftToStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ meta: draft.meta }))
  } catch {
    /* ignore quota */
  }
}

function loadDraftMetaFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { meta?: PackDraft['meta'] }
    if (parsed.meta) draft.meta = { ...defaultMeta(), ...parsed.meta }
  } catch {
    /* ignore */
  }
}

function syncMetaFormFromDraft(): void {
  const set = (elementId: string, value: string) => {
    const el = document.getElementById(elementId) as HTMLInputElement | HTMLTextAreaElement | null
    if (el) el.value = value
  }
  set('meta-id', draft.meta.id)
  set('meta-name', draft.meta.name)
  set('meta-desc', draft.meta.description)
  set('meta-author', draft.meta.author)
  set('meta-version', draft.meta.version)
}

async function handleExport(): Promise<void> {
  statusMessage = ''
  statusError = false
  try {
    const blob = await exportPack(draft)
    const safeName = slugId(draft.meta.name)
    downloadBlob(blob, `${safeName}.zip`)
    statusMessage = `Exported ${safeName}.zip (${(blob.size / 1024).toFixed(0)} KB)`
  } catch (e) {
    statusMessage = e instanceof Error ? e.message : 'Export failed'
    statusError = true
  }
  render()
}

async function handleImportZip(file: File): Promise<void> {
  statusMessage = ''
  try {
    applyDraftToUi(await importPack(await file.arrayBuffer()))
    statusMessage = `Loaded pack “${draft.meta.name}” (${draft.meta.id})`
    statusError = false
  } catch (e) {
    statusMessage = e instanceof Error ? e.message : 'Import failed'
    statusError = true
  }
  render()
}

function playSlot(id: AudioActionId): void {
  const url = previewUrls.get(id)
  if (!url) return
  audio.pause()
  audio.src = url
  void audio.play()
}

function renderMetaForm(): string {
  const m = draft.meta
  return `
    <h2>Theme</h2>
    <label for="meta-id">ID (slug)</label>
    <input type="text" id="meta-id" value="${escapeAttr(m.id)}" />
    <label for="meta-name">Name</label>
    <input type="text" id="meta-name" value="${escapeAttr(m.name)}" />
    <label for="meta-desc">Description</label>
    <textarea id="meta-desc">${escapeHtml(m.description)}</textarea>
    <label for="meta-author">Author</label>
    <input type="text" id="meta-author" value="${escapeAttr(m.author)}" />
    <label for="meta-version">Version</label>
    <input type="text" id="meta-version" value="${escapeAttr(m.version)}" />
    <h2>Banner (optional)</h2>
    ${bannerPreviewUrl ? `<img class="banner-preview" src="${bannerPreviewUrl}" alt="Banner preview" />` : ''}
    <div class="toolbar">
      <label class="file-btn">Choose image<input type="file" class="hidden-input" accept="image/*" data-banner /></label>
      ${draft.banner ? `<button type="button" data-clear-banner>Remove</button>` : ''}
    </div>
  `
}

function renderSlots(): string {
  const byCategory = new Map<SoundCategory, typeof SOUND_SLOTS>()
  for (const slot of SOUND_SLOTS) {
    const list = byCategory.get(slot.category) ?? []
    list.push(slot)
    byCategory.set(slot.category, list)
  }

  let html = ''
  for (const category of Object.keys(CATEGORY_LABELS) as SoundCategory[]) {
    const slots = byCategory.get(category)
    if (!slots?.length) continue
    html += `<section class="category"><h3>${CATEGORY_LABELS[category]}</h3>`
    for (const slot of slots) {
      const file = draft.files[slot.id]
      const mapped = !!file
      html += `
        <div class="slot ${mapped ? 'mapped' : ''}" data-slot="${slot.id}">
          <div class="slot-info">
            <div class="label">${escapeHtml(slot.label)}</div>
            <div class="id">${slot.id}</div>
            <div class="hint">${escapeHtml(slot.hint)} · export as <code>${slot.exportName}</code></div>
            ${file ? `<div class="filename">${escapeHtml(file.name)} (${formatBytes(file.size)})</div>` : ''}
          </div>
          <div class="slot-actions">
            <label class="file-btn slot-drop" data-slot-drop="${slot.id}" title="Choose or drop an audio file">File<input type="file" class="hidden-input" accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a" data-slot-file="${slot.id}" /></label>
            <button type="button" data-play="${slot.id}" ${mapped ? '' : 'disabled'}>▶</button>
            <button type="button" data-clear="${slot.id}" ${mapped ? '' : 'disabled'}>Clear</button>
          </div>
        </div>`
    }
    html += `</section>`
  }
  return html
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

function render(): void {
  const mapped = Object.keys(draft.files).length
  const total = SOUND_SLOTS.length
  const est = estimatedPackBytes()

  app.innerHTML = `
    <header>
      <h1>Harmony Audio Pack Studio</h1>
      <p>Map each notification / UI sound to a file, preview, and export a <code>.zip</code> for Settings → Audio themes.</p>
    </header>
    <div class="layout">
      <aside class="panel sidebar">
        ${renderMetaForm()}
        <h2>Pack</h2>
        <div class="drop-zone" data-drop-zone>
          Drop audio files here (merges into current slots)<br />
          <span style="font-size:0.78rem"><code>manifest.json</code> in folder updates name / author / description</span>
        </div>
        <div class="toolbar">
          <label class="file-btn" title="Replaces all sounds; reads manifest.json for theme fields">Import folder<input type="file" class="hidden-input" multiple webkitdirectory data-folder /></label>
          <label class="file-btn" title="Adds or overwrites matching slots only">Import files<input type="file" class="hidden-input" multiple accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a" data-files /></label>
          <label class="file-btn">Open .zip<input type="file" class="hidden-input" accept=".zip,application/zip" data-zip /></label>
        </div>
        <div class="toolbar">
          <button type="button" class="primary" data-export>Export .zip</button>
          <button type="button" data-fill-missing>Use built-in default sounds for gaps</button>
        </div>
        <p class="stats"><strong>${mapped}</strong> / ${total} sounds · ~${formatBytes(est)} / ${formatBytes(PACK_MAX_BYTES)} max</p>
      </aside>
      <main class="panel slots-panel">
        <div class="toolbar">
          <button type="button" data-play-all>Mapped sounds A→Z</button>
          <button type="button" data-clear-all>Clear all sounds</button>
        </div>
        ${renderSlots()}
      </main>
    </div>
    <div class="status-bar ${statusError ? 'error' : statusMessage ? 'ok' : ''}">${escapeHtml(statusMessage || 'Ready')}</div>
  `

  bindEvents()
  syncMetaFormFromDraft()
  saveDraftToStorage()
}

function bindEvents(): void {
  const bindMeta = (elementId: string, metaKey: keyof PackDraft['meta']) => {
    const el = document.getElementById(elementId) as HTMLInputElement | HTMLTextAreaElement | null
    el?.addEventListener('input', () => {
      draft.meta[metaKey] = el.value
      if (metaKey === 'name' && document.activeElement?.id !== 'meta-id') {
        draft.meta.id = slugId(el.value)
        const idInput = document.getElementById('meta-id') as HTMLInputElement | null
        if (idInput) idInput.value = draft.meta.id
      }
      saveDraftToStorage()
    })
  }
  bindMeta('meta-id', 'id')
  bindMeta('meta-name', 'name')
  bindMeta('meta-desc', 'description')
  bindMeta('meta-author', 'author')
  bindMeta('meta-version', 'version')

  document.querySelector('[data-banner]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) setBanner(file)
    ;(e.target as HTMLInputElement).value = ''
  })
  document.querySelector('[data-clear-banner]')?.addEventListener('click', () => setBanner(null))

  document.querySelector('[data-export]')?.addEventListener('click', () => void handleExport())

  document.querySelector('[data-zip]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void handleImportZip(file)
    ;(e.target as HTMLInputElement).value = ''
  })

  for (const input of document.querySelectorAll<HTMLInputElement>('[data-slot-file]')) {
    input.addEventListener('change', () => {
      const id = input.dataset.slotFile as AudioActionId
      const file = input.files?.[0]
      if (file) assignAudioToSlot(id, file)
      input.value = ''
    })
  }

  for (const dropTarget of document.querySelectorAll<HTMLElement>('[data-slot-drop]')) {
    const slotId = dropTarget.dataset.slotDrop as AudioActionId

    dropTarget.addEventListener('dragenter', (e) => {
      e.preventDefault()
      dropTarget.classList.add('dragover')
    })
    dropTarget.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      dropTarget.classList.add('dragover')
    })
    dropTarget.addEventListener('dragleave', (e) => {
      if (e.currentTarget === dropTarget && !dropTarget.contains(e.relatedTarget as Node)) {
        dropTarget.classList.remove('dragover')
      }
    })
    dropTarget.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      dropTarget.classList.remove('dragover')
      const dt = e.dataTransfer
      if (!dt) return
      const file = firstAudioFromDataTransfer(dt)
      if (file) assignAudioToSlot(slotId, file)
      else {
        statusMessage = 'Drop an audio file (.mp3, .ogg, .wav, …)'
        statusError = true
        render()
      }
    })
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-play]')) {
    btn.addEventListener('click', () => playSlot(btn.dataset.play as AudioActionId))
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-clear]')) {
    btn.addEventListener('click', () => setSlotFile(btn.dataset.clear as AudioActionId, null))
  }

  const runBulkImport = async (files: FileList | null, replace: boolean) => {
    if (!files?.length) return
    try {
      const { matched, skipped, metaFromManifest } = await importFromFileList(files, { replace })
      const parts: string[] = []
      if (replace) parts.push('Replaced pack sounds')
      if (metaFromManifest) parts.push(`theme: ${draft.meta.name}`)
      parts.push(`${matched} file(s) mapped`)
      if (skipped.length) {
        parts.push(
          `skipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` (+${skipped.length - 5})` : ''}`,
        )
      }
      statusMessage = parts.join(' · ')
      statusError = matched === 0 && !metaFromManifest
    } catch (e) {
      statusMessage = e instanceof Error ? e.message : 'Import failed'
      statusError = true
    }
    render()
  }

  document.querySelector('[data-folder]')?.addEventListener('change', (e) => {
    void runBulkImport((e.target as HTMLInputElement).files, true)
    ;(e.target as HTMLInputElement).value = ''
  })
  document.querySelector('[data-files]')?.addEventListener('change', (e) => {
    void runBulkImport((e.target as HTMLInputElement).files, false)
    ;(e.target as HTMLInputElement).value = ''
  })

  const dropZone = document.querySelector('[data-drop-zone]')
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropZone.classList.add('dragover')
  })
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.classList.remove('dragover')
    void runBulkImport(e.dataTransfer?.files ?? null, false)
  })

  document.querySelector('[data-clear-all]')?.addEventListener('click', () => {
    clearAllSounds()
    statusMessage = 'Cleared all sounds'
    statusError = false
    render()
  })

  document.querySelector('[data-play-all]')?.addEventListener('click', async () => {
    for (const slot of SOUND_SLOTS) {
      if (!draft.files[slot.id]) continue
      playSlot(slot.id)
      await new Promise((r) => {
        audio.onended = () => r(undefined)
        audio.onerror = () => r(undefined)
        setTimeout(r, 2000)
      })
    }
  })

  document.querySelector('[data-fill-missing]')?.addEventListener('click', async () => {
    statusMessage = 'Loading built-in default sounds for empty slots…'
    statusError = false
    render()

    let filled = 0
    for (const slot of SOUND_SLOTS) {
      if (draft.files[slot.id]) continue
      const candidates = [
        `/assets/sounds/default/${slot.id}.mp3`,
        `/assets/sounds/default/${slot.exportName}`,
      ]
      if (slot.id === 'server_invite') candidates.unshift('/assets/sounds/default/invite.mp3')
      if (slot.id === 'friend_request') candidates.unshift('/assets/sounds/default/request.mp3')
      if (slot.id === 'server_update') candidates.unshift('/assets/sounds/default/update.mp3')
      if (slot.id === 'emoji_added') candidates.unshift('/assets/sounds/default/new.mp3')
      if (slot.id === 'voice_channel_activity') candidates.unshift('/assets/sounds/default/connect.mp3')
      if (slot.id === 'ui_click') candidates.unshift('/assets/sounds/default/click.mp3')
      if (slot.id === 'ui_hover') candidates.unshift('/assets/sounds/default/hover.mp3')
      if (slot.id === 'ui_success') candidates.unshift('/assets/sounds/default/success.mp3')
      if (slot.id === 'ui_error') candidates.unshift('/assets/sounds/default/error.mp3')
      if (slot.id === 'ui_notification') candidates.unshift('/assets/sounds/default/notification.mp3')

      for (const path of candidates) {
        try {
          const res = await fetch(path)
          if (!res.ok) continue
          const blob = await res.blob()
          assignSlotFile(slot.id, new File([blob], `${slot.id}.mp3`, { type: blob.type || 'audio/mpeg' }))
          filled++
          break
        } catch {
          /* try next */
        }
      }
    }

    statusMessage = filled
      ? `Filled ${filled} empty slot(s) from built-in default pack`
      : 'Could not load defaults (run from repo: npm run dev:audio-pack)'
    statusError = !filled
    render()
  })
}

loadDraftMetaFromStorage()
render()
