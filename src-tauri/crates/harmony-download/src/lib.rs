//! Downloads an http(s) URL into a folder under a given name, resuming after a dropped
//! connection.
//!
//! Bytes go to `<target>.harmony-part`; once complete the file takes a name free in the folder:
//! `<name>`, else `<stem> (<n>)<.ext>`, never replacing a file. An attempt that fails on the
//! network, answers 408, 429 or 5xx, or ends short of its Content-Length is repeated after the
//! next of `delays` with `Range: bytes=<written>-` and `If-Range` (the first answer's strong ETag,
//! else its Last-Modified). A 206 from `<written>` continues the file; a 200 (the resource
//! changed, or the server ignores Range) restarts it. The delays start over once the file grows
//! past the most it has held.
//!
//! The finished file carries the platform's downloaded-from-the-internet mark: the
//! `Zone.Identifier` stream on Windows, the `com.apple.quarantine` attribute on macOS.

use std::fs::{File, OpenOptions};
use std::future::Future;
use std::io::{ErrorKind, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use reqwest::header::{HeaderMap, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::{StatusCode, Url};
use tokio::sync::Notify;

/// Waits before each repeated attempt; the download fails after the last.
pub const RETRY_DELAYS: [Duration; 6] = [
  Duration::from_secs(1),
  Duration::from_secs(2),
  Duration::from_secs(5),
  Duration::from_secs(10),
  Duration::from_secs(20),
  Duration::from_secs(30),
];

/// Minimum spacing of progress events.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// Suffix of a download in progress. Firefox's partial files end in `.part`; this one is never
/// one of theirs.
pub const PART_SUFFIX: &str = ".harmony-part";

/// A `PART_SUFFIX` file unmodified this long is left from a download that ended with the app; a
/// running download writes or retries within RETRY_DELAYS plus the 60 s read timeout.
pub const STALE_PART_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Longest file name written, bytes; ext4, APFS and NTFS allow 255.
const MAX_NAME_BYTES: usize = 200;

/// Names tried before a download gives up on finding a free one.
const NAME_ATTEMPTS: usize = 16;

/// Appended to a name the shell acts on (neutralize_shell_name).
const SHELL_SAFE_SUFFIX: &str = ".download";

/// Extensions a desktop shell acts on when a folder is listed or the file opened: .lnk and .url
/// point anywhere, .scf, .library-ms and .searchConnector-ms make Explorer reach remote paths,
/// .local redirects DLL loading, .desktop is a Linux launcher. Chromium IsShellIntegratedExtension
/// (lnk, local, {CLSID}) plus the rest.
const SHELL_EXTENSIONS: [&str; 7] = ["lnk", "local", "url", "scf", "library-ms", "searchconnector-ms", "desktop"];

/// Names Explorer reads from any folder it lists; Chromium IsReservedNameOnWindows magic names.
const SHELL_NAMES: [&str; 2] = ["desktop.ini", "thumbs.db"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
  /// `total` is 0 while the length is unknown.
  Progress { loaded: u64, total: u64 },
  /// Attempt `attempt` (1-based) of RETRY_DELAYS is about to run.
  Retrying { attempt: u32 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
  Cancelled,
  InvalidUrl,
  Http(u16),
  Network(String),
  Io(String),
}

impl std::fmt::Display for Error {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Error::Cancelled => write!(f, "cancelled"),
      Error::InvalidUrl => write!(f, "only http and https URLs are downloaded"),
      Error::Http(status) => write!(f, "HTTP {status}"),
      Error::Network(message) => write!(f, "{message}"),
      Error::Io(message) => write!(f, "{message}"),
    }
  }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
  fn from(error: std::io::Error) -> Self {
    Error::Io(error.to_string())
  }
}

/// Cancellation of a download. Ends the request, the body read or the retry wait in progress.
#[derive(Debug, Default)]
pub struct Cancel {
  flag: AtomicBool,
  notify: Notify,
}

impl Cancel {
  pub fn cancel(&self) {
    self.flag.store(true, Ordering::SeqCst);
    self.notify.notify_waiters();
  }

  pub fn is_cancelled(&self) -> bool {
    self.flag.load(Ordering::SeqCst)
  }

  async fn cancelled(&self) {
    loop {
      let mut notified = std::pin::pin!(self.notify.notified());
      // notify_waiters wakes only registered waiters: register before reading the flag.
      notified.as_mut().enable();
      if self.is_cancelled() {
        return;
      }
      notified.await;
    }
  }
}

/// `work`, or Err(Cancelled) as soon as `cancel` fires.
async fn or_cancel<T>(cancel: &Cancel, work: impl Future<Output = T>) -> Result<T, Error> {
  tokio::select! {
    biased;
    () = cancel.cancelled() => Err(Error::Cancelled),
    value = work => Ok(value),
  }
}

/// HTTP client for downloads. reqwest's rustls-no-provider needs a process-wide crypto provider;
/// ring, as tauri-plugin-updater installs.
pub fn client() -> Result<reqwest::Client, String> {
  if rustls::crypto::CryptoProvider::get_default().is_none() {
    let _ = rustls::crypto::ring::default_provider().install_default();
  }
  reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(20))
    .read_timeout(Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())
}

