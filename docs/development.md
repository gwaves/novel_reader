# Development Guide

## Prerequisites

- Node.js (the app uses native `node:sqlite`, so Node.js 22+ is recommended)
- npm

## Quick Start

```bash
npm install
npm run dev
```

This starts both the Vite frontend and the local SQLite API server.

- Frontend: http://127.0.0.1:5173/
- API server: http://127.0.0.1:5174/

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Vite + API server concurrently |
| `npm run api` | Start only the SQLite API server |
| `npm run vite:dev` | Start only the Vite dev server |
| `npm run build` | Type-check and build for production |
| `npm run reader` | Preview the production build (`vite preview`) |
| `npm run reader:build` | Build and preview |
| `npm run lint` | Run ESLint |
| `npm run preview` | Alias for `reader` |

## Environment Variables

### Dev Server (`scripts/dev.mjs`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVEL_READER_HOST` | `0.0.0.0` | Host that Vite binds to |
| `NOVEL_READER_PORT` | `5173` | Port that Vite listens on |

### API Server (`scripts/local-db-server.mjs`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVEL_READER_API_HOST` | `127.0.0.1` | API server host |
| `NOVEL_READER_API_PORT` | `5174` | API server port |
| `NOVEL_READER_DATA_DIR` | `~/.novel_reader` | Directory for app data |
| `NOVEL_READER_DB_PATH` | `<dataDir>/novel_reader.sqlite` | Full path to the SQLite database |

### Offline Scanner (`scripts/offline-scanner.mjs`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NOVEL_READER_OFFLINE_DB` | `~/.novel_reader/offline.sqlite` | Offline scanner database |
| `NOVEL_READER_MAIN_DB` | `~/.novel_reader/novel_reader.sqlite` | Main app database |
| `NOVEL_READER_OFFLINE_CONFIG` | `~/.novel_reader/offline-config.json` | Scanner config file |
| `OFFLINE_AI_PROVIDER` | — | Override provider: `ollama` or `openai` |
| `OFFLINE_OLLAMA_MODEL` | — | Override Ollama model |
| `OFFLINE_OLLAMA_CONCURRENCY` | — | Override Ollama concurrency (1-10) |
| `OFFLINE_OLLAMA_BASE_URL` | — | Override Ollama base URL |
| `OFFLINE_OPENAI_MODEL` | — | Override OpenAI model |
| `OFFLINE_OPENAI_CONCURRENCY` | — | Override OpenAI concurrency (1-10) |
| `OFFLINE_OPENAI_BASE_URL` | — | Override OpenAI base URL |
| `OFFLINE_OPENAI_API_KEY` | — | Override OpenAI API key |
| `OFFLINE_REQUEST_TIMEOUT_MS` | `300000` | Override per-request timeout |

## Project Structure

```text
novel_reader/
├── index.html              # Vite HTML entry
├── package.json            # npm scripts and dependencies
├── vite.config.ts          # Vite configuration
├── tsconfig*.json          # TypeScript configurations
├── eslint.config.js        # ESLint configuration
├── scripts/                # Node.js backend and CLI tools
│   ├── dev.mjs             # Starts Vite + API concurrently
│   ├── local-db-server.mjs # SQLite REST API server
│   ├── offline-scanner.mjs # Offline batch scanner CLI
│   └── offline-scanner/    # Scanner modules (config, db, llm, scanner)
├── gateway-android-app/    # Current maintained Gateway Android App
├── mobile-app/             # Legacy LAN-sync mobile app, deprecated and kept for reference
├── src/                    # React frontend
│   ├── main.tsx            # Entry point (desktop / mobile routing)
│   ├── App.tsx             # Main desktop UI
│   ├── MobileApp.tsx       # Mobile UI
│   ├── MobileApp.css       # Mobile UI styles
│   ├── hooks/              # React hooks
│   └── assets/             # Static assets
├── public/                 # Public static files
└── docs/                   # Documentation
```

## Import Formats

- `.txt`: the browser reads the file, decodes it with the selected encoding or automatic UTF-8 / GB18030 scoring, then splits chapters by heading patterns.
- `.epub`: the browser parses the ZIP structure, reads `META-INF/container.xml` to locate the OPF package, follows manifest/spine order, and converts XHTML content into plain-text chapters.
- EPUB v1 does not preserve images, CSS, footnote navigation, or complex layout. Imported EPUB chapters reuse the existing SQLite library, summaries, RAG, and knowledge graph workflows.

