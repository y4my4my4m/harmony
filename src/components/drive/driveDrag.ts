/** Drag payload of Drive items: files and folders moved between folders. */
export interface DriveDragPayload {
  files: string[]
  folders: string[]
}

export const DRIVE_DRAG_TYPE = 'application/x-harmony-drive'

export function writeDriveDrag(event: DragEvent, payload: DriveDragPayload): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(DRIVE_DRAG_TYPE, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'move'
}

export function readDriveDrag(event: DragEvent): DriveDragPayload | null {
  const raw = event.dataTransfer?.getData(DRIVE_DRAG_TYPE)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<DriveDragPayload>
    return {
      files: Array.isArray(value.files) ? value.files.filter((v): v is string => typeof v === 'string') : [],
      folders: Array.isArray(value.folders) ? value.folders.filter((v): v is string => typeof v === 'string') : [],
    }
  } catch {
    return null
  }
}
