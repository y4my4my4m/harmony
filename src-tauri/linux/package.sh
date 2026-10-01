#!/bin/sh
# Finishes the Linux packages from the deb `tauri build --bundles deb` produced:
#
#   1. Drops libgtk-3-0 from the deb's Depends. tauri-cli 3.0.0-alpha.3 adds it for
#      every runtime; the CEF runtime links GTK 4 (declared in tauri.linux.conf.json).
#      Only control.tar is rewritten, so data.tar keeps root ownership and the setuid
#      chrome-sandbox.
#   2. Builds the AppImage from the deb payload with quick-sharun. tauri-bundler's own
#      AppImage step downloads quick-sharun.sh from a moving branch on every build, and
#      the script in turn fetches its tools from moving branches and "latest" releases.
#      Here each is pinned by commit or release tag and checked against SHA-256, and
#      pre-seeded where quick-sharun looks before downloading, so it fetches nothing.
#   3. Signs both for tauri-plugin-updater when TAURI_SIGNING_PRIVATE_KEY is set.
#
# Usage: package.sh <Harmony_x.y.z_amd64.deb> [out-dir]
# Needs: ar, tar, gzip, curl, sha256sum, perl, cc, patchelf, file, strace, xvfb-run;
# npx (tauri CLI) for signing. CEF_TOOLS_DIR caches the pinned downloads.
set -eu

deb=$(realpath "$1")
out=$(realpath "${2:-$(dirname "$deb")/..}")
here=$(cd "$(dirname "$0")" && pwd)
tools=${CEF_TOOLS_DIR:-$here/../target/linux-tools}
product=Harmony

# Anylinux-AppImages fork that tauri-bundler 3.0.0-alpha.2 fetches quick-sharun from,
# at the commit its main branch held on 2026-10-01.
fork=https://raw.githubusercontent.com/FabianLars/Anylinux-AppImages/3e280d1b2270fecfcb2c2c823b490c782ecf1277/useful-tools
# anylinux.c before upstream moved it (404 on the branch URL since 2026-09-10).
upstream=https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/df9cd3246ccbcf61eb22fc321a52277351047b4b/useful-tools

fetch() { # fetch <file> <sha256> <url>
  if [ ! -f "$tools/$1" ] || ! echo "$2  $tools/$1" | sha256sum -c --status; then
    curl -fsSL -o "$tools/$1.part" "$3"
    echo "$2  $tools/$1.part" | sha256sum -c --quiet
    mv "$tools/$1.part" "$tools/$1"
  fi
}

mkdir -p "$tools/dwarfs"
fetch quick-sharun.sh 9704dbcc9c75a9e77d8ffffe00f480b72d7a7fa91ea9d11698043f88f9fecdaf "$fork/quick-sharun.sh"
fetch fix-namespaces.hook 437eb252e4f7be25f8674c83f705d6c3faf63a7045790a3df415fb3634f38012 "$fork/hooks/fix-namespaces.hook"
fetch vulkan-check.hook 76fa49f9cfd37ef80c5c41262675717cf5e62096cfe4dd39717e2162744fe746 "$fork/hooks/vulkan-check.hook"
fetch fix-gnome-csd.hook 21277a2a050343cabe3e156dbbfe573e3451b4560ae812b1d016c9283199eb24 "$fork/hooks/fix-gnome-csd.hook"
fetch anylinux.c f50650ad96d177559bdd0737df509fa20bd4af08887631c738fc1f31bfac185f "$upstream/lib/anylinux.c"
fetch sharun-x86_64 826bb0da3824daca97d710e4120074fcbdde82550e98516e4f35c5e653611169 \
  https://github.com/pkgforge-dev/Anylinux-sharun/releases/download/2.3.0/sharun-x86_64
fetch appimagetool-x86_64 629564ae579fda3323a43f7a2797289971a3571a3ae93ccc8cf5fb6783a9a76c \
  https://github.com/pkgforge-dev/appimagetool/releases/download/0.5.2/appimagetool-x86_64-linux
# The AppImage runtime and DwarFS packer appimagetool 0.5.2 otherwise downloads.
fetch uruntime-x86_64 b3c2916153e089d703cee5a7ebc540941d2f1d71baa90eb3092b15eef48345a8 \
  https://github.com/VHSgunzo/uruntime/releases/download/v0.8.1/uruntime-appimage-dwarfs-lite-x86_64
