/**
 * Vite plugin: background image lists.
 *
 * `virtual:backgrounds` exports the image files under public/backgrounds/login
 * and public/backgrounds/404 as root-relative URLs, read when the module loads.
 * Every `vite build` and `vite` dev server carries the lists, whatever command
 * started it; operators add images by dropping files into those folders.
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const PUBLIC_ID = 'virtual:backgrounds'
const RESOLVED_ID = '\0' + PUBLIC_ID
const IMAGE = /\.(webp|avif|png|jpe?g)$/i
const FOLDERS = { login: 'login', notFound: '404' } as const

function list(dir: string, folder: string): string[] {
  const path = join(dir, folder)
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => `/backgrounds/${folder}/${encodeURIComponent(name)}`)
}

export function backgrounds(): Plugin {
  let dir = ''
  return {
    name: 'harmony-backgrounds',
    configResolved(config) {
      dir = join(config.publicDir, 'backgrounds')
    },
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : undefined
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      const lists = Object.fromEntries(
        Object.entries(FOLDERS).map(([key, folder]) => [key, list(dir, folder)])
      )
      return `export default ${JSON.stringify(lists)}`
    },
    configureServer(server) {
      const onChange = (file: string) => {
        if (!file.startsWith(dir)) return
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (mod) server.moduleGraph.invalidateModule(mod)
      }
      server.watcher.add(dir)
      server.watcher.on('add', onChange)
      server.watcher.on('unlink', onChange)
    },
  }
}
