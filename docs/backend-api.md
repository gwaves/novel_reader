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

## Implementation Notes

- The database is SQLite with `PRAGMA foreign_keys = ON` and `WAL` journal mode.
- Entity uniqueness is `(book_id, type, normalized_name)`.
- Relation uniqueness is `(book_id, source_entity_id, target_entity_id, type)`.
- Confidence values are normalized to `0..1`.
- Unknown entity types are stored as `other`; unknown relation types are stored as `related_to`.
- Entity and relation edits reset `review_status` to `NULL` so review heuristics can re-evaluate them.
- API keys and model configuration are stored locally in SQLite as part of app state. Do not expose this API server to untrusted networks.