/// Unicode 15.1 general category Cf: bidi overrides and isolates (U+202E shows `x<U+202E>fdp.exe`
/// as `xexe.pdf`), zero-width characters, invisible operators, tags.
fn is_format_char(c: char) -> bool {
  matches!(
    c,
    '\u{AD}'
      | '\u{600}'..='\u{605}'
      | '\u{61C}'
      | '\u{6DD}'
      | '\u{70F}'
      | '\u{890}'..='\u{891}'
      | '\u{8E2}'
      | '\u{180E}'
      | '\u{200B}'..='\u{200F}'
      | '\u{202A}'..='\u{202E}'
      | '\u{2060}'..='\u{2064}'
      | '\u{2066}'..='\u{206F}'
      | '\u{FEFF}'
      | '\u{FFF9}'..='\u{FFFB}'
      | '\u{110BD}'
      | '\u{110CD}'
      | '\u{13430}'..='\u{1343F}'
      | '\u{1BCA0}'..='\u{1BCA3}'
      | '\u{1D173}'..='\u{1D17A}'
      | '\u{E0001}'
      | '\u{E0020}'..='\u{E007F}'
  )
}

/// `name` as a file name every desktop OS accepts and no shell acts on. Path separators and
/// control characters become `_`, on Windows also `< > : " | ? *`; a Windows reserved device name
/// gets a leading `_`. Format characters (Cf) are dropped and whitespace and dots go from both
/// ends, as Chromium ReplaceIllegalCharactersInPath. Shell-integrated names get SHELL_SAFE_SUFFIX.
/// Quotes, spaces and non-ASCII stay elsewhere.
pub fn safe_file_name(name: &str) -> String {
  let forbidden = |c: char| {
    c.is_control() || c == '/' || c == '\\' || (cfg!(windows) && matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
  };
  let replaced: String =
    name.chars().filter(|&c| !is_format_char(c)).map(|c| if forbidden(c) { '_' } else { c }).collect();
  let mut cleaned = replaced.trim_matches(|c: char| c.is_whitespace() || c == '.').to_string();
  if cleaned.is_empty() {
    cleaned = "download".to_string();
  }
  if cfg!(windows) {
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
      || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
      cleaned.insert(0, '_');
    }
  }
  neutralize_shell_name(truncate_name(&cleaned))
}

/// SHELL_SAFE_SUFFIX after a SHELL_EXTENSIONS extension, a `{CLSID}` extension or a SHELL_NAMES
/// name. Chromium replaces such an extension with `download`; the original stays readable here.
fn neutralize_shell_name(name: String) -> String {
  let lower = name.to_lowercase();
  let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
  let shell = SHELL_NAMES.contains(&lower.as_str())
    || SHELL_EXTENSIONS.contains(&extension)
    || (extension.len() > 2 && extension.starts_with('{') && extension.ends_with('}'));
  if shell {
    name + SHELL_SAFE_SUFFIX
  } else {
    name
  }
}

/// Splits `name` into stem and extension (with its dot); a leading dot is part of the stem.
fn split_extension(name: &str) -> (&str, &str) {
  match name.rfind('.') {
    Some(i) if i > 0 && name.len() - i <= 16 => (&name[..i], &name[i..]),
    _ => (name, ""),
  }
}

