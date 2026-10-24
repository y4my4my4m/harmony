// Outgoing webhook deliveries for journey specs, sent as the federation backend's worker sends
// them (deliver-outgoing-webhook, services/OutgoingWebhookSender.ts) but without Redis: due
// pending deliveries are read every 300 ms. Prints `ready` once polling.
//
// Run with federation-backend's tsx, environment set by e2e/specs/webhookWorker.ts.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = (p: string) => import(pathToFileURL(path.join(root, 'federation-backend/src', p)).href)
const { deliverOutgoingWebhook } = await mod('services/OutgoingWebhookSender.ts')
const { getSupabaseClient } = await mod('config/supabase.ts')

const supabase = getSupabaseClient()
let stopping = false
process.on('SIGTERM', () => { stopping = true })

console.log('ready')
while (!stopping) {
  const { data } = await supabase
    .from('outgoing_webhook_deliveries')
    .select('id')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .limit(20)
  for (const row of data ?? []) {
    await deliverOutgoingWebhook(row.id).catch((err: unknown) => console.error(`delivery ${row.id}:`, err))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}
process.exit(0)
