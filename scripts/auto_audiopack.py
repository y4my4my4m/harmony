#!/usr/bin/env python3
"""
Generate a complete Harmony-style audio pack from a theme description.

Features:
- GPT-5.4 generates:
  - theme metadata
  - one prompt per SFX
  - a banner prompt
- ElevenLabs generates the audio files
- OpenAI GPT Image generates banner.webp
- Optional ffmpeg post-processing:
  - loudness normalization
  - silence trimming
  - fade in/out
- manifest.json generation
- zip + tar.gz export
- concurrency + retries

Requirements:
  pip install openai requests python-slugify

Optional:
  ffmpeg installed and available on PATH

Environment variables:
  OPENAI_API_KEY=...
  ELEVENLABS_API_KEY=...

Example:
  python generate_harmony_pack.py \
    --theme "calm futuristic productivity with soft glassy clicks and warm notification tones" \
    --name "Aurora Focus" \
    --author "Your Name"

Notes:
- OpenAI: GPT-5.4 is used for orchestration; gpt-image-1 is used for banner generation.
- ElevenLabs Sound Effects API: POST /v1/sound-generation
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import dataclasses
import io
import json
import math
import os
import shutil
import subprocess
import tarfile
import tempfile
import textwrap
import threading
import time
import zipfile

from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from openai import OpenAI
from slugify import slugify


# -----------------------------
# Config
# -----------------------------

OPENAI_MODEL = "gpt-5.4"
OPENAI_BANNER_MODEL = "gpt-image-1"

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io"
ELEVENLABS_SOUND_ENDPOINT = "/v1/sound-generation"
ELEVENLABS_MODEL_ID = "eleven_text_to_sound_v2"
ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128"

DEFAULT_THEME_VERSION = "1.0.0"
DEFAULT_FORMAT_VERSION = 1
DEFAULT_PACK_FORMAT = "harmony-audio-pack"

# All supported sound keys from your manifest.
SOUND_SPECS: Dict[str, Dict[str, Any]] = {
    "mention": {"duration": 0.55, "category": "message", "intensity": "medium"},
    "dm": {"duration": 0.65, "category": "message", "intensity": "medium"},
    "reaction": {"duration": 0.40, "category": "social", "intensity": "light"},
    "reply": {"duration": 0.50, "category": "message", "intensity": "light"},
    "server_invite": {"duration": 1.00, "category": "social", "intensity": "medium"},
    "friend_request": {"duration": 0.95, "category": "social", "intensity": "medium"},
    "server_update": {"duration": 0.90, "category": "system", "intensity": "medium"},
    "emoji_added": {"duration": 0.45, "category": "social", "intensity": "light"},
    "voice_channel_activity": {"duration": 0.50, "category": "voice", "intensity": "light"},
    "voice_connect": {"duration": 0.80, "category": "voice", "intensity": "medium"},
    "voice_disconnect": {"duration": 0.75, "category": "voice", "intensity": "medium"},
    "call_incoming": {"duration": 2.50, "category": "call", "intensity": "medium", "loopable": True},
    "call_outgoing": {"duration": 1.80, "category": "call", "intensity": "medium"},
    "call_ended": {"duration": 0.80, "category": "call", "intensity": "low"},
    "mic_on": {"duration": 0.35, "category": "toggle", "intensity": "light"},
    "mic_off": {"duration": 0.35, "category": "toggle", "intensity": "light"},
    "deafen_on": {"duration": 0.40, "category": "toggle", "intensity": "light"},
    "deafen_off": {"duration": 0.40, "category": "toggle", "intensity": "light"},
    "camera_on": {"duration": 0.45, "category": "toggle", "intensity": "light"},
    "camera_off": {"duration": 0.45, "category": "toggle", "intensity": "light"},
    "screenshare_on": {"duration": 0.65, "category": "toggle", "intensity": "medium"},
    "screenshare_off": {"duration": 0.65, "category": "toggle", "intensity": "medium"},
    "ui_click": {"duration": 0.18, "category": "ui", "intensity": "light"},
    "ui_hover": {"duration": 0.12, "category": "ui", "intensity": "very_light"},
    "ui_success": {"duration": 0.70, "category": "ui", "intensity": "medium"},
    "ui_error": {"duration": 0.85, "category": "ui", "intensity": "medium"},
    "ui_notification": {"duration": 0.80, "category": "ui", "intensity": "medium"},
}

NEGATIVE_SFX_CONSTRAINTS = [
    "no voice",
    "no spoken words",
    "no lyrics",
    "no musical melody unless extremely subtle",
    "no long reverb tails unless event explicitly calls for it",
    "no clipping",
    "no distortion unless theme explicitly asks for it",
    "keep it recognizable as a UI sound effect",
]

PROMPT_SCHEMA_DESCRIPTION = """
Return STRICT JSON only with this shape:

