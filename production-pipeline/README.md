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

## Planned Commands

```bash
npm run production-pipeline -- create --book-id <bookId>
npm run production-pipeline -- run --job production-pipeline/jobs/<job>.json
npm run production-pipeline -- resume --run <runId>
npm run production-pipeline -- status --run <runId>
npm run production-pipeline -- verify --run <runId>
```

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