fn truncate_name(name: &str) -> String {
  if name.len() <= MAX_NAME_BYTES {
    return name.to_string();
  }
  let (stem, ext) = split_extension(name);
  let mut end = MAX_NAME_BYTES.saturating_sub(ext.len());
  while end > 0 && !stem.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}{}", &stem[..end.min(stem.len())], ext)
}

fn part_path(target: &Path) -> PathBuf {
  let mut name = target.as_os_str().to_owned();
  name.push(PART_SUFFIX);
  PathBuf::from(name)
}

fn taken(path: &Path) -> bool {
  path.exists() || part_path(path).exists()
}

/// `dir/name`, or `dir/<stem> (<n>)<.ext>` with the lowest n free; a name is taken by a file or
/// by a download in progress (PART_SUFFIX).
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
  let first = dir.join(name);
  if !taken(&first) {
    return first;
  }
  let (stem, ext) = split_extension(name);
  for n in 1..10_000u32 {
    let candidate = dir.join(format!("{stem} ({n}){ext}"));
    if !taken(&candidate) {
      return candidate;
    }
  }
  let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  dir.join(format!("{stem} ({stamp}){ext}"))
}

/// Creates the PART_SUFFIX file of a free name; a name another download claims between the check
/// and the creation is passed over. Returns the target and its part.
fn open_part(dir: &Path, name: &str) -> Result<(PathBuf, PathBuf, File), Error> {
  for _ in 0..NAME_ATTEMPTS {
    let target = free_path(dir, name);
    let part = part_path(&target);
    match OpenOptions::new().write(true).create_new(true).open(&part) {
      Ok(file) => return Ok((target, part, file)),
      Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(error.into()),
    }
  }
  Err(Error::Io(format!("no free name for {name}")))
}

/// Gives the finished `part` the name `target`, or the next free one: hard_link fails on an
/// existing destination, so a file that appeared meanwhile is never replaced. A folder without
/// hard links (FAT, some network shares) takes a rename after an existence check.
fn place(part: &Path, target: PathBuf, dir: &Path, name: &str) -> Result<PathBuf, Error> {
  let mut destination = target;
  for _ in 0..NAME_ATTEMPTS {
    match std::fs::hard_link(part, &destination) {
      Ok(()) => {
        let _ = std::fs::remove_file(part);
        return Ok(destination);
      }
      Err(error) if error.kind() == ErrorKind::AlreadyExists => destination = free_path(dir, name),
      Err(_) if destination.exists() => destination = free_path(dir, name),
      Err(_) => {
        std::fs::rename(part, &destination)?;
        return Ok(destination);
      }
    }
  }
  Err(Error::Io(format!("no free name for {name}")))
}

/// Removes PART_SUFFIX files in `dir` older than STALE_PART_AGE. Symlinks and folders stay.
fn remove_stale_parts(dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  let now = SystemTime::now();
  for entry in entries.flatten() {
    if !entry.file_name().to_string_lossy().ends_with(PART_SUFFIX) {
      continue;
    }
    // DirEntry::metadata does not follow symlinks.
    let Ok(meta) = entry.metadata() else {
      continue;
    };
    let stale = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= STALE_PART_AGE);
    if meta.is_file() && stale {
      let _ = std::fs::remove_file(entry.path());
    }
  }
}

/// `Zone.Identifier` stream content for a file from `url`: Internet zone (3), and the URL without
/// credentials, query or fragment (a signed URL's token is in the query).
#[cfg_attr(not(windows), allow(dead_code))]
fn zone_identifier(url: &Url) -> String {
  let mut host = url.clone();
  let _ = host.set_username("");
  let _ = host.set_password(None);
  host.set_query(None);
  host.set_fragment(None);
  format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={host}\r\n")
}

/// `com.apple.quarantine` value: flags 0x0081 (downloaded; as Chrome writes), the time in hex
/// seconds since the epoch, the agent name, and no LaunchServices event UUID.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn quarantine_value(at: SystemTime) -> String {
  let seconds = at.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  format!("0081;{seconds:08x};Harmony;")
}

/// Marks `path` as downloaded from `url`, for SmartScreen and Office Protected View. A volume
/// without alternate data streams (FAT) leaves it unmarked.
#[cfg(windows)]
fn mark_downloaded(path: &Path, url: &Url) {
  let mut stream = path.as_os_str().to_owned();
  stream.push(":Zone.Identifier");
  let _ = std::fs::write(PathBuf::from(stream), zone_identifier(url));
}

