# Stage Design

Every stage implements the same high-level contract:

- read job config and run context
- discover expected items
- compare expected items with durable outputs
- process missing or forced items
- update item progress
- write stage summary
- expose verification data

## import

Input:

- source file or main database book id

Output:

- normalized `books` and `chapters` rows

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

Output:

- `summary_embeddings`
- `chapter_chunk_embeddings`

Processing:

- split chapters inside the pipeline
- generate summary embeddings
- generate chunk embeddings
- write directly to SQLite

Resume:

- skip chapters with summary embedding and complete expected chunk embeddings
- regenerate a chapter only when forced or when expected chunk count differs

## audio

Input:

- `chapters`
- TTS config

Output:

- chapter MP3 files
- chapter timeline manifests
- local audio catalog candidate

Resume:

- skip chapters with valid `chapter.mp3` and `manifest.json`
- regenerate chapters only when forced

## package

Input:

- main database durable data
- generated artifacts

Output:

- `package.json`
- optional split package assets

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

- `rsync`

Resume:

- rerun rsync safely; it is naturally incremental

## verify

Input:

- gateway URL
- local artifact summary

Output:

- verification report

Checks:

- book exists
- package chapter count matches
- audio chapter count matches
- sampled manifests and downloads return 200

