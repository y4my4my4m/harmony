import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { selectivePreload } from './vite-plugin-selective-preload'

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

export default defineConfig({
  clearScreen: false,
  server: ({
    strictPort: true,
    port: 5173,
    // Allow custom local domains for development.
    // `allowedHosts` is `string[] | true` in Vite 5+, the array literal is fine
    // at runtime but vue-tsc's older Vite types may infer it differently; cast.
    allowedHosts: (['har.mony.local', 'localhost'] as unknown as string[]),
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
  },
  optimizeDeps: {
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
        // Better code splitting - split by route and vendor
        manualChunks: (id) => {
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
            // Other node_modules
            return 'vendor'
          }
          // Route-based chunks
          if (id.includes('/views/')) {
            const viewName = id.match(/\/views\/([^/]+)\.vue/)?.[1]
            if (viewName) {
              return `view-${viewName}`
            }
          }
          // Large components get their own chunks
          if (id.includes('/components/')) {
            if (id.includes('RichTextEditor') || id.includes('Composer')) {
              return 'editor'
            }
            if (id.includes('MessageDisplay') || id.includes('UnifiedMessageContent')) {
              return 'message'
            }
          }
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
