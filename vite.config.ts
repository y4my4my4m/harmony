import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
// export default defineConfig({
//   plugins: [
//     vue(),
//   ],
//   resolve: {
//     alias: {
//       '@': fileURLToPath(new URL('./src', import.meta.url))
//     }
//   }
// })

export default defineConfig({
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    strictPort: true,
  },
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'vue-easy-lightbox': 'vue-easy-lightbox/dist/external-css/vue-easy-lightbox.esm.min.js'
    }
  },
  // to access the Tauri environment variables set by the CLI with information about the current target
  envPrefix: ['VITE_', 'TAURI_PLATFORM', 'TAURI_ARCH', 'TAURI_FAMILY', 'TAURI_PLATFORM_VERSION', 'TAURI_PLATFORM_TYPE', 'TAURI_DEBUG'],
  define: {
    // Fix for simple-peer and other Node.js libraries
    global: 'globalThis',
    'process.env': {},
    'process.nextTick': 'setTimeout',
  },
  optimizeDeps: {
    include: [
      'simple-peer',
      // Ensure voice-related dependencies are pre-bundled to avoid runtime import issues
      '@/stores/unifiedVoiceChannel',
      '@/stores/spatialAudio',
      '@/services/unifiedWebRTC',
      '@/services/spatialAudio'
    ],
  },
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari16',
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          // Voice-related chunks - keep together to avoid dependency issues
          'voice-core': [
            './src/stores/unifiedVoiceChannel.ts',
            './src/stores/spatialAudio.ts',
            './src/services/unifiedWebRTC.ts',
            './src/services/spatialAudio.ts'
          ],
          'voice-ui': [
            './src/components/voice/UnifiedVoiceDock.vue',
            './src/components/voice/UnifiedVoiceOverlay.vue',
            './src/components/voice/VoiceSettingsPanel.vue',
            './src/components/voice/SpatialAudioPanel.vue',
            './src/components/voice/UnifiedVoiceUserCard.vue'
          ],
          // Store chunks to avoid dual import issues
          'stores-core': [
            './src/stores/useTheme.ts',
            './src/stores/useEmojiCache.ts',
            './src/stores/useReactions.ts'
          ],
          'stores-communication': [
            './src/stores/useChat.ts',
            './src/stores/useDM.ts',
            './src/stores/useActivityPub.ts'
          ],
          // Service chunks
          'services-core': [
            './src/services/StatePersistence.ts',
            './src/services/ViewContextTracker.ts',
            './src/services/usersService.ts'
          ]
        },
        // Ensure voice chunks are loaded in the right order
        chunkFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'voice-core') {
            return 'assets/voice-core-[hash].js';
          }
          if (chunkInfo.name === 'voice-ui') {
            return 'assets/voice-ui-[hash].js';
          }
          return 'assets/[name]-[hash].js';
        }
      }
    }
  },
})