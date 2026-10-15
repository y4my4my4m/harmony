// A titled window that plays a sound for the stream-audio probe.
//
//   ToneWindow native <title> <wav>    the app's own process plays the file, looped
//   ToneWindow webkit <title> <html>   a WKWebView plays the page; WebKit's GPU process renders
//
// Launched through `open`, so LaunchServices makes it its own responsible process.

import AVFoundation
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count == 4 else {
  FileHandle.standardError.write("usage: ToneWindow native|webkit <title> <file>\n".data(using: .utf8)!)
  exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
  contentRect: NSRect(x: 120, y: 120, width: 480, height: 320),
  styleMask: [.titled, .closable],
  backing: .buffered,
  defer: false)
window.title = args[2]
let file = URL(fileURLWithPath: args[3])

var player: AVAudioPlayer?
var web: WKWebView?
switch args[1] {
case "native":
  let p = try AVAudioPlayer(contentsOf: file)
  p.numberOfLoops = -1
  p.play()
  player = p
case "webkit":
  let config = WKWebViewConfiguration()
  config.mediaTypesRequiringUserActionForPlayback = []
  let view = WKWebView(frame: window.contentView!.bounds, configuration: config)
  view.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
  window.contentView = view
  web = view
default:
  exit(64)
}

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
