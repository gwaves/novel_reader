# Novel Reader Mobile App Development Plan

## Goal

Build an Android-first mobile companion app that can be used away from the home LAN.

The PC app remains the data production workstation. The mobile app is a full local consumer: it stores synced books, chapters, summaries, knowledge graph data, and PC-generated embedding assets locally. The mobile app must not generate book or chapter embeddings itself.

## Core Product Boundary

### PC App

- Import and parse books.
- Generate chapter summaries.
- Generate and maintain knowledge graph data.
- Generate summary and chapter chunk embeddings.
- Export/sync complete mobile data packages.
- Optionally receive reading progress or lightweight annotations from mobile.

### Mobile App

- Configure a PC sync endpoint while on the same LAN.
- Pull complete book data from the PC endpoint.
- Store all synced data locally.
- Read books fully offline.
- Search locally over synced text, summaries, and graph data.
- Use a configured public LLM service for answer generation when network is available.
- Never generate corpus embeddings for books, chapters, or chunks.

### Public LLM Service

- Used only by the mobile app for answer generation after local retrieval.
- May be OpenAI-compatible.
- Should not be required for ordinary reading, chapter navigation, summary viewing, or graph browsing.

## Important RAG Decision

The mobile app will receive PC-generated embeddings as synced data. However, vector retrieval normally also requires an embedding for the user's query.

To preserve the rule that mobile does not generate embeddings, Phase 1 mobile RAG should use local non-vector retrieval:

- SQLite FTS over chapter text, summaries, and chunk text.
- Knowledge graph entity and relation matching.
- Optional chapter/summary ranking heuristics.
- Public LLM answer generation over locally retrieved context.

If semantic vector query is required while away from the PC, the project must make one explicit product decision later:

- Allow public embedding API for query-only embedding.
- Or require vector search only when the mobile app can reach the PC.
- Or keep mobile RAG as FTS/graph retrieval plus public LLM generation.

The initial mobile app should not silently depend on query embedding generation.

## Proposed Workspace Shape

This directory is intended to become an independent mobile workspace.

```text
mobile-app/
  development-plan.md
  package.json
  src/
  android/
  docs/
```

Recommended implementation path:

- Capacitor + React for fastest reuse of the existing mobile UI.
- SQLite plugin for local persistent storage.
- A small mobile-only API client and sync/import layer.

React Native remains a later option if native UI becomes more important than reuse speed.

## Local Mobile Data Model

Use SQLite on Android. The schema should closely mirror the PC SQLite data model so sync remains simple.

Initial mobile tables:

- `books`
- `chapters`
- `summaries`
- `kg_entities`
- `kg_entity_mentions`
- `kg_relations`
- `kg_relation_mentions`
- `summary_embeddings`
- `chapter_chunk_embeddings`
- `reading_progress`
- `mobile_settings`
- `sync_metadata`

The embedding tables are read-only from the mobile app's point of view. They are replaced or updated only through PC sync.

## PC Sync API

Add mobile-specific read APIs instead of exposing every desktop editing endpoint.

Recommended endpoints:

```text
GET /api/mobile/manifest
GET /api/mobile/books
GET /api/mobile/books/:bookId/package
GET /api/mobile/books/:bookId/changes?since=...
POST /api/mobile/progress
```

### `/api/mobile/manifest`

Returns server metadata and sync capabilities.

Example payload:

```json
{
  "serverVersion": "0.1",
  "schemaVersion": 1,
  "capabilities": ["full-book-package", "reading-progress"],
  "generatedAt": "2026-06-21T00:00:00.000Z"
}
```

### `/api/mobile/books`

Returns a lightweight library listing.

Include:

- Book id and title.
- Chapter count.
- Word count.
- Summary coverage.
- Knowledge graph coverage.
- Embedding coverage.
- Last updated timestamp.

### `/api/mobile/books/:bookId/package`

Returns a complete mobile data package for one book.

The package should include:

- Book metadata.
- All chapters.
- All summaries.
- Knowledge graph entities, mentions, relations, and relation mentions.
- Summary embeddings.
- Chapter chunk embeddings.
- Package metadata with schema version and content hash.

