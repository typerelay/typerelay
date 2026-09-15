# Development workflow

TypeRelay uses Git flow. `develop` is the integration branch; `main` contains published releases.

## Start work

Update the integration branch, then create a focused branch:

```fish
git switch develop
git pull --ff-only origin develop
git switch -c feature/short-description
```

Use `bugfix/short-description` for fixes. Keep changes focused, add regression tests, and never commit credentials, signing material, real snippets or local SQLite databases.

## Validate and review

Run checks relevant to the change plus the repository policy check. Open feature and bugfix pull requests against `develop`. Describe the user-visible result, automated checks and any manual desktop verification.

Desktop input changes require real target-application checks because successful builds do not verify focus restoration, clipboard ownership or native input behavior.

## Release

Release work starts from reviewed `develop`. The release script verifies a clean, current checkout, merges `develop` into `main` in an isolated worktree, creates the dated release tag, pushes `main`, `develop` and the tag atomically, then publishes the server image.

Use `release/*` only for release preparation and `hotfix/*` for urgent production fixes. Merge hotfix/release results back into `develop`; do not leave the branches diverged. Desktop artifact signing and publication follow the [signed release guide](./signed-releases).
