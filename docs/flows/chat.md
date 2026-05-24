# Chat Message Flow

## Overview

Message sending in Harmony flows through `CoreMessageService`, which handles encryption decisions, database insertion, and relies on Supabase Realtime for delivery to other clients. Federation of messages is handled asynchronously by database triggers.

## Sending a Message

```mermaid
sequenceDiagram
    participant U as User
    participant MI as MessageInput
    participant CMS as CoreMessageService
    participant ENC as MegolmEncryptionService
    participant DB as Supabase
    participant RT as Realtime
    participant FED as Federation Queue

    U->>MI: Type and send message
    MI->>CMS: sendMessage(channelId, content, options)
    CMS->>CMS: Validate input
    CMS->>CMS: Check server encryption mode

    alt Encryption required or optional with keys available
        CMS->>ENC: isInitialized() && hasRecoveryKey() && isUnlocked()
        ENC-->>CMS: true
        CMS->>ENC: encrypt(content, channelId)
        ENC->>ENC: Get/create Megolm session for channel
        ENC-->>CMS: { ciphertext, session_id, device_id }
        CMS->>DB: INSERT message (encrypted payload)
    else Encryption disabled or keys unavailable
        CMS->>DB: INSERT message (plaintext)
    end

    DB->>RT: Broadcast INSERT event
    DB->>FED: Trigger queue_federation_job()
    RT-->>MI: New message callback
    FED-->>FED: Async delivery to remote instances
```

## Receiving a Message

```mermaid
sequenceDiagram
    participant RT as Realtime
    participant Store as useChat / useDM Store
    participant Dec as messageDecryption
    participant ENC as MegolmEncryptionService
    participant MD as MessageDisplay

    RT->>Store: New message event
    Store->>Store: Deduplicate (check existing messages)

    alt Message is encrypted
        Store->>Dec: processMessageDecryption(message)
        Dec->>ENC: decrypt(ciphertext, sessionId)
        alt Session key available
            ENC-->>Dec: Decrypted content
            Dec-->>Store: Update message with plaintext
        else Session key missing
            Dec-->>Store: Mark as "encrypted (key unavailable)"
            Note over Dec: Listen for megolm-key-received event
        end
    end

    Store-->>MD: Reactive update
    MD->>MD: Render message content
```

## Encryption Key Sharing

When a user joins an encrypted channel, they need the Megolm session key:

```mermaid
sequenceDiagram
    participant NewUser as New User
    participant DB as Supabase
    participant Existing as Existing Member
    participant SKS as SecureSessionKeyStore

    NewUser->>DB: Subscribe to megolm_session_shares
    Existing->>DB: INSERT session share for new user
    DB-->>NewUser: Realtime: new key share
    NewUser->>NewUser: Dispatch megolm-key-received CustomEvent
    NewUser->>SKS: Store key in IndexedDB (non-extractable)
    NewUser->>NewUser: Reprocess encrypted messages
```

## Thread Messages

Thread messages use `ThreadService` and bypass encryption entirely - they are always sent as plaintext directly to the database.

## DM Messages

DM (direct message) flow is similar to channel messages but uses the `useDM` store:

```mermaid
flowchart TD
    DM[DM Message] --> CMS[CoreMessageService]
    CMS --> CHECK{Conversation encrypted?}
    CHECK -->|Yes| ENCRYPT[Encrypt with Megolm]
    CHECK -->|No| PLAIN[Plaintext]
    ENCRYPT --> INSERT[INSERT into messages]
    PLAIN --> INSERT
    INSERT --> RT[Realtime broadcast]
    INSERT --> NOTIFY[send_notification trigger]
    RT --> RECIPIENT[Recipient's useDM store]
```

## Message Display

`MessageDisplay` renders the message list with:

- Virtual scrolling for performance (only visible messages rendered)
- Markdown/rich content rendering via `MessageContent` / `UnifiedMessageContent`
- Inline embeds (links, server invites, media)
- Reactions display and interaction
- Reply context and threading indicators
- Encryption status indicator per message

## Realtime Subscription

The chat store subscribes to messages via `RealtimeConnectionManager`:

```mermaid
flowchart TD
    ENTER[Enter channel] --> SUB["subscribeToTable('messages')"]
    SUB --> FILTER[Filter: channel_id = current]
    FILTER --> LISTEN[Listen for INSERT, UPDATE, DELETE]
    LISTEN --> INSERT_EV[INSERT → Add message, decrypt if needed]
    LISTEN --> UPDATE_EV[UPDATE → Edit message content]
    LISTEN --> DELETE_EV[DELETE → Remove from display]
    LEAVE[Leave channel] --> UNSUB[Unsubscribe]
```

## Server Encryption Modes

| Mode | Behavior |
|------|----------|
| `disabled` | All messages plaintext, encryption UI hidden |
| `optional` | Encrypt if keys available, fall back to plaintext |
| `required` | Block send if encryption not set up |

---

*See also: [Authentication Flow](./auth) for how sessions work, and [Real-time Updates](./realtime) for subscription management.*
