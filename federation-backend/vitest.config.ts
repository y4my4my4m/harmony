import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    root: __dirname,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**', 'src/index.ts'],
      thresholds: {
        'src/utils/**': { statements: 70, branches: 60, functions: 70, lines: 70 },
        'src/activitypub/converters/**': { statements: 60, branches: 50, functions: 60, lines: 60 },
      },
    },
  },
})
