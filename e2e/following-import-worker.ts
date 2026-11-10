// Following imports for journey specs, run as the federation backend's worker runs them
// (following-import, queue/handlers/followingImportHandler.ts) but without Redis: imports due are
// read every 300 ms. Prints `ready` once polling.
//
// Run with federation-backend's tsx, environment set by e2e/specs/followingImportWorker.ts.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = (p: string) => import(pathToFileURL(path.join(root, 'federation-backend/src', p)).href)
const { runFollowingImportBatch } = await mod('queue/handlers/followingImportHandler.ts')
const { getSupabaseClient } = await mod('config/supabase.ts')

const supabase = getSupabaseClient()
let stopping = false
process.on('SIGTERM', () => { stopping = true })

console.log('ready')
while (!stopping) {
  const { data } = await supabase
    .from('following_imports')
    .select('id')
    .is('finished_at', null)
    .lte('next_run_at', new Date().toISOString())
    .limit(20)
  for (const row of data ?? []) {
    await runFollowingImportBatch(row.id).catch((err: unknown) => console.error(`import ${row.id}:`, err))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}
process.exit(0)
