# Extracting the bridge into its own repository

The Discord bridge is fully self-contained: it talks **only** to a Harmony
`bot-gateway` over WebSocket + REST and has zero imports from the Harmony
monorepo. That makes it safe to split into a standalone repository that
community members can host without cloning all of Harmony.

## One-time split (preserves history)

From the **root** of the Harmony repo:

```bash
# 1. Split this subtree into a new branch with only its own history.
git subtree split --prefix=bot-plugins/discord-bridge -b discord-bridge-split

# 2. Create the new repo on GitHub (or your host), then push the split branch.
mkdir ../harmony-discord-bridge && cd ../harmony-discord-bridge
git init -b main
git pull ../harmony discord-bridge-split

# 3. Add the license (the bridge inherits Harmony's AGPL-3.0).
cp ../harmony/LICENSE .
git add LICENSE && git commit -m "Add license"

# 4. Point at the new remote and push.
git remote add origin git@github.com:YOUR_ORG/harmony-discord-bridge.git
git push -u origin main
```

Clean up the temporary branch in the monorepo afterwards:

```bash
cd ../harmony && git branch -D discord-bridge-split
```

## After extraction

- Keep `config/bridge-config.yml` out of git (already in `.gitignore`).
- The `ci.yml` workflow under `.github/workflows/` builds and typechecks on push.
- Consumers run it via `docker compose up -d` (see `README.md`) pointing
  `gatewayUrl` / `apiUrl` at any reachable Harmony `bot-gateway`.

## Keeping it in sync (optional)

If you want to continue developing in the monorepo and periodically publish to
the standalone repo, re-run the `git subtree split` and push, or wire a
read-only mirror. Most communities will simply fork the standalone repo.