{
  "theme_name": "string",
  "theme_id": "string_slug",
  "description": "string",
  "banner_prompt": "string",
  "tags": ["string", "string"],
  "sounds": {
    "mention": {
      "prompt": "string",
      "rationale": "string"
    },
    ...
  }
}

Requirements:
- Every sound key must be present exactly once.
- Prompts must be written for a text-to-sound-effects model.
- Keep prompts concise but specific.
- Each sound should fit the event and the overall theme.
- Preserve family resemblance across the pack.
- Mention duration target in natural language.
- Mention whether the sound should be soft / crisp / muted / glassy / analog / synthetic etc.
- For toggles, emphasize short and unambiguous states.
- For ui_hover, keep it extremely subtle.
- For call_incoming, make it loop-friendly and non-fatiguing.
- For ui_error, clearly indicate failure without being harsh.
- For ui_success, clearly indicate completion without sounding gamified unless the theme suggests it.
"""


# -----------------------------
# Helpers
# -----------------------------

print_lock = threading.Lock()


def log(msg: str) -> None:
    with print_lock:
        print(msg, flush=True)


def ensure_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def json_from_response_text(text: str) -> Dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def retry(
    func,
    *,
    attempts: int = 4,
    initial_delay: float = 1.0,
    max_delay: float = 12.0,
    exceptions: tuple[type[BaseException], ...] = (Exception,),
):
    delay = initial_delay
    last_exc = None
    for i in range(attempts):
        try:
            return func()
        except exceptions as exc:
            last_exc = exc
            if i == attempts - 1:
                break
            time.sleep(delay)
            delay = min(delay * 2, max_delay)
    raise last_exc


def ffmpeg_exists() -> bool:
    return shutil.which("ffmpeg") is not None


def run_ffmpeg(args: List[str]) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg failed")


def postprocess_audio(
    input_path: Path,
    output_path: Path,
    *,
    fade_in_ms: int = 6,
    fade_out_ms: int = 18,
    loudnorm: bool = True,
    trim_silence: bool = True,
) -> None:
    """
    Optional ffmpeg pass. Keeps it simple and robust.
    """
    if not ffmpeg_exists():
        shutil.copy2(input_path, output_path)
        return

    filters: List[str] = []
    if trim_silence:
        filters.append("silenceremove=start_periods=1:start_silence=0.03:start_threshold=-42dB")
        filters.append("areverse")
        filters.append("silenceremove=start_periods=1:start_silence=0.05:start_threshold=-42dB")
        filters.append("areverse")
    if loudnorm:
        filters.append("loudnorm=I=-19:TP=-1.5:LRA=7")
    if fade_in_ms > 0:
        filters.append(f"afade=t=in:st=0:d={fade_in_ms/1000.0}")
    if fade_out_ms > 0:
        # Fade-out uses relative duration only if known; safer to apply tiny end fade with apad+atrim not needed here.
        # ffmpeg accepts start time, so we skip dynamic end lookup and rely on minimal fade only if later extended.
        pass

    args = ["-i", str(input_path)]
    if filters:
        args += ["-af", ",".join(filters)]
    args += ["-c:a", "libmp3lame", "-b:a", "128k", str(output_path)]
    run_ffmpeg(args)


def package_zip(source_dir: Path, out_file: Path) -> None:
    with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=path.relative_to(source_dir))


def package_tar_gz(source_dir: Path, out_file: Path) -> None:
    with tarfile.open(out_file, "w:gz") as tf:
        for path in sorted(source_dir.rglob("*")):
            tf.add(path, arcname=path.relative_to(source_dir))


# -----------------------------
# Data models
# -----------------------------

@dataclasses.dataclass
class ThemePlan:
    theme_name: str
    theme_id: str
    description: str
    banner_prompt: str
    tags: List[str]
    sounds: Dict[str, Dict[str, str]]


# -----------------------------
# OpenAI planning
# -----------------------------

def build_system_prompt() -> str:
    spec_lines = []
    for key, meta in SOUND_SPECS.items():
        spec_lines.append(
            f"- {key}: duration≈{meta['duration']}s, category={meta['category']}, intensity={meta['intensity']}"
            + (", loopable=true" if meta.get("loopable") else "")
        )

    negatives = ", ".join(NEGATIVE_SFX_CONSTRAINTS)

    return textwrap.dedent(
        f"""
        You are designing a complete UI sound pack for a chat application.

        Goal:
        - Take a mood/theme from the user.
        - Create a coherent, tasteful, production-usable set of SFX prompts.
        - Keep prompts suitable for a text-to-sound-effects generator.

        Global constraints:
        - UI-first, not cinematic trailer design.
        - Every sound must be short, distinct, and functional.
        - Avoid repetition in wording and sonic behavior.
        - Maintain one cohesive sonic language across the full pack.
        - The prompt should be geared specifically for elevenlabs.
        - Make sure negative version of sounds keep the similarities from the positive version. (Camera on vs off)
        - Negative constraints to keep in mind: {negatives}

        Sound inventory:
        {chr(10).join(spec_lines)}

        Also generate a banner prompt:
        - wide composition
        - suitable for a modern app theme preview
        - no text in image
        - visually aligned with the same sonic theme
        - dark app-friendly composition unless user explicitly asks otherwise

        {PROMPT_SCHEMA_DESCRIPTION}
        """
    ).strip()


def generate_theme_plan(
    client: OpenAI,
    *,
    theme: str,
    explicit_name: Optional[str] = None,
) -> ThemePlan:
    system_prompt = build_system_prompt()
    user_prompt = {
        "requested_theme": theme,
        "preferred_name": explicit_name,
        "sound_keys": list(SOUND_SPECS.keys()),
    }

    def _call():
        return client.responses.create(
            model=OPENAI_MODEL,
            reasoning={"effort": "medium"},
            input=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_prompt, ensure_ascii=False)},
            ],
        )

    response = retry(_call)
    output_text = getattr(response, "output_text", None)
    if not output_text:
        raise RuntimeError("OpenAI did not return text output for theme planning.")

    data = json_from_response_text(output_text)

    missing = sorted(set(SOUND_SPECS.keys()) - set(data.get("sounds", {}).keys()))
    extra = sorted(set(data.get("sounds", {}).keys()) - set(SOUND_SPECS.keys()))
    if missing or extra:
        raise RuntimeError(f"Invalid sound set from planner. Missing={missing}, Extra={extra}")

    theme_name = explicit_name or data["theme_name"]
    theme_id = slugify(data.get("theme_id") or theme_name, separator="_")
    if not theme_id:
        theme_id = "generated_theme"

    return ThemePlan(
        theme_name=theme_name,
        theme_id=theme_id,
        description=data["description"],
        banner_prompt=data["banner_prompt"],
        tags=list(data.get("tags", [])),
        sounds=data["sounds"],
    )


# -----------------------------
# ElevenLabs
# -----------------------------

def elevenlabs_generate_sound(
    *,
    api_key: str,
    text: str,
    duration_seconds: float,
    output_path: Path,
    loop: bool = False,
    prompt_influence: float = 0.45,
    model_id: str = ELEVENLABS_MODEL_ID,
    output_format: str = ELEVENLABS_OUTPUT_FORMAT,
) -> None:
    url = f"{ELEVENLABS_BASE_URL}{ELEVENLABS_SOUND_ENDPOINT}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    params = {"output_format": output_format}
    payload = {
        "text": text,
        "duration_seconds": max(0.5, min(float(duration_seconds), 30.0)),
        "prompt_influence": max(0.0, min(float(prompt_influence), 1.0)),
        "loop": bool(loop),
        "model_id": model_id,
    }

    def _call():
        resp = requests.post(url, headers=headers, params=params, json=payload, timeout=180)
        if resp.status_code >= 400:
            raise RuntimeError(f"ElevenLabs error {resp.status_code}: {resp.text[:500]}")
        output_path.write_bytes(resp.content)

    retry(_call, attempts=5, initial_delay=1.5, max_delay=15.0)


# -----------------------------
# Banner generation
# -----------------------------

def generate_banner(
    client: OpenAI,
    *,
    banner_prompt: str,
    out_path: Path,
    size: str = "1536x1024",
    quality: str = "high",
) -> None:
    """
    Uses the Image API to generate one WebP banner.
    """

    def _call():
        return client.images.generate(
            model=OPENAI_BANNER_MODEL,
            prompt=banner_prompt,
            size=size,
            quality=quality,
            output_format="webp",
            output_compression=90,
        )

    result = retry(_call, attempts=4, initial_delay=2.0, max_delay=15.0)
    img_b64 = result.data[0].b64_json
    out_path.write_bytes(base64.b64decode(img_b64))


# -----------------------------
# Manifest
# -----------------------------

def build_manifest(
    *,
    plan: ThemePlan,
    author: str,
    version: str,
    include_banner: bool,
) -> Dict[str, Any]:
    theme_obj: Dict[str, Any] = {
        "id": plan.theme_id,
        "name": plan.theme_name,
        "description": plan.description,
        "author": author,
        "version": version,
        "isBuiltIn": False,
        "sounds": {key: f"{key}.mp3" for key in SOUND_SPECS.keys()},
    }
    if include_banner:
        theme_obj["banner"] = "banner.webp"

    return {
        "format": DEFAULT_PACK_FORMAT,
        "version": DEFAULT_FORMAT_VERSION,
        "theme": theme_obj,
    }


# -----------------------------
# Main orchestration
# -----------------------------

def write_debug_files(
    pack_dir: Path,
    plan: ThemePlan,
) -> None:
    debug = {
        "theme_name": plan.theme_name,
        "theme_id": plan.theme_id,
        "description": plan.description,
        "banner_prompt": plan.banner_prompt,
        "tags": plan.tags,
        "sounds": plan.sounds,
    }
    (pack_dir / "_plan.json").write_text(json.dumps(debug, indent=2, ensure_ascii=False), encoding="utf-8")


def generate_one_sound(
    *,
    key: str,
    prompt: str,
    duration: float,
    loopable: bool,
    elevenlabs_api_key: str,
    raw_dir: Path,
    final_dir: Path,
    enable_postprocess: bool,
) -> None:
    raw_path = raw_dir / f"{key}.mp3"
    out_path = final_dir / f"{key}.mp3"

    log(f"[audio] {key} -> generating")
    elevenlabs_generate_sound(
        api_key=elevenlabs_api_key,
        text=prompt,
        duration_seconds=duration,
        output_path=raw_path,
        loop=loopable,
    )

    if enable_postprocess:
        postprocess_audio(raw_path, out_path)
    else:
        shutil.copy2(raw_path, out_path)

    log(f"[audio] {key} -> done")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a Harmony audio pack from a theme")
    parser.add_argument("--theme", required=True, help="Theme / mood description")
    parser.add_argument("--name", default=None, help="Optional explicit pack name")
    parser.add_argument("--author", default="Auto Generator", help="Theme author")
    parser.add_argument("--version", default=DEFAULT_THEME_VERSION, help="Theme version")
    parser.add_argument("--output-dir", default="build", help="Where to write generated files")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrent sound jobs")
    parser.add_argument("--no-banner", action="store_true", help="Skip banner generation")
    parser.add_argument("--no-postprocess", action="store_true", help="Skip ffmpeg post-processing")
    parser.add_argument("--keep-debug", action="store_true", help="Keep planner debug JSON")
    parser.add_argument("--zip-only", action="store_true", help="Only export zip")
    parser.add_argument("--tar-only", action="store_true", help="Only export tar.gz")
    args = parser.parse_args()

    if args.zip_only and args.tar_only:
        raise SystemExit("Use at most one of --zip-only or --tar-only")

    openai_key = ensure_env("OPENAI_API_KEY")
    elevenlabs_key = ensure_env("ELEVENLABS_API_KEY")

    client = OpenAI(api_key=openai_key)

    base_out = Path(args.output_dir).resolve()
    base_out.mkdir(parents=True, exist_ok=True)

    log("[plan] generating theme plan with GPT-5.4")
    plan = generate_theme_plan(client, theme=args.theme, explicit_name=args.name)

    pack_root = base_out / plan.theme_id
    raw_dir = pack_root / "_raw_audio"
    pack_dir = pack_root / "pack"
    raw_dir.mkdir(parents=True, exist_ok=True)
    pack_dir.mkdir(parents=True, exist_ok=True)

    if args.keep_debug:
        write_debug_files(pack_root, plan)

    if not args.no_banner:
        log("[banner] generating banner.webp")
        generate_banner(
            client,
            banner_prompt=plan.banner_prompt,
            out_path=pack_dir / "banner.webp",
        )
        log("[banner] done")

    log("[audio] generating sound effects")
    futures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as executor:
        for key, meta in SOUND_SPECS.items():
            sound_prompt = plan.sounds[key]["prompt"]
            futures.append(
                executor.submit(
                    generate_one_sound,
                    key=key,
                    prompt=sound_prompt,
                    duration=meta["duration"],
                    loopable=bool(meta.get("loopable", False)),
                    elevenlabs_api_key=elevenlabs_key,
                    raw_dir=raw_dir,
                    final_dir=pack_dir,
                    enable_postprocess=not args.no_postprocess,
                )
            )

        for fut in concurrent.futures.as_completed(futures):
            fut.result()

    manifest = build_manifest(
        plan=plan,
        author=args.author,
        version=args.version,
        include_banner=not args.no_banner,
    )
    (pack_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    zip_path = base_out / f"{plan.theme_id}.zip"
    tar_path = base_out / f"{plan.theme_id}.tar.gz"

    if not args.tar_only:
        log("[package] writing zip")
        package_zip(pack_dir, zip_path)

    if not args.zip_only:
        log("[package] writing tar.gz")
        package_tar_gz(pack_dir, tar_path)

    log("")
    log("Done.")
    log(f"Pack dir: {pack_dir}")
    if zip_path.exists():
        log(f"ZIP:      {zip_path}")
    if tar_path.exists():
        log(f"TAR.GZ:   {tar_path}")


if __name__ == "__main__":
    main()
