package online.knowmad.harmony

import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.View
import java.io.ByteArrayOutputStream
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    fitContentToInsets()
    restoreBars()
  }

  // targetSdk 35+ is edge-to-edge on Android 15+: decorFitsSystemWindows(true)
  // is ignored and the IME no longer resizes the window, so the WebView keeps
  // its full height under the keyboard. Insets are applied as padding on the
  // content root on every API level; the bottom edge takes the larger of the
  // navigation bar and the IME.
  private fun fitContentToInsets() {
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  private fun restoreBars() {
    val prefs = getSharedPreferences("harmony_ui", MODE_PRIVATE)
    val status = prefs.getString("status_color", "#16161e") ?: "#16161e"
    val nav = prefs.getString("nav_color", "#16161e") ?: "#16161e"
    applyBars(status, nav, prefs.getBoolean("status_dark", false), prefs.getBoolean("nav_dark", false))
  }

  private fun applyBars(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    runOnUiThread {
      // statusBarColor is a no-op when edge-to-edge is enforced; the inset
      // padding shows the content root background instead.
      parse(statusHex)?.let {
        window.statusBarColor = it
        findViewById<View>(android.R.id.content).setBackgroundColor(it)
      }
      parse(navHex)?.let { window.navigationBarColor = it }
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.isAppearanceLightStatusBars = statusDark
      controller.isAppearanceLightNavigationBars = navDark
    }
  }

  // Extract a video's first frame as a JPEG data URL. Handles local and remote
  // http(s) URLs natively (no CORS). Returns "" on failure.
  fun videoThumbnail(url: String): String {
    val retriever = MediaMetadataRetriever()
    return try {
      if (url.startsWith("http")) {
        retriever.setDataSource(url, HashMap<String, String>())
      } else {
        retriever.setDataSource(url)
      }
      val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        ?: return ""
      val scaled = scaleForThumb(frame)
      val baos = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, 75, baos)
      if (scaled != frame) frame.recycle()
      "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
      ""
    } finally {
      try { retriever.release() } catch (_: Exception) {}
    }
  }

  private fun scaleForThumb(src: Bitmap): Bitmap {
    val max = 640
    val w = src.width
    val h = src.height
    if (w <= max && h <= max) return src
    val ratio = minOf(max.toFloat() / w, max.toFloat() / h)
    return Bitmap.createScaledBitmap(src, (w * ratio).toInt(), (h * ratio).toInt(), true)
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

  private fun parse(hex: String): Int? =
    try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      null
    }
}
