# Backend API Reference

This document describes the local SQLite HTTP API served by `scripts/local-db-server.mjs`.
It is a development reference for the local app backend, not a public network API contract.

## Server

Default base URL:

```text
http://127.0.0.1:5174
```

Runtime configuration:

| Environment variable | Default | Description |
|---|---:|---|
| `NOVEL_READER_API_HOST` | `127.0.0.1` | API listen host |
| `NOVEL_READER_API_PORT` | `5174` | API listen port |
| `NOVEL_READER_DATA_DIR` | `~/.novel_reader` | App data directory |
| `NOVEL_READER_DB_PATH` | `<dataDir>/novel_reader.sqlite` | SQLite database path |

All responses are JSON. Errors generally use:

```json
{ "error": "Human-readable message." }
```

CORS is open for local development. The server supports `OPTIONS` preflight.

## Common Data Shapes

### Knowledge Graph Entity

```ts
type KgEntity = {
  id: string
  bookId: string
  type: 'character' | 'sect' | 'item' | 'skill' | 'location' | 'beast' | 'event' | 'other'
  name: string
  aliases: string[]
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  mentionCount?: number
}
```

### Knowledge Graph Relation

```ts
type KgRelation = {
  id: string
  type:
    | 'knows'
    | 'ally_of'
    | 'enemy_of'
    | 'master_of'
    | 'disciple_of'
    | 'member_of'
    | 'belongs_to'
    | 'owns'
    | 'uses'
    | 'learns'
    | 'created_by'
    | 'located_in'
    | 'appears_with'
    | 'transforms_into'
    | 'related_to'
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  sourceId: string
  sourceName: string
  sourceType: string
  targetId: string
  targetName: string
  targetType: string
  mentionCount?: number
}
```

### Chapter Extraction

```ts
type ChapterExtraction = {
  entities: Array<{
    name: string
    type: KgEntity['type']
    aliases?: string[]
    description?: string
    confidence?: number
    evidence?: string[] | string
  }>
  relations: Array<{
    source: string
    target: string
    type: KgRelation['type']
    description?: string
    confidence?: number
    evidence?: string[] | string
  }>
}
```

Saving an extraction rewrites that chapter's graph mentions, upserts entities and relations, recomputes touched chapter ranges, and removes empty graph rows left by local rebuilds.

### RAG Search Result

```ts
type RagSearchResult = {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  summary: {
    short: string
    detail: string
    keyPoints: string[]
  }
  similarity: number
  matchType: 'vector' | 'entity' | 'both'
  matchedEntities: string[]
  contentSnippet: string | null
}
```

## Core State APIs

### `GET /api/state`

Loads the persisted app state.

Response:

```json
{ "state": {} }
```

Notes:

- If `state.books` exists, summaries are refreshed from the normalized `summaries` table before returning.
- Missing state returns `{ "state": null }`.

### `PUT /api/state`

Persists app state and mirrors books, chapters, and summaries into normalized tables.

Request:

```json
{ "state": {} }
```

Response:

```json
{ "ok": true }
```

### `GET /api/storage`

Returns storage paths.

Response:

```json
{
  "dataDir": "/Users/example/.novel_reader",
  "dbPath": "/Users/example/.novel_reader/novel_reader.sqlite"
}
```

### `PUT /api/books/:bookId`

Updates a book title and mirrors the title into persisted app state so refreshes do not revert to the old name.

Request:

```json
{ "title": "New title" }
```

Response:

```json
{ "ok": true }
```

## Database Backup APIs

### `GET /api/database/export`

Exports the complete SQLite database as a downloadable `.sqlite` file.

Response:

- Content-Type: `application/vnd.sqlite3`
- Content-Disposition filename: `novel_reader-backup-<timestamp>.sqlite`

Implementation notes:

- The server creates a temporary backup using `VACUUM INTO`.
- The temporary file is removed after being read into the response.

### `POST /api/database/import`

Uploads a full SQLite backup file and stages it for restore on the next API server start.

Request:

- Raw binary SQLite file body.
- Content-Type can be `application/octet-stream`.

Response:

```json
{
  "ok": true,
  "backupPath": "/Users/example/.novel_reader/novel_reader-before-import-1780000000000.sqlite",
  "pendingRestorePath": "/Users/example/.novel_reader/novel_reader.restore-pending.sqlite",
  "requiresRestart": true
}
```

