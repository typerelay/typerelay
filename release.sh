#!/usr/bin/env bash
set -euo pipefail

remote="origin"
develop_branch="develop"
main_branch="main"
image_build="local"
ghcr_image="${GHCR_IMAGE:-ghcr.io/typerelay/typerelay}"
dry_run=0
assume_yes=0
release_worktree=""

usage() {
	printf '%s\n' "Usage: ./release.sh [options]"
	printf '%s\n' ""
	printf '%s\n' "Options:"
	printf '%s\n' "    --build <local|dbh>    Build and push the image locally or on DBH (default: local)"
	printf '%s\n' "    --dry-run              Show release steps without changing git state"
	printf '%s\n' "    --yes                  Skip confirmation prompt"
	printf '%s\n' "    --remote <name>        Remote to use (default: origin)"
	printf '%s\n' "    --develop <branch>     Develop branch name (default: develop)"
	printf '%s\n' "    --main <branch>        Main branch name (default: main)"
	printf '%s\n' "    --help                 Show this help"
	printf '%s\n' ""
	printf '%s\n' "Environment:"
	printf '%s\n' "    GHCR_IMAGE=<image>     Override image name (default: ghcr.io/typerelay/typerelay)"
	printf '%s\n' "    GHCR_USERNAME=<user>   Override username for local GHCR login"
	printf '%s\n' "    RELEASE_DATE=YYYYMMDD  Override release date for tag creation"
}

log() {
	printf '%s\n' "$*"
}

fail() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	local command_name="$1"

	command -v "$command_name" >/dev/null 2>&1 || fail "${command_name} is required for --build ${image_build}"
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

require_date() {
	local value="$1"

	if [[ ! "$value" =~ ^[0-9]{8}$ ]]; then
		fail "RELEASE_DATE must be YYYYMMDD"
	fi
}

release_date() {
	if [ -n "${RELEASE_DATE:-}" ]; then
		require_date "$RELEASE_DATE"
		printf '%s\n' "$RELEASE_DATE"
		return 0
	fi

	date '+%Y%m%d'
}

remote_tag_names_for_date() {
	local date_prefix="$1"

	git ls-remote --tags --refs "$remote" "${date_prefix}[0-9]*" |
		awk '{print $2}' |
		sed 's#refs/tags/##' |
		grep -E "^${date_prefix}[0-9]+$" || true
}

next_tag_for_date() {
	local date_prefix="$1"
	local highest=0
	local tag
	local suffix

	while IFS= read -r tag; do
		[ -n "$tag" ] || continue
		suffix="${tag#${date_prefix}}"

		if [ "$suffix" -gt "$highest" ] 2>/dev/null; then
			highest="$suffix"
		fi
	done <<EOF
$(remote_tag_names_for_date "$date_prefix")
EOF

	printf '%s%s\n' "$date_prefix" "$((highest + 1))"
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

	printf 'Release %s into %s, push tag %s, and build via %s? [y/N] ' "$develop_branch" "$main_branch" "$tag" "$image_build"

	local answer
	read -r answer

	case "$answer" in
		y|Y|yes|YES)
			return 0
			;;
	esac

	fail "release cancelled"
}

prepare_image_build() {
	if [ "$dry_run" -eq 1 ]; then
		return 0
	fi

	require_command gh
	gh auth token --hostname github.com >/dev/null 2>&1 || fail "GitHub CLI is not authenticated"

	if [ "$image_build" = "local" ]; then
		require_command docker
		docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is not available"
	else
		require_command dbh-run
		dbh-run exec -- docker buildx version >/dev/null || fail "Docker Buildx is not available on DBH"
	fi
}

login_to_ghcr() {
	if [ "$dry_run" -eq 1 ]; then
		log "+ gh auth token --hostname github.com | docker login ghcr.io --username <github-user> --password-stdin"
		return 0
	fi

	local ghcr_username
	ghcr_username="${GHCR_USERNAME:-$(gh api user --hostname github.com --jq .login)}"
	gh auth token --hostname github.com | docker login ghcr.io --username "$ghcr_username" --password-stdin
}

build_image_locally() {
	local tag="$1"
	local release_commit="$2"

	log "Logging into GHCR"
	login_to_ghcr

	log "Building and pushing ${ghcr_image}:${tag} and ${ghcr_image}:latest locally"
	run docker buildx build --platform linux/amd64 --file "$release_worktree/apps/server/Dockerfile" --target production --build-arg "APP_VERSION=${tag}" --label "org.opencontainers.image.revision=${release_commit}" --label "org.opencontainers.image.version=${tag}" --provenance=false --tag "${ghcr_image}:${tag}" --tag "${ghcr_image}:latest" --push "$release_worktree"
}

build_image_on_dbh() {
	local tag="$1"
	local release_commit="$2"
	local ghcr_username
	ghcr_username="${GHCR_USERNAME:-$(gh api user --hostname github.com --jq .login)}"

	if [ "$dry_run" -eq 1 ]; then
		log "+ gh auth token --hostname github.com | dbh-run exec -- docker login ghcr.io --username <github-user> --password-stdin"
		log "+ dbh-run exec -- docker buildx build --platform linux/amd64 --file apps/server/Dockerfile --target production --build-arg APP_VERSION=${tag} --label org.opencontainers.image.revision=${release_commit} --label org.opencontainers.image.version=${tag} --provenance=false --tag ${ghcr_image}:${tag} --tag ${ghcr_image}:latest --push ."
		return 0
	fi

	log "Logging into GHCR on DBH"
	gh auth token --hostname github.com | (cd "$release_worktree" && dbh-run exec -- docker login ghcr.io --username "$ghcr_username" --password-stdin)
	log "Building and pushing ${ghcr_image}:${tag} and ${ghcr_image}:latest on DBH"
	(cd "$release_worktree" && dbh-run exec -- docker buildx build --platform linux/amd64 --file apps/server/Dockerfile --target production --build-arg "APP_VERSION=${tag}" --label "org.opencontainers.image.revision=${release_commit}" --label "org.opencontainers.image.version=${tag}" --provenance=false --tag "${ghcr_image}:${tag}" --tag "${ghcr_image}:latest" --push .)
}

publish_image() {
	local tag="$1"
	local release_commit="$2"

	case "$image_build" in
	local)
		build_image_locally "$tag" "$release_commit"
		;;
	dbh)
		build_image_on_dbh "$tag" "$release_commit"
		;;
	esac
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--build)
				[ "$#" -ge 2 ] || fail "--build requires local or dbh"

				case "$2" in
					local|dbh)
						image_build="$2"
						;;
					*)
						fail "--build must be local or dbh"
						;;
				esac

				shift 2
				;;
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

	local date_prefix
	date_prefix="$(release_date)"

	local tag
	tag="$(next_tag_for_date "$date_prefix")"

	confirm_release "$tag"
	prepare_image_build

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
	publish_image "$tag" "$release_commit"

	log "Release ${tag} and ${image_build} image push complete"
}

main "$@"
