package online.knowmad.harmony

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
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
    groupKey: String,
  ) {
    Thread {
      val avatar =
        if (avatarUrl.isNotEmpty()) {
          try {
            val conn = URL(avatarUrl).openConnection()
            conn.connect()
            BitmapFactory.decodeStream(conn.getInputStream())
          } catch (e: Exception) {
            null
          }
        } else {
          null
        }

      val personBuilder = Person.Builder().setName(sender)
      if (avatar != null) personBuilder.setIcon(IconCompat.createWithBitmap(avatar))
      val person = personBuilder.build()

      val style = NotificationCompat.MessagingStyle(person)
      if (conversationTitle.isNotEmpty()) {
        style.conversationTitle = conversationTitle
        style.isGroupConversation = true
      }
      style.addMessage(message, System.currentTimeMillis(), person)

      val launch = packageManager.getLaunchIntentForPackage(packageName)
      val pending =
        PendingIntent.getActivity(
          this,
          id,
          launch,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

      val builder =
        NotificationCompat.Builder(this, channelId)
          .setSmallIcon(R.drawable.ic_stat_harmony)
          .setStyle(style)
          .setAutoCancel(true)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setContentIntent(pending)
      if (groupKey.isNotEmpty()) builder.setGroup(groupKey)

      getSystemService(NotificationManager::class.java).notify(id, builder.build())
    }
      .start()
  }

  fun setSystemBarColors(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    runOnUiThread {
      WindowCompat.setDecorFitsSystemWindows(window, true)
      parse(statusHex)?.let { window.statusBarColor = it }
      parse(navHex)?.let { window.navigationBarColor = it }
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.isAppearanceLightStatusBars = statusDark
      controller.isAppearanceLightNavigationBars = navDark
    }
  }

  private fun parse(hex: String): Int? =
    try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      null
    }
}
