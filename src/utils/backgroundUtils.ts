/**
 * Utility functions for discovering and selecting background images
 * Supports organized folders: /backgrounds/login/ and /backgrounds/offline/
 * Falls back to legacy /img/ pattern if new folders don't exist
 * 
 * Uses a manifest file (generated at build time) for efficient discovery.
 * Falls back to minimal runtime discovery if manifest doesn't exist.
 */

// Cache for manifest
let manifestCache: { login: string[]; offline: string[]; notFound: string[] } | null = null
let manifestLoadAttempted = false

/**
 * Loads the background manifest file if it exists
 * This is generated at build time by scripts/build-background-manifest.mjs
 */
async function loadManifest(): Promise<{ login: string[]; offline: string[]; notFound: string[] } | null> {
  if (manifestCache !== null) {
    return manifestCache
  }
  
  if (manifestLoadAttempted) {
    return null
  }
  
  manifestLoadAttempted = true
  
  try {
    const response = await fetch('/backgrounds/manifest.json')
    if (response.ok) {
      const manifest = await response.json()
      manifestCache = {
        login: manifest.login || [],
        offline: manifest.offline || [],
        notFound: manifest.notFound || []
      }
      return manifestCache
    }
  } catch (error) {
    // Manifest missing or failed to load: fall back to defaults
  }
  
  return null
}


/**
 * Gets a random background image for login/register pages
 * Uses manifest if available, falls back to legacy /img/login_bg*.webp pattern
 */
export async function getRandomLoginBackground(): Promise<string> {
  // Try to load manifest first (most efficient)
  const manifest = await loadManifest()
  
  if (manifest && manifest.login.length > 0) {
    const randomIndex = Math.floor(Math.random() * manifest.login.length)
    return `url('${manifest.login[randomIndex]}')`
  }

  // Fallback to legacy pattern
  const randomNum = Math.floor(Math.random() * 65) + 1
  return `url('/img/login_bg${randomNum}.webp')`
}

/**
 * Gets a random background image for offline pages
 * Uses manifest if available, falls back to legacy /img/offline_bg*.webp pattern
 */
export async function getRandomOfflineBackground(): Promise<string> {
  // Try to load manifest first (most efficient)
  const manifest = await loadManifest()
  
  if (manifest && manifest.offline.length > 0) {
    const randomIndex = Math.floor(Math.random() * manifest.offline.length)
    return `url('${manifest.offline[randomIndex]}')`
  }

  // Fallback to legacy pattern
  const randomNum = Math.floor(Math.random() * 2) + 1
  return `url('/img/offline_bg${randomNum}.webp')`
}

/**
 * Gets a random 404 image
 * Uses manifest if available, falls back to legacy /404*.webp pattern
 */
export async function getRandom404Image(): Promise<string> {
  // Try to load manifest first (most efficient)
  const manifest = await loadManifest()
  
  if (manifest && manifest.notFound.length > 0) {
    const randomIndex = Math.floor(Math.random() * manifest.notFound.length)
    return manifest.notFound[randomIndex]
  }

  // Fallback to legacy pattern
  const legacyImages = ['/backgrounds/404/1.webp', '/backgrounds/404/2.webp']
  const randomIndex = Math.floor(Math.random() * legacyImages.length)
  return legacyImages[randomIndex]
}

/**
 * Clears the manifest cache (useful for development/testing)
 */
export function clearBackgroundCache(): void {
  manifestCache = null
  manifestLoadAttempted = false
}

