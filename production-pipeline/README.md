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
npm run production-pipeline -- doctor --job production-pipeline/config/example.job.json
npm run production-pipeline -- resume --run <runId|runDir|run.json>
npm run production-pipeline -- import --file <path> --book-id <bookId> --title <title>
npm run production-pipeline -- summary --book-id <bookId> --provider openai-compatible --base-url <url> --model <model>
npm run production-pipeline -- kg --book-id <bookId> --provider openai-compatible --base-url <url> --model <model>
npm run production-pipeline -- package --book-id <bookId>
npm run production-pipeline -- embedding --book-id <bookId> --provider ollama --base-url http://192.168.88.100:11434 --model qwen3-embedding:8b --concurrency 16 --mode all
npm run production-pipeline -- audio --book-id <bookId> --source-root tmp/tts/<book>
npm run production-pipeline -- audio --book-id <bookId> --tts-config ~/.novel_reader/tts-director.config.json --chapters 1-10
npm run production-pipeline -- publish --run <runId|runDir|run.json> --remote-host <host> --remote-user <user>
npm run production-pipeline -- verify --run <runId|runDir|run.json> --gateway-url <url> --gateway-token <token>
npm run production-pipeline -- status --run <runId|runDir|run.json>
```

`doctor` preflights a job JSON without creating a run or touching SQLite, so
missing source files, TTS config, provider settings, and Gateway credentials
surface before a long production run. `run` reads a job JSON and executes the
configured stages in order. `resume` loads an existing `run.json` and skips stages whose status is already
`completed`. `import` writes canonical `books` and `chapters` rows into the main database.
`summary` reads chapters directly from SQLite, calls the configured chat model,
and writes the `summaries` table without requiring the old `127.0.0.1:5174` API
service. `kg` reads chapters directly from SQLite, calls the configured chat
model, and writes the `kg_*` tables. `embedding` reads SQLite directly, calls
the configured embedding provider, and writes `summary_embeddings` plus
`chapter_chunk_embeddings` without requiring the old `127.0.0.1:5174` API
service. Use `--mode chunks` to embed chapter text immediately after import,
`--mode summaries` to embed generated summaries, or `--mode all` for both.
`audio` can either map an existing
`audio/chapter.mp3` tree or invoke `offline-tts/scripts/tts-director.mjs
batch-pipeline` first via `--tts-config`, then package the generated MP3 files.
`package` reads durable rows and writes Gateway-ready artifacts under the run
directory. `publish` uses `rsync` for package/audio files and merges
`books.json` so the Gateway book list can see the published book. `verify`
checks the live Gateway HTTP APIs against the run artifacts, including library
visibility, package chapter ids, KG counts, embedding coverage metadata, and
audio chapter ids/counts when audio artifacts are present.

The current full-flow runner can orchestrate `import`, `summary`, `kg`,
`embedding`, `audio`, `package`, `publish`, and `verify`. In a job config,
`embedding` is automatically split into `chunkEmbedding` and `summaryEmbedding`;
after `import`, `summary`, `kg`, `chunkEmbedding`, and `audio` may run in
parallel, then `summaryEmbedding` runs before final packaging.

## Job Config

The job JSON is the repeatable production contract. It should include:

- `bookId`: canonical id shared by the main DB, Gateway package, and audio catalog.
- `mainDbPath`: Novel Reader SQLite database path.
- `stages`: ordered stage list, for example `["summary", "kg", "embedding", "audio", "package", "publish", "verify"]`.
- `llm`: shared chat provider settings for `summary` and `kg`, including model-specific `concurrency`, retries, timeout, and optional weighted scheduling.
- `llm.scheduler`: when present, the full-flow runner treats `llm.concurrency`
  as a shared pool for active LLM stages. `weights.summary`, `weights.kg`, and
  `weights.audio` divide the pool among runnable stages; if the pool is smaller
  than the number of runnable LLM stages, lower-priority stages wait for the next
  batch. `borrowIdle` defaults to `true`, so active stages can borrow the share
  of absent stages; set it to `false` to keep weighted shares reserved. Without
  `llm.scheduler`, existing stage-level concurrency behavior is unchanged.
  Audio scheduling maps its share to offline TTS `directorConcurrency` and keeps
  `llmChapters` at 1, so chapter-level pipelining does not multiply LLM requests.
- `summary` / `kg`: optional stage limits or overrides; stage-level `concurrency` overrides `llm.concurrency` when the weighted scheduler is not enabled.
- `embedding`: provider, base URL, model, concurrency, retries, and timeout.
- `audio`: either `sourceRoot` for existing MP3 artifacts or `ttsConfig` for generating MP3 first; optional `chapters`, `ttsConcurrency`, `ttsChapters`, and strictness.
- `gateway` / `publish` / `verify`: rsync target and Gateway HTTP verification settings.

Embedding does not call `127.0.0.1:5174`; it opens SQLite directly. Publish uses
`rsync` for data/audio files. Verify uses the live Gateway HTTP APIs after
publish.

Recommended Ollama embedding config:

```json
{
  "embedding": {
    "provider": "ollama",
    "baseUrl": "http://192.168.88.100:11434",
    "model": "qwen3-embedding:8b",
    "concurrency": 16,
    "retries": 5,
    "timeoutMs": 300000
  }
}
```

OpenAI-compatible embedding endpoints are still supported by setting
`provider` to `openai-compatible`; v2 will call `/embeddings` for those and
`/api/embeddings` for Ollama.

Example for a 大唐双龙传-style TXT import:

```bash
cat > tmp/production-pipeline-datang.job.json <<'JSON'
{
  "bookId": "mqxe7ya6-yiulrd3l",
  "title": "大唐双龙传",
  "mainDbPath": "~/.novel_reader/novel_reader.sqlite",
  "source": { "type": "txt", "file": "/Users/gwaves/Downloads/shuanglongzhuan.txt" },
  "stages": ["import", "summary", "kg", "embedding", "audio", "package", "publish", "verify"],
  "import": { "replace": false },
  "llm": {
    "provider": "openai-compatible",
    "baseUrl": "http://llm-provider.example/v1",
    "apiKey": "LLM_API_KEY_PLACEHOLDER",
    "model": "qwen3.6-27b",
    "concurrency": 4,
    "scheduler": {
      "borrowIdle": true,
      "weights": {
        "summary": 4,
        "kg": 2,
        "audio": 1
      }
    },
    "timeoutMs": 300000
  },
  "summary": { "limit": 0 },
  "kg": { "limit": 0 },
  "embedding": {
    "provider": "ollama",
    "baseUrl": "http://192.168.88.100:11434",
    "model": "qwen3-embedding:8b",
    "concurrency": 16,
    "retries": 5
  },
  "audio": {
    "ttsConfig": "~/.novel_reader/tts-director.config.json",
    "ttsConcurrency": 16,
    "ttsChapters": 2,
    "resume": true
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

For a smoke test, set `summary.limit`, `kg.limit`, and `embedding.limit` to a
small number and use a temporary `mainDbPath`. For a full audio run, omit
`audio.chapters`; v2 will pass `1-<chapterCount>` to the TTS director.

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

`run.json` is the durable run summary. `status` prints a readable view with
stage status, child run paths, artifacts, and log tails; use `--json` to print
the raw `run.json`. `items.sqlite` stores item-level progress and retry state.
This keeps production history removable and portable without polluting the main
app database.

## Local Console

The legacy Content Pipeline console at `http://127.0.0.1:6290` can also launch
and monitor v2 jobs. Start it with:

```bash
npm run content:pipeline:service
```

Then choose `Production v2` in the mode selector and fill `V2 Job JSON` with a
job file path. The console reads the v2 `run.json` from
`tmp/production-pipeline/runs/<bookId>/<runId>/run.json` and shows the stage
status, child run paths, and child log files while the job is still running.

## Stage Model

Each stage must be idempotent, resumable, observable, and independently runnable.

Stages:

- `import`
- `summary`
- `kg`
- `embedding`
- `audio`
- `package`
- `publish`
- `verify`