# dwarfs-universal picks the tool from argv[0], so the file is named mkdwarfs.
fetch dwarfs/mkdwarfs 50891c38ba359db8271819a6cbf6aaa8068681523f0c4f2b8242007a45edaa28 \
  https://github.com/mhx/dwarfs/releases/download/v0.15.6/dwarfs-universal-0.15.6-Linux-x86_64
chmod +x "$tools/sharun-x86_64" "$tools/appimagetool-x86_64" "$tools/uruntime-x86_64" "$tools/dwarfs/mkdwarfs"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 1. deb: rewrite Depends in control.tar only.
mkdir "$work/ar" "$work/control"
(cd "$work/ar" && ar x "$deb")
control_tar=$(cd "$work/ar" && ls control.tar*)
data_tar=$(cd "$work/ar" && ls data.tar*)
tar -xf "$work/ar/$control_tar" -C "$work/control"
perl -pi -e 'if (/^Depends: /) { s/^Depends: //; chomp; $_ = "Depends: " . join(", ", grep { $_ ne "libgtk-3-0" } split(/, /)) . "\n" }' \
  "$work/control/control"
(cd "$work/control" && tar --owner=0 --group=0 -czf "$work/ar/control.tar.gz" .)
[ "$control_tar" = control.tar.gz ] || rm "$work/ar/$control_tar"
(cd "$work/ar" && rm -f "$deb" && ar rc "$deb" debian-binary control.tar.gz "$data_tar")
grep '^Depends:' "$work/control/control"

# 2. AppImage from the deb payload.
mkdir "$work/payload"
tar -xf "$work/ar/$data_tar" -C "$work/payload"
bin_name=$(basename "$(readlink "$work/payload/usr/bin/"*)")
version=$(sed -n 's/^Version: //p' "$work/control/control")
appdir=$work/$product.AppDir
mkdir -p "$appdir/bin" "$appdir/lib"
cp -a "$work/payload/usr/share/$product/." "$appdir/bin/"
# tauri-plugin-updater picks its install method from this marker (tauri-bundler patch_binary).
perl -0777 -pi -e 's/__TAURI_BUNDLE_TYPE_VAR_(?:DEB|UNK)/__TAURI_BUNDLE_TYPE_VAR_APP/' "$appdir/bin/$bin_name"
grep -q __TAURI_BUNDLE_TYPE_VAR_APP "$appdir/bin/$bin_name"
cp "$work/payload/usr/share/applications/$product.desktop" "$appdir/$product.desktop"
icon=$(ls -S "$work/payload/usr/share/icons/hicolor/"*/apps/*.png | head -n 1)
cp "$icon" "$appdir/$product.png"
cp "$tools/sharun-x86_64" "$appdir/sharun"
cp "$tools/fix-namespaces.hook" "$tools/vulkan-check.hook" "$tools/fix-gnome-csd.hook" "$appdir/bin/"
cc -shared -fPIC -O2 "$tools/anylinux.c" -o "$appdir/lib/anylinux.so"

# NSS loads these with dlopen; the strace pass does not always see them.
nss_dir=$(dirname "$(find /usr/lib /usr/lib64 -name libsoftokn3.so -print -quit)")
set --
find "$appdir/bin" -type f >"$work/files"
while IFS= read -r f; do
  head -c 4 "$f" | grep -qa ELF && set -- "$@" "$f"
done <"$work/files"
set -- "$@" "$nss_dir/libsoftokn3.so" "$nss_dir/libfreeblpriv3.so"

outname=${product}_${version}_amd64.AppImage
mkdir -p "$out/appimage"
# appimagetool reports success over a stale output file when mkdwarfs fails.
rm -f "$out/appimage/$outname" "$out/appimage/$outname.sig"
(
  cd "$out/appimage"
  APPDIR=$appdir MAIN_BIN=$appdir/bin/$bin_name OUTPUT_APPIMAGE=1 OUTNAME=$outname \
    APPIMAGETOOL=$tools/appimagetool-x86_64 RUNTIME=$tools/uruntime-x86_64 DWARFS_CMD=$tools/dwarfs/mkdwarfs \
    DEPLOY_CHROMIUM=1 ADD_HOOKS=fix-namespaces.hook \
    sh "$tools/quick-sharun.sh" "$@"
)

# 3. Updater signatures.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  for f in "$deb" "$out/appimage/$outname"; do
    rm -f "$f.sig"
    npx --no-install tauri signer sign "$f" >/dev/null
  done
fi

echo "deb:      $deb"
echo "AppImage: $out/appimage/$outname"
