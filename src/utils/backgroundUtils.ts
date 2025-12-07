/**
 * Utility functions for discovering and selecting background images
 * Supports organized folders: /backgrounds/login/ and /backgrounds/offline/
 * Falls back to legacy /img/ pattern if new folders don't exist
 */

const imageExtensions = ['.webp', '.png', '.jpg', '.jpeg']
const maxDiscoveryAttempts = 100 // Limit attempts to prevent infinite loops

// Cache for discovered images to avoid repeated discovery
const imageCache = new Map<string, string[]>()

/**
 * Attempts to discover available images in a directory by trying to load them
 * Uses a simple approach: tries numbered filenames with common extensions
 */
async function discoverImagesInFolder(folderPath: string): Promise<string[]> {
  const cacheKey = folderPath
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey)!
  }

  const discoveredImages: string[] = []
  const attempts: Promise<boolean>[] = []

  // Try numbered filenames (1-100) with common extensions
  for (let i = 1; i <= maxDiscoveryAttempts; i++) {
    for (const ext of imageExtensions) {
      const imagePath = `${folderPath}/${i}${ext}`
      attempts.push(
        new Promise<boolean>((resolve) => {
          const img = new Image()
          img.onload = () => {
            discoveredImages.push(imagePath)
            resolve(true)
          }
          img.onerror = () => resolve(false)
          // Set a timeout to prevent hanging
          setTimeout(() => resolve(false), 100)
          img.src = imagePath
        })
      )
    }
  }

  // Wait for all attempts with a reasonable timeout
  await Promise.allSettled(attempts.slice(0, 20)) // Check first 20 quickly
  await Promise.allSettled(attempts.slice(20)) // Then check the rest

  // Cache the results
  imageCache.set(cacheKey, discoveredImages)
  return discoveredImages
}

/**
 * Gets a random background image for login/register pages
 * Tries /backgrounds/login/ first, falls back to /img/login_bg*.webp
 */
export async function getRandomLoginBackground(): Promise<string> {
  // Try new organized folder first
  const loginImages = await discoverImagesInFolder('/backgrounds/login')
  
  if (loginImages.length > 0) {
    const randomIndex = Math.floor(Math.random() * loginImages.length)
    return `url('${loginImages[randomIndex]}')`
  }

  // Fallback to legacy pattern
  const randomNum = Math.floor(Math.random() * 65) + 1
  return `url('/img/login_bg${randomNum}.webp')`
}

/**
 * Gets a random background image for offline pages
 * Tries /backgrounds/offline/ first, falls back to /img/offline_bg*.webp
 */
export async function getRandomOfflineBackground(): Promise<string> {
  // Try new organized folder first
  const offlineImages = await discoverImagesInFolder('/backgrounds/offline')
  
  if (offlineImages.length > 0) {
    const randomIndex = Math.floor(Math.random() * offlineImages.length)
    return `url('${offlineImages[randomIndex]}')`
  }

  // Fallback to legacy pattern (if it exists)
  const randomNum = Math.floor(Math.random() * 2) + 1
  return `url('/img/offline_bg${randomNum}.webp')`
}

/**
 * Clears the image cache (useful for development/testing)
 */
export function clearBackgroundCache(): void {
  imageCache.clear()
}

