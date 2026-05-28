import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher
} from '@privacyresearch/libsignal-protocol-typescript'

// Minimal in-memory storage for testing
class InMemoryStorage {
  constructor() {
    this.identity = null
    this.registrationId = 0
    this.sessions = new Map()
  }

  async getIdentityKeyPair() { return this.identity }
  async getLocalRegistrationId() { return this.registrationId }
  async isTrustedIdentity() { return true }
  async saveIdentity() { return true }
  async loadSession(addr) { return this.sessions.get(addr) }
  async storeSession(addr, record) { this.sessions.set(addr, record) }
  
  // Add other required interface methods (stubs)
  async loadPreKey() {}
  async storePreKey() {}
  async removePreKey() {}
  async loadSignedPreKey() {}
  async storeSignedPreKey() {}
  async removeSignedPreKey() {}
}

// Helpers for encoding/decoding (same as app)
function arrayBufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

function base64ToArrayBuffer(base64) {
  const buffer = Buffer.from(base64, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

async function runTest() {
  try {
    console.log('🔑 Generating keys...')
    
    // 1. Generate keys (Sender & Recipient)
    const recipientIdentity = await KeyHelper.generateIdentityKeyPair()
    const recipientRegId = await KeyHelper.generateRegistrationId()
    
    const signedPreKey = await KeyHelper.generateSignedPreKey(recipientIdentity, 1)
    const preKey = await KeyHelper.generatePreKey(1)

    // 2. Simulate database storage (serialize to base64)
    const databaseBundle = {
      identity_key: arrayBufferToBase64(recipientIdentity.pubKey),
      registration_id: recipientRegId,
      signed_prekey: {
        id: signedPreKey.keyId,
        public_key: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
        signature: arrayBufferToBase64(signedPreKey.signature)
      },
      one_time_prekey: {
        id: preKey.keyId,
        public_key: arrayBufferToBase64(preKey.keyPair.pubKey)
      }
    }
    
    console.log('📦 Database bundle created (base64 strings)')

    // 3. Setup Sender Storage
    const senderStore = new InMemoryStorage()
    const senderIdentity = await KeyHelper.generateIdentityKeyPair()
    senderStore.identity = senderIdentity
    senderStore.registrationId = await KeyHelper.generateRegistrationId()

    // 4. Transform bundle back to ArrayBuffers (App Logic)
    const transformedBundle = {
      identityKey: base64ToArrayBuffer(databaseBundle.identity_key),
      registrationId: databaseBundle.registration_id,
      signedPreKey: {
        keyId: databaseBundle.signed_prekey.id,
        publicKey: base64ToArrayBuffer(databaseBundle.signed_prekey.public_key),
        signature: base64ToArrayBuffer(databaseBundle.signed_prekey.signature)
      },
      preKey: {
        keyId: databaseBundle.one_time_prekey.id,
        publicKey: base64ToArrayBuffer(databaseBundle.one_time_prekey.public_key)
      }
    }

    console.log('🔄 Bundle transformed back to ArrayBuffers')

    // 5. Process Bundle (Establish Session)
    const recipientAddress = new SignalProtocolAddress("recipient", 1)
    const builder = new SessionBuilder(senderStore, recipientAddress)
    
    console.log('🤝 Processing prekey bundle...')
    await builder.processPreKey(transformedBundle)
    
    console.log('✅ Session established successfully!')
    
    // 6. Test Encryption
    const cipher = new SessionCipher(senderStore, recipientAddress)
    const plaintextNode = new TextEncoder().encode("Hello World")
    // Convert Node Buffer to ArrayBuffer
    const plaintext = plaintextNode.buffer.slice(plaintextNode.byteOffset, plaintextNode.byteOffset + plaintextNode.byteLength)
    
    await cipher.encrypt(plaintext)

    console.log('Message encrypted successfully')
    
  } catch (error) {
    console.error('❌ Test Failed:', error)
    process.exit(1)
  }
}

runTest()

