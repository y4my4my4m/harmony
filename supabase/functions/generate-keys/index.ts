import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

async function generateRsaKeypair() {
  // 2048-bit RSA key pair for ActivityPub (RSASSA-PKCS1-v1_5, SHA-256)
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )

  // Private key (PKCS#8 PEM)
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
  const pkcs8b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)))
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${
    pkcs8b64.match(/.{1,64}/g)?.join("\n")
  }\n-----END PRIVATE KEY-----`

  // Public key (SPKI PEM)
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey)
  const spkib64 = btoa(String.fromCharCode(...new Uint8Array(spki)))
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${
    spkib64.match(/.{1,64}/g)?.join("\n")
  }\n-----END PUBLIC KEY-----`

  return { private_key: privateKeyPem, public_key: publicKeyPem }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }
  try {
    const keys = await generateRsaKeypair()
    return new Response(JSON.stringify(keys), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
