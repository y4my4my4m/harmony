# Nix package for Harmony

An initial Nix package for the official Harmony Linux desktop release
(`Harmony_Linux_V1.9.7.deb`, x86_64 only). It unpacks the released `.deb` and
patches the bundled CEF runtime for NixOS; it is not a from-source build.

## Build and run

```sh
nix-build nix
./result/bin/harmony
```

`nix/package.nix` is written `callPackage`-style, so it can also be used
directly:

```sh
nix-build -E 'with import <nixpkgs> {}; callPackage ./nix/package.nix {}'
```

To install it system-wide on NixOS, drop the file into your configuration and
add it to `environment.systemPackages`:

```nix
environment.systemPackages = [ (pkgs.callPackage /path/to/nix/package.nix { }) ];
```

## Sandbox

Chromium's `chrome-sandbox` helper must be root-owned and setuid, which a Nix
store path cannot be. Without a usable helper, Harmony falls back to Chromium's
user-namespace sandbox and starts with the sandbox disabled if that is also
unavailable. To keep the per-process sandbox, enable the shared NixOS wrapper:

```nix
security.chromiumSuidSandbox.enable = true;
```

The launcher then points `CHROME_DEVEL_SANDBOX` at
`/run/wrappers/bin/chrome-sandbox` when it exists.

## Updates and licensing

The package carries the `.deb` bundle type, so Harmony's Tauri updater never
installs in place and cannot write to the read-only store. Upgrade the package
by updating `version` and the release artifact's `hash` in `package.nix` (or
obtaining an updated expression), then rebuilding it. Rebuilding the unchanged
expression keeps the same version. The AppImage is the only Linux build that
self-updates.

Harmony is AGPL-3.0-only plus the additional §7 attribution and trademark terms
in `LICENSE-ADDITIONAL-TERMS.md`; `meta.longDescription` records this so the
package is not presented as plain AGPL without those terms.

## Desktop identity (KDE Plasma)

Plasma matches a running window to `share/applications/harmony.desktop` through
that entry's `StartupWMClass`, so the task manager only shows the transparent
icon once the package is installed into an XDG data directory. Launching
`./result/bin/harmony` straight from the build has no menu entry to match and
Plasma falls back to the opaque white icon embedded in the upstream binary.

The bundle's window otherwise has no X11 class at all: the CEF runtime's GTK4
winit backend creates its `GtkApplication` without `g_application_run`, so
GLib's program name stays unset and GDK publishes an empty `WM_CLASS`. The
package preloads a small shim (`lib/harmony/wmclass.so`) that fills in
`harmony`/`harmony`, matching `StartupWMClass=harmony`.

The generated entry also points `Icon=` at the absolute path of the installed
512px PNG (substituted in `postFixup`), so Plasma does not depend on an icon
theme lookup or a warm theme cache to find it.

To test desktop integration, install the package into a user profile with
`nix profile add --file ./nix`, then run `kbuildsycoca6 --noincremental`. Fully quit
Harmony and start it from the application menu. Merely copying the desktop
file is insufficient unless its `Exec=harmony` also resolves to this package.

### Start menu shows a generic icon

Plasma can retain an older desktop-entry cache after installing the package.
If rebuilding the cache with `kbuildsycoca6 --noincremental` does not refresh
the menu icon, log out and back in. A separately installed browser web app may
also appear under the name Harmony; check which entry you are launching.

### Tray and window icon background

Tauri embeds `default_window_icon()` from the first `.png` in `bundle.icon`
(the Unix branch of `tauri-codegen-2.7.6/src/context.rs`), which is
`src-tauri/icons/32x32.png`; `src-tauri/src/lib.rs` hands that same icon to the
StatusNotifierItem tray. The released `.deb` ships those PNGs with a solid
white background, unlike the transparent `public/img/app_icon_square.webp`
(the 512px icon the web manifest ships). They have been regenerated in-tree
from that source with ImageMagick, keeping the expected sizes:

```sh
magick public/img/app_icon_square.webp -filter Lanczos -resize 32x32! \
  -strip -define png:color-type=6 PNG32:src-tauri/icons/32x32.png
# likewise 128x128.png at 128x128 and 128x128@2x.png at 256x256
```

`scripts/check-tray-icons.sh` asserts the three files are RGBA with a
transparent background and that `bundle.icon` still lists `icons/32x32.png`
first. No Windows/macOS/iOS/Android icon was touched. The tray stays white
until the upstream Linux `.deb` is rebuilt from those sources; this package
only rewraps the released binary and cannot change the embedded icon.

## Remaining steps for nixpkgs

- Register a maintainer entry for ZaneH (Zane Helton, <https://github.com/ZaneH>)
  in `maintainers/maintainer-list.nix`, then list it in `meta.maintainers`.
  There is no existing entry, and inventing an email is not acceptable.
- Move the expression to `pkgs/by-name/ha/harmony/package.nix` for automatic
  discovery (no existing `harmony` name collision was found).
- Have nixpkgs reviewers confirm the additional license terms and binary
  redistribution/branding policy are acceptable.
- Verify desktop rendering, audio, and screen sharing on real hardware before
  treating the package as fully tested.
