package online.knowmad.harmony

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    (application as HarmonyApplication).attach(this)
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

  fun applyBars(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
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

  private fun parse(hex: String): Int? =
    try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      null
    }
}
