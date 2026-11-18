/**
 * Vite plugin: built-in activities (activities/<id>/manifest.json).
 *
 * Each app's entry is bundled by esbuild into one classic script, as the activity frame loads it
 * (federation-backend src/activities/frame.ts): an opaque-origin document cannot load module
 * scripts or fetch from the instance without CORS. Build output:
 *
 *   activities/index.json             the catalog: manifests plus the hashed entry file names
 *   activities/<id>/app.<hash>.js     the bundle, hash = first 10 hex of its SHA-256
 *   activities/<id>/<icon>            the manifest's icon, copied
 *
 * `virtual:activity-catalog` exports the same catalog to the app bundle: a native app reads the
 * instance's /activities/index.json first and falls back to its own when that fails.
 *
 * The dev server builds an app on each request for /activities/<id>/app.dev.js, serves the catalog
 * with those names, and serves the local harness at /activities/dev/ (activities/dev/).
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'

const PUBLIC_ID = 'virtual:activity-catalog'
const RESOLVED_ID = '\0' + PUBLIC_ID
const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const CONTEXTS = ['direct', 'group', 'channel', 'voice']

export interface ActivityManifest {
  id: string
  name: string
  version: string
  description: string
  /** Per-locale name and description. */
  i18n?: Record<string, { name?: string; description?: string }>
  minPlayers: number
  maxPlayers: number
  contexts: string[]
  /** File in the app folder. */
  icon: string
  /** CSS colour of the app's cards. */
  accent: string
  /** Source entry in the app folder. */
  entry: string
}

export interface CatalogEntry extends Omit<ActivityManifest, 'entry'> {
  /** Built script in /activities/<id>/. */
  entry: string
}

export interface Catalog {
  v: 1
  apps: CatalogEntry[]
}

function readManifest(dir: string): ActivityManifest {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ActivityManifest
  const problems: string[] = []
  if (!APP_ID.test(manifest.id)) problems.push('id')
  if (!manifest.name || manifest.name.length > 60) problems.push('name')
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push('version')
  if (!(manifest.minPlayers >= 1 && manifest.maxPlayers <= 64 && manifest.minPlayers <= manifest.maxPlayers)) problems.push('players')
  if (!Array.isArray(manifest.contexts) || !manifest.contexts.length || manifest.contexts.some((c) => !CONTEXTS.includes(c))) problems.push('contexts')
  if (!manifest.icon || !existsSync(join(dir, manifest.icon))) problems.push('icon')
  if (!manifest.entry || !existsSync(join(dir, manifest.entry))) problems.push('entry')
  if (problems.length) throw new Error(`activities/${manifest.id ?? dir}: invalid manifest (${problems.join(', ')})`)
  return manifest
}

function appDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
    .map((entry) => join(root, entry.name))
    .sort()
}

async function bundle(entry: string, dev: boolean): Promise<string> {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'safari15'],
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl', '.webp': 'dataurl', '.mp3': 'dataurl', '.ogg': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  })
  return result.outputFiles[0].text
}

function catalogEntry(manifest: ActivityManifest, entry: string): CatalogEntry {
  return { ...manifest, entry }
}

function contentType(file: string): string {
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.webp')) return 'image/webp'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

export function activities(): Plugin {
  const root = fileURLToPath(new URL('./activities', import.meta.url))
  let built: Promise<Awaited<ReturnType<typeof buildAll>>> | null = null
  let isBuild = false

  async function buildAll(dev: boolean): Promise<{ catalog: Catalog; files: Array<{ fileName: string; source: string | Uint8Array }> }> {
    const apps: CatalogEntry[] = []
    const files: Array<{ fileName: string; source: string | Uint8Array }> = []
    for (const dir of appDirs(root)) {
      const manifest = readManifest(dir)
      const js = await bundle(join(dir, manifest.entry), dev)
      const name = `app.${createHash('sha256').update(js).digest('hex').slice(0, 10)}.js`
      files.push({ fileName: `activities/${manifest.id}/${name}`, source: js })
      files.push({ fileName: `activities/${manifest.id}/${manifest.icon}`, source: readFileSync(join(dir, manifest.icon)) })
      apps.push(catalogEntry(manifest, name))
    }
    return { catalog: { v: 1, apps }, files }
  }

  function devCatalog(): Catalog {
    return { v: 1, apps: appDirs(root).map((dir) => catalogEntry(readManifest(dir), 'app.dev.js')) }
  }

  async function serveDev(server: ViteDevServer, url: string): Promise<{ type: string; body: string | Buffer } | null> {
    const path = url.split('?')[0]
    if (path === '/activities/index.json') return { type: 'application/json', body: JSON.stringify(devCatalog()) }
    if (path === '/activities/dev' || path === '/activities/dev/') {
      const html = readFileSync(join(root, 'dev/harness.html'), 'utf8')
      return { type: 'text/html; charset=utf-8', body: await server.transformIndexHtml(path, html) }
    }
    if (path === '/activities/dev/harness.js') {
      return { type: 'text/javascript; charset=utf-8', body: await bundle(join(root, 'dev/harness.ts'), true) }
    }
    const match = /^\/activities\/([a-z][a-z0-9-]{1,39})\/([A-Za-z0-9._-]+)$/.exec(path)
    if (!match) return null
    const [, id, file] = match
    const dir = join(root, id)
    if (!existsSync(join(dir, 'manifest.json'))) return null
    const manifest = readManifest(dir)
    if (file === 'app.dev.js') return { type: contentType(file), body: await bundle(join(dir, manifest.entry), true) }
    if (file === manifest.icon) return { type: contentType(file), body: readFileSync(join(dir, file)) }
    return null
  }

  return {
    name: 'harmony-activities',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    async buildStart() {
      if (isBuild) built = null
    },
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : undefined
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined
      if (!isBuild) return `export default ${JSON.stringify(devCatalog())}`
      built ??= buildAll(false)
      return `export default ${JSON.stringify((await built).catalog)}`
    },
    async generateBundle() {
      built ??= buildAll(false)
      const { catalog, files } = await built
      for (const file of files) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source })
      this.emitFile({ type: 'asset', fileName: 'activities/index.json', source: JSON.stringify(catalog) })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/activities/')) return next()
        serveDev(server, req.url)
          .then((out) => {
            if (!out) return next()
            res.setHeader('Content-Type', out.type)
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(out.body)
          })
          .catch((error: Error) => {
            server.config.logger.error(`activities: ${error.message}`)
            res.statusCode = 500
            res.end(error.message)
          })
      })
      server.watcher.add(root)
      server.watcher.on('change', (file) => {
        if (!file.startsWith(root)) return
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (mod) server.moduleGraph.invalidateModule(mod)
      })
    },
  }
}
