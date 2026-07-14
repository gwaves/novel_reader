# Gateway Contract

Gateway consumes filesystem assets. Production Pipeline v2 publishes bulk assets with
`rsync`, then verifies through Gateway HTTP APIs.

## Filesystem Layout

```text
data/books.json
data/books/<bookId>/package.json
audio/books/<bookId>/audio.json
audio/books/<bookId>/chxxx-.../chapter.mp3
audio/books/<bookId>/chxxx-.../manifest.json
data/downloads/android-app.json
data/downloads/novel_gateway.apk
data/downloads/novel_gateway-v<versionName>-debug.apk
```

## Identity Rules

- `package.book.id` must equal `<bookId>`.
- `package.chapters[].id` must equal `audio.chapters[].chapterId` for matching
  chapters.
- Audio catalog order must match package chapter order.
- A book must not be published under a temporary slug if the main database has a
  stable book id.
- `data/books.json` must include the same stable book id, otherwise Gateway can
  serve the package by direct URL but the mobile library will not list the book.
- Android Gateway packages must use `novel_gateway.apk` for the stable latest
  file and `novel_gateway-v<versionName>-debug.apk` for archived builds.
  `android-app.json` must point `latestFileName` / `latestUrl` and
  `versionedFileName` / `versionedUrl` at those files.

## Publish

Publishing uses `rsync`:

```text
local artifacts
  -> rsync package bundle
  -> rsync audio bundle
```

HTTP upload APIs are intentionally avoided for large files.

When Production Pipeline publishes into a Gateway bind mount through
`gatewayDataDir` or `gatewayAudioDir`, the publisher must run as the same UID/GID
that owns the Gateway host directories. The 88.100 deployment uses
`gwaves:gwaves` (`1000:1000`). Do not run the production service as root for
local bind-mount publishing, because `rsync` will create root-owned Gateway
assets that later cannot be edited by the Gateway service or normal deploy user.

For same-host deployments, prefer `gateway.root` or explicit
`gatewayDataDir`/`gatewayAudioDir` local paths. The publisher automatically uses
local directories when the Gateway root exists inside the container; SSH publish
is reserved for remote Gateway hosts.

Remote SSH publishing should use the Gateway deploy user, normally `gwaves`, so
the remote filesystem ownership stays consistent with the Gateway deployment.

## Verification

After publish, verify through Gateway HTTP APIs:

- `/health`
- `/mobile/books`
- when `--gateway-admin-token` is provided, `/admin/books` and `/auth/session`
- `/mobile/books/:bookId/package`
- `/mobile/books/:bookId/audio`
- sampled `/mobile/books/:bookId/audio/:chapterId/manifest`
- sampled `/mobile/books/:bookId/audio/:chapterId/download`
- when `--gateway-admin-token` is provided, `POST /admin/books/:bookId/audio/refresh`
  followed by `GET /admin/audio`

Audio verification compares the remote audio catalog with the run artifact:

- chapter ids must match the generated `audio.json`
- `durationMs` and `sizeBytes` must match the generated `audio.json`
- sampled MP3 downloads must have the same byte length as `sizeBytes`
- admin refresh/list summaries must agree with the generated audio chapter count,
  missing chapter count, and total audio size

Package visibility verification compares Admin book catalog visibility with the
current mobile session's `allowedVisibilities` and the `/mobile/books` result.
This catches cases where `books.json` contains the book but the target mobile
device cannot actually see it, or where a hidden/trusted book is unexpectedly
visible to the wrong device role.
