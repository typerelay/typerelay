#!/bin/sh
# Idempotent local Git-flow configuration; never resets or checks out branches.
set -eu
git rev-parse --show-toplevel >/dev/null
for branch in main develop; do
    if ! git show-ref --verify --quiet "refs/heads/$branch"; then
        git branch --track "$branch" "origin/$branch"
    fi
done
git config --local gitflow.branch.master main
git config --local gitflow.branch.develop develop
git config --local gitflow.prefix.feature feature/
git config --local gitflow.prefix.bugfix bugfix/
git config --local gitflow.prefix.release release/
git config --local gitflow.prefix.hotfix hotfix/
git config --local gitflow.prefix.support support/
git config --local gitflow.prefix.versiontag v
printf '%s\n' 'Git-flow configured: main / develop; feature/, bugfix/, release/, hotfix/; tags v*.'