Behavior:

- Rejects empty uploads.
- Validates the uploaded SQLite file before staging it.
- Creates a backup of the current database before staging the restore.
- The active database is replaced only after restarting the local API server.

## Knowledge Graph Overview

### `GET /api/kg/overview`

Query parameters:

| Name | Required | Description |
|---|---:|---|
| `bookId` | yes | Book ID |

Response:

```json
{
  "overview": {
    "scanned_chapters": 10,
    "entity_count": 120,
    "relation_count": 80
  }
}
```

### `GET /api/kg/chapters`

Lists saved chapter extraction rows for a book.

Query parameters:

| Name | Required | Description |
|---|---:|---|
| `bookId` | yes | Book ID |

Response:

```ts
{
  chapters: Array<{
    chapterId: string
    bookId: string
    chapterIndex: number
    title: string
    status: string
    model: string | null
    scannedAt: string | null
    updatedAt: string
    entityCount: number
    relationCount: number
  }>
}
```

## Entity APIs

### `GET /api/kg/entities`

Lists entities for a book.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `type` | no | `''` | Entity type filter |
| `q` | no | `''` | Normalized name or alias search |
| `limit` | no | `100` | Clamped to `1..200` |

Response:

```json
{ "entities": [] }
```

### `GET /api/kg/entities/:entityId`

Returns entity detail, mentions, and directly related relations.

Response:

```ts
{
  entity: KgEntity
  mentions: Array<{
    id: string
    chapterId: string
    chapterIndex: number
    chapterTitle: string
    evidence: string | null
    confidence: number
  }>
  relations: KgRelation[]
}
```

### `PUT /api/kg/entities/:entityId`

Updates entity name, type, aliases, and description.

Request:

```json
{
  "name": "韩立",
  "type": "character",
  "aliases": ["韩兄"],
  "description": "主角"
}
```

Response:

```json
{ "entity": {} }
```

Validation:

- `name` is required.
- Duplicate `(book_id, type, normalized_name)` is rejected.
- Review status is reset after editing.

### `DELETE /api/kg/entities/:entityId`

Deletes an entity. Entity mentions and connected relations are removed by SQLite cascades.

Response:

```json
{ "ok": true }
```

### `POST /api/kg/entities/merge`

Merges one source entity into one target entity.

Request:

```json
{
  "sourceId": "source-entity-id",
  "targetId": "target-entity-id"
}
```

Response:

```json
{
  "entity": {},
  "sourceName": "旧实体名"
}
```

### `POST /api/kg/entities/merge-batch`

Merges multiple source entities into one target entity.

Request:

```json
{
  "sourceIds": ["source-a", "source-b"],
  "targetId": "target-entity-id"
}
```

Response:

```json
{
  "entity": {},
  "mergedCount": 2,
  "sourceNames": ["旧实体 A", "旧实体 B"]
}
```

### `POST /api/kg/entities/:entityId/split`

Splits selected aliases, mentions, and/or relations from a source entity into a new or existing target entity.

Request to create a new target:

```json
{
  "name": "新实体",
  "type": "character",
  "aliases": ["别名"],
  "description": "描述",
  "movedAliases": ["源实体别名"],
  "mentionIds": ["mention-id"],
  "relationIds": ["relation-id"]
}
```

Request to split into an existing target:

```json
{
  "targetEntityId": "existing-entity-id",
  "movedAliases": ["源实体别名"],
  "mentionIds": ["mention-id"],
  "relationIds": ["relation-id"]
}
```

Response:

```json
{
  "source": {},
  "target": {}
}
```

Validation:

- At least one `mentionId` or `relationId` is required.
- Existing target must belong to the same book and cannot be the source.
- New target name is required and cannot duplicate same-book same-type normalized name.

### `GET /api/kg/entities/:entityId/neighborhood`

Returns a one-hop graph around an entity. Used by the entity relation graph view.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `entityType` | no | `''` | Neighbor entity type filter. Center entity is always retained. |
| `relationType` | no | `''` | Relation type filter |
| `limit` | no | `100` | Relation limit, clamped to `1..200` |

Response:

```ts
{
  centerId: string
  entities: KgEntity[]
  relations: KgRelation[]
}
```

## Relation APIs

### `GET /api/kg/relations`

