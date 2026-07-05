# Release Policy

Novel Reader Assistant is still pre-1.0, but published releases should remain stable and reproducible.

## Versioning

- Use semantic versioning style: `MAJOR.MINOR.PATCH`.
- While the project is under `1.0.0`, minor versions may include breaking workflow changes.
- Prefer the `v` prefix for future tags, for example `v0.8.0`, to keep release naming consistent going forward.

## Release Checklist

1. Merge feature and documentation PRs into `main`.
2. Update user-facing documentation and release notes.
3. Run local validation:

   ```bash
   npm run lint
   npm run build
   ```

4. Confirm GitHub Actions are green on `main`.
5. Create an annotated tag from the intended `main` commit.
6. Publish a GitHub Release with user-facing highlights, upgrade notes, and a changelog link.

## Tag Discipline

Do not move or force-push a published release tag. If a release misses a fix or PR, publish a patch release instead, such as `v0.8.1`.

Draft releases are fine while preparing notes, but a published release should point to an immutable commit.

## Notes

- Gateway Android APKs are published through the Gateway downloads flow as `/downloads/novel_gateway.apk`; release notes should include the Android `versionName`, `versionCode`, build number, and source commit. If APKs are attached to GitHub Releases later, include build provenance and the exact source commit.
- Any database migration or local data compatibility concern should be called out in the release notes.
