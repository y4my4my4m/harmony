package online.knowmad.harmony

import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.widget.FrameLayout

// Shows a page's fullscreen content over the whole window. onChange(true) runs once the
// content is shown, onChange(false) once it is gone.
class FullscreenVideo(
  private val container: ViewGroup,
  private val onChange: (Boolean) -> Unit,
) : FullscreenHost {
  private var view: View? = null
  private var callback: WebChromeClient.CustomViewCallback? = null

  val isActive: Boolean
    get() = view != null

  override fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    if (this.view != null) {
      callback.onCustomViewHidden()
      return
    }
    this.view = view
    this.callback = callback
    view.setBackgroundColor(Color.BLACK)
    container.addView(
      view,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    onChange(true)
  }

  // The page left fullscreen.
  override fun exitFullscreen() {
    remove()
  }

  // The user left fullscreen (Back): the page is told through its callback.
  fun leave() {
    remove()?.onCustomViewHidden()
  }

  private fun remove(): WebChromeClient.CustomViewCallback? {
    val shown = view ?: return null
    val pending = callback
    view = null
    callback = null
    container.removeView(shown)
    onChange(false)
    return pending
  }
}