## Database

The app uses the native Node.js `node:sqlite` module (`DatabaseSync`).

- Default database path: `~/.novel_reader/novel_reader.sqlite`
- Journal mode: `WAL`
- Foreign keys: enabled

Main tables:

- `books`, `chapters` — imported novels and chapters
- `summaries` — chapter and page summaries
- `kg_scan_jobs`, `kg_chapter_extractions` — knowledge graph scan state
- `kg_entities`, `kg_entity_mentions` — extracted entities
- `kg_relations`, `kg_relation_mentions` — extracted relations
- `summary_embeddings`, `chapter_chunk_embeddings` — summary and chapter-content embeddings for RAG search
- `app_state` — app settings and model configuration

## Knowledge Graph

The knowledge graph is implemented as a property graph on top of SQLite.

- Scan flow: `chapter text -> LLM extraction -> raw JSON -> normalize -> upsert entities/relations`
- Scan jobs are resumable. Pending jobs are automatically resumed on app startup.
- Low-confidence entities and relations are flagged for review in the UI.
- Saved chapter extractions can be replayed into the graph for local rebuilds. Override rescans call the model again and replace the selected chapter evidence.
- Chapter rescan previews can diff the new extraction against the current graph before applying changes.
- Entity neighborhood and filtered global graph views are rendered with React Flow (`@xyflow/react`).
- Knowledge graph evidence can be searched and exported as JSON or GraphML.
- The global coreference pass groups likely duplicate character entities, asks the configured LLM to resolve identity clusters, and then merges aliases, mentions, and conflicting relations.
- Review queue maintenance supports batch approval, ignore, and delete actions.

See [knowledge-graph-roadmap.md](knowledge-graph-roadmap.md) for the full roadmap.
See [backend-api.md](backend-api.md) for the backend API reference.

## RAG Search

RAG search combines summary embeddings, chapter chunk embeddings, and knowledge graph entity matching.

- Embeddings are generated through `/api/rag/embeddings/batch` and stored in `summary_embeddings` plus `chapter_chunk_embeddings`.
- Embedding configuration is separate from the text-generation model configuration and is validated through `/api/rag/embeddings/validate` so browser CORS does not block Ollama/OpenAI-compatible checks.
- Search calls `/api/rag/search`, which fuses summary vector recall, best-per-chapter chunk recall, and entity recall with reciprocal-rank-style scoring.
- Search results include chapter summaries, matched entity names, similarity, match type, and optional best-matching chunk snippets.
- If fewer than 80% of chapters have embeddings for the selected model, the API returns `409 EMBEDDINGS_NOT_READY`.
- The current web desktop UI and `/mobile` route can still generate embeddings, search, and ask the configured generation model to answer from retrieved results.
- The independent Android mobile app must not generate book, chapter, or chunk embeddings. It consumes PC-generated embeddings synced into local mobile storage.

## Mobile Support Status

The maintained Android mobile client is now [`../gateway-android-app`](../gateway-android-app). It uses Gateway for the library, book packages, RAG/AI, and MP3 audio, then caches data locally for offline reading and playback. The older [`../mobile-app`](../mobile-app) LAN-sync client is deprecated and kept only as historical reference.

The PC/Gateway production path still owns:

- Keep owning book import, chapter splitting, summary generation, knowledge graph extraction, entity cleanup, summary embeddings, and chapter chunk embeddings.
- Expose `/api/mobile/*` and Gateway publishing scripts so Gateway can import complete book packages.
- Include books, chapters, summaries, graph entities, graph relations, evidence rows, `summary_embeddings`, and `chapter_chunk_embeddings` in exported mobile packages.
- Exclude LLM API keys, sensitive desktop model configuration fields, and unnecessary desktop UI state from mobile packages.
- Optionally accept reading progress from mobile later; Phase 1 should prioritize one-way PC -> mobile sync.

Recommended PC endpoints:

```text
GET /api/mobile/manifest
GET /api/mobile/books
GET /api/mobile/books/:bookId/package
GET /api/mobile/books/:bookId/changes?since=...
POST /api/mobile/progress
```

Phase 1 only needs the first three:

