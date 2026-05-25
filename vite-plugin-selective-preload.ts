/**
 * Vite Plugin: Selective Preload
 * 
 * Prevents Vite from preloading all route chunks in the HTML.
 * Only preloads critical chunks (vendor, main entry) and defers route chunks
 * until they're actually needed (lazy loading).
 * 
 * This significantly improves initial load time by not downloading
 * code for routes the user isn't visiting.
 */

import type { Plugin } from 'vite'

interface SelectivePreloadOptions {
  /**
   * Chunks to always preload (e.g., vendor, main entry)
   * These will be kept in the HTML
   */
  alwaysPreload?: string[]
  
  /**
   * Chunks to never preload (e.g., route chunks)
   * These will be removed from the HTML
   */
  neverPreload?: RegExp[]
  
  /**
   * Route chunks pattern - matches view-* chunks
   */
  routeChunkPattern?: RegExp
}

export function selectivePreload(options: SelectivePreloadOptions = {}): Plugin {
  const {
    alwaysPreload = ['index', 'vendor', 'vue-vendor', 'supabase-vendor', 'crypto-vendor'],
    neverPreload = [/^view-/],
    routeChunkPattern = /^view-/
  } = options

  return {
    name: 'selective-preload',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        // Find all modulepreload links
        const modulepreloadRegex = /<link[^>]*rel=["']modulepreload["'][^>]*>/gi
        const matches = html.match(modulepreloadRegex) || []
        
        if (!matches || matches.length === 0) {
          return html
        }

        // Filter which preloads to keep
        const preloadsToKeep: string[] = []
        const preloadsToRemove: string[] = []

        matches.forEach((preloadTag) => {
          // Extract the href to check the chunk name
          const hrefMatch = preloadTag.match(/href=["']([^"']+)["']/)
          if (!hrefMatch) {
            // Keep if we can't parse it (better safe than sorry)
            preloadsToKeep.push(preloadTag)
            return
          }

          const href = hrefMatch[1]
          // Extract chunk name from paths like /assets/view-UserSettings-iME7Lp0f.js
          // or /assets/vendor-Chxb5v8W.js
          const filenameMatch = href.match(/\/([^/]+)\.js/)
          const chunkName = filenameMatch?.[1] || ''

          // Check if this is a route chunk (view-*)
          const isRouteChunk = routeChunkPattern.test(chunkName)
          
          // Check if it matches neverPreload patterns
          const shouldNeverPreload = neverPreload.some(pattern => pattern.test(chunkName))
          
          // Check if it's in alwaysPreload list (check if chunk name contains any always-preload name)
          const shouldAlwaysPreload = alwaysPreload.some(name => chunkName.includes(name))

          if (shouldNeverPreload || isRouteChunk) {
            // Remove route chunks and never-preload chunks
            preloadsToRemove.push(preloadTag)
          } else if (shouldAlwaysPreload) {
            // Keep critical chunks
            preloadsToKeep.push(preloadTag)
          } else {
            // For unknown chunks, be conservative and keep them
            // (could be CSS or other critical assets)
            preloadsToKeep.push(preloadTag)
          }
        })

        // Remove the preloads we don't want
        let newHtml = html
        preloadsToRemove.forEach((tag) => {
          newHtml = newHtml.replace(tag, '')
        })

        return newHtml
      }
    }
  }
}

