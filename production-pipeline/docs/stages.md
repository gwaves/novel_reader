# Stage Design

Every stage implements the same high-level contract:

- read job config and run context
- discover expected items
- compare expected items with durable outputs
- process missing or forced items
- update item progress
- write stage summary
- expose verification data

The `run` command reads a job JSON and executes the configured stage list in
order. The `resume` command reads the existing `run.json`; by default it skips
stages already marked `completed` and reruns stages that are missing or failed.
Each orchestrated stage is run as a child stage run under the parent run so the
single-stage commands remain independently usable.

Current v2 CLI stages:

- `import`
- `embedding`
- `audio`
- `package`
- `publish`
- `verify`

Planned but not yet wired into the v2 CLI:

- `summary`
- `kg`

## import

Input:

- source file or main database book id
- optional `job.source.file` for TXT imports

Output:

- normalized `books` and `chapters` rows
- an import report and chapter preview artifact

Idempotency:

- source hash or book id identifies the book
- existing chapter ids are preserved when possible

## summary

Input:

- `chapters`
- summary model config

Output:

- durable chapter summary records

Resume:

- skip chapters that already have summaries unless forced

## kg

Input:

- `chapters`
- knowledge graph model config

Output:

- entities
- entity mentions
- relations
- relation mentions
- extraction metadata

Resume:

- skip chapters with completed KG extraction unless forced

## embedding

Input:

- `chapters`
- summaries
- embedding provider config
- `mainDbPath`

Output:

- `summary_embeddings`
- `chapter_chunk_embeddings`

Processing:

- split chapters inside the pipeline
- generate summary embeddings
- generate chunk embeddings
- write directly to SQLite
- call the provider directly; do not call `127.0.0.1:5174`

Resume:

- skip chapters with summary embedding and complete expected chunk embeddings
- regenerate a chapter only when forced or when expected chunk count differs

## audio

Input:

- `chapters`
- existing MP3 artifact directory from `job.audio.sourceRoot`, or
- TTS director config from `job.audio.ttsConfig`
- optional `job.audio.chapters`; when omitted, v2 generates `1-<chapterCount>`

Output:

- optional TTS source tree from `offline-tts/scripts/tts-director.mjs batch-pipeline`
- Gateway-ready copied `chapter.mp3` files
- copied timeline manifests when present
- `audio.json` with canonical main DB chapter ids
- `tts-director.log` when v2 invokes the TTS director

Resume:

- rerun safely from the existing source artifact directory
- generated TTS runs can pass `resume: true` through to the TTS director
- strict mode fails when an MP3 chapter number cannot map to a main DB chapter

## package

Input:

- main database durable data
- generated artifacts

Output:

- `package.json`
- `book-summary.json`
- Gateway data directory under the stage run artifacts

Identity:

- `package.book.id` must equal job `bookId`
- chapter ids are canonical and reused by audio

## publish

Input:

- package artifacts
- audio artifacts
- gateway config

Output:

- files synced to Gateway host

Mechanism:

- local or remote `rsync`
- remote publish uses SSH options from `gateway` / `publish`

Resume:

- rerun rsync safely; it is naturally incremental
- package publish also merges `books.json` before syncing

## verify

Input:

- gateway URL
- local artifact summary

Output:

- verification report

Checks:

- book exists
- package chapter count matches
- package chapter ids match in order
- package summary chapter ids match when summaries are present
- package knowledge graph counts match when KG is present
- package embedding coverage metadata matches when embeddings are present
- audio chapter count matches
- audio chapter ids match in order
- sampled audio manifests are readable when `manifestFileName` is present
- sampled audio downloads return non-empty MP3 responses

Mechanism:

- Gateway HTTP only
- no bulk upload through the Gateway API
