import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  // Serve built-in sounds for “fill gaps from default pack”
  publicDir: path.resolve(root, '../../public'),
  server: {
    port: 5179,
    strictPort: true,
  },
})
