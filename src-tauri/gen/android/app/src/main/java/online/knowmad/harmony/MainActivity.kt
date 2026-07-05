package online.knowmad.harmony

import android.graphics.Color
import android.os.Bundle
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, true)
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
