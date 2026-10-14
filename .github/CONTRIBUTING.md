# Contributing

`develop` is the integration branch. `main` contains published releases.

- Base contribution branches on current `develop` and target `develop` in every contribution pull request.
- With GitHub CLI, use `gh pr create --base develop`. Verify the base after creation and again before merging: `gh pr view --json baseRefName --jq .baseRefName`.
- Maintainer and agent tasks follow [AGENTS.md](../AGENTS.md): obtain plan approval, use a task branch and worktree, and complete independent review and relevant checks before integrating into `develop`.
- External contributors may use any branch name. Include focused tests and describe manual verification where desktop input behavior changes.
- Update `main` only through explicitly authorized release work. Never use release credentials for ordinary contribution work.
- Do not commit credentials, private snippets, signing material, or local databases.

See the [development workflow](../docs/development/workflow.md) for validation and release details.
