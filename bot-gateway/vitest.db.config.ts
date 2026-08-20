import { defineConfig } from 'vitest/config'

// Requires docker: the suite builds a database from db_schema/migrations/ and fronts it
// with PostgREST. Kept out of vitest.config.ts so `npm test` stays dependency-free.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    globals: true,
    root: __dirname,
    testTimeout: 240_000,
    hookTimeout: 420_000,
    fileParallelism: false,
  },
})
