# Novel Reader Assistant

[English](README.md) | [中文](README.zh-CN.md)

A local-first web reader for long Chinese web novels, with AI-powered summaries and a knowledge graph for tracking characters, factions, items, skills, locations, and more.

## Features

- Import `.txt` novels with automatic UTF-8 / GB18030 decoding.
- Split long novels into chapters and paginate the chapter list by 100 chapters.
- Persist imported chapters, reading progress, summaries, and settings in a local SQLite database under `~/.novel_reader`.
- Generate single-chapter or current-page summaries.
- Configure local Ollama models and OpenAI-compatible external models.
- Support multiple external model profiles, each with its own model name, base URL, API key, temperature, and thinking mode.
- Adjust reader font size.
- **Knowledge Graph**:
  - Extract entities (characters, sects, items, skills, locations, beasts, events) and relations from each chapter.
  - Batch scan the whole book with resumable jobs.
  - Review low-confidence entities and relations in a review queue.
  - Merge, edit, and delete entities and relations.
  - Browse entity/relation lists with filters and search.
- **Offline Scanner CLI** (`scripts/offline-scanner.mjs`):
  - Batch scan summaries and/or knowledge graph extractions outside the browser.
  - Resume interrupted scans and export results back to the main database.
  - Supports the same Ollama/OpenAI configuration as the web app.

## Documentation

- [Development Guide](docs/development.md)
- [开发文档（中文）](docs/development.zh-CN.md)
- [Knowledge Graph Roadmap](docs/knowledge-graph-roadmap.md)
- [Current Progress](docs/current_progress.md) (Chinese)

## Development

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

You can change the dev server port:

```bash
NOVEL_READER_PORT=5174 npm run dev
```

You can change the database location or API port:

```bash
NOVEL_READER_DATA_DIR=/path/to/data NOVEL_READER_API_PORT=6174 npm run dev
```

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
