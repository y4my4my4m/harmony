import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { selectivePreload } from './vite-plugin-selective-preload'

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5173,
    // Allow custom local domains for development
    allowedHosts: ['har.mony.local', 'localhost'],
  },
  plugins: [
    vue({
      template: {
        compilerOptions: {
          comments: false
        }
      }
    }),
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
          // Vendor chunks
          if (id.includes('node_modules')) {
            // Large libraries get their own chunks
            if (id.includes('vue') || id.includes('@vue')) {
              return 'vue-vendor'
            }
            if (id.includes('supabase')) {
              return 'supabase-vendor'
            }
            if (id.includes('@privacyresearch')) {
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
        // Optimize chunk size
        chunkSizeWarningLimit: 1000,
      }
    },
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari16',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Increase chunk size limit for better splitting
    chunkSizeWarningLimit: 1000,
  },
})
