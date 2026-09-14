#!/usr/bin/env bash
set -euo pipefail

remote="origin"
develop_branch="develop"
main_branch="main"
dry_run=0
assume_yes=0
release_worktree=""

usage() {
	printf '%s\n' "Usage: ./release.sh [options]"
	printf '%s\n' ""
	printf '%s\n' "Options:"
	printf '%s\n' "    --dry-run              Show release steps without changing git state"
	printf '%s\n' "    --yes                  Skip confirmation prompt"
	printf '%s\n' "    --remote <name>        Remote to use (default: origin)"
	printf '%s\n' "    --develop <branch>     Develop branch name (default: develop)"
	printf '%s\n' "    --main <branch>        Main branch name (default: main)"
	printf '%s\n' "    --help                 Show this help"
}

log() {
	printf '%s\n' "$*"
}

fail() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

run() {
	if [ "$dry_run" -eq 1 ]; then
		printf '+'
		printf ' %q' "$@"
		printf '\n'
		return 0
	fi

	"$@"
}

current_branch() {
	git symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

cleanup_release_worktree() {
	if [ "$dry_run" -eq 1 ]; then
		return 0
	fi

	if [ -z "$release_worktree" ]; then
		return 0
	fi

	if [ -e "$release_worktree/.git" ]; then
		git worktree remove --force "$release_worktree" >/dev/null 2>&1 || true
	elif [ -d "$release_worktree" ]; then
		rmdir "$release_worktree" >/dev/null 2>&1 || true
	fi
}

require_clean_tree() {
	git diff --quiet || fail "working tree has unstaged changes"
	git diff --cached --quiet || fail "index has staged changes"

	if [ -n "$(git ls-files --others --exclude-standard)" ]; then
		fail "working tree has untracked files"
	fi
}

require_branch() {
	local branch="$1"

	git show-ref --verify --quiet "refs/heads/${branch}" || fail "local branch ${branch} is missing"
}

require_remote_branch() {
	local branch="$1"

	git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null || fail "remote branch ${remote}/${branch} is missing"
}

require_version() {
	local version="$1"

	if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		fail "project version must be X.Y.Z"
	fi
}

workspace_version() {
	awk '
		$0 == "[workspace.package]" { in_workspace_package = 1; next }
		in_workspace_package && /^\[/ { exit }
		in_workspace_package && $1 == "version" { gsub(/"/, "", $3); print $3; exit }
	' Cargo.toml
}

cargo_package_version() {
	awk '$1 == "version" { gsub(/"/, "", $3); print $3; exit }' "$1"
}

json_package_version() {
	sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

release_version() {
	local version
	local source
	local source_version

	version="$(workspace_version)"
	[ -n "$version" ] || fail "Cargo.toml workspace version is missing"
	require_version "$version"

	for source in apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json; do
		case "$source" in
			*.json)
				source_version="$(json_package_version "$source")"
				;;
			*)
				source_version="$(cargo_package_version "$source")"
				;;
		esac

		[ "$source_version" = "$version" ] || fail "${source} version ${source_version:-<missing>} does not match Cargo.toml ${version}"
	done

	printf '%s\n' "$version"
}

local_tag_points_at_commit() {
	local tag="$1"
	local commit="$2"

	if ! git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
		return 1
	fi

	local target
	target="$(git rev-list -n 1 "$tag")"

	[ "$target" = "$commit" ]
}

remote_tag_exists() {
	local tag="$1"

	git ls-remote --exit-code --tags --refs "$remote" "$tag" >/dev/null 2>&1
}

local_tag_is_reusable() {
	local tag="$1"
	local release_commit="$2"

	if ! git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
		return 1
	fi

	if remote_tag_exists "$tag"; then
		fail "release tag ${tag} already exists on ${remote}"
	fi

	if local_tag_points_at_commit "$tag" "$release_commit"; then
		return 0
	fi

	fail "local tag ${tag} exists but does not point at release head"
}

create_release_worktree() {
	if [ "$dry_run" -eq 1 ]; then
		release_worktree="<release-worktree>"
		run git worktree add --detach "$release_worktree" "${remote}/${main_branch}"
		return 0
	fi

	release_worktree="$(mktemp -d "${TMPDIR:-/tmp}/typerelay-release.XXXXXX")"
	git worktree add --detach "$release_worktree" "${remote}/${main_branch}" >/dev/null
}

fast_forward_local_branch() {
	local branch="$1"
	local release_commit="$2"
	local branch_commit

	branch_commit="$(git rev-parse "$branch")"

	if [ "$dry_run" -eq 1 ]; then
		log "Fast-forwarding local ${branch}"
		run git update-ref "refs/heads/${branch}" "$release_commit" "$branch_commit"
		return 0
	fi

	if ! git merge-base --is-ancestor "$branch" "$release_commit"; then
		fail "local ${branch} cannot fast-forward to release head"
	fi

	if [ "$(current_branch)" = "$branch" ]; then
		log "Fast-forwarding checked-out ${branch}"
		run git merge --ff-only "$release_commit"
		return 0
	fi

	log "Fast-forwarding local ${branch}"
	run git update-ref "refs/heads/${branch}" "$release_commit" "$branch_commit"
}

confirm_release() {
	local tag="$1"

	if [ "$assume_yes" -eq 1 ] || [ "$dry_run" -eq 1 ]; then
		return 0
	fi

	printf 'Release %s into %s as %s? [y/N] ' "$develop_branch" "$main_branch" "$tag"

	local answer
	read -r answer

	case "$answer" in
		y|Y|yes|YES)
			return 0
			;;
	esac

	fail "release cancelled"
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--dry-run)
				dry_run=1
				shift
				;;
			--yes)
				assume_yes=1
				shift
				;;
			--remote)
				[ "$#" -ge 2 ] || fail "--remote requires a value"
				remote="$2"
				shift 2
				;;
			--develop)
				[ "$#" -ge 2 ] || fail "--develop requires a value"
				develop_branch="$2"
				shift 2
				;;
			--main)
				[ "$#" -ge 2 ] || fail "--main requires a value"
				main_branch="$2"
				shift 2
				;;
			--help)
				usage
				exit 0
				;;
			*)
				fail "unknown option $1"
				;;
		esac
	done
}

