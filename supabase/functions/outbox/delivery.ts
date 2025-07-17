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
    console.log(`📋 Item details: actor=${item.actor_username}@${item.actor_domain}, attempts=${item.attempts}`)

    // Get activity data from ap_activities table
    console.log(`📄 Getting activity data for ${item.activity_id}...`)
    const activityData = await getActivityData(supabase, item.activity_id)
    console.log(`✅ Got activity data: type=${activityData.type}, actor=${activityData.actor}`)
    
    // Get private key for signing
    console.log(`🔑 Getting private key for ${item.actor_username}...`)
    const privateKey = await getPrivateKey(supabase, item.actor_username)
    console.log(`✅ Got private key (length: ${privateKey.length} chars)`)

    // Generate HTTP signature
    console.log(`🔒 Generating HTTP signature...`)
    const signature = await generateHttpSignature(
      item.target_inbox_url,
      JSON.stringify(activityData),
      item.actor_username,
      item.actor_domain,
      privateKey
    )
    console.log(`✅ Generated signature with date: ${signature.date_header}`)

    // Make HTTP request with proper headers
    console.log(`📤 Making HTTP POST to ${item.target_inbox_url}...`)
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

    console.log(`📥 Got response: ${response.status} ${response.statusText}`)
    const responseBody = await response.text()
    console.log(`📄 Response body (first 200 chars): ${responseBody.slice(0, 200)}`)
    
    const deliveryDuration = Date.now() - startTime
    const success = response.status >= 200 && response.status < 300

    console.log(`📡 Delivery result: ${response.status} ${response.statusText} (${deliveryDuration}ms) - Success: ${success}`)

    const result = {
      success,
      status_code: response.status,
      response_body: responseBody.slice(0, 1000), // Truncate to avoid huge logs
      delivery_duration_ms: deliveryDuration
    }

    console.log(`🎯 Returning delivery result:`, JSON.stringify(result))
    return result

  } catch (error) {
    const deliveryDuration = Date.now() - startTime
    
    console.error(`❌ Delivery failed for ${item.activity_id}:`, error)
    console.error(`❌ Error details: ${error.message}`)
    console.error(`❌ Error stack:`, error.stack)

    const result = {
      success: false,
      error_message: error.message,
      delivery_duration_ms: deliveryDuration
    }

    console.log(`💥 Returning error result:`, JSON.stringify(result))
    return result
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
  // Get pending deliveries AND stuck processing items (older than 5 minutes)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  
  const { data: deliveryItems, error: fetchError } = await supabase
    .from('federation_delivery_queue')
    .select('*')
    .or(`status.eq.pending,and(status.eq.processing,updated_at.lt.${fiveMinutesAgo})`)
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
    console.log(`🔄 Processing delivery item ${item.id} (activity: ${item.activity_id})`)
    try {
      // Mark as processing
      console.log(`📝 Marking ${item.id} as processing...`)
      const { error: updateError } = await supabase
        .from('federation_delivery_queue')
        .update({ status: 'processing' })
        .eq('id', item.id)

      if (updateError) {
        console.error(`❌ Failed to mark ${item.id} as processing:`, updateError)
        throw updateError
      }
      console.log(`✅ Marked ${item.id} as processing`)

      // Deliver the activity
      console.log(`🚚 Starting delivery for ${item.id}...`)
      const result = await deliverActivity(supabase, item)
      console.log(`📦 Delivery completed for ${item.id}, success: ${result.success}`)
      deliveryResults.push({ item, result })

      // Update status based on result
      console.log(`🔄 Updating delivery status for ${item.id}...`)
      await updateDeliveryStatus(supabase, item.id, result, item.attempts + 1)
      console.log(`✅ Updated delivery status for ${item.id}`)

    } catch (error) {
      console.error(`💥 Failed to process delivery ${item.id}:`, error)
      console.error(`💥 Error message: ${error.message}`)
      console.error(`💥 Error stack:`, error.stack)
      
      // Mark as failed
      const failedResult = {
        success: false,
        error_message: error.message,
        delivery_duration_ms: 0
      }
      
      console.log(`📝 Marking ${item.id} as failed due to exception...`)
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
