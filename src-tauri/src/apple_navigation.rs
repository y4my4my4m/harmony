//! wry 0.57's WKNavigationDelegate (WryNavigationDelegate) hands every WKNavigationAction's URL to
//! the webview's navigation handler, subframes included, and the handler cannot tell them apart.
//! This delegate stands in front of wry's: it judges webView:decidePolicyForNavigationAction:
//! decisionHandler: with the target frame, and forwards that call when it allows, and every other
//! delegate method always, to wry's delegate unchanged.

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use tauri::Url;

use crate::external_links::Frame;

/// WKNavigationActionPolicyCancel.
const POLICY_CANCEL: isize = 0;

type Decide = Box<dyn Fn(Frame, &Url) -> bool>;

struct Ivars {
  /// wry's delegate.
  inner: Retained<AnyObject>,
  decide: Decide,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[thread_kind = MainThreadOnly]
  #[ivars = Ivars]
  struct FrameDelegate;

  impl FrameDelegate {
    #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
    fn decide_policy(&self, webview: *mut AnyObject, action: *mut AnyObject, handler: &Block<dyn Fn(isize)>) {
      let ivars = self.ivars();
      // SAFETY: WebKit passes a live WKNavigationAction.
      if let Some((frame, url)) = unsafe { read_action(action) } {
        if !(ivars.decide)(frame, &url) {
          handler.call((POLICY_CANCEL,));
          return;
        }
      }
      unsafe {
        let _: () = msg_send![&*ivars.inner, webView: webview, decidePolicyForNavigationAction: action, decisionHandler: handler];
      }
    }

    // WebKit reads the delegate's methods once, in setNavigationDelegate:. The preferences variant
    // of the policy method takes precedence over the plain one, so it is never reported.
    #[unsafe(method(respondsToSelector:))]
    fn responds_to_selector(&self, sel: Sel) -> bool {
      sel != sel!(webView:decidePolicyForNavigationAction:preferences:decisionHandler:)
        && unsafe {
          let own: bool = msg_send![super(self), respondsToSelector: sel];
          own || msg_send![&*self.ivars().inner, respondsToSelector: sel]
        }
    }

    #[unsafe(method(forwardingTargetForSelector:))]
    fn forwarding_target_for_selector(&self, _sel: Sel) -> *mut AnyObject {
      Retained::as_ptr(&self.ivars().inner) as *mut AnyObject
    }
  }
);

/// The action's frame and URL. A new window has no target frame and counts as a main frame.
unsafe fn read_action(action: *mut AnyObject) -> Option<(Frame, Url)> {
  let target: *mut AnyObject = msg_send![action, targetFrame];
  let main = target.is_null() || {
    let main: bool = msg_send![target, isMainFrame];
    main
  };
  // A message to nil returns nil.
  let request: *mut AnyObject = msg_send![action, request];
  let url: *mut AnyObject = msg_send![request, URL];
  let string: *mut AnyObject = msg_send![url, absoluteString];
  let utf8: *const c_char = msg_send![string, UTF8String];
  if utf8.is_null() {
    return None;
  }
  let url = Url::parse(CStr::from_ptr(utf8).to_str().ok()?).ok()?;
  Some((if main { Frame::Main } else { Frame::Sub }, url))
}

/// objc_setAssociatedObject key: the address is the key.
static DELEGATE_KEY: u8 = 0;

/// Puts `decide` (true lets a navigation happen) in front of the window's wry delegate.
pub fn judge_navigations<F>(window: &tauri::WebviewWindow, decide: F)
where
  F: Fn(Frame, &Url) -> bool + Send + 'static,
{
  let result = window.with_webview(move |webview| {
    let Some(wry) = webview.downcast_ref::<tauri_runtime_wry::Webview>() else {
      return;
    };
    let wk = wry.inner() as *mut AnyObject;
    // with_webview runs on the main thread.
    let Some(mtm) = MainThreadMarker::new() else {
      return;
    };
    if wk.is_null() {
      return;
    }
    unsafe {
      let inner: *mut AnyObject = msg_send![wk, navigationDelegate];
      let Some(inner) = Retained::retain(inner) else {
        eprintln!("[links] the webview has no navigation delegate");
        return;
      };
      let allocated = mtm.alloc::<FrameDelegate>().set_ivars(Ivars { inner, decide: Box::new(decide) });
      let retained: Retained<FrameDelegate> = msg_send![super(allocated), init];
      let delegate = Retained::as_ptr(&retained) as *mut AnyObject;
      // navigationDelegate is weak: the webview keeps the delegate alive.
      objc2::ffi::objc_setAssociatedObject(
        wk,
        &DELEGATE_KEY as *const u8 as *const c_void,
        delegate,
        objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
      );
      let _: () = msg_send![wk, setNavigationDelegate: delegate];
    }
  });
  if let Err(e) = result {
    eprintln!("[links] webview unavailable: {e}");
  }
}
