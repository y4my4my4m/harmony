// Outbox delivery handler - processes federation_delivery_queue
// This handles the actual HTTP delivery of activities to remote instances

import { 
  DeliveryQueueItem, 
  DeliveryResult, 
  generateHttpSignature, 
  getPrivateKey, 
  getActivityData,
  updateDeliveryStatus,
  logDeliveryMetrics 
} from '../common/index.ts'

/**
 * Deliver a single activity to a remote inbox
 */
export async function deliverActivity(
  supabase: any,
  item: DeliveryQueueItem
): Promise<DeliveryResult> {
  const startTime = Date.now()

  try {
    console.log(`🚀 Delivering activity ${item.activity_id} to ${item.target_inbox_url}`)

    // Get activity data from ap_activities table
    const activityData = await getActivityData(supabase, item.activity_id)
    
    // Get private key for signing
    const privateKey = await getPrivateKey(supabase, item.actor_username)

    // Generate HTTP signature
    const signature = await generateHttpSignature(
      item.target_inbox_url,
      JSON.stringify(activityData),
      item.actor_username,
      item.actor_domain,
      privateKey
    )

    // Make HTTP request with proper headers
    const response = await fetch(item.target_inbox_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json',
        'User-Agent': 'Harmony/1.0.0',
        'Host': item.target_domain,
        'Date': signature.date_header,
        'Digest': signature.digest_header,
        'Signature': signature.signature_header,
        'Accept': 'application/activity+json'
      },
      body: JSON.stringify(activityData)
    })

    const responseBody = await response.text()
    const deliveryDuration = Date.now() - startTime

    const success = response.status >= 200 && response.status < 300

    console.log(`📡 Delivery result: ${response.status} ${response.statusText} (${deliveryDuration}ms)`)

    return {
      success,
      status_code: response.status,
      response_body: responseBody.slice(0, 1000), // Truncate to avoid huge logs
      delivery_duration_ms: deliveryDuration
    }

  } catch (error) {
    const deliveryDuration = Date.now() - startTime
    
    console.error(`❌ Delivery failed:`, error)

    return {
      success: false,
      error_message: error.message,
      delivery_duration_ms: deliveryDuration
    }
  }
}

/**
 * Process the federation delivery queue
 */
export async function processDeliveryQueue(supabase: any): Promise<{
  processed: number
  successful: number
  failed: number
  details: any[]
}> {
  // Get pending deliveries
  const { data: deliveryItems, error: fetchError } = await supabase
    .from('federation_delivery_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(50) // Process in batches

  if (fetchError) {
    throw new Error(`Failed to fetch delivery queue: ${fetchError.message}`)
  }

  if (!deliveryItems || deliveryItems.length === 0) {
    return {
      processed: 0,
      successful: 0,
      failed: 0,
      details: []
    }
  }

  console.log(`📦 Processing ${deliveryItems.length} pending deliveries`)

  const deliveryResults: Array<{ item: DeliveryQueueItem; result: DeliveryResult }> = []

  // Process each delivery
  for (const item of deliveryItems) {
    try {
      // Mark as processing
      await supabase
        .from('federation_delivery_queue')
        .update({ status: 'processing' })
        .eq('id', item.id)

      // Deliver the activity
      const result = await deliverActivity(supabase, item)
      deliveryResults.push({ item, result })

      // Update status based on result
      await updateDeliveryStatus(supabase, item.id, result, item.attempts + 1)

    } catch (error) {
      console.error(`💥 Failed to process delivery ${item.id}:`, error)
      
      // Mark as failed
      const failedResult = {
        success: false,
        error_message: error.message,
        delivery_duration_ms: 0
      }
      
      await updateDeliveryStatus(supabase, item.id, failedResult, item.attempts + 1)
      deliveryResults.push({ item, result: failedResult })
    }
  }

  // Log metrics
  await logDeliveryMetrics(supabase, deliveryResults)

  const successful = deliveryResults.filter(d => d.result.success).length
  const failed = deliveryResults.filter(d => !d.result.success).length

  return {
    processed: deliveryResults.length,
    successful,
    failed,
    details: deliveryResults.map(d => ({
      activity_id: d.item.activity_id,
      target_domain: d.item.target_domain,
      success: d.result.success,
      status_code: d.result.status_code,
      duration_ms: d.result.delivery_duration_ms
    }))
  }
}