Lists relations for a book.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `type` | no | `''` | Relation type filter |
| `limit` | no | `150` | Clamped to `1..300` |

Response:

```json
{ "relations": [] }
```

### `GET /api/kg/relations/:relationId`

Returns relation detail and evidence mentions.

Response:

```ts
{
  relation: KgRelation
  mentions: Array<{
    id: string
    chapterId: string
    chapterIndex: number
    chapterTitle: string
    evidence: string | null
    confidence: number
  }>
}
```

### `PUT /api/kg/relations/:relationId`

Updates relation type, description, source endpoint, and target endpoint.

Request:

```json
{
  "type": "member_of",
  "description": "关系描述",
  "sourceId": "source-entity-id",
  "targetId": "target-entity-id"
}
```

Response:

```json
{ "relation": {} }
```

Validation and behavior:

- Source and target cannot be the same entity.
- Both endpoints must exist and belong to the same book as the relation.
- If the new `(book_id, source, target, type)` already exists, mentions are migrated into the existing relation and the old relation is deleted.
- Review status is reset after editing.

### `DELETE /api/kg/relations/:relationId`

Deletes one relation and its mentions.

Response:

```json
{ "ok": true }
```

## Graph, Evidence Search, And Export APIs

### `GET /api/kg/graph`

Returns a filtered global graph slice for a book.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `entityType` | no | `''` | Requires both source and target to match this entity type when set |
| `relationType` | no | `''` | Relation type filter |
| `limit` | no | `150` | Relation limit, clamped to `1..300` |

Response:

```ts
{
  entities: KgEntity[]
  relations: KgRelation[]
}
```

### `GET /api/kg/search`

Searches entity mentions and relation mentions/evidence.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `q` | no | `''` | Search text |
| `kind` | no | `all` | `all`, `entities`, or `relations` |
| `entityType` | no | `''` | Entity mention type filter |
| `relationType` | no | `''` | Relation mention type filter |
| `limit` | no | `80` | Per-kind limit, clamped to `1..200` |

Response:

```ts
{
  entities: Array<{
    mentionId: string
    entityId: string
    entityName: string
    entityType: string
    entityDescription: string | null
    chapterId: string
    chapterIndex: number
    chapterTitle: string
    evidence: string | null
    confidence: number
  }>
  relations: Array<{
    mentionId: string
    relationId: string
    relationType: string
    relationDescription: string | null
    sourceId: string
    sourceName: string
    sourceType: string
    targetId: string
    targetName: string
    targetType: string
    chapterId: string
    chapterIndex: number
    chapterTitle: string
    evidence: string | null
    confidence: number
  }>
}
```

### `GET /api/kg/export`

Exports a book's knowledge graph.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `format` | no | `json` | `json` or `graphml` |

Responses:

- `format=json`: `application/json`, filename `<book>-knowledge-graph.json`
- `format=graphml`: `application/graphml+xml`, filename `<book>-knowledge-graph.graphml`

## Review Queue APIs

### `GET /api/kg/review-queue`

Returns low-confidence or suspicious entities and relations that have not been marked reviewed or ignored.

Query parameters:

| Name | Required | Default | Description |
|---|---:|---:|---|
| `bookId` | yes | - | Book ID |
| `kind` | no | `all` | `all`, `entities`, or `relations` |
| `limit` | no | `200` | Clamped to `1..500` |

Response:

```ts
{
  entities: Array<KgEntity & { reasons: string[] }>
  relations: Array<KgRelation & { reasons: string[] }>
}
```

Review reason values:

```text
confidence_low
type_unclear
name_too_short
description_missing
alias_suspicious
self_loop
```

### `POST /api/kg/review-queue/mark`

Marks review queue items as approved or ignored.

Request:

```json
{
  "ids": ["id-a", "id-b"],
  "kind": "entities",
  "status": "approved"
}
```

Allowed values:

- `kind`: `entities`, `relations`
- `status`: `approved`, `ignored`

Response:

```json
{ "marked": 2 }
```

### `POST /api/kg/review-queue/delete`

Deletes review queue entities or relations in batches.

Request:

```json
{
  "ids": ["id-a", "id-b"],
  "kind": "entities"
}
```

Allowed values:

- `kind`: `entities`, `relations`

Response:

```json
{ "deleted": 2 }
```

## Coreference APIs

