import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue() as any],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    'import.meta.env.VITE_DOMAIN': JSON.stringify('harmony.test'),
    'import.meta.env.VITE_HARMONY_ALT_DOMAINS': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://localhost:54321'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
    'import.meta.env.VITE_DEV_MODE': JSON.stringify('true'),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'federation-backend', 'tests/db/**', 'tests/integration/**'],
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    testTimeout: 10000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/main.ts',
        'src/types.ts',
        'src/locales/**',
        'src/assets/**',
      ],
    },
  },
})