main() {
	parse_args "$@"

	local repo_root
	repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository"
	cd "$repo_root"

	if [ -z "$(current_branch)" ]; then
		fail "detached HEAD is not supported"
	fi

	require_clean_tree
	require_branch "$develop_branch"
	require_branch "$main_branch"
	require_remote_branch "$develop_branch"
	require_remote_branch "$main_branch"

	trap cleanup_release_worktree EXIT

	log "Fetching ${remote}"
	run git fetch "$remote" --prune --tags

	log "Pushing ${develop_branch}"
	run git push "$remote" "$develop_branch"

	log "Refreshing ${remote}"
	run git fetch "$remote" --prune --tags

	local version
	version="$(release_version)"

	local tag="v${version}"

	if remote_tag_exists "$tag"; then
		fail "release tag ${tag} already exists on ${remote}"
	fi

	confirm_release "$tag"

	log "Creating release worktree"
	create_release_worktree

	run git -C "$release_worktree" merge --no-ff --no-edit "${remote}/${develop_branch}"

	local release_commit
	if [ "$dry_run" -eq 1 ]; then
		release_commit="<release-head>"
	else
		release_commit="$(git -C "$release_worktree" rev-parse HEAD)"
	fi

	if [ "$dry_run" -eq 1 ]; then
		log "Creating tag ${tag}"
		run git -C "$release_worktree" tag -a "$tag" -m "$tag"
	elif local_tag_is_reusable "$tag" "$release_commit"; then
		log "Reusing local tag ${tag}"
	else
		log "Creating tag ${tag}"
		run git -C "$release_worktree" tag -a "$tag" -m "$tag"
	fi

	log "Pushing ${main_branch}, ${develop_branch}, and ${tag}"
	run git -C "$release_worktree" push --atomic "$remote" "HEAD:refs/heads/${main_branch}" "HEAD:refs/heads/${develop_branch}" "refs/tags/${tag}"

	fast_forward_local_branch "$main_branch" "$release_commit"
	fast_forward_local_branch "$develop_branch" "$release_commit"

	log "Release ${tag} complete"
}

main "$@"
