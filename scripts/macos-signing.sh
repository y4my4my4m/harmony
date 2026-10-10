#!/usr/bin/env bash
# macos-signing.sh keychain | verify <Harmony.app>
#
# keychain: imports the code-signing identity in MACOS_CERTIFICATE (base64 PKCS#12) and
# MACOS_CERTIFICATE_PASSWORD into a temporary keychain on the search list and exports
# APPLE_SIGNING_IDENTITY, which tauri build signs the bundle with. Without MACOS_CERTIFICATE the
# app stays linker-signed ad hoc.
#
# The identity is self-signed, not an Apple Developer ID: the app is signed, not notarized, and
# Gatekeeper asks on first launch. Its designated requirement
#   identifier "online.knowmad.harmony" and certificate root = H"<certificate SHA-1>"
# is the same for every build, so TCC grants (microphone, camera, screen recording) survive
# updates. An ad-hoc signature's requirement is its cdhash, which every build changes.
# tauri.conf.json turns the hardened runtime off: it serves notarization.
#
# verify: prints the bundle's signature per architecture and its designated requirement; fails
# when APPLE_SIGNING_IDENTITY is set and the bundle is not signed with a certificate.
set -euo pipefail
IDENTITY="Harmony Code Signing"

keychain() {
  if [ -z "${MACOS_CERTIFICATE:-}" ]; then
    echo "::warning::MACOS_CERTIFICATE is not set: the macOS app is ad-hoc signed and loses its permissions on every update."
    return 0
  fi
  local kc="$RUNNER_TEMP/harmony-signing.keychain-db"
  local p12="$RUNNER_TEMP/harmony-signing.p12"
  local pem="$RUNNER_TEMP/harmony-signing.pem"
  local probe="$RUNNER_TEMP/sign-probe"
  local pass
  pass=$(openssl rand -hex 16)
  printf '%s' "$MACOS_CERTIFICATE" | base64 --decode > "$p12"
  security create-keychain -p "$pass" "$kc"
  security set-keychain-settings -lut 21600 "$kc"
  security unlock-keychain -p "$pass" "$kc"
  security import "$p12" -k "$kc" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$kc" >/dev/null
  # shellcheck disable=SC2046 # one keychain path per word
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  security find-certificate -c "$IDENTITY" -p "$kc" > "$pem"
  echo "certificate SHA-1: $(openssl x509 -in "$pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"

  # Sign a copy of a system binary the way tauri signs the bundle. An identity codesign refuses
  # as untrusted gets admin trust for code signing; trust-settings.admin otherwise needs a
  # password prompt.
  cp /bin/echo "$probe"
  if ! codesign --force -s "$IDENTITY" "$probe" 2> "$probe.err"; then
    echo "codesign refused the identity: $(cat "$probe.err"); trusting it for code signing"
    sudo security authorizationdb write com.apple.trust-settings.admin allow
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$pem"
    codesign --force -s "$IDENTITY" "$probe"
  fi
  codesign --display --requirements - "$probe" 2>&1 | sed -n 's/^designated => /probe requirement: /p'
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY" >> "$GITHUB_ENV"
}

verify() {
  local app=$1
  for arch in arm64 x86_64; do
    echo "[$arch]"
    codesign --display --arch "$arch" --verbose=2 "$app" 2>&1 | grep -E '^(Identifier|Format|Authority|Signature|TeamIdentifier)=' | sed 's/^/  /' || true
  done
  local req
  req=$(codesign --display --requirements - "$app" 2>&1 | sed -n 's/^designated => //p')
  echo "designated requirement: ${req:-none}"
  [ -n "${APPLE_SIGNING_IDENTITY:-}" ] || return 0
  codesign --verify --deep --strict "$app"
  case "$req" in
    *'certificate root = H"'* | *'certificate leaf = H"'*) ;;
    *) echo "::error::$app is not signed with \"$APPLE_SIGNING_IDENTITY\""; exit 1 ;;
  esac
}

case "${1:-}" in
  keychain) keychain ;;
  verify) verify "${2:?bundle path}" ;;
  *) echo "usage: $0 keychain | verify <Harmony.app>" >&2; exit 2 ;;
esac
