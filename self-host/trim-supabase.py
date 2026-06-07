#!/usr/bin/env python3
"""Trim the upstream Supabase Docker compose for Harmony.

Removes services Harmony does not use:
  - functions  (edge runtime; federation runs as a separate Node backend)
  - supavisor  (connection pooler; not needed - the federation listener uses a
                dedicated least-privilege role on the db service directly, and
                removing it also stops Postgres being published on the host)

Also strips any depends_on / volume references to the removed services and
relaxes imgproxy limits so Harmony's animated emojis/larger images work.

Usage: trim-supabase.py <path-to-docker-compose.yml>
"""
import sys
import yaml

REMOVE = {"functions", "supavisor"}


def main(path: str) -> None:
    with open(path) as fh:
        doc = yaml.safe_load(fh)

    # Drop the upstream top-level project name; under `include:` the parent
    # project's name must win, and a nested `name:` can cause conflicts.
    doc.pop("name", None)

    services = doc.get("services", {})
    for name in list(services):
        if name in REMOVE:
            del services[name]

    # Kong no longer needs host ports: Caddy proxies it internally via
    # supabase-kong:8000, so the only public ports are Caddy's 80/443.
    kong = services.get("kong")
    if kong is not None:
        kong.pop("ports", None)

    # Drop dangling depends_on references to removed services.
    for svc in services.values():
        dep = svc.get("depends_on")
        if isinstance(dep, dict):
            for name in list(dep):
                if name in REMOVE:
                    del dep[name]
        elif isinstance(dep, list):
            svc["depends_on"] = [d for d in dep if d not in REMOVE]

    # Relax imgproxy limits (matches scripts/install.sh behaviour).
    img = services.get("imgproxy")
    if img is not None:
        env = img.setdefault("environment", {})
        if isinstance(env, dict):
            env["IMGPROXY_MAX_SRC_RESOLUTION"] = 50
            env["IMGPROXY_MAX_ANIMATION_FRAMES"] = 120

    # Remove now-unused top-level named volumes (e.g. deno-cache for functions).
    volumes = doc.get("volumes")
    if isinstance(volumes, dict):
        for vol in ("deno-cache",):
            volumes.pop(vol, None)

    with open(path, "w") as fh:
        yaml.safe_dump(doc, fh, default_flow_style=False, sort_keys=False)

    print(f"Trimmed: removed {', '.join(sorted(REMOVE))}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: trim-supabase.py <docker-compose.yml>")
    main(sys.argv[1])
