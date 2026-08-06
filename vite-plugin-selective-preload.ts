/**
 * Vite plugin: selective preload.
 *
 * Strips modulepreload links for route chunks from the generated HTML, leaving
 * only critical chunks (vendor, main entry). Route chunks then load on demand.
 */

import type { Plugin } from 'vite'

interface SelectivePreloadOptions {
  /** Substring match against the chunk name; matches stay in the HTML. */
  alwaysPreload?: string[]
  
  /** Chunk names matching any pattern are dropped from the HTML. */
  neverPreload?: RegExp[]
  
  /** Identifies route chunks; matches are dropped from the HTML. */
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
        const modulepreloadRegex = /<link[^>]*rel=["']modulepreload["'][^>]*>/gi
        const matches = html.match(modulepreloadRegex) || []
        
        if (!matches || matches.length === 0) {
          return html
        }

        const preloadsToKeep: string[] = []
        const preloadsToRemove: string[] = []

        matches.forEach((preloadTag) => {
          const hrefMatch = preloadTag.match(/href=["']([^"']+)["']/)
          if (!hrefMatch) {
            // Unparseable tag: keep it.
            preloadsToKeep.push(preloadTag)
            return
          }

          const href = hrefMatch[1]
          // Chunk name from paths like /assets/view-UserSettings-iME7Lp0f.js
          // or /assets/vendor-Chxb5v8W.js
          const filenameMatch = href.match(/\/([^/]+)\.js/)
          const chunkName = filenameMatch?.[1] || ''

          const isRouteChunk = routeChunkPattern.test(chunkName)
          
          const shouldNeverPreload = neverPreload.some(pattern => pattern.test(chunkName))
          
          const shouldAlwaysPreload = alwaysPreload.some(name => chunkName.includes(name))

          if (shouldNeverPreload || isRouteChunk) {
            preloadsToRemove.push(preloadTag)
          } else if (shouldAlwaysPreload) {
            preloadsToKeep.push(preloadTag)
          } else {
            // Unknown chunks may be CSS or other critical assets: keep.
            preloadsToKeep.push(preloadTag)
          }
        })

        let newHtml = html
        preloadsToRemove.forEach((tag) => {
          newHtml = newHtml.replace(tag, '')
        })

        return newHtml
      }
    }
  }
}

