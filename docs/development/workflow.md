# Development workflow

`develop` is the active development branch; `main` contains published releases.

## Start work

Update `develop` and work in the existing checkout:

```fish
git switch develop
git pull --ff-only origin develop
```

Maintainer and Codex tasks commit focused changes and push `develop` directly. Do not create a topic branch or pull request unless the task explicitly requests one. External contributors may open pull requests against `develop`; branch names are unrestricted.

## Validate and deliver

Run checks relevant to the change plus the repository policy check. Commit only task-scoped files, then push `develop`. Describe the user-visible result, automated checks and any manual desktop verification.

Desktop input changes require real target-application checks because successful builds do not verify focus restoration, clipboard ownership or native input behavior.

## Release

Release work starts from current `develop`. The release script verifies a clean checkout, merges `develop` into `main` in an isolated worktree, creates the dated release tag, pushes `main`, `develop` and the tag atomically, then publishes the server image. Desktop artifact signing and publication follow the [signed release guide](./signed-releases).
