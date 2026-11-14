# Releasing

Ferd follows SemVer. Until 2.0.0, data on disk and the public HTTP API stay compatible across patch and minor releases.

- **Patch** (1.0.X): fixes, docs, internal changes.
- **Minor** (1.X.0): new features and fields, additive only.
- **Major** (X.0.0): renames or removes anything in the HTTP API, changes the type or meaning of a stored field, needs a manual data migration, or forces a re-login, re-publish or re-import.

Deprecate before removing where reasonable.

## Stable release

1. Bump `VERSION` and move `[Unreleased]` in `CHANGELOG.md` into a dated section. Commit both to `main`.
2. Tag the commit, signed and annotated:

   ```sh
   git tag -s -a vX.Y.Z -m "Ferd X.Y.Z"
   git push origin main vX.Y.Z
   ```

3. Once the tag reaches GitHub, `release-apk` creates the release. Set its title and notes:

   ```sh
   gh release edit vX.Y.Z --title "Ferd X.Y.Z" --notes-file <notes>
   ```

The tag fires `docker-publish` (images `:X`, `:X.Y`, `:X.Y.Z` and `:latest`) and `release-apk` (the signed Android APK, attached to the release).

After the release, both workflows prune what it superseded with `scripts/prune-releases.py`. `release-apk` deletes the release pages of older betas, keeping the newest beta, since beta testers' Obtainium filters on "beta" in the title and reports an error when no release matches. `docker-publish` deletes superseded beta images, and on every push to `main` also keeps only the newest 20 commit builds, plus the untagged platform images and attestations a kept tag still references. Tags stay: deleting one on GitHub alone would not hold anyway, since the forge sync pushes it back. A beta line that never shipped as its own stable, such as `1.6.0-beta.*` that became 2.0.0, counts as superseded by the stable that absorbed it. `--dry-run` lists what a run would delete.

Both publish workflows wait for `release-gate`, which fails the release unless:

- the tag commit is on `main`,
- the tests pass on that commit,
- a stable tag equals `v` plus the contents of `VERSION`. Beta tags skip this check, since `VERSION` names the last stable release until the next one is cut.

Tags up to v1.4.0 are lightweight and unsigned, and stay that way.

## Beta

Tag `main` without bumping `VERSION` or cutting the changelog:

```sh
git tag -s -a vX.Y.Z-beta.N -m "Ferd X.Y.Z-beta.N"
git push origin vX.Y.Z-beta.N
```

`release-apk` builds the beta app (`io.github.polybjorn.ferd.beta`, shown as "Ferd beta") as a pre-release, and `docker-publish` pushes only `:X.Y.Z-beta.N` and `:beta`. Put the notes on the pre-release with `--title "Ferd X.Y.Z-beta.N"`. The title must contain "beta": the README tells Obtainium beta testers to filter release titles on it.
