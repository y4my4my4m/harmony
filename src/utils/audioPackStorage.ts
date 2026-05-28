/**
 * IndexedDB storage for audio theme pack blobs.
 * Pack themes store individual sound blobs; metadata (fromPack, soundsMap) lives in localStorage.
 */

const DB_NAME = 'harmony-audio-packs'
const DB_VERSION = 1
const STORE_NAME = 'blobs'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
  })
}

function blobKey(themeId: string, action: string): string {
  return `${themeId}:${action}`
}

export async function savePackBlob(themeId: string, action: string, blob: Blob): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put({ key: blobKey(themeId, action), blob })
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function getPackBlob(themeId: string, action: string): Promise<Blob | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(blobKey(themeId, action))
    req.onsuccess = () => {
      db.close()
      resolve(req.result?.blob ?? null)
    }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export async function getAllPackBlobs(themeId: string, actions: string[]): Promise<Record<string, Blob>> {
  const result: Record<string, Blob> = {}
  for (const action of actions) {
    const blob = await getPackBlob(themeId, action)
    if (blob) result[action] = blob
  }
  return result
}

export async function deletePackBlobs(themeId: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        db.close()
        resolve()
        return
      }
      const key = cursor.primaryKey as string
      if (key.startsWith(`${themeId}:`)) {
        cursor.delete()
      }
      cursor.continue()
    }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}
