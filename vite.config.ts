import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// Custom plugin for emoji API endpoint
const emojiApiPlugin = () => {
  return {
    name: 'emoji-api',
    configureServer(server) {
      server.middlewares.use('/emojis', async (req, res, next) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const emojiIdMatch = url.pathname.match(/^\/([a-f0-9-]+)$/);
        
        if (emojiIdMatch && req.method === 'GET') {
          const emojiId = emojiIdMatch[1];
          const baseUrl = `${url.protocol}//${url.host}`;
          
          try {
            // Load env variables
            const env = loadEnv('', process.cwd(), '');
            const supabaseUrl = env.VITE_SUPABASE_URL;
            const supabaseKey = env.VITE_SUPABASE_ANON_KEY;
            
            if (!supabaseUrl || !supabaseKey) {
              throw new Error('Missing Supabase environment variables');
            }
            
            // Fetch emoji from Supabase
            const response = await fetch(`${supabaseUrl}/rest/v1/emojis?id=eq.${emojiId}&select=*`, {
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
              }
            });
            
            if (!response.ok) {
              throw new Error('Failed to fetch emoji');
            }
            
            const data = await response.json();
            
            if (!data || data.length === 0) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Emoji not found' }));
              return;
            }
            
            const emoji = data[0];
            const activityPubEmoji = {
              "@context": [
                "https://www.w3.org/ns/activitystreams",
                {
                  "toot": "http://joinmastodon.org/ns#",
                  "Emoji": "toot:Emoji",
                  "focalPoint": {
                    "@container": "@list",
                    "@id": "toot:focalPoint"
                  }
                }
              ],
              "id": `${baseUrl}/emojis/${emoji.id}`,
              "type": "Emoji",
              "name": `:${emoji.name}:`,
              "updated": emoji.updated_at || emoji.created_at,
              "icon": {
                "type": "Image",
                "mediaType": emoji.url.endsWith('.gif') ? "image/gif" : "image/png",
                "url": emoji.url
              }
            };
            
            res.setHeader('Content-Type', 'application/activity+json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.statusCode = 200;
            res.end(JSON.stringify(activityPubEmoji, null, 2));
            return;
          } catch (error) {
            console.error('Error handling emoji request:', error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
          }
        }
        
        next();
      });
    }
  };
};

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
    emojiApiPlugin(), // Add the emoji API plugin
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
    include: ['simple-peer'],
  },
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari16',
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})