For large books, support compressed download later. Phase 1 can start with JSON if book sizes are acceptable; Phase 2 should consider NDJSON or SQLite export packages.

### `/api/mobile/books/:bookId/changes?since=...`

Later incremental sync endpoint. Not required for the first working version.

### `/api/mobile/progress`

Optional lightweight write-back endpoint for reading progress when the phone returns to the LAN.

## Mobile Sync Flow

1. User enters PC sync URL and token.
2. Mobile calls `/api/mobile/manifest`.
3. Mobile shows available books from `/api/mobile/books`.
4. User selects books to download.
5. Mobile downloads full book package.
6. Mobile validates `schemaVersion`, `bookId`, and package hash if present.
7. Mobile imports into SQLite inside a transaction.
8. Mobile marks the book as available offline in `sync_metadata`.

Failure behavior:

- A failed import must not corrupt the previous local copy.
- Use a temporary import area or transaction rollback.
- Surface clear errors for incompatible schema, network failure, and invalid package.

## Mobile Reading Features

Phase 1 reading features:

- Local bookshelf.
- Chapter list.
- Chapter reading.
- Reading progress persistence.
- Summary viewing.
- Local keyword search.
- Settings for font size, line height, paragraph spacing, and theme.

Phase 2 reading features:

- Offline graph entity browsing.
- Entity evidence search.
- Relation browsing.
- Book-level sync status and data freshness.

## Mobile RAG Features

Phase 1:

- Local FTS search over chapter text, summaries, and chunk text.
- Local graph lookup for entity names and aliases.
- Build answer context locally.
- Send only selected context and the user's question to the configured public LLM.
- Save no public LLM keys in synced PC packages.

Phase 2:

- Add better local ranking.
- Add citations back to chapter ids and graph evidence.
- Add answer history stored locally.

Deferred:

- Query embedding through public embedding APIs.
- PC-assisted vector search while on LAN.
- Fully local mobile embedding models.

## Security

PC sync endpoints must not be open to the LAN without protection.

Minimum requirements:

- User-configured sync token.
- Token required on all `/api/mobile/*` endpoints.
- Clear UI warning when serving on `0.0.0.0`.
- No LLM API keys included in exported mobile data packages.

Later:

- Pairing QR code.
- Token rotation.
- Optional HTTPS for non-home network sync.

## Implementation Phases

### Phase 0: Workspace Setup

- Create independent `mobile-app` workspace.
- Add Capacitor + React app shell.
- Add Android target.
- Add local settings screen for PC sync URL and token.

### Phase 1: Full Book Sync and Offline Reading

- Add PC `/api/mobile/manifest`.
- Add PC `/api/mobile/books`.
- Add PC `/api/mobile/books/:bookId/package`.
- Add mobile SQLite schema.
- Import full book packages into local SQLite.
- Render bookshelf, chapter list, reader, and summaries from local SQLite.

### Phase 2: Offline Search and Graph Consumption

- Add local SQLite FTS indexes.
- Add local search UI.
- Import and browse knowledge graph entities and relations.
- Add graph/evidence search from local data.

### Phase 3: Mobile RAG Without Mobile Embedding Generation

- Retrieve context locally through FTS and graph matching.
- Configure public LLM endpoint.
- Generate answers from local context.
- Add citations to chapters and evidence.

### Phase 4: Sync Polish

- Add sync freshness indicators.
- Add resumable or compressed downloads.
- Add incremental sync.
- Add optional reading progress write-back to PC.

## First Technical Slice

The first practical slice should prove the data path end to end:

1. Add `/api/mobile/manifest`.
2. Add `/api/mobile/books`.
3. Add `/api/mobile/books/:bookId/package` for one selected book.
4. Create mobile SQLite schema.
5. Import one book package.
6. Read a chapter from mobile SQLite with airplane mode enabled.

Success means the Android app can keep reading after leaving the PC network.

## Explicit Non-Goals For The First Version

- Mobile book import.
- Mobile summary generation.
- Mobile knowledge graph scanning.
- Mobile corpus embedding generation.
- Mobile entity editing and merge workflows.
- Full desktop feature parity.

