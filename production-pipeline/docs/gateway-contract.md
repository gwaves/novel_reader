# Gateway Contract

Gateway consumes filesystem assets. Production Pipeline v2 publishes bulk assets with
`rsync`, then verifies through Gateway HTTP APIs.

## Filesystem Layout

```text
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
- `/mobile/books/:bookId/package`
- `/mobile/books/:bookId/audio`
- sampled `/mobile/books/:bookId/audio/:chapterId/manifest`
- sampled `/mobile/books/:bookId/audio/:chapterId/download`

