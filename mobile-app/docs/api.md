# Mobile API Contract

This document mirrors the PC-side `docs/backend-api.md` mobile sync section. The Android app should treat this as its client contract.

## Base URL

The user configures a PC sync URL while the phone is on the same LAN.

Example:

```text
http://192.168.1.8:5174
```

All sync requests use this base URL plus `/api/mobile/*`.

## Authentication

Send the sync token on every request:

```text
Authorization: Bearer <sync-token>
```

The mobile app must store this token in mobile settings, not inside synced book packages.

## Endpoints

```text
GET /api/mobile/manifest
GET /api/mobile/books
GET /api/mobile/books/:bookId/package
GET /api/mobile/books/:bookId/changes?since=...
POST /api/mobile/progress
```

Phase 1 requires only:

- `GET /api/mobile/manifest`
- `GET /api/mobile/books`
- `GET /api/mobile/books/:bookId/package`

## Data Rules

- PC generates summaries, knowledge graph data, and all corpus embeddings.
- Mobile never generates book, chapter, summary, or chunk embeddings.
- Mobile imports synced embeddings as read-only local data.
- Mobile may use a user-configured public LLM for answer generation over locally retrieved context.
- PC responses must not include LLM API keys or sensitive desktop model configuration.

## Types

```ts
export type MobileManifest = {
  serverVersion: string
  schemaVersion: number
  capabilities: Array<
    | 'full-book-package'
    | 'reading-progress'
    | 'incremental-sync'
    | 'compressed-package'
  >
  generatedAt: string
}

export type MobileBookListItem = {
  id: string
  title: string
  importedAt: string
  updatedAt: string | null
  chapterCount: number
  wordCount: number
  summaryCoverage: {
    completed: number
    total: number
  }
  graphCoverage: {
    scannedChapters: number
    totalChapters: number
    entityCount: number
    relationCount: number
  }
  embeddingCoverage: {
    model: string | null
    dimension: number | null
    embeddedSummaries: number
    totalSummaries: number
    embeddedChunks: number
    totalChunks: number
  }
  packageVersion: string
}

export type MobileBookPackage = {
  schemaVersion: number
  packageVersion: string
  generatedAt: string
  book: {
    id: string
    title: string
    importedAt: string
    chapterCount: number
    wordCount: number
  }
  chapters: MobileChapter[]
  summaries: MobileSummary[]
  knowledgeGraph: {
    entities: MobileKgEntity[]
    entityMentions: MobileKgEntityMention[]
    relations: MobileKgRelation[]
    relationMentions: MobileKgRelationMention[]
  }
  embeddings: {
    summaries: MobileSummaryEmbedding[]
    chunks: MobileChunkEmbedding[]
  }
  integrity: {
    contentHash: string | null
    algorithm: 'sha256' | null
  }
}

export type MobileChapter = {
  id: string
  bookId: string
  index: number
  title: string
  content: string
  wordCount: number
  updatedAt: string | null
}

export type MobileSummary = {
  chapterId: string
  short: string
  detail: string
  keyPoints: string[]
  skippable: string
  generatedBy: 'local' | 'ollama' | 'openai'
  updatedAt: string | null
}

export type MobileKgEntity = {
  id: string
  bookId: string
  type: string
  name: string
  normalizedName: string
  aliases: string[]
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  reviewStatus: string | null
  updatedAt: string | null
}

export type MobileKgEntityMention = {
  id: string
  entityId: string
  bookId: string
  chapterId: string
  chapterIndex: number
  evidence: string | null
  confidence: number
}

export type MobileKgRelation = {
  id: string
  bookId: string
  sourceEntityId: string
  targetEntityId: string
  type: string
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  reviewStatus: string | null
  updatedAt: string | null
}

export type MobileKgRelationMention = {
  id: string
  relationId: string
  bookId: string
  chapterId: string
  chapterIndex: number
  evidence: string | null
  confidence: number
}

export type MobileSummaryEmbedding = {
  chapterId: string
  bookId: string
  model: string
  dimension: number
  embedding: number[]
  generatedAt: string
}

export type MobileChunkEmbedding = {
  id: string
  bookId: string
  chapterId: string
  chapterIndex: number
  chunkIndex: number
  startOffset: number
  endOffset: number
  text: string
  model: string
  dimension: number
  embedding: number[]
  generatedAt: string
}
```

## Mobile Import Expectations

The app should import a package inside one transaction.

Import order:

1. Validate `schemaVersion`.
2. Validate `book.id` and package `bookId` relationships.
3. Replace existing local rows for the book.
4. Insert book, chapters, summaries, graph rows, and embeddings.
5. Update `sync_metadata`.

If import fails, the previous local copy must remain readable.

