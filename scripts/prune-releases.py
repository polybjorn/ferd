#!/usr/bin/env python3
"""Delete superseded beta releases and container images on GitHub.

    python3 scripts/prune-releases.py releases [--dry-run]
    python3 scripts/prune-releases.py images --keep-commits 20 [--dry-run]

releases: deletes the GitHub release of every beta a stable release has
superseded. The newest beta stays even then, because beta testers' Obtainium
filters release titles on "beta" and reports an error when none match. Tags
are never touched.

images: deletes every ghcr version nothing keeps: superseded betas, commit
builds past the newest --keep-commits, and untagged manifests that no kept
tag references. Stable, latest, beta and dev tags always stay, and an untagged
manifest younger than an hour stays, since it may belong to a push still in
progress.

Reads GITHUB_TOKEN and GITHUB_REPOSITORY, as set in a workflow.
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.github.com"
STABLE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
BETA = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$")
COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
# A major tag is short; a commit tag is seven characters and can be all digits.
PROTECTED = re.compile(r"^(latest|beta|dev|\d{1,4}|\d+\.\d+|\d+\.\d+\.\d+)$")
INDEX_TYPES = ",".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
GRACE = timedelta(hours=1)


def superseded_betas(tags):
    """Beta tags at or below the newest stable version, except the newest beta."""
    stables = [tuple(map(int, m.groups())) for m in map(STABLE.match, tags) if m]
    betas = {t: tuple(map(int, m.groups())) for t in tags if (m := BETA.match(t))}
    if not stables or not betas:
        return set()
    newest_stable = max(stables)
    newest_beta = max(betas, key=betas.get)
    return {t for t, v in betas.items() if v[:3] <= newest_stable and t != newest_beta}


def droppable(versions, keep_commits, now):
    """Ids of versions no tag keeps, before references are considered."""
    old_betas = superseded_betas([t for v in versions for t in v["tags"]])
    commit_builds = sorted(
        (v for v in versions if v["tags"] and all(COMMIT.match(t) for t in v["tags"])),
        key=lambda v: v["created"], reverse=True)
    old_commits = {v["id"] for v in commit_builds[keep_commits:]}
    out = set()
    for v in versions:
        if not v["tags"]:
            gone = now - v["created"] > GRACE
        else:
            gone = v["id"] in old_commits or all(t in old_betas for t in v["tags"])
        if gone:
            out.add(v["id"])
    return out


def plan_images(versions, children, keep_commits, now):
    """Pick the image versions to delete.

    versions: dicts with id, digest, tags and created (aware datetime).
    children: digest -> digests that manifest references, for every kept
    tagged version; a multi-arch image's platform manifests and attestations
    are untagged, and deleting one breaks the tag that points at its index.
    """
    drop = droppable(versions, keep_commits, now)
    referenced = {c for v in versions if v["id"] not in drop
                  for c in children.get(v["digest"], ())}
    doomed = [v for v in versions if v["id"] in drop and v["digest"] not in referenced]
    for v in doomed:
        hit = [t for t in v["tags"] if PROTECTED.match(t)]
        if hit:
            raise SystemExit(f"refusing to delete {v['digest']}: protected tags {hit}")
    return doomed


def request(url, token, method="GET", accept="application/vnd.github+json", auth="Bearer"):
    req = urllib.request.Request(url, method=method, headers={
        "Accept": accept, "Authorization": f"{auth} {token}"})
    with urllib.request.urlopen(req) as resp:
        body = resp.read()
    return json.loads(body) if body else None


def paged(url, token):
    page = 1
    while True:
        sep = "&" if "?" in url else "?"
        batch = request(f"{url}{sep}per_page=100&page={page}", token)
        if not batch:
            return
        yield from batch
        page += 1


def delete(url, token):
    try:
        request(url, token, method="DELETE")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise


def prune_releases(repo, token, dry_run):
    releases = list(paged(f"{API}/repos/{repo}/releases", token))
    old = superseded_betas([r["tag_name"] for r in releases])
    for r in releases:
        if r["tag_name"] in old and r["prerelease"]:
            print(f"delete release {r['tag_name']}")
            if not dry_run:
                delete(f"{API}/repos/{repo}/releases/{r['id']}", token)


def registry_token(repo, token):
    basic = base64.b64encode(f"x:{token}".encode()).decode()
    url = f"https://ghcr.io/token?service=ghcr.io&scope=repository:{repo}:pull"
    return request(url, basic, auth="Basic")["token"]


def prune_images(repo, token, keep_commits, dry_run):
    owner, name = repo.lower().split("/")
    base = f"{API}/users/{owner}/packages/container/{name}/versions"
    versions = [{
        "id": v["id"], "digest": v["name"],
        "tags": v["metadata"]["container"]["tags"],
        "created": datetime.fromisoformat(v["created_at"].replace("Z", "+00:00")),
    } for v in paged(base, token)]

    now = datetime.now(timezone.utc)
    drop = droppable(versions, keep_commits, now)
    reg = registry_token(f"{owner}/{name}", token)
    children = {}
    for v in versions:
        if v["tags"] and v["id"] not in drop:
            man = request(f"https://ghcr.io/v2/{owner}/{name}/manifests/{v['digest']}",
                          reg, accept=INDEX_TYPES)
            children[v["digest"]] = [m["digest"] for m in man.get("manifests", [])]

    doomed = plan_images(versions, children, keep_commits, now)
    print(f"{len(versions)} versions, deleting {len(doomed)}")
    for v in doomed:
        print(f"delete {v['digest'][:19]} {','.join(v['tags']) or '(untagged)'}")
        if not dry_run:
            delete(f"{base}/{v['id']}", token)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("what", choices=["releases", "images"])
    ap.add_argument("--keep-commits", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    token, repo = os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"]
    if args.what == "releases":
        prune_releases(repo, token, args.dry_run)
    else:
        prune_images(repo, token, args.keep_commits, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
