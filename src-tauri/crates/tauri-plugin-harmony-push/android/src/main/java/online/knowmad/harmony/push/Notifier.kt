package online.knowmad.harmony.push

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.util.LruCache
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Renders and cancels notifications for every source: FCM, UnifiedPush and the running app.
 *
 * One Android notification per context (PushPayload.contextKey), tagged with the key under
 * a shared id. The payloads behind each visible notification persist in SharedPreferences,
 * so a "read" message that arrives in a fresh process can remove single messages from a
 * stack, and a payload seen twice (push and running app) alerts once.
 */
object Notifier {
  const val NOTIFICATION_ID = 0x4841
  const val EXTRA_TARGET = "online.knowmad.harmony.push.TARGET"

  /** Application meta-data naming the status bar icon resource. */
  private const val ICON_META = "online.knowmad.harmony.push.icon"
  private const val PREFS = "harmony_push_notifications"
  private const val KEY_ACTIVE = "active"
  private const val TAG = "HarmonyPush"
  private const val MAX_LINES = 7
  private const val MAX_CONTEXTS = 60
  private const val IMAGE_PX = 256
  private const val IMAGE_MAX_BYTES = 2 * 1024 * 1024
  private const val NET_TIMEOUT_MS = 4000

  private val lock = Any()
  private val images = LruCache<String, Bitmap>(32)

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    nm.createNotificationChannels(
      listOf(
        NotificationChannel(PushPayload.CHANNEL_MESSAGES, "Direct messages", NotificationManager.IMPORTANCE_HIGH)
          .apply { description = "Direct and group messages" },
        NotificationChannel(PushPayload.CHANNEL_MENTIONS, "Mentions and replies", NotificationManager.IMPORTANCE_HIGH)
          .apply { description = "Mentions, replies and thread replies" },
        NotificationChannel(PushPayload.CHANNEL_SOCIAL, "Reactions and social", NotificationManager.IMPORTANCE_DEFAULT)
          .apply { description = "Reactions, follows, boosts, requests and invites" },
      )
    )
  }

  /**
   * Adds the payload to its context and posts it. fetchImages downloads missing avatars first;
   * callers on the main thread pass false and follow with refreshImages off it.
   */
  fun show(context: Context, payload: PushPayload, fetchImages: Boolean) {
    val app = context.applicationContext
    ensureChannels(app)
    if (fetchImages) prefetch(listOf(payload.avatar, payload.icon))
    synchronized(lock) {
      val store = load(app)
      val key = payload.contextKey
      val active = activeTags(app)
      val previous = store[key]?.takeIf { key in active }.orEmpty()
      if (previous.any { it.id == payload.id }) return
      val lines = (previous + payload).takeLast(MAX_LINES)
      store.remove(key)
      store[key] = lines
      retain(store, active + key)
      save(app, store)
      post(app, key, lines, alert = true)
    }
  }

  /** Downloads the images a posted context lacks and re-posts it silently. */
  fun refreshImages(context: Context, key: String) {
    val app = context.applicationContext
    val lines = synchronized(lock) { load(app)[key] } ?: return
    val urls = lines.flatMap { listOf(it.avatar, it.icon) }.filter { it.isNotEmpty() && images.get(it) == null }
    if (urls.isEmpty()) return
    prefetch(urls)
    synchronized(lock) {
      val current = load(app)[key] ?: return
      if (key in activeTags(app)) post(app, key, current, alert = false)
    }
  }

  fun apply(context: Context, dismissal: Dismissal) {
    if (dismissal.all) cancelAll(context) else cancel(context, dismissal.ids)
  }

  /** Removes these notification ids; a stack that keeps other messages is re-posted silently. */
  fun cancel(context: Context, ids: Set<String>) {
    if (ids.isEmpty()) return
    val app = context.applicationContext
    synchronized(lock) {
      val store = load(app)
      val active = activeTags(app)
      val nm = NotificationManagerCompat.from(app)
      var changed = false
      for (key in store.keys.toList()) {
        val lines = store[key] ?: continue
        val remaining = lines.filterNot { it.id in ids }
        if (remaining.size == lines.size) continue
        changed = true
        if (remaining.isEmpty() || key !in active) {
          nm.cancel(key, NOTIFICATION_ID)
          store.remove(key)
        } else {
          store[key] = remaining
          post(app, key, remaining, alert = false)
        }
      }
      if (changed) save(app, store)
    }
  }

  fun cancelAll(context: Context) {
    val app = context.applicationContext
    synchronized(lock) {
      val nm = NotificationManagerCompat.from(app)
      for (key in load(app).keys + activeTags(app)) nm.cancel(key, NOTIFICATION_ID)
      save(app, LinkedHashMap())
    }
  }

  /** Cancels every notification whose id is not listed. */
  fun cancelExcept(context: Context, keep: Set<String>) {
    val ids = synchronized(lock) { load(context.applicationContext).values.flatten().map { it.id } }
    cancel(context, ids.filterNot { it in keep }.toSet())
  }

  /** Cancels the messages of a conversation or channel, as the web's dismissNotifications does. */
  fun cancelWhere(context: Context, conversationId: String?, channelId: String?) {
    val ids = synchronized(lock) {
      load(context.applicationContext).values.flatten().filter {
        (!conversationId.isNullOrEmpty() && it.conversationId == conversationId) ||
          (!channelId.isNullOrEmpty() && it.channelId == channelId)
      }.map { it.id }
    }
    cancel(context, ids.toSet())
  }

  /** Drops a context the user opened by tapping it; Android already removed the notification. */
  fun forget(context: Context, key: String) {
    val app = context.applicationContext
    synchronized(lock) {
      val store = load(app)
      if (store.remove(key) != null) save(app, store)
    }
  }

  /** Visible payloads per context, oldest first. */
  fun active(context: Context): Map<String, List<PushPayload>> =
    synchronized(lock) { load(context.applicationContext) }

  // Posting is gated on areNotificationsEnabled and a refusal is caught.
  @SuppressLint("MissingPermission")
  private fun post(app: Context, key: String, lines: List<PushPayload>, alert: Boolean) {
    if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return
    val latest = lines.last()
    val launch = launchIntent(app, LaunchTarget.of(latest, lines.map { it.id }))
    val content = PendingIntent.getActivity(
      app,
      key.hashCode(),
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val builder = NotificationCompat.Builder(app, latest.channel)
      .setSmallIcon(smallIcon(app))
      .setAutoCancel(true)
      .setContentIntent(content)
      .setWhen(latest.sentAt)
      .setShowWhen(true)
      .setNumber(lines.size)
      .setOnlyAlertOnce(!alert)
      .setSilent(!alert)
      .setPriority(
        if (latest.channel == PushPayload.CHANNEL_SOCIAL) NotificationCompat.PRIORITY_DEFAULT
        else NotificationCompat.PRIORITY_HIGH
      )
      .setCategory(if (latest.isMessage) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_SOCIAL)

    val large = cached(latest.icon) ?: cached(latest.avatar)
    large?.let { builder.setLargeIcon(circle(it)) }

    if (latest.isMessage) {
      val self = Person.Builder().setName("You").setKey("self").build()
      val style = NotificationCompat.MessagingStyle(self)
      if (latest.conv.isNotEmpty()) {
        style.conversationTitle = latest.conv
        style.isGroupConversation = true
      }
      for (line in lines) {
        style.addMessage(line.body.ifEmpty { line.title }, line.sentAt, person(line))
      }
      builder.setStyle(style)
      publishShortcut(app, key, latest, person(latest), large, launch)?.let { builder.setShortcutId(it) }
    } else {
      builder
        .setContentTitle(latest.title)
        .setContentText(latest.body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(latest.body))
    }

    try {
      NotificationManagerCompat.from(app).notify(key, NOTIFICATION_ID, builder.build())
    } catch (e: SecurityException) {
      Log.w(TAG, "notify refused: ${e.message}")
    }
  }

  private fun person(payload: PushPayload): Person {
    val name = payload.sender.ifEmpty { payload.title.ifEmpty { "Harmony" } }
    val builder = Person.Builder().setName(name).setKey(name)
    cached(payload.avatar)?.let { builder.setIcon(IconCompat.createWithBitmap(circle(it))) }
    return builder.build()
  }

  // A long-lived conversation shortcut moves the notification into Android 11+'s
  // conversation section.
  private fun publishShortcut(
    app: Context,
    key: String,
    latest: PushPayload,
    person: Person,
    icon: Bitmap?,
    launch: Intent,
  ): String? = try {
    val shortcut = ShortcutInfoCompat.Builder(app, key)
      .setLongLived(true)
      .setShortLabel(latest.conv.ifEmpty { latest.sender.ifEmpty { latest.title.ifEmpty { "Harmony" } } })
      .setIntent(launch)
      .setPerson(person)
      .apply { icon?.let { setIcon(IconCompat.createWithBitmap(circle(it))) } }
      .build()
    ShortcutManagerCompat.pushDynamicShortcut(app, shortcut)
    key
  } catch (e: Exception) {
    Log.w(TAG, "shortcut not published: ${e.message}")
    null
  }

  private fun launchIntent(app: Context, target: LaunchTarget): Intent {
    val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)
      ?: Intent(Intent.ACTION_MAIN).setPackage(app.packageName)
    return intent
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_TARGET, target.toJson().toString())
  }

  @Suppress("DEPRECATION")
  private fun smallIcon(app: Context): Int {
    val info = try {
      app.packageManager.getApplicationInfo(app.packageName, PackageManager.GET_META_DATA)
    } catch (e: PackageManager.NameNotFoundException) {
      app.applicationInfo
    }
    val res = info.metaData?.getInt(ICON_META, 0) ?: 0
    return if (res != 0) res else info.icon
  }

  private fun activeTags(app: Context): Set<String> = try {
    app.getSystemService(NotificationManager::class.java)
      ?.activeNotifications
      ?.filter { it.id == NOTIFICATION_ID && it.tag != null }
      ?.map { it.tag }
      ?.toSet()
      .orEmpty()
  } catch (e: Exception) {
    emptySet()
  }

  // Oldest contexts go first; entries whose notification is gone are dropped.
  private fun retain(store: LinkedHashMap<String, List<PushPayload>>, visible: Set<String>) {
    store.keys.retainAll(visible)
    while (store.size > MAX_CONTEXTS) store.remove(store.keys.first())
  }

  private fun load(app: Context): LinkedHashMap<String, List<PushPayload>> {
    val out = LinkedHashMap<String, List<PushPayload>>()
    val raw = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ACTIVE, null) ?: return out
    try {
      val root = JSONObject(raw)
      val keys = root.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        val array = root.optJSONArray(key) ?: continue
        val lines = (0 until array.length()).mapNotNull { i ->
          array.optJSONObject(i)?.let { PushPayload.fromJson(it, it.optLong("at")) }
        }
        if (lines.isNotEmpty()) out[key] = lines
      }
    } catch (e: Exception) {
      Log.w(TAG, "notification store unreadable, reset: ${e.message}")
    }
    return out
  }

  private fun save(app: Context, store: Map<String, List<PushPayload>>) {
    val root = JSONObject()
    for ((key, lines) in store) {
      root.put(key, JSONArray(lines.map { toJson(it) }))
    }
    app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ACTIVE, root.toString()).commit()
  }

  private fun toJson(p: PushPayload): JSONObject = JSONObject().apply {
    put("id", p.id)
    put("type", p.type)
    put("title", p.title)
    put("body", p.body)
    put("sender", p.sender)
    put("conv", p.conv)
    put("avatar", p.avatar)
    put("icon", p.icon)
    put("url", p.url)
    put("conversation_id", p.conversationId)
    put("server_id", p.serverId)
    put("channel_id", p.channelId)
    put("thread_id", p.threadId)
    put("message_id", p.messageId)
    put("post_id", p.postId)
    put("at", p.sentAt)
  }

  private fun cached(url: String): Bitmap? = if (url.isEmpty()) null else images.get(url)

  private fun prefetch(urls: List<String>) {
    for (url in urls.distinct()) {
      if (url.isEmpty() || images.get(url) != null) continue
      download(url)?.let { images.put(url, it) }
    }
  }

  private fun download(url: String): Bitmap? {
    var conn: HttpURLConnection? = null
    return try {
      conn = URL(url).openConnection() as HttpURLConnection
      conn.connectTimeout = NET_TIMEOUT_MS
      conn.readTimeout = NET_TIMEOUT_MS
      if (conn.responseCode !in 200..299) return null
      val bytes = conn.inputStream.use { input ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          out.write(buffer, 0, n)
          if (out.size() > IMAGE_MAX_BYTES) return null
        }
        out.toByteArray()
      }
      decode(bytes)
    } catch (e: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }

  private fun decode(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= IMAGE_PX && bounds.outHeight / (sample * 2) >= IMAGE_PX) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
  }

  private fun circle(src: Bitmap): Bitmap {
    val size = minOf(src.width, src.height)
    val left = (src.width - size) / 2
    val top = (src.height - size) / 2
    val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint().apply { isAntiAlias = true }
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    canvas.drawBitmap(src, Rect(left, top, left + size, top + size), Rect(0, 0, size, size), paint)
    return output
  }
}
