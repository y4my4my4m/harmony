package online.knowmad.harmony

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.net.URL

class MainActivity : TauriActivity() {
  private val channelId = "harmony_messages"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, true)
    createChannel()
    restoreBars()
  }

  private fun restoreBars() {
    val prefs = getSharedPreferences("harmony_ui", MODE_PRIVATE)
    val status = prefs.getString("status_color", "#16161e") ?: "#16161e"
    val nav = prefs.getString("nav_color", "#16161e") ?: "#16161e"
    applyBars(status, nav, prefs.getBoolean("status_dark", false), prefs.getBoolean("nav_dark", false))
  }

  private fun applyBars(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    runOnUiThread {
      WindowCompat.setDecorFitsSystemWindows(window, true)
      parse(statusHex)?.let { window.statusBarColor = it }
      parse(navHex)?.let { window.navigationBarColor = it }
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.isAppearanceLightStatusBars = statusDark
      controller.isAppearanceLightNavigationBars = navDark
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      val channel = NotificationChannel(channelId, "Messages", NotificationManager.IMPORTANCE_HIGH)
      manager.createNotificationChannel(channel)
    }
  }

  fun showNotification(
    id: Int,
    sender: String,
    conversationTitle: String,
    message: String,
    avatarUrl: String,
    largeIconUrl: String,
    groupKey: String,
  ) {
    Thread {
      val avatar = download(avatarUrl)
      val largeIcon = download(largeIconUrl) ?: avatar

      val personBuilder = Person.Builder().setName(sender).setKey(sender)
      if (avatar != null) personBuilder.setIcon(IconCompat.createWithBitmap(circleCrop(avatar)))
      val person = personBuilder.build()

      val style = NotificationCompat.MessagingStyle(person)
      if (conversationTitle.isNotEmpty()) {
        style.conversationTitle = conversationTitle
        style.isGroupConversation = true
      }
      style.addMessage(message, System.currentTimeMillis(), person)

      val launch =
        packageManager.getLaunchIntentForPackage(packageName)
          ?: Intent(Intent.ACTION_MAIN).setPackage(packageName)
      val pending =
        PendingIntent.getActivity(
          this,
          id,
          launch,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

      // conversation shortcut promotes the notification to Android's conversation
      // section: title/avatar prominent, app name de-emphasized (Discord-style)
      val shortcutId = if (groupKey.isNotEmpty()) groupKey else "conv_$id"
      val shortcutIcon = largeIcon?.let { IconCompat.createWithBitmap(circleCrop(it)) }
      val shortcut =
        ShortcutInfoCompat.Builder(this, shortcutId)
          .setLongLived(true)
          .setShortLabel(if (conversationTitle.isNotEmpty()) conversationTitle else sender)
          .setIntent(launch)
          .setPerson(person)
          .apply { shortcutIcon?.let { setIcon(it) } }
          .build()
      ShortcutManagerCompat.pushDynamicShortcut(this, shortcut)

      val builder =
        NotificationCompat.Builder(this, channelId)
          .setSmallIcon(R.drawable.ic_stat_harmony)
          .setStyle(style)
          .setShortcutId(shortcutId)
          .setAutoCancel(true)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setContentIntent(pending)
      largeIcon?.let { builder.setLargeIcon(circleCrop(it)) }
      if (groupKey.isNotEmpty()) builder.setGroup(groupKey)

      getSystemService(NotificationManager::class.java).notify(id, builder.build())
    }
      .start()
  }

  fun openUrl(url: String) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(intent)
    } catch (e: Exception) {
      android.util.Log.w("Harmony", "openUrl failed: ${e.message}")
    }
  }

  fun startCallService() {
    val i = Intent(this, CallForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
  }

  fun stopCallService() {
    stopService(Intent(this, CallForegroundService::class.java))
  }

  private fun download(url: String): Bitmap? =
    if (url.isEmpty()) {
      null
    } else {
      try {
        val conn = URL(url).openConnection()
        conn.connect()
        BitmapFactory.decodeStream(conn.getInputStream())
      } catch (e: Exception) {
        null
      }
    }

  fun setSystemBarColors(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    getSharedPreferences("harmony_ui", MODE_PRIVATE)
      .edit()
      .putString("status_color", statusHex)
      .putString("nav_color", navHex)
      .putBoolean("status_dark", statusDark)
      .putBoolean("nav_dark", navDark)
      .apply()
    applyBars(statusHex, navHex, statusDark, navDark)
  }

  private fun circleCrop(src: Bitmap): Bitmap {
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

  private fun parse(hex: String): Int? =
    try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      null
    }
}
