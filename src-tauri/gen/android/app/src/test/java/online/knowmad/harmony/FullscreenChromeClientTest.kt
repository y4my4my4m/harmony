package online.knowmad.harmony

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Fullscreen goes to the host; everything else reaches wry's client unchanged. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class FullscreenChromeClientTest {
  private class Host : FullscreenHost {
    val calls = mutableListOf<String>()
    override fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
      calls += "enter"
    }
    override fun exitFullscreen() {
      calls += "exit"
    }
  }

  private class Inner : WebChromeClient() {
    val calls = mutableListOf<String>()
    val poster: Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
      calls += "show"
    }
    override fun onHideCustomView() {
      calls += "hide"
    }
    override fun onPermissionRequest(request: PermissionRequest) {
      calls += "permission"
    }
    override fun onShowFileChooser(
      webView: WebView,
      filePathCallback: ValueCallback<Array<Uri>>,
      fileChooserParams: FileChooserParams,
    ): Boolean {
      calls += "files"
      return true
    }
    override fun onReceivedTitle(view: WebView, title: String?) {
      calls += "title:$title"
    }
    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
      calls += "console"
      return true
    }
    override fun getDefaultVideoPoster(): Bitmap = poster
  }

  private val webView = WebView(ApplicationProvider.getApplicationContext<Application>())

  @Test
  fun fullscreenGoesToTheHostAndNotToWry() {
    val host = Host()
    val inner = Inner()
    val client = FullscreenChromeClient(inner, host)
    client.onShowCustomView(View(webView.context), object : WebChromeClient.CustomViewCallback {
      override fun onCustomViewHidden() {}
    })
    client.onHideCustomView()

    assertEquals(listOf("enter", "exit"), host.calls)
    assertEquals(emptyList<String>(), inner.calls)
  }

  @Test
  fun everyOtherCallbackReachesWry() {
    val inner = Inner()
    val client = FullscreenChromeClient(inner, Host())
    client.onPermissionRequest(object : PermissionRequest() {
      override fun getOrigin(): Uri = Uri.parse("https://x")
      override fun getResources(): Array<String> = arrayOf(RESOURCE_AUDIO_CAPTURE)
      override fun grant(resources: Array<String>) {}
      override fun deny() {}
    })
    assertTrue(client.onShowFileChooser(webView, ValueCallback {}, object : WebChromeClient.FileChooserParams() {
      override fun getMode() = MODE_OPEN
      override fun getAcceptTypes() = arrayOf("image/*")
      override fun isCaptureEnabled() = false
      override fun getTitle(): CharSequence? = null
      override fun getFilenameHint(): String? = null
      override fun createIntent() = android.content.Intent()
    }))
    client.onReceivedTitle(webView, "Harmony")
    assertTrue(client.onConsoleMessage(ConsoleMessage("m", "s", 1, ConsoleMessage.MessageLevel.LOG)))
    assertSame(inner.poster, client.defaultVideoPoster)

    assertEquals(listOf("permission", "files", "title:Harmony", "console"), inner.calls)
  }

  // A callback wry handles and this client does not override would silently fall back to
  // WebChromeClient's default (a denied permission, no file chooser).
  @Test
  fun overridesEveryCallbackWryHandles() {
    val wry = RustWebChromeClient::class.java.declaredMethods.filter { m ->
      Modifier.isPublic(m.modifiers) && !m.isSynthetic && !m.isBridge &&
        runCatching { WebChromeClient::class.java.getMethod(m.name, *m.parameterTypes) }.isSuccess
    }
    assertTrue(wry.size >= 8)
    val missing = wry.filter { m ->
      runCatching { FullscreenChromeClient::class.java.getDeclaredMethod(m.name, *m.parameterTypes) }.isFailure
    }.map { it.name }
    assertEquals(emptyList<String>(), missing)
  }
}