### `GET /api/kg/coreference/components`

Returns candidate character-identity components for the global coreference pass.

Query parameters:

| Name | Required | Description |
|---|---:|---|
| `bookId` | yes | Book ID |

Response:

```ts
{
  totalComponents: number
  components: Array<Array<{
    id: string
    name: string
    aliases: string[]
    firstChapterIndex: number | null
    lastChapterIndex: number | null
    description: string | null
  }>>
}
```

### `POST /api/kg/coreference/resolve`

Starts an LLM-assisted global coreference job. The job groups likely duplicate character entities, asks the configured generation model to decide identity clusters, and merges matching entities.

Request:

```json
{
  "bookId": "book-id",
  "provider": "ollama",
  "model": "qwen3:8b",
  "baseUrl": "http://127.0.0.1:11434",
  "apiKey": "",
  "limit": 10,
  "concurrency": 1,
  "temperature": 0,
  "jsonMode": true,
  "thinkingEnabled": false
}
```

Response:

```json
{
  "jobId": "job-id",
  "totalComponents": 42,
  "processedThisRun": 10,
  "hasMore": true
}
```

Behavior:

- The job is recorded in `kg_scan_jobs` with scope `coreference`.
- A recent running coreference job for the same book returns `409`.
- `limit` can be used to process a small batch before running the whole book.
- Merges move mentions and aliases, merge conflicting relations, and recompute affected chapter ranges.

## Scan Job APIs

The web frontend creates and updates scan jobs while LLM calls happen in the browser. The API persists job state so interrupted scans can be resumed.

### `POST /api/kg/scan/jobs`

Creates a new scan job for a book and deletes older jobs for that book.

Request:

```json
{
  "bookId": "book-id",
  "scope": "当前章节",
  "totalChapters": 10
}
```

Response:

```json
{ "job": {} }
```

### `GET /api/kg/scan/status`

Query parameters:

| Name | Required | Description |
|---|---:|---|
| `bookId` | yes | Book ID |

Response:

```json
{ "job": null }
```

or:

```json
{ "job": {} }
```

### `PUT /api/kg/scan/jobs/:jobId`

Updates scan job progress.

Request:

```json
{
  "status": "running",
  "completedChapters": 3,
  "failedChapters": 1,
  "error": null
}
```

Response:

```json
{ "ok": true }
```

## Chapter Extraction APIs

### `POST /api/kg/chapters/:chapterId/extraction/diff`

Previews how a new extraction would change the normalized graph for one chapter without writing it.

Request:

```json
{
  "bookId": "book-id",
  "extraction": {
    "entities": [],
    "relations": []
  }
}
```

Response:

```ts
{
  chapter: { id: string, index: number, title: string }
  summary: {
    entitiesAdded: number
    entitiesRemoved: number
    entitiesUnchanged: number
    relationsAdded: number
    relationsRemoved: number
    relationsUnchanged: number
  }
  entities: {
    added: EntityDiffItem[]
    removed: EntityDiffItem[]
    unchanged: EntityDiffItem[]
  }
  relations: {
    added: RelationDiffItem[]
    removed: RelationDiffItem[]
    unchanged: RelationDiffItem[]
  }
}

type EntityDiffItem = {
  key: string
  name: string
  type: string
  description: string
  evidence: string
  confidence: number
}

type RelationDiffItem = {
  key: string
  sourceName: string
  targetName: string
  sourceType: string
  targetType: string
  type: string
  description: string
  evidence: string
  confidence: number
}
```

The exact diff payload is intended for UI preview and may evolve with graph maintenance logic.

### `GET /api/kg/chapters/:chapterId/extraction`

Returns the saved raw extraction for a chapter.

Response:

```ts
{
  extraction: null | {
    chapterId: string
    bookId: string
    status: string
    extraction: ChapterExtraction | null
    error: string | null
    model: string | null
    scannedAt: string | null
    updatedAt: string
  }
}
```

### `PUT /api/kg/chapters/:chapterId/extraction`

Saves a raw extraction and writes it into normalized graph tables.

Request:

```json
{
  "bookId": "book-id",
  "model": "qwen3:8b",
  "extraction": {
    "entities": [],
    "relations": []
  }
}
```

Response:

```json
{ "ok": true }
```

Behavior:

