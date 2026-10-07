#!/usr/bin/env bash
# =============================================================================
# Harmony self-host updater
# =============================================================================
# Steps; a failure stops the update and says what state it left:
#   1. check out the new code
#   2. merge new configuration keys (configure.sh --non-interactive); the image
#      tag follows the checkout (X.Y.Z at tag vX.Y.Z, otherwise edge)
#   3. pull the images (or build Harmony's with HARMONY_BUILD=1); the running
#      stack is untouched
#   4. back up the database and the config files into backups/
#   5. apply new migrations while the old containers keep running
#   6. recreate the containers whose image or configuration changed
#
# Usage:
#   bash update.sh                        see "Target" below
#   HARMONY_REF=v1.6.8 bash update.sh     a tag, branch or commit
#   (harmony update --version 1.6.8 sets HARMONY_REF)
#
# Target without HARMONY_REF: a checkout on a release tag moves to the newest
# release; a checkout on a branch fast-forwards it (master: the edge channel).
#
#   HARMONY_REMOTE        git remote to fetch (default origin)
#   HARMONY_SKIP_BACKUP=1 no backup (one was taken some other way)
#
# Nothing here deletes volumes, data directories or backups.
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SCRIPT_DIR="$SELF_HOST_DIR"
REMOTE="${HARMONY_REMOTE:-origin}"

STEP=start
BACKUP_PATH=""
on_exit() {
	local rc=$?
	[[ $rc -eq 0 ]] && return
	printf '\nUpdate stopped during: %s\n' "$STEP" >&2
	case "$STEP" in
		code)      echo "The checkout is unchanged or at the target; no container was touched." >&2 ;;
		configure) echo "New code is checked out; containers still run the previous version. Fix the error and re-run the update." >&2 ;;
		images)    echo "Containers still run the previous version; the database is unchanged. Re-run the update once images are available." >&2 ;;
		backup)    echo "No migration was applied; containers still run the previous version." >&2 ;;
		migrate)   echo "The database is at the last migration that succeeded; containers still run the previous version." >&2
		           [[ -z "$BACKUP_PATH" ]] || echo "Pre-update backup: $BACKUP_PATH (harmony restore it to return to the old database)." >&2 ;;
		restart)   echo "Migrations are applied; some containers may still run old images. Check 'docker compose ps' and re-run 'docker compose up -d'." >&2 ;;
	esac
}

main() {
	cd "$SCRIPT_DIR"
	trap on_exit EXIT

	[[ -f "$ENV_FILE" ]] || die "self-host/.env is missing; this is not a configured install (run harmony install)"
	command -v git >/dev/null || die "git is required"

	# --- 1. code -----------------------------------------------------------------
	local prev now
	prev="$(git -C "$REPO_DIR" rev-parse HEAD)"
	if [[ "${1:-}" == --code-updated ]]; then
		prev="${2:-$prev}"
	else
		STEP=code
		update_code
		now="$(git -C "$REPO_DIR" rev-parse HEAD)"
		if [[ "$now" != "$prev" ]]; then
			# Continue in the new update.sh: its steps are the ones the new
			# code expects.
			trap - EXIT
			exec bash "$SCRIPT_DIR/update.sh" --code-updated "$prev"
		fi
	fi
	now="$(git -C "$REPO_DIR" rev-parse HEAD)"
	if [[ "$now" == "$prev" ]]; then
		info "Code at $(git -C "$REPO_DIR" describe --tags --always) (unchanged)"
	else
		info "Code $(git -C "$REPO_DIR" rev-parse --short "$prev") -> $(git -C "$REPO_DIR" describe --tags --always)"
	fi

	# --- 2. configuration --------------------------------------------------------
	STEP=configure
	bash "$SCRIPT_DIR/configure.sh" --non-interactive </dev/null

	# --- 3. images ---------------------------------------------------------------
	STEP=images
	pull_images

	# --- 4. backup ---------------------------------------------------------------
	STEP=backup
	if [[ "${HARMONY_SKIP_BACKUP:-}" == 1 ]]; then
		warn "HARMONY_SKIP_BACKUP=1: no backup taken"
	else
		bash "$SCRIPT_DIR/backup.sh" create --no-storage \
			--label "$(git -C "$REPO_DIR" rev-parse --short "$prev")-to-$(git -C "$REPO_DIR" rev-parse --short "$now")"
		BACKUP_PATH="$(latest_backup)"
	fi

	# --- 5. migrations -----------------------------------------------------------
	STEP=migrate
	bash "$SCRIPT_DIR/bootstrap.sh" --migrations-only

	# --- 6. restart --------------------------------------------------------------
	STEP=restart
	info "Recreating changed containers..."
	compose up -d
	# The Caddyfile is bind-mounted as a file, which pins its inode; git
	# replaces the file, so a running Caddy keeps the old one until restarted.
	if ! git -C "$REPO_DIR" diff --quiet "$prev" "$now" -- self-host/Caddyfile; then
		info "Caddyfile changed; restarting Caddy..."
		compose restart caddy
	fi
	compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'

	STEP=done
	echo
	ok "Update complete ($(env_get "$ENV_FILE" HARMONY_VERSION))."
	info "Check the instance: harmony doctor"
}

