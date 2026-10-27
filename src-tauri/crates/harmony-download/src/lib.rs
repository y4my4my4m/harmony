//! Downloads an http(s) URL into a folder under a given name, resuming after a dropped
//! connection.
//!
//! Bytes go to `<target>.part`; once complete the file takes a name free in the folder: `<name>`,
//! else `<stem> (<n>)<.ext>`. An attempt that fails on the network, answers 408, 429 or 5xx, or
//! ends short of its Content-Length is repeated after the next of `delays` with
//! `Range: bytes=<written>-` and `If-Range` (the first answer's strong ETag, else its
//! Last-Modified). A 206 from `<written>` continues the file; a 200 (the resource changed, or the
//! server ignores Range) restarts it. The delays start over once the file grows past the most it
//! has held.

use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::{StatusCode, Url};

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

/// Longest file name written, bytes; ext4, APFS and NTFS allow 255.
const MAX_NAME_BYTES: usize = 200;

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

/// `name` as a file name every desktop OS accepts. Path separators and control characters become
/// `_`; on Windows also `< > : " | ? *` and the reserved device names. Quotes, spaces and
/// non-ASCII stay elsewhere.
pub fn safe_file_name(name: &str) -> String {
  let forbidden = |c: char| {
    c.is_control() || c == '/' || c == '\\' || (cfg!(windows) && matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
  };
  let replaced: String = name.chars().map(|c| if forbidden(c) { '_' } else { c }).collect();
  let mut cleaned = replaced.trim().trim_end_matches(['.', ' ']).to_string();
  if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
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
  truncate_name(&cleaned)
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
  name.push(".part");
  PathBuf::from(name)
}

fn taken(path: &Path) -> bool {
  path.exists() || part_path(path).exists()
}

/// `dir/name`, or `dir/<stem> (<n>)<.ext>` with the lowest n free; a name is taken by a file or
/// by a download in progress (`.part`).
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
  cancel: &'a AtomicBool,
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
    let mut request = client.get(url.clone());
    if self.written > 0 {
      request = request.header(RANGE, format!("bytes={}-", self.written));
      if let Some(validator) = &self.validator {
        request = request.header(IF_RANGE, validator.as_str());
      }
    }
    let mut response = match request.send().await {
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
      if self.cancel.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
      }
      match response.chunk().await {
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
  cancel: &AtomicBool,
  delays: &[Duration],
  on_event: F,
) -> Result<(), Error> {
  let mut transfer = Transfer { file, written: 0, total: None, validator: None, cancel, on_event, last_event: None };
  let mut retries = 0usize;
  let mut most = 0u64;
  loop {
    if cancel.load(Ordering::SeqCst) {
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
        tokio::time::sleep(*delay).await;
      }
    }
  }
}

/// Downloads `url` into `dir` as `name` (made safe and free, see free_path); returns the path
/// written. `cancel` stops it between chunks; the partial file is removed on any failure.
pub async fn download<F: FnMut(Event) + Send>(
  client: &reqwest::Client,
  url: &str,
  dir: &Path,
  name: &str,
  cancel: &AtomicBool,
  delays: &[Duration],
  on_event: F,
) -> Result<PathBuf, Error> {
  let url = Url::parse(url).map_err(|_| Error::InvalidUrl)?;
  if !matches!(url.scheme(), "http" | "https") {
    return Err(Error::InvalidUrl);
  }
  std::fs::create_dir_all(dir)?;
  let safe = safe_file_name(name);
  let target = free_path(dir, &safe);
  let part = part_path(&target);
  let file = OpenOptions::new().write(true).create_new(true).open(&part)?;
  match fetch(client, &url, file, cancel, delays, on_event).await {
    Ok(()) => {
      // Another file may have taken the name meanwhile.
      let destination = if target.exists() { free_path(dir, &safe) } else { target };
      std::fs::rename(&part, &destination)?;
      Ok(destination)
    }
    Err(error) => {
      let _ = std::fs::remove_file(&part);
      Err(error)
    }
  }
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

  fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("harmony-download-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
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
    let path = download(&client().unwrap(), &url, &d, "amogus \"ünï\".zip", &AtomicBool::new(false), &QUICK, |e| events.push(e))
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
    let path = download(&client().unwrap(), &url, &d, "a.txt", &AtomicBool::new(false), &QUICK, |_| {}).await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"abcdef");
  }

  #[tokio::test]
  async fn a_refusal_ends_the_download_and_leaves_no_file() {
    let (url, _) = serve(vec![Box::new(|| b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec())]);
    let d = dir("refusal");
    let result = download(&client().unwrap(), &url, &d, "gone.bin", &AtomicBool::new(false), &QUICK, |_| {}).await;
    assert_eq!(result, Err(Error::Http(404)));
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
  }

  #[tokio::test]
  async fn gives_up_after_the_last_delay() {
    let short = || -> Responder { Box::new(|| b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nab".to_vec()) };
    let (url, heads) = serve(vec![short(), short(), short(), short()]);
    let d = dir("give-up");
    let result = download(&client().unwrap(), &url, &d, "x.bin", &AtomicBool::new(false), &QUICK[..1], |_| {}).await;
    assert!(matches!(result, Err(Error::Network(_))), "{result:?}");
    assert_eq!(heads.lock().unwrap().len(), 2);
  }

  #[test]
  fn takes_the_first_free_name() {
    let d = dir("names");
    std::fs::write(d.join("a.zip"), b"").unwrap();
    std::fs::write(d.join("a (1).zip.part"), b"").unwrap();
    assert_eq!(free_path(&d, "a.zip"), d.join("a (2).zip"));
    assert_eq!(free_path(&d, "b.zip"), d.join("b.zip"));
  }

  #[test]
  fn file_names_keep_what_the_os_allows() {
    assert_eq!(safe_file_name("../etc/passwd"), ".._etc_passwd");
    assert_eq!(safe_file_name("  report final.pdf. "), "report final.pdf");
    assert_eq!(safe_file_name(""), "download");
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
  fn parses_content_ranges() {
    assert_eq!(parse_content_range("bytes 5-9/10"), Some((5, Some(10))));
    assert_eq!(parse_content_range("bytes 0-0/*"), Some((0, None)));
    assert_eq!(parse_content_range("bytes 9-5/10"), None);
    assert_eq!(parse_content_range("items 0-1/2"), None);
  }
}