- Validates that `chapterId` belongs to `bookId`.
- Deletes previous mentions for this chapter.
- Upserts entities and relations.
- Saves raw JSON in `kg_chapter_extractions`.
- Recomputes touched entity/relation chapter ranges.
- Deletes empty relations and empty entities created by local rebuilds.

### `POST /api/kg/chapters/:chapterId/replay`

Replays an already-saved raw extraction into normalized graph tables without calling a model.

Request:

```json
{ "bookId": "book-id" }
```

Response:

```json
{ "ok": true }
```

Validation:

- Saved extraction must exist for `chapterId`.
- Saved extraction status must be `completed`.
- Saved extraction JSON must parse to an object.

## RAG APIs

### `POST /api/rag/embeddings/validate`

Validates the selected embedding provider and model through the local backend.

Request:

```json
{
  "provider": "ollama",
  "model": "nomic-embed-text",
  "baseUrl": "http://127.0.0.1:11434",
  "apiKey": ""
}
```

Response:

```json
{
  "ok": true,
  "dimension": 768
}
```

### `POST /api/rag/embeddings/batch`

Generates embeddings for chapter summaries and chapter-content chunks that do not already have embeddings for the selected model.

Request:

```json
{
  "bookId": "book-id",
  "provider": "ollama",
  "model": "nomic-embed-text",
  "baseUrl": "http://127.0.0.1:11434",
  "apiKey": "",
  "chapterIds": ["optional-chapter-id"]
}
```

Provider values:

- `ollama`: calls `<baseUrl>/api/embeddings`
- `openai`: calls `<baseUrl>/embeddings`

Response:

```json
{
  "completed": 10,
  "failed": 0,
  "total": 10,
  "chunkCompleted": 84,
  "chunkFailed": 0
}
```

Notes:

- If `chapterIds` is omitted, all summaries for the book are considered.
- Existing summary embeddings for the same `(chapter_id, model)` are skipped.
- Chapter content is split into paragraph-aware chunks of roughly 1200 characters with overlap, then stored in `chapter_chunk_embeddings`.
- Embeddings are L2-normalized before storage.

### `GET /api/rag/embeddings/status`

Returns embedding coverage for a book and model.

Query parameters:

| Name | Required | Description |
|---|---:|---|
| `bookId` | yes | Book ID |
| `model` | yes | Embedding model name |

Response:

```json
{
  "totalChapters": 100,
  "summarizedChapters": 90,
  "missingSummaries": 10,
  "embeddedChapters": 95,
  "missingChapters": 5,
  "totalChunks": 620,
  "embeddedChunks": 588,
  "missingChunks": 32,
  "model": "nomic-embed-text",
  "dimension": 1024
}
```

### `POST /api/rag/search`

Runs RAG search using summary embeddings, chapter chunk embeddings, and knowledge graph entity recall.

Request:

```json
{
  "bookId": "book-id",
  "query": "韩立什么时候得到某件法宝？",
  "topK": 10,
  "includeSnippets": true,
  "provider": "ollama",
  "model": "nomic-embed-text",
  "baseUrl": "http://127.0.0.1:11434",
  "apiKey": ""
}
```

Response:

```ts
{
  results: RagSearchResult[]
  entityMatches: Array<{
    entityId: string
    entityName: string
    entityType: string
    firstChapterIndex: number | null
    lastChapterIndex: number | null
  }>
}
```

Error response when embeddings are not ready:

```json
{
  "error": "Embeddings not ready: 20/100 chapters embedded.",
  "code": "EMBEDDINGS_NOT_READY",
  "embeddedCount": 20,
  "totalChapters": 100
}
```

The API requires at least 80% embedding coverage for the selected model before search.

## Implementation Notes

- The database is SQLite with `PRAGMA foreign_keys = ON` and `WAL` journal mode.
- Entity uniqueness is `(book_id, type, normalized_name)`.
- Relation uniqueness is `(book_id, source_entity_id, target_entity_id, type)`.
- Summary embedding uniqueness is `(chapter_id, model)`.
- Confidence values are normalized to `0..1`.
- Unknown entity types are stored as `other`; unknown relation types are stored as `related_to`.
- Entity and relation edits reset `review_status` to `NULL` so review heuristics can re-evaluate them.
- API keys and model configuration are stored locally in SQLite as part of app state. Do not expose this API server to untrusted networks.
