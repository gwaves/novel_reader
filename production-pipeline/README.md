# Production Pipeline v2

Production Pipeline v2 is the independent content production system for Novel Reader.
It produces durable assets for the PC app, Gateway, and mobile readers without
depending on the PC local API service, frontend dev server, or Gateway runtime except
for final verification.

## Design Decisions

- CLI first. No local HTTP control service in v1.
- Runtime state is stored under each run directory, not in the main Novel Reader DB.
- The main SQLite database stores only durable product data such as summaries,
  knowledge graph data, and embeddings.
- Gateway publishing uses file sync, primarily `rsync`, because package and audio
  assets can be large.
- Gateway HTTP APIs are used for verification after publish, not for bulk upload.

## Current Commands

```bash
npm run production-pipeline -- import --file <path> --book-id <bookId> --title <title>
npm run production-pipeline -- package --book-id <bookId>
npm run production-pipeline -- embedding --book-id <bookId> --provider openai --base-url <url> --model <model> --concurrency 16
npm run production-pipeline -- audio --book-id <bookId> --source-root tmp/tts/<book>
npm run production-pipeline -- publish --run <runId|runDir|run.json> --remote-host <host> --remote-user <user>
npm run production-pipeline -- verify --run <runId|runDir|run.json> --gateway-url <url> --gateway-token <token>
npm run production-pipeline -- status --run <runId>
```

`import` writes canonical `books` and `chapters` rows into the main database.
`package` reads those rows and writes Gateway-ready artifacts under the run
directory. `embedding` reads `summaries` and `chapters` directly from SQLite,
calls the configured embedding provider, and writes `summary_embeddings` plus
`chapter_chunk_embeddings` without requiring the old `127.0.0.1:5174` API
service. `audio` maps existing `audio/chapter.mp3` outputs back to canonical main
database chapter ids and writes Gateway `audio.json`. `publish` uses `rsync` for
package/audio files and merges `books.json` so the Gateway book list can see the
published book. `verify` checks the live Gateway HTTP APIs against the run
artifacts, including library visibility, package chapter ids, and audio chapter
ids/counts when audio artifacts are present.

Planned commands still include stage-level `run` and `resume` once summary, KG,
embedding, and audio workers are wired into a single full-flow runner.

## Run Layout

```text
tmp/production-pipeline/runs/<runId>/
  run.json
  items.sqlite
  logs/
  artifacts/
  checkpoints/
```

`run.json` is the human-readable run summary. `items.sqlite` stores item-level
progress and retry state. This keeps production history removable and portable
without polluting the main app database.

## Stage Model

Each stage must be idempotent, resumable, observable, and independently runnable.

Planned stages:

- `import`
- `summary`
- `kg`
- `embedding`
- `audio`
- `package`
- `publish`
- `verify`