- `/api/mobile/manifest`: server version, mobile package schema version, capabilities, and current time.
- `/api/mobile/books`: library list with chapter count, word count, summary coverage, graph coverage, embedding coverage, and update timestamps.
- `/api/mobile/books/:bookId/package`: complete single-book mobile package for import into mobile SQLite.

Security requirements:

- `/api/mobile/*` should not be reachable from the LAN without a sync token.
- When `NOVEL_READER_API_HOST=0.0.0.0`, the UI or logs should make the LAN exposure explicit.
- Phase 1 can use a static user-configured sync token; QR pairing, token rotation, and HTTPS can come later.

Mobile package implementation notes:

- Phase 1 can use JSON to prove the end-to-end flow.
- Packages must include `schemaVersion`, `bookId`, `generatedAt`, and validation metadata.
- If large books make sync slow, upgrade later to compressed JSON, NDJSON streaming, or SQLite export packages.
- Packages should be idempotent, complete, and verifiable so failed mobile imports do not corrupt existing local data.

## Reader UX Polish Plan

The Reader UX polish phase prioritizes long continuous reading over adding more always-visible controls.

- Reading preferences should live in shared `StoredState` so desktop and mobile reuse the same theme, font size, line height, and paragraph spacing.
- Chapter scroll positions are saved by `bookId:chapterId` and restored when returning to a chapter; chapters without a saved position open at the top.
- Reader keyboard shortcuts must not intercept input while fields, buttons, or selects are focused.
- Mobile reading uses lightweight body tap zones for paging instead of adding more fixed buttons.
- In-reader AI should start from contextual actions such as selected text -> search/explain/related graph, rather than keeping the full AI panel in the main reading flow.

## Database Backup And Restore

The local API can export and stage a full SQLite restore.

- `GET /api/database/export` streams a temporary `VACUUM INTO` backup and removes the temporary file after reading.
- `POST /api/database/import` validates the uploaded SQLite file, backs up the current database, stores the upload as `novel_reader.restore-pending.sqlite`, and returns `requiresRestart: true`.
- On API startup, a pending restore replaces the active database after the current database is backed up.

## Offline Scanner

The offline scanner is a CLI for batch processing outside the browser.

Typical workflow:

```bash
# 1. Import a book from the main database
node scripts/offline-scanner.mjs import <bookId>

# 2. Scan summaries and/or knowledge graph
node scripts/offline-scanner.mjs scan all <bookId>

# 3. If interrupted, resume
node scripts/offline-scanner.mjs resume all <bookId>

# 4. Export results back to the main database
node scripts/offline-scanner.mjs export <bookId>

# 5. Or create a per-book JSON package for web import
node scripts/offline-scanner.mjs bundle <bookId>
```

Commands:

| Command | Arguments | Description |
|---------|-----------|-------------|
| `list` | — | List books in the main database |
| `import` | `<bookId>` | Import a book into the offline database |
| `scan` | `<summary\|kg\|all> <bookId>` | Create a scan job and run it |
| `resume` | `<summary\|kg\|all> <bookId>` | Resume an interrupted scan job |
| `status` | `[bookId]` | Show progress |
| `export` | `<bookId>` | Export results to the main database |
| `bundle` | `<bookId> [path]` | Create a per-book offline scan data package for web import |
| `sync` | — | Sync model config from the main project |
| `config` | — | Show current model config |
| `stop` | — | Send a graceful stop signal |
| `help` | — | Show help |

### Troubleshooting the Offline Scanner

If you see `fetch failed` for some chapters:

- The scanner already retries transient network errors up to 3 times with exponential backoff.
- Increase the per-request timeout:
  ```bash
  OFFLINE_REQUEST_TIMEOUT_MS=600000 node scripts/offline-scanner.mjs resume kg <bookId>
  ```
- Lower concurrency if your local Ollama instance is overloaded:
  ```bash
  OFFLINE_OLLAMA_CONCURRENCY=3 node scripts/offline-scanner.mjs resume kg <bookId>
  ```

## Lint and Build

```bash
npm run lint
npm run build
```

There are a few pre-existing ESLint warnings/errors around React hook dependency and set-state-in-effect rules. TypeScript compilation and the Vite build should both pass.

## Notes

- This is a personal local app. API keys are stored in SQLite. Do not expose the API server or the database to untrusted networks.
- The offline scanner and the web app share the same model configuration via the main database's `app_state` table.