/// Marks `path` as downloaded, for Gatekeeper. A volume without extended attributes leaves it
/// unmarked.
#[cfg(target_os = "macos")]
fn mark_downloaded(path: &Path, _url: &Url) {
  use std::os::unix::ffi::OsStrExt;
  let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
    return;
  };
  let value = quarantine_value(SystemTime::now());
  // SAFETY: both strings are NUL-terminated and outlive the call; value is len bytes.
  unsafe {
    libc::setxattr(path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0);
  }
}

/// Linux desktops keep no such mark.
#[cfg(not(any(windows, target_os = "macos")))]
fn mark_downloaded(_path: &Path, _url: &Url) {}

/// First byte and complete length of `bytes <first>-<last>/<length|*>`.
pub fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
  let rest = value.trim().strip_prefix("bytes")?.trim_start();
  let (range, length) = rest.split_once('/')?;
  let (first, last) = range.split_once('-')?;
  let first: u64 = first.trim().parse().ok()?;
  let last: u64 = last.trim().parse().ok()?;
  if last < first {
    return None;
  }
  let length = match length.trim() {
    "*" => None,
    n => Some(n.parse().ok()?),
  };
  Some((first, length))
}

/// If-Range value: a strong ETag, else Last-Modified. A weak ETag cannot validate a range.
fn validator_of(headers: &HeaderMap) -> Option<String> {
  let etag = headers.get(ETAG).and_then(|v| v.to_str().ok()).filter(|v| !v.starts_with("W/"));
  etag
    .or_else(|| headers.get(LAST_MODIFIED).and_then(|v| v.to_str().ok()))
    .map(str::to_string)
}

enum Outcome {
  Done,
  Retry(Error),
}

struct Transfer<'a, F: FnMut(Event)> {
  file: File,
  written: u64,
  total: Option<u64>,
  validator: Option<String>,
  cancel: &'a Cancel,
  on_event: F,
  last_event: Option<Instant>,
}

impl<F: FnMut(Event)> Transfer<'_, F> {
  fn report(&mut self, force: bool) {
    let now = Instant::now();
    if !force && self.last_event.is_some_and(|t| now.duration_since(t) < PROGRESS_INTERVAL) {
      return;
    }
    self.last_event = Some(now);
    (self.on_event)(Event::Progress { loaded: self.written, total: self.total.unwrap_or(0) });
  }

  fn restart(&mut self) -> Result<(), Error> {
    self.file.set_len(0)?;
    self.file.seek(SeekFrom::Start(0))?;
    self.written = 0;
    self.total = None;
    self.validator = None;
    Ok(())
  }

  /// One request; Err for an answer that ends the download.
  async fn attempt(&mut self, client: &reqwest::Client, url: &Url) -> Result<Outcome, Error> {
    let cancel = self.cancel;
    let mut request = client.get(url.clone());
    if self.written > 0 {
      request = request.header(RANGE, format!("bytes={}-", self.written));
      if let Some(validator) = &self.validator {
        request = request.header(IF_RANGE, validator.as_str());
      }
    }
    let mut response = match or_cancel(cancel, request.send()).await? {
      Ok(response) => response,
      Err(error) => return Ok(Outcome::Retry(Error::Network(error.to_string()))),
    };
    let status = response.status();
    if status == StatusCode::PARTIAL_CONTENT && self.written > 0 {
      let range = response.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range);
      match range {
        Some((first, length)) if first == self.written => {
          if length.is_some() {
            self.total = length;
          }
        }
        // A range other than the one asked for: start over without one.
        _ => {
          self.restart()?;
          return Ok(Outcome::Retry(Error::Network("unexpected Content-Range".into())));
        }
      }
    } else if status == StatusCode::OK {
      if self.written > 0 {
        self.restart()?;
      }
      self.total = response.content_length();
      self.validator = validator_of(response.headers());
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE && self.written > 0 && self.total == Some(self.written) {
      return Ok(Outcome::Done);
    } else if status.is_server_error() || status == StatusCode::REQUEST_TIMEOUT || status == StatusCode::TOO_MANY_REQUESTS {
      return Ok(Outcome::Retry(Error::Http(status.as_u16())));
    } else {
      return Err(Error::Http(status.as_u16()));
    }

    loop {
      match or_cancel(cancel, response.chunk()).await? {
        Ok(Some(bytes)) => {
          self.file.write_all(&bytes)?;
          self.written += bytes.len() as u64;
          self.report(false);
        }
        Ok(None) => break,
        Err(error) => return Ok(Outcome::Retry(Error::Network(error.to_string()))),
      }
    }
    if self.total.is_some_and(|total| self.written < total) {
      return Ok(Outcome::Retry(Error::Network("connection closed early".into())));
    }
    Ok(Outcome::Done)
  }
}

