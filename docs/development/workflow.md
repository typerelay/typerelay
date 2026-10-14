# Development workflow

`develop` is the active development branch; `main` contains published releases.

## Start work

After plan approval, update `develop` without discarding existing work:

```fish
git switch develop
git pull --ff-only origin develop
```

Maintainer and agent tasks create a task branch and worktree from current `develop`, then implement, review, and test there. Follow `AGENTS.md` and `.github/CONTRIBUTING.md`. External contributors may use any branch name.

All contribution pull requests target `develop`. Set the base explicitly with `gh pr create --base develop`; verify it after creation and before merging with `gh pr view --json baseRefName --jq .baseRefName`. A default branch is a convenience, not enforcement: GitHub still allows someone to open a PR against another branch.

## Validate and deliver

Run checks relevant to the change plus the repository policy check. Commit only task-scoped files and obtain independent review. Incorporate any newer `develop` changes and repeat affected checks before integrating into `develop`. Verify the integrated result and push it to the configured remote. Preserve unrelated work and clean up only the completed task's worktree after remote integration is verified. Describe the user-visible result, automated checks and any manual desktop verification.

Desktop input changes require real target-application checks because successful builds do not verify focus restoration, clipboard ownership or native input behavior.

## Release

`main` is release-only. Release work requires explicit authorization and starts from current `develop`. The release script verifies a clean checkout, merges `develop` into `main` in an isolated worktree, creates the dated release tag, pushes `main`, `develop` and the tag atomically, then publishes the server image. Keep release credentials separate from ordinary contribution credentials. Desktop artifact signing and publication follow the [signed release guide](./signed-releases.md).

`release.sh` uses the shared `Nitai Release` GitHub App launcher from `~/repos/helpmonks-install-script/scripts/github-app-release/release.mjs`. Keep that checkout current. Its key is `~/.config/github-apps/nitai-release/private-key.pem` with owner-only permissions. Check installation access without publishing using `node ~/repos/helpmonks-install-script/scripts/github-app-release/release.mjs --check`. `--dry-run` and `--help` do not require the key. See the [shared authentication and ruleset guide](https://github.com/Helpmonks/helpmonks-install-script/blob/master/scripts/github-app-release/README.md) for other projects and private-repository plan requirements.

The GitHub settings use `develop` as the default branch and separate `main` rulesets: history protection has no bypass; update restriction permits only the release App. The key can authorize writes across its installed repositories, so keep it separate from ordinary development access. These rules do not prevent an administrator from changing repository settings.
