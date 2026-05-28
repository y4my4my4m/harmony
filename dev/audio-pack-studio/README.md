# Audio Pack Studio

Local dev UI for building Harmony audio theme packs (`.zip` with `manifest.json` + sound files).

## Run

From the repo root:

```bash
npm run dev:audio-pack
```

Open http://localhost:5179

## Workflow

1. Set theme **ID**, **name**, **author**, etc. in the sidebar.
2. Assign sounds per slot (or bulk-import):
   - **Import folder** — **replaces** all current sounds, reads `manifest.json` for id / name / author / description, then maps audio files
   - **Import files** or **drop** — merge into existing slots (only overwrites matching names)
   - **Per-slot** file picker with **▶** preview
3. Optional **banner** image (shown in theme picker).
4. **Export .zip** — import in Harmony via Settings → Audio themes.

Partial packs are fine; missing actions fall back to the default theme in-app.

## Tips

- Filenames should match the action id (`voice_connect.mp3`) or a [legacy alias](./soundSlots.ts) (`invite.mp3` → server invite).
- **Use built-in default sounds for gaps** copies from `public/assets/sounds/default/` (requires running this tool from the repo).
- Pack size limit: **10MB** (same as the app importer).
- For AI-generated full packs, see `scripts/auto_audiopack.py`.

## Format

Matches `AudioThemeService.importThemePack` / `exportThemePack`:

- `manifest.json` — `format: "harmony-audio-pack"`, `theme.sounds` maps action → filename
- One audio file per mapped action
- Optional `banner.webp` (or png/jpg)
