package online.knowmad.harmony.push

import org.json.JSONArray
import org.json.JSONObject

/**
 * One notification as the app renders it. Built from an FCM data map, a decrypted
 * UnifiedPush body, or the webview's show command; the field names are the ones
 * appPushData in federation-backend/src/services/pushPolicy.ts writes.
 */
data class PushPayload(
  val id: String,
  val type: String,
  val title: String,
  val body: String,
  val sender: String,
  val conv: String,
  val avatar: String,
  val icon: String,
  val url: String,
  val conversationId: String,
  val serverId: String,
  val channelId: String,
  val threadId: String,
  val messageId: String,
  val postId: String,
  val sentAt: Long,
) {
  /** DMs, group chats and channel messages stack per conversation in MessagingStyle. */
  val isMessage: Boolean get() = type in MESSAGE_TYPES

  val channel: String get() = channelFor(type)

  /**
   * Android notification tag. Messages share one notification per conversation, thread or
   * channel; everything else gets its own.
   */
  val contextKey: String
    get() = when {
      !isMessage -> "n:$id"
      conversationId.isNotEmpty() -> "conv:$conversationId"
      threadId.isNotEmpty() -> "thread:$threadId"
      channelId.isNotEmpty() -> "ch:$channelId"
      else -> "n:$id"
    }

  companion object {
    const val CHANNEL_MESSAGES = "harmony_messages"
    const val CHANNEL_MENTIONS = "harmony_mentions"
    const val CHANNEL_SOCIAL = "harmony_social"

    val MESSAGE_TYPES = setOf("dm", "chat_message", "mention", "reply", "thread_reply")

    private val MENTION_TYPES = setOf("mention", "reply", "thread_reply", "activitypub_mention", "activitypub_reply")
    private val DIRECT_TYPES = setOf("dm", "chat_message", "test")

    fun channelFor(type: String): String = when (type) {
      in DIRECT_TYPES -> CHANNEL_MESSAGES
      in MENTION_TYPES -> CHANNEL_MENTIONS
      else -> CHANNEL_SOCIAL
    }

    /** Null when the map is not a displayable notification. */
    fun fromMap(data: Map<String, String?>, sentAt: Long = System.currentTimeMillis()): PushPayload? {
      fun field(key: String, max: Int = 512): String = (data[key] ?: "").take(max)
      val id = field("id", 64)
      val title = field("title", 200)
      val body = field("body", 1000)
      if (id.isEmpty() || (title.isEmpty() && body.isEmpty())) return null
      return PushPayload(
        id = id,
        type = field("type", 64),
        title = title,
        body = body,
        sender = field("sender", 128),
        conv = field("conv", 160),
        avatar = httpUrl(field("avatar")),
        icon = httpUrl(field("icon")),
        url = field("url", 1024),
        conversationId = field("conversation_id", 64),
        serverId = field("server_id", 64),
        channelId = field("channel_id", 64),
        threadId = field("thread_id", 64),
        messageId = field("message_id", 64),
        postId = field("post_id", 64),
        sentAt = if (sentAt > 0) sentAt else System.currentTimeMillis(),
      )
    }

    fun fromJson(json: JSONObject, sentAt: Long = System.currentTimeMillis()): PushPayload? =
      fromMap(jsonToMap(json), sentAt)

    fun jsonToMap(json: JSONObject): Map<String, String> {
      val out = HashMap<String, String>()
      val keys = json.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        val value = json.opt(key)
        if (value is String) out[key] = value
      }
      return out
    }

    private fun httpUrl(url: String): String =
      if (url.startsWith("https://") || url.startsWith("http://")) url else ""
  }
}

/** A "read" message: cancel these ids, or everything. */
data class Dismissal(val ids: Set<String>, val all: Boolean) {
  companion object {
    fun fromMap(data: Map<String, String?>): Dismissal? {
      if (data["kind"] != "read") return null
      if (data["all"] == "1" || data["all"] == "true") return Dismissal(emptySet(), true)
      val ids = (data["ids"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
      return if (ids.isEmpty()) null else Dismissal(ids, false)
    }
  }
}

/**
 * Where a tapped notification leads. Travels as JSON in the Notifier.EXTRA_TARGET intent
 * extra; the field names are PushLaunchTarget's in src/services/androidPush.ts.
 */
data class LaunchTarget(
  val id: String,
  val ids: List<String>,
  val type: String,
  val url: String,
  val conversationId: String,
  val serverId: String,
  val channelId: String,
  val threadId: String,
  val messageId: String,
  val postId: String,
  val contextKey: String,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("ids", JSONArray(ids))
    put("type", type)
    put("url", url)
    put("conversation_id", conversationId)
    put("server_id", serverId)
    put("channel_id", channelId)
    put("thread_id", threadId)
    put("message_id", messageId)
    put("post_id", postId)
    put("ctx", contextKey)
  }

  companion object {
    fun of(latest: PushPayload, ids: List<String>): LaunchTarget = LaunchTarget(
      id = latest.id,
      ids = ids,
      type = latest.type,
      url = latest.url,
      conversationId = latest.conversationId,
      serverId = latest.serverId,
      channelId = latest.channelId,
      threadId = latest.threadId,
      messageId = latest.messageId,
      postId = latest.postId,
      contextKey = latest.contextKey,
    )
  }
}
