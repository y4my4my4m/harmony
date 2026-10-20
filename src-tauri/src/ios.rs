use objc2::msg_send;
use objc2::runtime::AnyObject;

// UIScrollViewContentInsetAdjustmentNever. The default, Automatic, insets the
// WKWebView scroll view by the safe area on top of the page's own
// env(safe-area-inset-*) padding (index.html sets viewport-fit=cover), and the
// page scrolls by that inset. Never is Capacitor's default for the same setup.
const CONTENT_INSET_ADJUSTMENT_NEVER: isize = 2;

/// The page lays out under the status bar and home indicator and pads itself.
pub fn fill_safe_area(window: &tauri::WebviewWindow) {
  let result = window.with_webview(|webview| {
    let Some(wry) = webview.downcast_ref::<tauri_runtime_wry::Webview>() else {
      return;
    };
    let wk = wry.inner() as *mut AnyObject;
    if wk.is_null() {
      return;
    }
    // with_webview runs on the main thread; wk is a live WKWebView.
    unsafe {
      let scroll: *mut AnyObject = msg_send![wk, scrollView];
      if !scroll.is_null() {
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: CONTENT_INSET_ADJUSTMENT_NEVER];
      }
    }
  });
  if let Err(e) = result {
    eprintln!("[ios] webview unavailable: {e}");
  }
}
