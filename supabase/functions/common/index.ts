// Common utilities for ActivityPub federation
// Shared between inbox and outbox edge functions

export interface ActivityPubActivity {
  '@context'?: string | string[]
  id: string
  type: string
  actor: string
  object: string | object
  published?: string
  to?: string[]
  cc?: string[]
}

export interface DeliveryQueueItem {
  id: string
  activity_id: string
  target_domain: string
  target_inbox_url: string
  actor_username: string
  actor_domain: string
  attempts: number
  max_attempts: number
  priority: number
}

export interface DeliveryResult {
  success: boolean
  status_code?: number
  response_body?: string
  error_message?: string
  delivery_duration_ms: number
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, signature, date, digest',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/**
 * Generate HTTP signature for ActivityPub federation
 */
export async function generateHttpSignature(
  targetUrl: string,
  body: string,
  actorUsername: string,
  instanceDomain: string,
  privateKey: string,
  method = 'POST'
): Promise<{
  signature_header: string
  date_header: string
  digest_header: string
}> {
  const url = new URL(targetUrl)
  const targetHost = url.hostname
  const targetPath = url.pathname + (url.search || '')

  const date = new Date().toUTCString()
  const bodyBytes = new TextEncoder().encode(body)
  const hashBuffer = await crypto.subtle.digest("SHA-256", bodyBytes)
  const digestHash = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
  const digest = `SHA-256=${digestHash}`

  const keyId = `https://${instanceDomain}/users/${actorUsername}#main-key`
  const headers = ['(request-target)', 'host', 'date', 'digest']
  const stringToSign = [
    `(request-target): ${method.toLowerCase()} ${targetPath}`,
    `host: ${targetHost}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n')

  // Clean and import private key
  const keyData = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/[\r\n\s]/g, '')

  try {
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0))
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const stringToSignBytes = new TextEncoder().encode(stringToSign)
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      stringToSignBytes
    )
    
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    const signatureHeader = [
      `keyId="${keyId}"`,
      `algorithm="rsa-sha256"`,
      `headers="${headers.join(' ')}"`,
      `signature="${signatureBase64}"`
    ].join(',')

    return {
      signature_header: signatureHeader,
      date_header: date,
      digest_header: digest
    }
  } catch (error) {
    throw new Error(`Failed to generate HTTP signature: ${error.message}`)
  }
}

/**
 * Get private key for actor from database
 */
export async function getPrivateKey(supabase: any, actorUsername: string): Promise<string> {
  // Get the user profile to get the user ID
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', actorUsername)
    .eq('is_local', true)
    .single()

  if (profileError || !profile) {
    throw new Error(`Actor profile not found: ${actorUsername}`)
  }

  // Get private key from secure table
  const { data: keyData, error } = await supabase
    .from('user_private_keys')
    .select('private_key')
    .eq('user_id', profile.id)
    .single()

  if (error || !keyData) {
    throw new Error(`Private key not found for actor: ${actorUsername}`)
  }

  return keyData.private_key
}

/**
 * Get activity data from ap_activities table
 */
export async function getActivityData(supabase: any, activityId: string): Promise<any> {
  const { data: activity, error } = await supabase
    .from('ap_activities')
    .select('activity_data')
    .eq('id', activityId)
    .single()

  if (error || !activity) {
    throw new Error(`Activity not found: ${activityId}`)
  }

  return activity.activity_data
}

/**
 * Update delivery queue item status
 */
export async function updateDeliveryStatus(
  supabase: any,
  itemId: string,
  result: DeliveryResult,
  newAttempts: number
): Promise<void> {
  const now = new Date().toISOString()
  
  if (result.success) {
    // Mark as delivered
    await supabase
      .from('federation_delivery_queue')
      .update({
        status: 'delivered',
        delivered_at: now,
        attempts: newAttempts,
        http_status_code: result.status_code,
        response_body: result.response_body,
        delivery_duration_ms: result.delivery_duration_ms,
        updated_at: now
      })
      .eq('id', itemId)

    console.log(`✅ Delivered ${itemId} (${result.delivery_duration_ms}ms)`)
  } else {
    // Handle failure with exponential backoff
    const maxAttempts = 5
    const isMaxAttemptsReached = newAttempts >= maxAttempts

    if (isMaxAttemptsReached) {
      // Permanently failed
      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'failed',
          attempts: newAttempts,
          http_status_code: result.status_code,
          response_body: result.response_body,
          error_message: result.error_message || `Max attempts reached after ${newAttempts} tries`,
          delivery_duration_ms: result.delivery_duration_ms,
          updated_at: now
        })
        .eq('id', itemId)

      console.log(`💀 Failed ${itemId} permanently (${newAttempts} attempts)`)
    } else {
      // Schedule retry with exponential backoff
      const backoffMinutes = Math.pow(2, newAttempts)
      const nextAttempt = new Date(Date.now() + (backoffMinutes * 60 * 1000)).toISOString()

      await supabase
        .from('federation_delivery_queue')
        .update({
          status: 'pending',
          attempts: newAttempts,
          next_attempt_at: nextAttempt,
          http_status_code: result.status_code,
          response_body: result.response_body,
          error_message: result.error_message || 'Delivery failed, retrying',
          delivery_duration_ms: result.delivery_duration_ms,
          updated_at: now
        })
        .eq('id', itemId)

      console.log(`🔄 Retry ${itemId} in ${backoffMinutes}min (attempt ${newAttempts})`)
    }
  }
}

/**
 * Log delivery metrics to federation_delivery_stats
 */
export async function logDeliveryMetrics(
  supabase: any,
  deliveries: Array<{ item: DeliveryQueueItem; result: DeliveryResult }>
): Promise<void> {
  try {
    const successful = deliveries.filter(d => d.result.success).length
    const failed = deliveries.filter(d => !d.result.success).length
    const totalDuration = deliveries.reduce((sum, d) => sum + d.result.delivery_duration_ms, 0)
    const avgDuration = deliveries.length > 0 ? totalDuration / deliveries.length : 0

    // Insert delivery stats
    await supabase
      .from('federation_delivery_stats')
      .insert({
        period_start: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
        period_end: new Date().toISOString(),
        total_deliveries: deliveries.length,
        successful_deliveries: successful,
        failed_deliveries: failed,
        avg_delivery_time_ms: avgDuration
      })

    console.log(`📊 Delivery batch: ${successful}/${deliveries.length} successful (avg ${avgDuration.toFixed(0)}ms)`)
  } catch (error) {
    console.warn('Failed to log delivery metrics:', error)
  }
}