update_code() {
	local branch ref="${HARMONY_REF:-}" git=(git -C "$REPO_DIR") current newest
	"${git[@]}" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_DIR is not a git checkout; update.sh updates through git"
	info "Fetching $REMOTE..."
	"${git[@]}" fetch -q "$REMOTE" || die "git fetch $REMOTE failed"
	if [[ -z "$ref" ]] && ! "${git[@]}" symbolic-ref -q HEAD >/dev/null; then
		# Detached: on a release tag, follow releases.
		current="$("${git[@]}" describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null)" ||
			die "the checkout is detached at $("${git[@]}" describe --tags --always); set the target: harmony update --version X.Y.Z"
		"${git[@]}" fetch -q "$REMOTE" 'refs/tags/v*:refs/tags/v*' 2>/dev/null || true
		newest="$("${git[@]}" tag -l 'v[0-9]*' --sort=-v:refname | grep -v -- - | head -1 || true)"
		if [[ -z "$newest" || "$newest" == "$current" ]]; then
			info "Already on the newest release ($current)"
			return 0
		fi
		ref="$newest"
		info "Release $current -> $newest"
	fi
	if [[ -n "$ref" ]]; then
		"${git[@]}" fetch -q "$REMOTE" "refs/tags/$ref:refs/tags/$ref" 2>/dev/null || true
		if "${git[@]}" rev-parse -q --verify "refs/remotes/$REMOTE/$ref" >/dev/null; then
			"${git[@]}" checkout -q "$ref" ||
				die "git could not switch to branch $ref (local changes to tracked files? 'git -C $REPO_DIR status')"
			"${git[@]}" merge -q --ff-only "$REMOTE/$ref" ||
				die "branch $ref has diverged from $REMOTE/$ref; reconcile it by hand"
		elif "${git[@]}" rev-parse -q --verify "$ref^{commit}" >/dev/null; then
			"${git[@]}" checkout -q --detach "$ref" ||
				die "git could not check out $ref (local changes to tracked files? 'git -C $REPO_DIR status')"
		else
			die "$ref is no branch, tag or commit of $REMOTE"
		fi
	else
		branch="$("${git[@]}" symbolic-ref -q --short HEAD)"
		"${git[@]}" rev-parse -q --verify "$branch@{upstream}" >/dev/null ||
			die "branch $branch tracks no remote branch; set the target: harmony update --version X.Y.Z"
		"${git[@]}" merge -q --ff-only "$branch@{upstream}" ||
			die "git could not fast-forward $branch (local commits or changes to tracked files; 'git -C $REPO_DIR status')"
	fi
}

main "$@"; exit
