import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type DepOptimizationOptions, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { selectivePreload } from './vite-plugin-selective-preload'

type ModuleInfoLookup = (id: string) => { isEntry: boolean; importers: readonly string[] } | null

let reachMemo = new Map<string, boolean>()
let reachMemoOwner: ModuleInfoLookup | null = null

/**
 * True when a chain of static importers links the module to an entry, i.e.
 * the module executes on first load. Modules behind a dynamic import return
 * false.
 */
function isStaticallyReachable(id: string, getModuleInfo: ModuleInfoLookup): boolean {
  if (reachMemoOwner !== getModuleInfo) {
    reachMemo = new Map()
    reachMemoOwner = getModuleInfo
  }
  const known = reachMemo.get(id)
  if (known !== undefined) return known
  const visited = new Set<string>([id])
  const stack = [id]
  let found = false
  while (stack.length && !found) {
    const info = getModuleInfo(stack.pop()!)
    if (!info) continue
    if (info.isEntry) { found = true; break }
    for (const importer of info.importers) {
      if (reachMemo.get(importer) === true) { found = true; break }
      if (!visited.has(importer)) { visited.add(importer); stack.push(importer) }
    }
  }
  reachMemo.set(id, found)
  return found
}

/** Strip HTML comments from index.html during production build. */
function stripHtmlComments(): Plugin {
  return {
    name: 'strip-html-comments',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        return html.replace(/<!--[\s\S]*?-->/g, '')
      }
    }
  }
}

type EsbuildPlugin = NonNullable<NonNullable<DepOptimizationOptions['esbuildOptions']>['plugins']>[number]

/**
 * Dependency scan: leaves require('@/...') calls unresolved. esbuild refuses
 * to follow a require() into a module graph holding a top-level await
 * (src/services/runtimeConfig.ts) and aborts the scan. Browsers have no
 * require, so those calls throw at runtime in dev and production alike.
 */
function skipAppRequires(): EsbuildPlugin {
  return {
    name: 'skip-app-requires',
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) =>
        args.kind === 'require-call' ? { path: args.path, external: true } : undefined
      )
    },
  }
}

export default defineConfig({
  clearScreen: false,
  server: ({
    strictPort: true,
    port: 5173,
    // bind all interfaces so a physical device (tauri mobile dev) can reach the
    // dev server at the machine's LAN IP; TAURI_DEV_HOST overrides when set
    host: process.env.TAURI_DEV_HOST || '0.0.0.0',
    // allow the LAN IP / device host tauri injects (array would reject it)
    allowedHosts: (true as unknown as string[]),
    proxy: {
      '/api/federation': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/federation/, ''),
      },
      '/api/livekit': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  } as any),
  plugins: [
    vue({
      template: {
        compilerOptions: {
          comments: false
        }
      }
    }),
    // Strip HTML comments from index.html in production (Vue's comments:false only affects .vue templates)
    stripHtmlComments(),
    // Only preload critical chunks, not route chunks (saves ~500KB+ on initial load)
    selectivePreload({
      alwaysPreload: ['index', 'vendor', 'vue-vendor', 'supabase-vendor', 'crypto-vendor'],
      neverPreload: [/^view-/], // Don't preload route chunks
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'vue-easy-lightbox': 'vue-easy-lightbox/dist/external-css/vue-easy-lightbox.esm.min.js'
    }
  },
  envPrefix: [
    'VITE_',
    'TAURI_PLATFORM',
    'TAURI_ARCH',
    'TAURI_FAMILY',
    'TAURI_PLATFORM_VERSION',
    'TAURI_PLATFORM_TYPE',
    'TAURI_DEBUG'
  ],
  define: {
    global: 'globalThis',
    'process.env': {},
    'process.nextTick': 'setTimeout',
    // vue-i18n compiles messages to an AST it interprets. Without the flag it
    // compiles them with new Function, which a CSP without 'unsafe-eval' refuses.
    __INTLIFY_JIT_COMPILATION__: true,
    __INTLIFY_DROP_MESSAGE_COMPILER__: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [skipAppRequires()],
    },
    include: [
      'simple-peer',
      '@privacyresearch/libsignal-protocol-typescript',  // Browser-compatible Signal Protocol
    ],
    exclude: []
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      external: [],
      output: {
        // Vendor chunks only; routes split at their dynamic imports.
        manualChunks: (id, { getModuleInfo }) => {
          // Rollup's virtual commonjs interop helpers are imported by BOTH
          // vendor and vue-vendor (a CJS package in vendor requires
          // vue-router, so its augmented-namespace wrapper is emitted inside
          // vue-vendor). If the helpers live in vendor that wrapper import
          // closes a vendor -> vue-vendor -> vendor cycle; giving them their
          // own leaf chunk keeps the graph acyclic.
          if (id.includes('commonjsHelpers')) {
            return 'commonjs-helpers'
          }
          // Vendor chunks
          if (id.includes('node_modules')) {
            // Match exact package directories. The previous loose
            // `includes('vue')` swept every "vue-*" ecosystem package
            // (toastification, i18n, tanstack vue-virtual, ...) into
            // vue-vendor while their own dependencies landed in vendor,
            // producing a vendor <-> vue-vendor import cycle. Only the core
            // runtime stack (which imports nothing from vendor) lives here,
            // so imports flow one way: vendor -> vue-vendor.
            if (/node_modules\/(?:vue|@vue|vue-router|pinia|vue-demi)\//.test(id)) {
              return 'vue-vendor'
            }
            if (id.includes('node_modules/@supabase/')) {
              return 'supabase-vendor'
            }
            if (id.includes('node_modules/@privacyresearch/')) {
              return 'crypto-vendor'
            }
            // Other node_modules needed on first load. Packages reached only
            // through dynamic imports (vuedraggable, qrcode, date-fns, tauri
            // plugins) stay with the lazy chunks that use them.
            if (isStaticallyReachable(id, getModuleInfo)) {
              return 'vendor'
            }
            return
          }
          // Application modules stay unassigned. A manual chunk absorbs the
          // unassigned static dependencies of its members, so a per-view chunk
          // takes shared stores and services with it and the entry then
          // imports that view chunk statically.
        },
      }
    },
    // Optimize chunk size - must live at `build.chunkSizeWarningLimit`, not
    // inside `rollupOptions.output`.
    chunkSizeWarningLimit: 1000,
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari16',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
