import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createHash } from "https://deno.land/std@0.168.0/hash/mod.ts"

interface SignRequest {
  target_url: string
  body: string
  actor_username: string
  instance_domain: string
  method?: string
  private_key: string
}

interface SignResponse {
  signature_header: string
  date_header: string
  digest_header: string
  headers_to_sign: string[]
}

async function signHttpRequest(request: SignRequest): Promise<SignResponse> {
  const { target_url, body, actor_username, instance_domain, method = 'POST', private_key } = request
  
  // Extract host and path from target URL
  const url = new URL(target_url)
  const target_host = url.hostname
  const target_path = url.pathname + url.search || '/'
  
  // Generate date header (RFC 1123 format)
  const date = new Date().toUTCString()
  
  // Generate digest header (SHA-256 of body)
  const bodyBytes = new TextEncoder().encode(body)
  const hash = createHash("sha256")
  hash.update(bodyBytes)
  const digestHash = hash.toString("base64")
  const digest = `SHA-256=${digestHash}`
  
  // Build key ID
  const keyId = `https://${instance_domain}/users/${actor_username}#main-key`
  
  // Define headers to sign
  const headers = ['(request-target)', 'host', 'date', 'digest']
  
  // Build string to sign
  const stringToSign = [
    `(request-target): ${method.toLowerCase()} ${target_path}`,
    `host: ${target_host}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n')
  
  // Import the private key
  const privateKeyPem = private_key
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----')
  
  try {
    // Import the private key for signing
    const keyData = privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----\n?/, '')
      .replace(/\n?-----END PRIVATE KEY-----/, '')
      .replace(/\n/g, '')
    
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0))
    
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    )
    
    // Sign the string
    const stringToSignBytes = new TextEncoder().encode(stringToSign)
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      stringToSignBytes
    )
    
    // Convert signature to base64
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    
    // Build signature header
    const signatureHeader = [
      `keyId="${keyId}"`,
      `algorithm="rsa-sha256"`,
      `headers="${headers.join(' ')}"`,
      `signature="${signatureBase64}"`
    ].join(',')
    
    return {
      signature_header: signatureHeader,
      date_header: date,
      digest_header: digest,
      headers_to_sign: headers
    }
    
  } catch (error) {
    console.error('Signing error:', error)
    throw new Error(`Failed to sign request: ${error.message}`)
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const requestData: SignRequest = await req.json()
    
    // Validate required fields
    if (!requestData.target_url || !requestData.body || !requestData.actor_username || 
        !requestData.instance_domain || !requestData.private_key) {
      return new Response('Missing required fields', { status: 400 })
    }
    
    const signResult = await signHttpRequest(requestData)
    
    return new Response(JSON.stringify(signResult), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
    
  } catch (error) {
    console.error('Error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
})
