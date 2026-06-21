# Novel Reader Assistant

[English](README.en.md) | [中文](README.md)

A local-first web reader for long Chinese web novels, with AI-powered summaries, RAG search, and a knowledge graph for tracking characters, factions, items, skills, locations, and more.

## Features

- Import `.txt` novels with automatic UTF-8 / GB18030 decoding, or `.epub` books by reading the OPF spine and XHTML chapters.
- Split imported books into chapters and paginate the chapter list by 100 chapters.
- Persist imported chapters, reading progress, summaries, knowledge graph data, embeddings, and settings in a local SQLite database under `~/.novel_reader`.
- Android companion app under `mobile-app`: sync complete PC-generated book packages over the LAN, then read chapters, summaries, and graph data offline. The mobile app consumes PC-generated embeddings and does not generate corpus embeddings itself.
- Generate single-chapter, current-page, or all-missing chapter summaries.
- Configure local Ollama models and OpenAI-compatible external models, with separate validation for generation and embedding models.
- Support multiple external model profiles, each with its own model name, base URL, API key, temperature, thinking mode, and an independent embedding configuration.
- Adjust reader font size.
- Navigate chapters from both the top and bottom of the desktop reader.
- Export or restore the full SQLite database from the web UI.
- **RAG Search**:
  - Generate summary embeddings with Ollama or OpenAI-compatible embedding models.
  - Search across chapters with vector recall and knowledge-graph entity boosting.
  - Generate an answer from retrieved chapter summaries/snippets.
- **Knowledge Graph**:
  - Extract entities (characters, sects, items, skills, locations, beasts, events) and relations from each chapter.
  - Batch scan the whole book with resumable jobs, override rescans, saved-JSON replay, and graph change previews.
  - Review low-confidence entities and relations in a review queue, including batch deletes.
  - Merge, edit, split, and delete entities and relations.
  - Run an LLM-assisted global coreference pass to merge duplicate character identities.
  - Browse entity/relation lists with filters and search.
  - Search evidence, visualize entity neighborhoods/global graph slices, and export JSON or GraphML.
- **Offline Scanner CLI** (`scripts/offline-scanner.mjs`):
  - Batch scan summaries and/or knowledge graph extractions outside the browser.
  - Resume interrupted scans and export results back to the main database.
  - Supports the same Ollama/OpenAI configuration as the web app.

## Documentation

- [Development Guide](docs/development.md)
- [开发文档（中文）](docs/development.zh-CN.md)
- [Backend API Reference](docs/backend-api.md)
- [Mobile API Contract](mobile-app/docs/api.md)
- [Android App Guide](mobile-app/docs/android.md)
- [Knowledge Graph Roadmap](docs/knowledge-graph-roadmap.md)
- [Current Progress](docs/current_progress.md) (Chinese)

## Quick Start

```bash
npm install
npm run dev
```

This starts both the Vite frontend and the local database API. The SQLite database is stored at:

```text
~/.novel_reader/novel_reader.sqlite
```

Open:

```text
http://127.0.0.1:5173/
```

## Android Mobile App

Start the PC API on a LAN-reachable address:

```bash
NOVEL_READER_API_HOST=0.0.0.0 npm run api
```

In the Android app, use the PC LAN URL, for example:

```text
http://192.168.x.x:5174
```

Build a debug APK from the mobile workspace:

```bash
cd mobile-app
npm install
npm run android:sync
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew assembleDebug
```

APK output:

```text
mobile-app/android/app/build/outputs/apk/debug/app-debug.apk
```

See [mobile-app/docs/android.md](mobile-app/docs/android.md) for Android build, LAN HTTP sync, and status-bar safe-area notes.

## Development

You can change the dev server port:

```bash
NOVEL_READER_PORT=5174 npm run dev
```

You can change the database location or API port:

```bash
NOVEL_READER_DATA_DIR=/path/to/data NOVEL_READER_API_PORT=6174 npm run dev
```

For LAN mobile sync, `NOVEL_READER_MOBILE_SYNC_TOKEN` can be set to require `Authorization: Bearer <token>` on `/api/mobile/*`.

## Reader Instance

To run a separate local reading instance without occupying the development port:

```bash
NOVEL_READER_PORT=6173 npm run reader:build
```

Open:

```text
http://127.0.0.1:6173/
```

You can also customize the host:

```bash
NOVEL_READER_HOST=0.0.0.0 NOVEL_READER_PORT=6173 npm run reader:build
```

## Build

```bash
npm run build
```

## Notes

This is currently a personal local web app. API keys are stored in the local SQLite database, so do not use this deployment model for a public multi-user service without adding a backend proxy, authentication, and secret management.
If you bind the API server to `0.0.0.0` for mobile sync, use it only on trusted LANs or set `NOVEL_READER_MOBILE_SYNC_TOKEN`.
