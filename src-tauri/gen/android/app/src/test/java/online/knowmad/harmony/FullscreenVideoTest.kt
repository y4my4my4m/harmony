package online.knowmad.harmony

import android.app.Application
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A page's fullscreen content over the window, left by the page or by Back. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class FullscreenVideoTest {
  private class Callback : WebChromeClient.CustomViewCallback {
    var hidden = 0
    override fun onCustomViewHidden() {
      hidden++
    }
  }

  private lateinit var container: FrameLayout
  private val changes = mutableListOf<Boolean>()
  private lateinit var fullscreen: FullscreenVideo

  @Before
  fun setUp() {
    container = FrameLayout(ApplicationProvider.getApplicationContext())
    container.addView(View(container.context))
    changes.clear()
    fullscreen = FullscreenVideo(container) { changes += it }
  }

  @Test
  fun showsTheContentOverEverythingOnABlackBackground() {
    val content = View(container.context)
    val callback = Callback()
    fullscreen.enterFullscreen(content, callback)

    assertTrue(fullscreen.isActive)
    assertEquals(2, container.childCount)
    assertSame(content, container.getChildAt(1))
    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, content.layoutParams.width)
    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, content.layoutParams.height)
    assertEquals(Color.BLACK, (content.background as ColorDrawable).color)
    assertEquals(listOf(true), changes)
    assertEquals(0, callback.hidden)
  }

  @Test
  fun refusesASecondFullscreenWhileOneIsShown() {
    fullscreen.enterFullscreen(View(container.context), Callback())
    val second = Callback()
    fullscreen.enterFullscreen(View(container.context), second)

    assertEquals(1, second.hidden)
    assertEquals(2, container.childCount)
    assertEquals(listOf(true), changes)
  }

  @Test
  fun thePageLeavingRemovesTheContentWithoutCallingItBack() {
    val content = View(container.context)
    val callback = Callback()
    fullscreen.enterFullscreen(content, callback)
    fullscreen.exitFullscreen()

    assertFalse(fullscreen.isActive)
    assertNull(content.parent)
    assertEquals(1, container.childCount)
    assertEquals(listOf(true, false), changes)
    assertEquals(0, callback.hidden)
  }

  @Test
  fun backTellsThePageOnceAndItsOwnExitIsANoOp() {
    val callback = Callback()
    fullscreen.enterFullscreen(View(container.context), callback)
    fullscreen.leave()
    // The WebView reports the exit it was asked for.
    fullscreen.exitFullscreen()
    fullscreen.leave()

    assertEquals(1, callback.hidden)
    assertEquals(1, container.childCount)
    assertEquals(listOf(true, false), changes)
  }

  @Test
  fun enteringAgainAfterLeavingWorks() {
    fullscreen.enterFullscreen(View(container.context), Callback())
    fullscreen.leave()
    val again = View(container.context)
    fullscreen.enterFullscreen(again, Callback())

    assertSame(again, container.getChildAt(1))
    assertEquals(listOf(true, false, true), changes)
  }
}
