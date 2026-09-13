# Git-flow

From this baseline forward, `main` holds release history and `develop` is the integration/default branch. Existing history is preserved; no releases are retroactively tagged.

| Work | Start from | Branch | Merge into |
| --- | --- | --- | --- |
| Feature | develop | feature/short-description | develop |
| Ordinary fix | develop | bugfix/short-description | develop |
| Release stabilization | develop | release/x.y.z | main, then develop |
| Urgent released-version fix | main | hotfix/x.y.z | main, then develop |
| Fix during stabilization | release/x.y.z | bugfix/short-description | release/x.y.z |

The GitHub bootstrap continues to default to main; use `--ref develop` explicitly for integration builds. CI builds artifacts but does not publish or deploy releases automatically.

Use pull requests. Do not send feature branches directly to main. Preserve release/hotfix merge history with merge commits; tag the resulting release commit `vX.Y.Z`. Back-merge main into develop after every release or hotfix so fixes cannot be lost. Remove merged topic branches when no longer needed.

## Local setup

After cloning/fetching, run `sh scripts/init-git-flow.sh`. It configures the standard git-flow keys locally and creates tracking branches only if missing. A git-flow extension is optional; ordinary Git commands work too. The script does not reset branches or switch away from your current work.

Example (fish-compatible):

```fish
git switch develop
git pull --ff-only
git switch -c feature/snippet-preview
# Implement and verify, then commit.
git push -u origin feature/snippet-preview
gh pr create --base develop
```

Release: create `release/x.y.z` from current develop, stabilize/version it, and open a PR to main. After that PR merges, tag its main merge commit, push the tag, then open main → develop to bring the release fixes back. Hotfixes follow the same sequence, starting from main. Never rewrite shared branches to simulate this history.

## Checks and GitHub limitation

Repository policy CI validates PR destinations and rejects tracked credential/runtime-file names. Gitleaks scans complete fetched history on pushes and PRs. Existing Rust, web and desktop workflows continue to run on their existing triggers.

GitHub currently returns HTTP 403 for branch protection on this private repository: the account plan does not support it. The repository remains private. CI is therefore advisory, not a server-side block against direct pushes, force-pushes or deletion. When protection becomes available, protect main and develop against deletion/force-push, require PRs and successful applicable checks, and disallow bypasses as appropriate for the team. No additional reviewer count is imposed by this setup.

## Secret checks

Run `python3 scripts/check-repository.py` and `docker compose run --rm --no-deps secrets` before pushing. Signing keys, credential files, environment values and live SQLite databases belong outside Git. Ignore rules are preventative only: force-added files are still checked by CI. Do not add broad scanner allowlists to hide findings.

Initial audit: Gitleaks v8.30.1 scanned all 37 existing commits across local refs and the tracked HEAD snapshot; no leaks were detected. A tracked-filename audit found no private-key, credential or database files. This is a scanner result, not a guarantee that every possible secret representation is detectable. No history rewrite or credential rotation was indicated by the findings.
