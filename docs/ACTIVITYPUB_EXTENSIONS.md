# Harmony ActivityPub Extensions Specification

**Namespace URI:** `https://harmonyapp.dev/ns#`
**Prefix:** `harmony`
**Version:** Draft 0.1
**Status:** Informal - not yet submitted as a FEP

This document specifies the ActivityPub vocabulary extensions used by Harmony to federate chat-server functionality (channels, threads, voice, moderation, roles) alongside standard Fediverse interactions.

All `harmony:` properties are optional and ignored by implementations that do not understand them. Standard ActivityPub fields remain the authoritative data; Harmony extensions provide supplementary metadata for richer interoperability between Harmony instances.

---

## Table of Contents

1. [JSON-LD Context](#1-json-ld-context)
2. [Actor Extensions (Person)](#2-actor-extensions-person)
3. [Note Extensions (Channel Messages)](#3-note-extensions-channel-messages)
4. [Group Extensions (Chat Servers)](#4-group-extensions-chat-servers)
5. [Channel Object Types](#5-channel-object-types)
6. [Thread Extensions](#6-thread-extensions)
7. [Join Activity Extensions](#7-join-activity-extensions)
8. [Moderation Extensions](#8-moderation-extensions)
9. [Role Extensions](#9-role-extensions)
10. [Voice Extensions](#10-voice-extensions)
11. [Compatibility Notes](#11-compatibility-notes)
12. [Future Work](#12-future-work)

---

## 1. JSON-LD Context

Harmony activities include the namespace in the `@context` array:

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "harmony": "https://harmonyapp.dev/ns#"
    }
  ]
}
```

Domain-specific contexts may extend this with shorthand mappings:

```json
{
  "harmony": "https://harmonyapp.dev/ns#",
  "rawContent": "harmony:rawContent",
  "channelName": "harmony:channelName",
  "channelType": "harmony:channelType",
  "serverId": "harmony:serverId",
  "serverName": "harmony:serverName"
}
```

Voice activities use an additional namespace:

```json
{
  "harmony": "https://harmony.social/ns/voice"
}
```

---

## 2. Actor Extensions (Person)

Applied to `Person` actors representing user profiles.

### `harmony:profileColor`

- **Type:** `string` (CSS hex color)
- **Description:** User's accent/profile color, used for name display and profile cards.

### `harmony:customStatus`

- **Type:** `object`
- **Description:** User's custom status (similar to Discord's custom status).
- **Properties:**
  - `text` (string) - Status text
  - `emoji` (string, optional) - Unicode emoji
  - `emoji_url` (string, optional) - URL to custom emoji image

**Example:**

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", {"harmony": "https://harmonyapp.dev/ns#"}],
  "type": "Person",
  "id": "https://harmony.example.com/users/alice",
  "preferredUsername": "alice",
  "harmony:profileColor": "#ff5500",
  "harmony:customStatus": {
    "text": "Building cool things",
    "emoji": "🔨"
  }
}
```

---

## 3. Note Extensions (Channel Messages)

Applied to `Note` objects representing messages sent within server channels.

### `harmony:rawContent`

- **Type:** `array` (MessagePart[])
- **Description:** Structured message content preserving rich formatting, mentions, emoji, and file attachments. Standard `content` (HTML) remains the primary display; `rawContent` enables lossless round-tripping between Harmony instances.

### `harmony:channelName`

- **Type:** `string`
- **Description:** Display name of the channel the message was sent in.

### `harmony:channelType`

- **Type:** `string` - `"text"` | `"voice"`
- **Description:** Type of the originating channel.

### `harmony:serverId`

- **Type:** `string` (UUID)
- **Description:** Local UUID of the originating server.

### `harmony:serverName`

- **Type:** `string`
- **Description:** Display name of the originating server.

**Example:**

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "harmony": "https://harmonyapp.dev/ns#",
      "rawContent": "harmony:rawContent",
      "channelName": "harmony:channelName",
      "channelType": "harmony:channelType",
      "serverId": "harmony:serverId",
      "serverName": "harmony:serverName"
    }
  ],
  "type": "Create",
  "actor": "https://harmony.example.com/users/alice",
  "object": {
    "type": "Note",
    "content": "<p>Hello everyone!</p>",
    "rawContent": [{"type": "text", "text": "Hello everyone!"}],
    "channelName": "general",
    "channelType": "text",
    "serverId": "550e8400-e29b-41d4-a716-446655440000",
    "serverName": "My Server"
  }
}
```

---

## 4. Group Extensions (Chat Servers)

Applied to `Group` actors representing chat servers.

### `harmony:type`

- **Type:** `string` - `"ChatServer"`
- **Description:** Identifies this Group as a Harmony chat server (as opposed to a generic ActivityPub Group).

### `harmony:memberCount`

- **Type:** `number`
- **Description:** Current member count.

### `harmony:channels`

- **Type:** `array`
- **Description:** Ordered list of channel objects describing the server's structure.

**Context:**

```json
{
  "harmony": "https://harmonyapp.dev/ns#",
  "ChatServer": "harmony:ChatServer",
  "TextChannel": "harmony:TextChannel",
  "VoiceChannel": "harmony:VoiceChannel",
  "channels": "harmony:channels",
  "memberCount": "harmony:memberCount"
}
```

**Example:**

```json
{
  "type": "Group",
  "id": "https://harmony.example.com/servers/my-server",
  "name": "My Server",
  "harmony:type": "ChatServer",
  "harmony:memberCount": 42,
  "harmony:channels": [
    {
      "type": "harmony:Category",
      "name": "Text Channels",
      "position": 0
    },
    {
      "type": "harmony:TextChannel",
      "id": "https://harmony.example.com/channels/general",
      "name": "general",
      "position": 0,
      "category": "https://harmony.example.com/categories/text"
    },
    {
      "type": "harmony:VoiceChannel",
      "id": "https://harmony.example.com/channels/voice-lobby",
      "name": "Voice Lobby",
      "position": 1
    }
  ]
}
```

---

## 5. Channel Object Types

Used in `harmony:channels` arrays and in `Add`/`Update`/`Remove` activities for channel management.

| Type | Description |
|------|-------------|
| `harmony:Category` | A category grouping channels together |
| `harmony:TextChannel` | A text chat channel |
| `harmony:VoiceChannel` | A voice/video channel |

Channel objects may include: `id`, `localId`, `name`, `position`, `order`, `category`/`categoryId`, `description`, `channelType`.

---

## 6. Thread Extensions

Applied to thread objects (conversations within a channel message).

### `harmony:ChatThread`

- **Type:** Object type identifier
- **Description:** Marks an object as a Harmony chat thread.

### `harmony:autoArchiveDuration`

- **Type:** `number` (minutes)
- **Description:** Duration after which the thread auto-archives.

### `harmony:messageCount`

- **Type:** `number`

### `harmony:memberCount`

- **Type:** `number`

### `harmony:lastMessageAt`

- **Type:** `string` (ISO 8601 timestamp)

**Context:**

```json
{
  "ChatThread": "harmony:ChatThread",
  "autoArchiveDuration": "harmony:autoArchiveDuration",
  "messageCount": "harmony:messageCount",
  "memberCount": "harmony:memberCount",
  "lastMessageAt": "harmony:lastMessageAt"
}
```

---

## 7. Join Activity Extensions

### `harmony:inviteCode`

- **Type:** `string`
- **Applies To:** `Join` activity targeting a Group (server)
- **Description:** Invite code for joining private servers. The receiving instance validates the code before accepting membership.

**Example:**

```json
{
  "type": "Join",
  "actor": "https://remote.example.com/users/bob",
  "object": "https://harmony.example.com/servers/my-server",
  "harmony:inviteCode": "abc123"
}
```

---

## 8. Moderation Extensions

### `harmony:Ban`

- **Type:** Activity type
- **Description:** Bans a user from a server. Sent as a standalone activity (not wrapped in `Create`).

### `harmony:expiresAt`

- **Type:** `string` (ISO 8601 timestamp, optional)
- **Applies To:** `harmony:Ban`
- **Description:** When the ban expires. Omitting means permanent.

**Context:**

```json
{
  "harmony": "https://harmonyapp.dev/ns#",
  "Ban": "harmony:Ban",
  "expiresAt": "harmony:expiresAt"
}
```

**Example:**

```json
{
  "type": "harmony:Ban",
  "actor": "https://harmony.example.com/users/admin",
  "object": "https://remote.example.com/users/troll",
  "target": "https://harmony.example.com/servers/my-server",
  "harmony:expiresAt": "2025-06-01T00:00:00Z"
}
```

Unbanning is expressed as `Undo` wrapping a `harmony:Ban`.

---

## 9. Role Extensions

### `harmony:Role`

- **Type:** Object type identifier

### `harmony:permissions`

- **Type:** `object` (permission bitmask/flags)

### `harmony:hoist`

- **Type:** `boolean`
- **Description:** Whether this role is displayed separately in the member list.

### `harmony:mentionable`

- **Type:** `boolean`
- **Description:** Whether this role can be @-mentioned.

**Context:**

```json
{
  "Role": "harmony:Role",
  "permissions": "harmony:permissions",
  "hoist": "harmony:hoist",
  "mentionable": "harmony:mentionable"
}
```

---

## 10. Voice Extensions

Voice activities use a separate context namespace: `https://harmony.social/ns/voice`.

### Activity Types

| Type | Direction | Description |
|------|-----------|-------------|
| `harmony:VoiceCallInvite` | Caller → Callee | Initiate a DM voice/video call |
| `harmony:VoiceCallAccept` | Callee → Caller | Accept a call |
| `harmony:VoiceCallReject` | Callee → Caller | Reject a call |
| `harmony:VoiceCallEnd` | Either → Other | End an active call |
| `harmony:VoiceChannelJoin` | User → Server | Request to join a voice channel |
| `harmony:VoiceChannelLeave` | User → Server | Leave a voice channel |
| `harmony:VoiceChannelJoinAccept` | Server → User | Accept with LiveKit token |
| `harmony:VoiceChannelJoinReject` | Server → User | Reject voice join |

### Object Types

| Type | Used In | Description |
|------|---------|-------------|
| `harmony:VoiceCall` | `VoiceCallInvite` object | Call metadata (callType, conversationId, livekitUrl, roomName) |
| `harmony:VoiceChannel` | Join/Leave object | Voice channel reference |
| `harmony:VoiceToken` | `VoiceChannelJoinAccept` result | LiveKit token and connection metadata |

---

## 11. Compatibility Notes

### How other Fediverse software handles Harmony extensions

- **Mastodon / Misskey / Pleroma / Akkoma:** Unknown JSON-LD properties are silently ignored. Harmony `Note` objects are rendered using the standard `content` field. Server-related metadata (`channelName`, `serverName`, etc.) is not displayed but does not cause errors.
- **Group support:** `Group` actors are partially supported by Lemmy, Friendica, and Hubzilla. Harmony's `harmony:ChatServer` type is ignored; the `Group` is treated as a generic group.
- **Voice activities:** Entirely Harmony-specific. Other implementations ignore these.
- **Moderation:** `harmony:Ban` is Harmony-specific. Standard `Block` and `Flag` activities are also emitted where applicable for wider compatibility.

### Graceful degradation

All Harmony extensions degrade gracefully:
- Messages fall back to `content` (HTML) when `rawContent` is unavailable
- Servers fall back to generic `Group` actors
- Voice, moderation, and role activities are simply not processed

---

## 12. Future Work

- **FEP submission:** Formalize `harmony:ChatServer` and channel structure as a Fediverse Enhancement Proposal for chat-server federation patterns
- **E2EE key exchange over ActivityPub:** Federate Megolm session keys between Harmony instances
- **Instance discovery:** `/.well-known/harmony-instance` endpoint for Harmony-to-Harmony discovery
- **Namespace consolidation:** Unify `harmonyapp.dev/ns#` and `harmony.social/ns/voice` under a single namespace
- **Reaction federation:** Standardize emoji reaction format across chat platforms
