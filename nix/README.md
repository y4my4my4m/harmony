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
