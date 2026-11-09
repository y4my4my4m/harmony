# Modes of the files the containers read. Sourced by lib.sh and configure.sh, never run; expects
# REPO_DIR.
#
# A bind mount, and COPY in an image build, keep the host file's mode and owner. supabase-db
# (postgres) runs supabase/volumes/db/*.sql, kong (kong) reads supabase/volumes/api/kong.yml, and
# the images HARMONY_BUILD=1 builds run as node: each reads through the "other" bits. git and tar
# create files 0666 and directories 0777 less the umask: 0600 and 0700 under umask 077, 0640 and
# 0750 under 027.
#
# Public paths: the files git tracks in the checkout and their directories, and self-host/supabase
# (upstream's docker/ directory) less its data (volumes/db/data*, volumes/storage*), its .env and
# .env.* files, and the other operator files upstream's .gitignore names (test.http,
# docker-compose.override.yml). Each gets the modes umask 022 gives: o+r, and o+x on a directory
# and on a file its owner may execute. Untracked files elsewhere keep their modes: .env,
# federation.env, livekit.yaml and backups/ stay 0600 and 0700.

# public_unreadable: public files without o+r and public directories without o+rx, each path
# relative to REPO_DIR and NUL-terminated.
public_unreadable() (
	sb=self-host/supabase
	cd "$REPO_DIR" 2>/dev/null || exit 0
	{
		printf '.\0'
		git ls-tree -r -d -z --name-only HEAD 2>/dev/null
		git ls-files -z 2>/dev/null
	} | while IFS= read -r -d '' p; do printf './%s\0' "$p"; done |
		xargs -0 -r sh -c 'find "$@" -maxdepth 0 \( -type f ! -perm -0004 -o -type d ! -perm -0005 \) -print0 2>/dev/null; :' sh
	[[ ! -d "$sb" ]] || find "$sb" \( -path "$sb/volumes/db/data*" -o -path "$sb/volumes/storage*" \
		-o -name .env -o -name '.env.*' -o -path "$sb/test.http" -o -path "$sb/docker-compose.override.yml" \) -prune \
		-o \( -type f ! -perm -0004 -o -type d ! -perm -0005 \) -print0 2>/dev/null
	exit 0
)

# public_readable: gives each path public_unreadable lists the modes above. PUBLIC_CHANGED is how
# many it listed; status non-zero when chmod refused one (a file of another user, without root).
PUBLIC_CHANGED=0
public_readable() {
	local p
	local -a paths=()
	while IFS= read -r -d '' p; do paths+=("$p"); done < <(public_unreadable)
	PUBLIC_CHANGED=${#paths[@]}
	(( PUBLIC_CHANGED )) || return 0
	( cd "$REPO_DIR" && printf '%s\0' "${paths[@]}" | xargs -0 chmod a+rX -- ) 2>/dev/null
}
