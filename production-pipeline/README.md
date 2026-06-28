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
npm run production-pipeline -- run --job production-pipeline/config/example.job.json
npm run production-pipeline -- resume --run <runId|runDir|run.json>
npm run production-pipeline -- import --file <path> --book-id <bookId> --title <title>
npm run production-pipeline -- package --book-id <bookId>
npm run production-pipeline -- embedding --book-id <bookId> --provider openai --base-url <url> --model <model> --concurrency 16
npm run production-pipeline -- audio --book-id <bookId> --source-root tmp/tts/<book>
npm run production-pipeline -- publish --run <runId|runDir|run.json> --remote-host <host> --remote-user <user>
npm run production-pipeline -- verify --run <runId|runDir|run.json> --gateway-url <url> --gateway-token <token>
npm run production-pipeline -- status --run <runId>
```

`run` reads a job JSON and executes the configured stages in order. `resume`
loads an existing `run.json` and skips stages whose status is already
`completed`. `import` writes canonical `books` and `chapters` rows into the main database.
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

The current full-flow runner can orchestrate `import`, `package`, `embedding`,
`audio`, `publish`, and `verify`. `summary` and `kg` remain planned stage names
until their workers are moved into v2.

## Job Config

The job JSON is the repeatable production contract. It should include:

- `bookId`: canonical id shared by the main DB, Gateway package, and audio catalog.
- `mainDbPath`: Novel Reader SQLite database path.
- `stages`: ordered stage list, for example `["embedding", "audio", "package", "publish", "verify"]`.
- `embedding`: provider, base URL, model, concurrency, retries, and timeout.
- `audio`: source directory for existing MP3 artifacts and optional strictness.
- `gateway` / `publish` / `verify`: rsync target and Gateway HTTP verification settings.

Embedding does not call `127.0.0.1:5174`; it opens SQLite directly. Publish uses
`rsync` for data/audio files. Verify uses the live Gateway HTTP APIs after
publish.

Example for a 大唐双龙传-style main-DB book:

```bash
cat > tmp/production-pipeline-datang.job.json <<'JSON'
{
  "bookId": "mqxe7ya6-yiulrd3l",
  "title": "大唐双龙传",
  "mainDbPath": "~/.novel_reader/novel_reader.sqlite",
  "source": { "type": "main-db" },
  "stages": ["embedding", "audio", "package", "publish", "verify"],
  "embedding": {
    "provider": "openai-compatible",
    "baseUrl": "https://embedding-provider.example/v1",
    "model": "qwen3-embedding-8b",
    "concurrency": 16,
    "retries": 5
  },
  "audio": {
    "sourceRoot": "tmp/tts/datang",
    "chapters": "all"
  },
  "gateway": {
    "host": "gateway.example.lan",
    "user": "gwaves",
    "root": "/home/gwaves/novel-reader-gateway",
    "url": "https://gateway.example.lan:8888",
    "token": "GATEWAY_TOKEN_PLACEHOLDER"
  }
}
JSON

npm run production-pipeline -- run --job tmp/production-pipeline-datang.job.json
```

## Run Layout

```text
tmp/production-pipeline/runs/<bookId>/<runId>/
  run.json
  items.sqlite
  logs/
  artifacts/
  checkpoints/
  stage-runs/
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
