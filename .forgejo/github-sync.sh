#!/bin/bash
# Pushes the ref this run was triggered by to github.com/polybjorn/ferd,
# history and all, after the denylist gate has read every commit GitHub does
# not hold yet. A full-history push cannot drop files the way the snapshot
# publish action does, so the gate is what stands between the forge and GitHub.
set -euo pipefail

refuse() { echo "github-sync: $*" >&2; exit 1; }

ci_actions="${1:?usage: github-sync.sh CI_ACTIONS_DIR}"

[ -n "${DEPLOY_KEY:-}" ] || refuse "PUBLISH_DEPLOY_KEY is empty"
[ -n "${DENYLIST:-}" ] || refuse "DEPLOY_DENYLIST is empty, and an empty list passes anything"
case "$REF" in
  refs/heads/main|refs/tags/v*) ;;
  *) refuse "not a ref this job publishes: $REF" ;;
esac

url=git@github.com:polybjorn/ferd.git
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The forge UI can drop a pasted key's final newline, and ssh refuses a key
# without one
(umask 077 && printf '%s\n' "$DEPLOY_KEY" > "$work/key")
unset DEPLOY_KEY
# GitHub's ed25519 host key as published at api.github.com/meta, pinned so a
# first connection cannot be talked into trusting another host
echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$work/known_hosts"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/known_hosts -o StrictHostKeyChecking=yes"

git fetch -q --no-tags "$url" refs/heads/main || refuse "could not fetch main from GitHub"
github_main=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor "$github_main" HEAD \
  || refuse "GitHub main ($github_main) is not in the forge history, so something landed on GitHub. Pull it into the forge with git pull github main && git push origin main; that push syncs again."

if [ "$(git rev-list --count "$github_main..HEAD")" -gt 0 ]; then
  python3 "$ci_actions/denylist-gate/gate.py" commits "$github_main..HEAD" \
    || refuse "the denylist gate refused a commit, so nothing was pushed"
fi

git push "$url" "HEAD:$REF"