async fn fetch<F: FnMut(Event) + Send>(
  client: &reqwest::Client,
  url: &Url,
  file: File,
  cancel: &Cancel,
  delays: &[Duration],
  on_event: F,
) -> Result<(), Error> {
  let mut transfer = Transfer { file, written: 0, total: None, validator: None, cancel, on_event, last_event: None };
  let mut retries = 0usize;
  let mut most = 0u64;
  loop {
    if cancel.is_cancelled() {
      return Err(Error::Cancelled);
    }
    let outcome = transfer.attempt(client, url).await?;
    match outcome {
      Outcome::Done => {
        transfer.file.flush()?;
        transfer.file.sync_all()?;
        if transfer.total.is_none() {
          transfer.total = Some(transfer.written);
        }
        transfer.report(true);
        return Ok(());
      }
      Outcome::Retry(error) => {
        if transfer.written > most {
          most = transfer.written;
          retries = 0;
        }
        let Some(delay) = delays.get(retries) else {
          return Err(error);
        };
        retries += 1;
        (transfer.on_event)(Event::Retrying { attempt: retries as u32 });
        or_cancel(cancel, tokio::time::sleep(*delay)).await?;
      }
    }
  }
}

/// Downloads `url` into `dir` as `name` (made safe and free, see free_path); returns the path
/// written. `cancel` ends it at once; the partial file is removed on any failure. Stale partial
/// files in `dir` (STALE_PART_AGE) are removed first.
pub async fn download<F: FnMut(Event) + Send>(
  client: &reqwest::Client,
  url: &str,
  dir: &Path,
  name: &str,
  cancel: &Cancel,
  delays: &[Duration],
  on_event: F,
) -> Result<PathBuf, Error> {
  let url = Url::parse(url).map_err(|_| Error::InvalidUrl)?;
  if !matches!(url.scheme(), "http" | "https") {
    return Err(Error::InvalidUrl);
  }
  if cancel.is_cancelled() {
    return Err(Error::Cancelled);
  }
  std::fs::create_dir_all(dir)?;
  remove_stale_parts(dir);
  let safe = safe_file_name(name);
  let (target, part, file) = open_part(dir, &safe)?;
  let placed = match fetch(client, &url, file, cancel, delays, on_event).await {
    // Marked before it takes its name: the stream or attribute moves with the file.
    Ok(()) => {
      mark_downloaded(&part, &url);
      place(&part, target, dir, &safe)
    }
    Err(error) => Err(error),
  };
  if placed.is_err() {
    let _ = std::fs::remove_file(&part);
  }
  placed
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader};
  use std::net::TcpListener;
  use std::sync::{Arc, Mutex};

  type Responder = Box<dyn Fn() -> Vec<u8> + Send>;

  /// Answers each connection with the next response, then closes it; records request heads.
  fn serve(responses: Vec<Responder>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/file.bin", listener.local_addr().unwrap());
    let heads = Arc::new(Mutex::new(Vec::new()));
    let seen = heads.clone();
    std::thread::spawn(move || {
      for (stream, respond) in listener.incoming().zip(responses) {
        let mut stream = stream.unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
          let mut line = String::new();
          if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
          }
          head.push_str(&line.to_ascii_lowercase());
        }
        seen.lock().unwrap().push(head);
        let _ = stream.write_all(&respond());
        let _ = stream.flush();
      }
    });
    (url, heads)
  }

  /// A response that waits `hold` with the connection open, then sends `head`.
  fn stall(head: &'static [u8], hold: Duration) -> Responder {
    Box::new(move || {
      std::thread::sleep(hold);
      head.to_vec()
    })
  }

  fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("harmony-download-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
  }

  fn names(d: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
  }

  const QUICK: [Duration; 3] = [Duration::from_millis(5); 3];

  #[tokio::test]
  async fn resumes_with_range_after_the_connection_drops() {
    let (url, heads) = serve(vec![
      Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"e1\"\r\nConnection: close\r\n\r\n01234".to_vec()),
      Box::new(|| b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 5-9/10\r\nContent-Length: 5\r\nConnection: close\r\n\r\n56789".to_vec()),
    ]);
    let d = dir("resume");
    let mut events = Vec::new();
    let path = download(&client().unwrap(), &url, &d, "amogus \"ünï\".zip", &Cancel::default(), &QUICK, |e| events.push(e))
      .await
      .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"0123456789");
    assert_eq!(path.file_name().unwrap().to_string_lossy(), safe_file_name("amogus \"ünï\".zip"));
    let heads = heads.lock().unwrap();
    assert!(!heads[0].contains("range:"));
    assert!(heads[1].contains("range: bytes=5-"), "{}", heads[1]);
    assert!(heads[1].contains("if-range: \"e1\""), "{}", heads[1]);
    assert!(events.contains(&Event::Retrying { attempt: 1 }));
    assert_eq!(events.last(), Some(&Event::Progress { loaded: 10, total: 10 }));
    assert!(!part_path(&path).exists());
  }

  #[tokio::test]
  async fn restarts_when_the_server_answers_a_range_with_the_whole_file() {
    let (url, _) = serve(vec![
      Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc".to_vec()),
      Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef".to_vec()),
    ]);
    let d = dir("restart");
    let path = download(&client().unwrap(), &url, &d, "a.txt", &Cancel::default(), &QUICK, |_| {}).await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"abcdef");
  }

  #[tokio::test]
  async fn a_refusal_ends_the_download_and_leaves_no_file() {
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec())]);
    let d = dir("refusal");
    let result = download(&client().unwrap(), &url, &d, "gone.bin", &Cancel::default(), &QUICK, |_| {}).await;
    assert_eq!(result, Err(Error::Http(404)));
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
  }

  #[tokio::test]
  async fn gives_up_after_the_last_delay() {
    let short = || -> Responder { Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nab".to_vec()) };
    let (url, heads) = serve(vec![short(), short(), short(), short()]);
    let d = dir("give-up");
    let result = download(&client().unwrap(), &url, &d, "x.bin", &Cancel::default(), &QUICK[..1], |_| {}).await;
    assert!(matches!(result, Err(Error::Network(_))), "{result:?}");
    assert_eq!(heads.lock().unwrap().len(), 2);
  }

  /// Runs `download` and cancels it after 100 ms; the result must come well inside the 60 s
  /// read timeout and the 30 s retry wait.
  async fn cancelled_after_a_moment(url: String, d: &Path, delays: &[Duration]) -> Result<PathBuf, Error> {
    let cancel = Arc::new(Cancel::default());
    let trigger = cancel.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(100)).await;
      trigger.cancel();
    });
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(5), download(&client().unwrap(), &url, d, "c.bin", &cancel, delays, |_| {}))
      .await
      .expect("cancel did not end the download");
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    result
  }

  #[tokio::test]
  async fn cancel_ends_a_request_waiting_for_its_answer() {
    let (url, _) = serve(vec![stall(b"", Duration::from_secs(20))]);
    let d = dir("cancel-send");
    assert_eq!(cancelled_after_a_moment(url, &d, &QUICK).await, Err(Error::Cancelled));
    assert_eq!(names(&d), Vec::<String>::new());
  }

  #[tokio::test]
  async fn cancel_ends_a_stalled_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/file.bin", listener.local_addr().unwrap());
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut line = String::new();
      while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
        line.clear();
      }
      let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n01234");
      let _ = stream.flush();
      std::thread::sleep(Duration::from_secs(20));
    });
    let d = dir("cancel-body");
    assert_eq!(cancelled_after_a_moment(url, &d, &QUICK).await, Err(Error::Cancelled));
    assert_eq!(names(&d), Vec::<String>::new());
  }

  #[tokio::test]
  async fn cancel_ends_the_wait_before_a_retry() {
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec())]);
    let d = dir("cancel-wait");
    assert_eq!(cancelled_after_a_moment(url, &d, &[Duration::from_secs(30)]).await, Err(Error::Cancelled));
    assert_eq!(names(&d), Vec::<String>::new());
  }

  #[tokio::test]
  async fn a_download_cancelled_before_it_starts_writes_nothing() {
    let d = dir("cancel-first");
    let cancel = Cancel::default();
    cancel.cancel();
    let result = download(&client().unwrap(), "http://127.0.0.1:9/never", &d, "n.bin", &cancel, &QUICK, |_| {}).await;
    assert_eq!(result, Err(Error::Cancelled));
    assert_eq!(names(&d), Vec::<String>::new());
  }

  #[test]
  fn takes_the_first_free_name() {
    let d = dir("names");
    std::fs::write(d.join("a.zip"), b"").unwrap();
    std::fs::write(d.join(format!("a (1).zip{PART_SUFFIX}")), b"").unwrap();
    assert_eq!(free_path(&d, "a.zip"), d.join("a (2).zip"));
    assert_eq!(free_path(&d, "b.zip"), d.join("b.zip"));
  }

  #[test]
  fn never_replaces_a_file_that_took_the_name_meanwhile() {
    let d = dir("place");
    let (target, part, mut file) = open_part(&d, "a.zip").unwrap();
    assert_eq!(target, d.join("a.zip"));
    file.write_all(b"new").unwrap();
    drop(file);
    // Another program saves a.zip after the download chose the name.
    std::fs::write(d.join("a.zip"), b"theirs").unwrap();
    let placed = place(&part, target, &d, "a.zip").unwrap();
    assert_eq!(placed, d.join("a (1).zip"));
    assert_eq!(std::fs::read(d.join("a.zip")).unwrap(), b"theirs");
    assert_eq!(std::fs::read(&placed).unwrap(), b"new");
    assert_eq!(names(&d), vec!["a (1).zip", "a.zip"]);
  }

  #[test]
  fn a_name_claimed_by_another_download_is_passed_over() {
    let d = dir("claim");
    let (first, _, _) = open_part(&d, "a.zip").unwrap();
    let (second, part, _) = open_part(&d, "a.zip").unwrap();
    assert_eq!(first, d.join("a.zip"));
    assert_eq!(second, d.join("a (1).zip"));
    assert_eq!(part, d.join(format!("a (1).zip{PART_SUFFIX}")));
  }

  #[tokio::test]
  async fn removes_its_own_stale_partial_files_only() {
    let d = dir("stale");
    let old = SystemTime::now() - STALE_PART_AGE - Duration::from_secs(60);
    for name in [format!("old.zip{PART_SUFFIX}"), "firefox.zip.part".into(), "notes.txt".into(), format!("fresh.zip{PART_SUFFIX}")] {
      let file = File::create(d.join(&name)).unwrap();
      if !name.starts_with("fresh") {
        file.set_modified(old).unwrap();
      }
    }
    std::fs::create_dir(d.join(format!("folder{PART_SUFFIX}"))).unwrap();
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec())]);
    download(&client().unwrap(), &url, &d, "new.bin", &Cancel::default(), &QUICK, |_| {}).await.unwrap();
    assert_eq!(
      names(&d),
      vec![
        "firefox.zip.part".to_string(),
        format!("folder{PART_SUFFIX}"),
        format!("fresh.zip{PART_SUFFIX}"),
        "new.bin".into(),
        "notes.txt".into(),
      ]
    );
  }

  #[test]
  fn file_names_keep_what_the_os_allows() {
    assert_eq!(safe_file_name("../etc/passwd"), "_etc_passwd");
    assert_eq!(safe_file_name("  report final.pdf. "), "report final.pdf");
    assert_eq!(safe_file_name(""), "download");
    assert_eq!(safe_file_name(" . .. "), "download");
    assert_eq!(safe_file_name("a\u{0}b\nc.txt"), "a_b_c.txt");
    if cfg!(windows) {
      assert_eq!(safe_file_name("it's \"q\" ünï?.zip"), "it's _q_ ünï_.zip");
      assert_eq!(safe_file_name("con.txt"), "_con.txt");
    } else {
      assert_eq!(safe_file_name("it's \"q\" ünï?.zip"), "it's \"q\" ünï?.zip");
    }
    let long = format!("{}.tar.gz", "é".repeat(300));
    let cut = safe_file_name(&long);
    assert!(cut.len() <= MAX_NAME_BYTES);
    assert!(cut.ends_with(".gz"));
  }

  #[test]
  fn file_names_lose_format_characters_and_leading_dots() {
    // Displayed as "invoiceexe.pdf".
    assert_eq!(safe_file_name("invoice\u{202E}fdp.exe"), "invoicefdp.exe");
    assert_eq!(safe_file_name("\u{200B}\u{2066}a\u{FEFF}b\u{2069}.png\u{200F}"), "ab.png");
    assert_eq!(safe_file_name("\u{E0041}tag.txt"), "tag.txt");
    assert_eq!(safe_file_name(".bashrc"), "bashrc");
    assert_eq!(safe_file_name("\u{202E}..hidden"), "hidden");
    assert_eq!(safe_file_name("ünï 🎉.zip"), "ünï 🎉.zip");
  }

  #[test]
  fn file_names_the_shell_acts_on_get_a_suffix() {
    let shell = [
      "evil.lnk",
      "Evil.LNK",
      "x.url",
      "x.scf",
      "x.library-ms",
      "x.searchConnector-ms",
      "x.desktop",
      "x.local",
      "x.{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
      "desktop.ini",
      "Thumbs.db",
    ];
    for name in shell {
      assert_eq!(safe_file_name(name), format!("{name}{SHELL_SAFE_SUFFIX}"), "{name}");
    }
    assert_eq!(safe_file_name("x.lnk. "), "x.lnk.download");
    for name in ["link.txt", "lnk", "desktop", "my.desktop.png", "desktop.ini.bak", "x.{}"] {
      assert_eq!(safe_file_name(name), name, "{name}");
    }
    let long = format!("{}.lnk", "a".repeat(300));
    assert!(safe_file_name(&long).ends_with(".lnk.download"));
  }

  #[test]
  fn the_zone_identifier_names_the_host_without_the_token() {
    let url = Url::parse("https://user:pw@db.example/storage/v1/object/sign/message_media/a.zip?token=secret&download=a.zip#x").unwrap();
    assert_eq!(
      zone_identifier(&url),
      "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://db.example/storage/v1/object/sign/message_media/a.zip\r\n"
    );
  }

  #[test]
  fn the_quarantine_value_is_flags_time_and_agent() {
    let at = std::time::UNIX_EPOCH + Duration::from_secs(0x6720_1234);
    assert_eq!(quarantine_value(at), "0081;67201234;Harmony;");
  }

  #[cfg(windows)]
  #[tokio::test]
  async fn a_finished_file_is_in_the_internet_zone() {
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec())]);
    let d = dir("zone");
    let path = download(&client().unwrap(), &format!("{url}?token=t"), &d, "z.exe", &Cancel::default(), &QUICK, |_| {}).await.unwrap();
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let zone = std::fs::read_to_string(PathBuf::from(stream)).unwrap();
    assert_eq!(zone, format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={url}\r\n"));
  }

  #[cfg(target_os = "macos")]
  #[tokio::test]
  async fn a_finished_file_is_quarantined() {
    use std::os::unix::ffi::OsStrExt;
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec())]);
    let d = dir("quarantine");
    let path = download(&client().unwrap(), &url, &d, "q.app.zip", &Cancel::default(), &QUICK, |_| {}).await.unwrap();
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut value = [0u8; 128];
    // SAFETY: NUL-terminated strings; value is 128 writable bytes.
    let len = unsafe {
      libc::getxattr(c_path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0)
    };
    assert!(len > 0);
    assert!(std::str::from_utf8(&value[..len as usize]).unwrap().starts_with("0081;"));
  }

  #[test]
  fn parses_content_ranges() {
    assert_eq!(parse_content_range("bytes 5-9/10"), Some((5, Some(10))));
    assert_eq!(parse_content_range("bytes 0-0/*"), Some((0, None)));
    assert_eq!(parse_content_range("bytes 9-5/10"), None);
    assert_eq!(parse_content_range("items 0-1/2"), None);
  }
}
