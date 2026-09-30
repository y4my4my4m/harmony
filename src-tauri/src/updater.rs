// Whether tauri-plugin-updater runs: only with a real minisign public key and
// an install the plugin can replace.

use serde::Serialize;

// Committed value of `plugins.updater.pubkey` before a release keypair exists.
const PUBKEY_PLACEHOLDER: &str = "HARMONY_UPDATER_PUBKEY";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterStatus {
  Enabled,
  // Placeholder, missing or undecodable `plugins.updater.pubkey`.
  NotConfigured,
  // Linux outside an AppImage: the plugin writes the AppImage payload over the
  // running executable, which would clobber a distro package or a dev binary.
  #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
  Unsupported,
}

pub struct UpdaterState(pub UpdaterStatus);

pub fn status(config: &tauri::Config) -> UpdaterStatus {
  let pubkey = config
    .plugins
    .0
    .get("updater")
    .and_then(|u| u.get("pubkey"))
    .and_then(|p| p.as_str())
    .unwrap_or_default();
  if !pubkey_is_valid(pubkey) {
    return UpdaterStatus::NotConfigured;
  }
  #[cfg(target_os = "linux")]
  if tauri::Env::default().appimage.is_none() {
    return UpdaterStatus::Unsupported;
  }
  UpdaterStatus::Enabled
}

// `tauri signer generate` pubkey: base64 of the two-line minisign public key
// file. Mirrors the decode in tauri-plugin-updater's verify_signature.
fn pubkey_is_valid(pubkey: &str) -> bool {
  use base64::Engine;
  let pubkey = pubkey.trim();
  if pubkey.is_empty() || pubkey == PUBKEY_PLACEHOLDER {
    return false;
  }
  let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(pubkey) else {
    return false;
  };
  let Ok(text) = std::str::from_utf8(&bytes) else {
    return false;
  };
  minisign_verify::PublicKey::decode(text).is_ok()
}

#[tauri::command]
pub fn updater_status(state: tauri::State<'_, UpdaterState>) -> UpdaterStatus {
  state.0
}

#[cfg(test)]
mod tests {
  use super::pubkey_is_valid;

  // Pubkey fixture from tauri-cli's v1 config migration tests.
  const SAMPLE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5QzMxNjYwNTM5OEUwNTgKUldSWTRKaFRZQmJER1h4d1ZMYVA3dnluSjdpN2RmMldJR09hUFFlZDY0SlFqckkvRUJhZDJVZXAK";

  #[test]
  fn rejects_placeholder_and_garbage() {
    assert!(!pubkey_is_valid("HARMONY_UPDATER_PUBKEY"));
    assert!(!pubkey_is_valid(""));
    assert!(!pubkey_is_valid("not base64 at all"));
    assert!(!pubkey_is_valid("aGVsbG8gd29ybGQ="));
  }

  #[test]
  fn accepts_signer_pubkey() {
    assert!(pubkey_is_valid(SAMPLE_PUBKEY));
    assert!(pubkey_is_valid(&format!("{SAMPLE_PUBKEY}\n")));
  }
}
