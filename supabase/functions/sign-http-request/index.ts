import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

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
  const { target_url, body, actor_username, instance_domain, method = 'POST', private_key } = request;

  const url = new URL(target_url);
  const target_host = url.hostname;
  const target_path = url.pathname + (url.search || '');

  const date = new Date().toUTCString();
  const bodyBytes = new TextEncoder().encode(body);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bodyBytes);
  const digestHash = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
  const digest = `SHA-256=${digestHash}`;

  const keyId = `https://${instance_domain}/users/${actor_username}#main-key`;
  const headers = ['(request-target)', 'host', 'date', 'digest'];
  const stringToSign = [
    `(request-target): ${method.toLowerCase()} ${target_path}`,
    `host: ${target_host}`,
    `date: ${date}`,
    `digest: ${digest}`
  ].join('\n');

  // Robust PEM cleanup
  const keyData = private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/[\r\n\s]/g, '');

  console.log("private_key:", JSON.stringify(private_key));
  console.log("keyData:", keyData.length, keyData.slice(0, 60), '...', keyData.slice(-60));

  try {
    console.log('keyData (first 30):', keyData.slice(0, 30), '...(last 30):', keyData.slice(-30));
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const stringToSignBytes = new TextEncoder().encode(stringToSign);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      stringToSignBytes
    );
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const signatureHeader = [
      `keyId="${keyId}"`,
      `algorithm="rsa-sha256"`,
      `headers="${headers.join(' ')}"`,
      `signature="${signatureBase64}"`
    ].join(',');

    return {
      signature_header: signatureHeader,
      date_header: date,
      digest_header: digest,
      headers_to_sign: headers
    };

  } catch (e) {
    console.error('Signing or base64 decode error:', e, keyData);
    throw new Error('Failed to decode base64 or sign data');
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
