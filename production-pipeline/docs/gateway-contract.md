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

## Publish

Publishing uses `rsync`:

```text
local artifacts
  -> rsync package bundle
  -> rsync audio bundle
```

HTTP upload APIs are intentionally avoided for large files.

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
