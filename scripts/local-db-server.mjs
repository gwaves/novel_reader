import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const host = process.env.NOVEL_READER_API_HOST || '127.0.0.1'
const port = Number(process.env.NOVEL_READER_API_PORT || 5174)
const dataDir = process.env.NOVEL_READER_DATA_DIR || join(homedir(), '.novel_reader')
const dbPath = process.env.NOVEL_READER_DB_PATH || join(dataDir, 'novel_reader.sqlite')
const pendingRestorePath = join(dataDir, 'novel_reader.restore-pending.sqlite')
const stateKey = 'novel-reader-mvp-state'

mkdirSync(dirname(dbPath), { recursive: true })

if (existsSync(pendingRestorePath)) {
  const backupPath = join(dataDir, `novel_reader.before-restore-${Date.now()}.sqlite`)
  if (existsSync(dbPath)) {
    copyFileSync(dbPath, backupPath)
  }
  renameSync(pendingRestorePath, dbPath)
  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${dbPath}${suffix}`
    if (existsSync(sidecarPath)) unlinkSync(sidecarPath)
  }
}

const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    chapter_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS summaries (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    short TEXT NOT NULL,
    detail TEXT NOT NULL,
    key_points_json TEXT NOT NULL,
    skippable TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chapters_book_index ON chapters(book_id, chapter_index);
  CREATE INDEX IF NOT EXISTS idx_chapters_title ON chapters(title);

  CREATE TABLE IF NOT EXISTS kg_scan_jobs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    total_chapters INTEGER NOT NULL DEFAULT 0,
    completed_chapters INTEGER NOT NULL DEFAULT 0,
    failed_chapters INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_chapter_extractions (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    extraction_json TEXT,
    error TEXT,
    model TEXT,
    scanned_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_entities (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    first_chapter_index INTEGER,
    last_chapter_index INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(book_id, type, normalized_name)
  );

  CREATE TABLE IF NOT EXISTS kg_entity_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    evidence TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_relations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    source_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    description TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(book_id, source_entity_id, target_entity_id, type)
  );

  CREATE TABLE IF NOT EXISTS kg_relation_mentions (
    id TEXT PRIMARY KEY,
    relation_id TEXT NOT NULL REFERENCES kg_relations(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL,
    evidence TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entities_book_type ON kg_entities(book_id, type);
  CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(book_id, normalized_name);
  CREATE INDEX IF NOT EXISTS idx_kg_entity_mentions_entity ON kg_entity_mentions(entity_id, chapter_index);
  CREATE INDEX IF NOT EXISTS idx_kg_entity_mentions_chapter ON kg_entity_mentions(chapter_id);
  CREATE INDEX IF NOT EXISTS idx_kg_relations_book_type ON kg_relations(book_id, type);
  CREATE INDEX IF NOT EXISTS idx_kg_relation_mentions_relation ON kg_relation_mentions(relation_id, chapter_index);
  CREATE INDEX IF NOT EXISTS idx_kg_relation_mentions_chapter ON kg_relation_mentions(chapter_id);
  CREATE INDEX IF NOT EXISTS idx_kg_chapter_extractions_book ON kg_chapter_extractions(book_id);

  CREATE TABLE IF NOT EXISTS summary_embeddings (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_summary_embeddings_book ON summary_embeddings(book_id);
`)

// Migration: add first/last chapter index to relations if missing
try {
  db.exec(`ALTER TABLE kg_relations ADD COLUMN first_chapter_index INTEGER`)
  db.exec(`ALTER TABLE kg_relations ADD COLUMN last_chapter_index INTEGER`)
} catch {
  // columns may already exist
}

// Migration: add review_status for low-confidence review queue
try {
  db.exec(`ALTER TABLE kg_entities ADD COLUMN review_status TEXT`)
} catch {
  // column may already exist
}
try {
  db.exec(`ALTER TABLE kg_relations ADD COLUMN review_status TEXT`)
} catch {
  // column may already exist
}

const getStateStatement = db.prepare('SELECT value_json FROM app_state WHERE key = ?')
const saveStateStatement = db.prepare(`
  INSERT INTO app_state (key, value_json, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
`)
const listBookIdsStatement = db.prepare('SELECT id FROM books')
const deleteBookStatement = db.prepare('DELETE FROM books WHERE id = ?')
const upsertBookStatement = db.prepare(`
  INSERT INTO books (id, title, imported_at, chapter_count, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    imported_at = excluded.imported_at,
    chapter_count = excluded.chapter_count,
    updated_at = excluded.updated_at
`)
const upsertChapterStatement = db.prepare(`
  INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    book_id = excluded.book_id,
    chapter_index = excluded.chapter_index,
    title = excluded.title,
    content = excluded.content,
    word_count = excluded.word_count,
    updated_at = excluded.updated_at
`)
const upsertSummaryStatement = db.prepare(`
  INSERT INTO summaries (
    chapter_id,
    short,
    detail,
    key_points_json,
    skippable,
    generated_by,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(chapter_id) DO UPDATE SET
    short = excluded.short,
    detail = excluded.detail,
    key_points_json = excluded.key_points_json,
    skippable = excluded.skippable,
    generated_by = excluded.generated_by,
    updated_at = excluded.updated_at
`)
const getSummariesForBookStatement = db.prepare(`
  SELECT
    s.chapter_id AS chapterId,
    s.short,
    s.detail,
    s.key_points_json AS keyPointsJson,
    s.skippable,
    s.generated_by AS generatedBy
  FROM summaries s
  JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ?
`)
const getSummaryForChapterStatement = db.prepare(`
  SELECT
    chapter_id AS chapterId,
    short,
    detail,
    key_points_json AS keyPointsJson
  FROM summaries
  WHERE chapter_id = ?
`)
const countChaptersForBookStatement = db.prepare(`
  SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?
`)
const countEmbeddingsForBookStatement = db.prepare(`
  SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ? AND model = ?
`)
const getEmbeddingDimensionStatement = db.prepare(`
  SELECT dimension FROM summary_embeddings WHERE book_id = ? AND model = ? LIMIT 1
`)
const listEmbeddingsForBookStatement = db.prepare(`
  SELECT
    se.chapter_id AS chapterId,
    se.embedding_json AS embeddingJson,
    se.model,
    se.dimension,
    c.chapter_index AS chapterIndex,
    c.title AS chapterTitle
  FROM summary_embeddings se
  JOIN chapters c ON c.id = se.chapter_id
  WHERE se.book_id = ? AND se.model = ?
  ORDER BY c.chapter_index ASC
`)
const getEmbeddingForChapterStatement = db.prepare(`
  SELECT embedding_json AS embeddingJson, model, dimension
  FROM summary_embeddings
  WHERE chapter_id = ? AND model = ?
`)
const getMissingEmbeddingChapterIdsStatement = db.prepare(`
  SELECT s.chapter_id AS chapterId
  FROM summaries s
  JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM summary_embeddings se
      WHERE se.chapter_id = s.chapter_id AND se.model = ?
    )
  ORDER BY c.chapter_index ASC
`)
const getSummaryChapterIdsForBookStatement = db.prepare(`
  SELECT s.chapter_id AS chapterId
  FROM summaries s
  JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ?
  ORDER BY c.chapter_index ASC
`)
const upsertEmbeddingStatement = db.prepare(`
  INSERT INTO summary_embeddings (chapter_id, book_id, model, dimension, embedding_json, generated_at)
  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(chapter_id) DO UPDATE SET
    book_id = excluded.book_id,
    model = excluded.model,
    dimension = excluded.dimension,
    embedding_json = excluded.embedding_json,
    generated_at = excluded.generated_at
`)
const listEntitiesForBookStatement = db.prepare(`
  SELECT
    id,
    type,
    name,
    aliases_json AS aliasesJson,
    first_chapter_index AS firstChapterIndex,
    last_chapter_index AS lastChapterIndex
  FROM kg_entities
  WHERE book_id = ?
`)
const listEntityMentionsForEntityStatement = db.prepare(`
  SELECT DISTINCT chapter_id AS chapterId, chapter_index AS chapterIndex
  FROM kg_entity_mentions
  WHERE entity_id = ?
  ORDER BY chapter_index ASC
`)
const getChapterContentSnippetStatement = db.prepare(`
  SELECT substr(content, 1, 500) AS snippet
  FROM chapters
  WHERE id = ?
`)
const getChapterStatement = db.prepare(`
  SELECT id, book_id, chapter_index, title
  FROM chapters
  WHERE id = ?
`)
const getBookStatement = db.prepare(`
  SELECT id, title, imported_at AS importedAt, chapter_count AS chapterCount
  FROM books
  WHERE id = ?
`)
const getKgOverviewStatement = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM kg_chapter_extractions WHERE book_id = ?) AS scanned_chapters,
    (SELECT COUNT(*) FROM kg_entities WHERE book_id = ?) AS entity_count,
    (SELECT COUNT(*) FROM kg_relations WHERE book_id = ?) AS relation_count
`)
const insertKgScanJobStatement = db.prepare(`
  INSERT INTO kg_scan_jobs (id, book_id, scope, status, total_chapters, completed_chapters, failed_chapters, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)
const updateBookTitleStatement = db.prepare(`
  UPDATE books
  SET title = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)

const updateKgScanJobStatement = db.prepare(`
  UPDATE kg_scan_jobs
  SET completed_chapters = ?, failed_chapters = ?, error = ?, status = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const updateKgScanJobProgressStatement = db.prepare(`
  UPDATE kg_scan_jobs
  SET total_chapters = ?,
      completed_chapters = ?,
      failed_chapters = ?,
      error = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const getLatestKgScanJobStatement = db.prepare(`
  SELECT
    id,
    book_id AS bookId,
    scope,
    status,
    total_chapters AS totalChapters,
    completed_chapters AS completedChapters,
    failed_chapters AS failedChapters,
    error,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM kg_scan_jobs
  WHERE book_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`)
const deleteKgScanJobsForBookStatement = db.prepare(`
  DELETE FROM kg_scan_jobs WHERE book_id = ?
`)
const listKgEntitiesStatement = db.prepare(`
  SELECT
    e.id,
    e.book_id AS bookId,
    e.type,
    e.name,
    e.aliases_json AS aliasesJson,
    e.description,
    e.confidence,
    e.first_chapter_index AS firstChapterIndex,
    e.last_chapter_index AS lastChapterIndex,
    COUNT(m.id) AS mentionCount
  FROM kg_entities e
  LEFT JOIN kg_entity_mentions m ON m.entity_id = e.id
  WHERE e.book_id = ?
    AND (? = '' OR e.type = ?)
    AND (? = '' OR e.normalized_name LIKE ? OR e.aliases_json LIKE ?)
  GROUP BY e.id
  ORDER BY mentionCount DESC, e.first_chapter_index ASC, e.name ASC
  LIMIT ?
`)
const getKgEntityStatement = db.prepare(`
  SELECT
    id,
    book_id AS bookId,
    type,
    name,
    aliases_json AS aliasesJson,
    description,
    confidence,
    first_chapter_index AS firstChapterIndex,
    last_chapter_index AS lastChapterIndex
  FROM kg_entities
  WHERE id = ?
`)
const getKgEntityMentionsStatement = db.prepare(`
  SELECT
    m.id,
    m.chapter_id AS chapterId,
    m.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    m.evidence,
    m.confidence
  FROM kg_entity_mentions m
  JOIN chapters c ON c.id = m.chapter_id
  WHERE m.entity_id = ?
  ORDER BY m.chapter_index ASC
  LIMIT 100
`)
const listKgCharacterEntitiesForCoreferenceStatement = db.prepare(`
  SELECT
    id,
    name,
    aliases_json AS aliasesJson,
    description,
    first_chapter_index AS firstChapterIndex,
    last_chapter_index AS lastChapterIndex
  FROM kg_entities
  WHERE book_id = ? AND type = 'character'
`)
const listKgEntityOrganizationsStatement = db.prepare(`
  SELECT
    target.id AS organizationId,
    target.name AS organizationName
  FROM kg_relations r
  JOIN kg_entities target ON target.id = r.target_entity_id
  WHERE r.source_entity_id = ? AND r.type = 'member_of'
`)
const listKgEntityOrganizationMembersStatement = db.prepare(`
  SELECT
    e.id,
    e.name,
    e.aliases_json AS aliasesJson,
    e.first_chapter_index AS firstChapterIndex,
    e.last_chapter_index AS lastChapterIndex,
    e.description
  FROM kg_relations r
  JOIN kg_entities e ON e.id = r.source_entity_id
  WHERE r.target_entity_id = ? AND r.type = 'member_of' AND e.id != ?
`)
const listKgEntityRelationSummariesStatement = db.prepare(`
  SELECT r.type, target.name AS targetName
  FROM kg_relations r
  JOIN kg_entities target ON target.id = r.target_entity_id
  WHERE r.source_entity_id = ?
  LIMIT 12
`)
const bulkUpdateKgEntityMentionsEntityStatement = db.prepare(`
  UPDATE kg_entity_mentions SET entity_id = ? WHERE entity_id = ?
`)
const getKgEntityRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.type,
    r.description,
    r.confidence,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  WHERE r.source_entity_id = ? OR r.target_entity_id = ?
  ORDER BY r.confidence DESC, r.updated_at DESC
  LIMIT 100
`)
const getKgNeighborhoodEntityStatement = db.prepare(`
  SELECT
    e.id,
    e.book_id AS bookId,
    e.type,
    e.name,
    e.aliases_json AS aliasesJson,
    e.description,
    e.confidence,
    e.first_chapter_index AS firstChapterIndex,
    e.last_chapter_index AS lastChapterIndex,
    COUNT(m.id) AS mentionCount
  FROM kg_entities e
  LEFT JOIN kg_entity_mentions m ON m.entity_id = e.id
  WHERE e.id = ?
  GROUP BY e.id
`)
const listKgNeighborhoodRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.source_entity_id = ? OR r.target_entity_id = ?
  GROUP BY r.id
  ORDER BY mentionCount DESC, r.confidence DESC, r.updated_at DESC
  LIMIT ?
`)
const listKgGraphRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.book_id = ?
    AND (? = '' OR r.type = ?)
    AND (? = '' OR (source.type = ? AND target.type = ?))
  GROUP BY r.id
  ORDER BY mentionCount DESC, r.confidence DESC, r.updated_at DESC
  LIMIT ?
`)
const searchKgEntityEvidenceStatement = db.prepare(`
  SELECT
    m.id AS mentionId,
    e.id AS entityId,
    e.name AS entityName,
    e.type AS entityType,
    e.description AS entityDescription,
    c.id AS chapterId,
    c.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    m.evidence,
    m.confidence
  FROM kg_entity_mentions m
  JOIN kg_entities e ON e.id = m.entity_id
  JOIN chapters c ON c.id = m.chapter_id
  WHERE e.book_id = ?
    AND (? = '' OR e.type = ?)
    AND (
      ? = ''
      OR e.name LIKE ?
      OR e.normalized_name LIKE ?
      OR e.aliases_json LIKE ?
      OR e.description LIKE ?
      OR m.evidence LIKE ?
      OR c.title LIKE ?
    )
  ORDER BY c.chapter_index ASC, e.name ASC
  LIMIT ?
`)
const searchKgRelationEvidenceStatement = db.prepare(`
  SELECT
    mention.id AS mentionId,
    r.id AS relationId,
    r.type AS relationType,
    r.description AS relationDescription,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    c.id AS chapterId,
    c.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    mention.evidence,
    mention.confidence
  FROM kg_relation_mentions mention
  JOIN kg_relations r ON r.id = mention.relation_id
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  JOIN chapters c ON c.id = mention.chapter_id
  WHERE r.book_id = ?
    AND (? = '' OR r.type = ?)
    AND (
      ? = ''
      OR r.type LIKE ?
      OR r.description LIKE ?
      OR mention.evidence LIKE ?
      OR source.name LIKE ?
      OR target.name LIKE ?
      OR c.title LIKE ?
    )
  ORDER BY c.chapter_index ASC, source.name ASC, target.name ASC
  LIMIT ?
`)
const listKgRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.book_id = ?
    AND (? = '' OR r.type = ?)
  GROUP BY r.id
  ORDER BY mentionCount DESC, r.confidence DESC, r.updated_at DESC
  LIMIT ?
`)
const listKgExportEntitiesStatement = db.prepare(`
  SELECT
    e.id,
    e.book_id AS bookId,
    e.type,
    e.name,
    e.aliases_json AS aliasesJson,
    e.description,
    e.confidence,
    e.first_chapter_index AS firstChapterIndex,
    e.last_chapter_index AS lastChapterIndex,
    COUNT(m.id) AS mentionCount
  FROM kg_entities e
  LEFT JOIN kg_entity_mentions m ON m.entity_id = e.id
  WHERE e.book_id = ?
  GROUP BY e.id
  ORDER BY e.type ASC, e.name ASC
`)
const listKgExportEntityMentionsStatement = db.prepare(`
  SELECT
    m.id,
    m.entity_id AS entityId,
    m.chapter_id AS chapterId,
    c.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    m.evidence,
    m.confidence
  FROM kg_entity_mentions m
  JOIN chapters c ON c.id = m.chapter_id
  WHERE m.book_id = ?
  ORDER BY c.chapter_index ASC
`)
const listKgExportRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.book_id AS bookId,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.book_id = ?
  GROUP BY r.id
  ORDER BY r.type ASC, source.name ASC, target.name ASC
`)
const listKgExportRelationMentionsStatement = db.prepare(`
  SELECT
    m.id,
    m.relation_id AS relationId,
    m.chapter_id AS chapterId,
    c.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    m.evidence,
    m.confidence
  FROM kg_relation_mentions m
  JOIN chapters c ON c.id = m.chapter_id
  WHERE m.book_id = ?
  ORDER BY c.chapter_index ASC
`)
const listKgReviewEntitiesStatement = db.prepare(`
  SELECT
    e.id,
    e.book_id AS bookId,
    e.type,
    e.name,
    e.aliases_json AS aliasesJson,
    e.description,
    e.confidence,
    e.first_chapter_index AS firstChapterIndex,
    e.last_chapter_index AS lastChapterIndex,
    COUNT(m.id) AS mentionCount
  FROM kg_entities e
  LEFT JOIN kg_entity_mentions m ON m.entity_id = e.id
  WHERE e.book_id = ? AND e.review_status IS NULL
  GROUP BY e.id
  ORDER BY e.confidence ASC, e.updated_at DESC
  LIMIT ?
`)
const listKgReviewRelationsStatement = db.prepare(`
  SELECT
    r.id,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.book_id = ? AND r.review_status IS NULL
  GROUP BY r.id
  ORDER BY r.confidence ASC, r.updated_at DESC
  LIMIT ?
`)
const markKgEntitiesReviewedStatement = db.prepare(`
  UPDATE kg_entities SET review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`)
const markKgRelationsReviewedStatement = db.prepare(`
  UPDATE kg_relations SET review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`)
const resetKgEntityReviewStatusStatement = db.prepare(`
  UPDATE kg_entities SET review_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`)
const resetKgRelationReviewStatusStatement = db.prepare(`
  UPDATE kg_relations SET review_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`)
const getKgRelationStatement = db.prepare(`
  SELECT
    r.id,
    r.book_id AS bookId,
    r.type,
    r.description,
    r.confidence,
    r.first_chapter_index AS firstChapterIndex,
    r.last_chapter_index AS lastChapterIndex,
    source.id AS sourceId,
    source.name AS sourceName,
    source.type AS sourceType,
    target.id AS targetId,
    target.name AS targetName,
    target.type AS targetType,
    COUNT(mention.id) AS mentionCount
  FROM kg_relations r
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  LEFT JOIN kg_relation_mentions mention ON mention.relation_id = r.id
  WHERE r.id = ?
  GROUP BY r.id
`)
const getKgRelationMentionsStatement = db.prepare(`
  SELECT
    m.id,
    m.chapter_id AS chapterId,
    m.chapter_index AS chapterIndex,
    c.title AS chapterTitle,
    m.evidence,
    m.confidence
  FROM kg_relation_mentions m
  JOIN chapters c ON c.id = m.chapter_id
  WHERE m.relation_id = ?
  ORDER BY m.chapter_index ASC
  LIMIT 100
`)
const listKgChapterEntityDiffRowsStatement = db.prepare(`
  SELECT
    e.id AS entityId,
    e.name,
    e.type,
    e.description,
    m.evidence,
    m.confidence
  FROM kg_entity_mentions m
  JOIN kg_entities e ON e.id = m.entity_id
  WHERE m.chapter_id = ?
  ORDER BY e.type ASC, e.name ASC
`)
const listKgChapterRelationDiffRowsStatement = db.prepare(`
  SELECT
    r.id AS relationId,
    r.type,
    r.description,
    r.confidence,
    source.name AS sourceName,
    source.type AS sourceType,
    target.name AS targetName,
    target.type AS targetType,
    m.evidence
  FROM kg_relation_mentions m
  JOIN kg_relations r ON r.id = m.relation_id
  JOIN kg_entities source ON source.id = r.source_entity_id
  JOIN kg_entities target ON target.id = r.target_entity_id
  WHERE m.chapter_id = ?
  ORDER BY r.type ASC, source.name ASC, target.name ASC
`)
const getKgChapterExtractionStatement = db.prepare(`
  SELECT
    chapter_id AS chapterId,
    book_id AS bookId,
    status,
    extraction_json AS extractionJson,
    error,
    model,
    scanned_at AS scannedAt,
    updated_at AS updatedAt
  FROM kg_chapter_extractions
  WHERE chapter_id = ?
`)
const listKgScannedChaptersStatement = db.prepare(`
  SELECT
    extraction.chapter_id AS chapterId,
    extraction.book_id AS bookId,
    chapter.chapter_index AS chapterIndex,
    chapter.title AS title,
    extraction.status,
    extraction.model,
    extraction.scanned_at AS scannedAt,
    extraction.updated_at AS updatedAt,
    (
      SELECT COUNT(DISTINCT mention.entity_id)
      FROM kg_entity_mentions mention
      WHERE mention.chapter_id = extraction.chapter_id
    ) AS entityCount,
    (
      SELECT COUNT(DISTINCT relation_mention.relation_id)
      FROM kg_relation_mentions relation_mention
      WHERE relation_mention.chapter_id = extraction.chapter_id
    ) AS relationCount
  FROM kg_chapter_extractions extraction
  JOIN chapters chapter ON chapter.id = extraction.chapter_id
  WHERE extraction.book_id = ?
  ORDER BY chapter.chapter_index ASC
`)
const upsertKgChapterExtractionStatement = db.prepare(`
  INSERT INTO kg_chapter_extractions (
    chapter_id,
    book_id,
    status,
    extraction_json,
    error,
    model,
    scanned_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(chapter_id) DO UPDATE SET
    book_id = excluded.book_id,
    status = excluded.status,
    extraction_json = excluded.extraction_json,
    error = excluded.error,
    model = excluded.model,
    scanned_at = excluded.scanned_at,
    updated_at = excluded.updated_at
`)
const deleteKgEntityMentionsForChapterStatement = db.prepare(`
  DELETE FROM kg_entity_mentions
  WHERE chapter_id = ?
`)
const deleteKgRelationMentionsForChapterStatement = db.prepare(`
  DELETE FROM kg_relation_mentions
  WHERE chapter_id = ?
`)
const listKgEntityIdsForChapterStatement = db.prepare(`
  SELECT DISTINCT entity_id AS entityId
  FROM kg_entity_mentions
  WHERE chapter_id = ?
`)
const listKgRelationIdsForChapterStatement = db.prepare(`
  SELECT DISTINCT relation_id AS relationId
  FROM kg_relation_mentions
  WHERE chapter_id = ?
`)
const getKgRelationEndpointsStatement = db.prepare(`
  SELECT source_entity_id AS sourceEntityId, target_entity_id AS targetEntityId
  FROM kg_relations
  WHERE id = ?
`)
const getKgRelationMentionCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM kg_relation_mentions
  WHERE relation_id = ?
`)
const getKgEntityMentionCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM kg_entity_mentions
  WHERE entity_id = ?
`)
const getKgEntityRelationCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM kg_relations
  WHERE source_entity_id = ? OR target_entity_id = ?
`)
const findKgEntityStatement = db.prepare(`
  SELECT id, aliases_json AS aliasesJson, description, confidence, first_chapter_index AS firstChapterIndex, last_chapter_index AS lastChapterIndex
  FROM kg_entities
  WHERE book_id = ? AND type = ? AND normalized_name = ?
`)
const insertKgEntityStatement = db.prepare(`
  INSERT INTO kg_entities (
    id,
    book_id,
    type,
    name,
    normalized_name,
    aliases_json,
    description,
    confidence,
    first_chapter_index,
    last_chapter_index,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)
const updateKgEntityStatement = db.prepare(`
  UPDATE kg_entities
  SET
    aliases_json = ?,
    description = COALESCE(NULLIF(?, ''), description),
    confidence = MAX(confidence, ?),
    first_chapter_index = CASE
      WHEN first_chapter_index IS NULL THEN ?
      ELSE MIN(first_chapter_index, ?)
    END,
    last_chapter_index = CASE
      WHEN last_chapter_index IS NULL THEN ?
      ELSE MAX(last_chapter_index, ?)
    END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const updateKgEntityFullStatement = db.prepare(`
  UPDATE kg_entities
  SET
    type = ?,
    name = ?,
    normalized_name = ?,
    aliases_json = ?,
    description = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const deleteKgEntityStatement = db.prepare(`
  DELETE FROM kg_entities WHERE id = ?
`)
const deleteKgRelationStatement = db.prepare(`
  DELETE FROM kg_relations WHERE id = ?
`)
const findKgEntityByNormalizedStatement = db.prepare(`
  SELECT id
  FROM kg_entities
  WHERE book_id = ? AND type = ? AND normalized_name = ?
`)
const listKgEntityMentionsForMergeStatement = db.prepare(`
  SELECT
    id,
    chapter_id AS chapterId,
    chapter_index AS chapterIndex,
    evidence,
    confidence
  FROM kg_entity_mentions
  WHERE entity_id = ?
  ORDER BY chapter_index ASC
`)
const listKgRelationsForMergeStatement = db.prepare(`
  SELECT
    id,
    source_entity_id AS sourceEntityId,
    target_entity_id AS targetEntityId,
    type,
    description,
    confidence,
    first_chapter_index AS firstChapterIndex,
    last_chapter_index AS lastChapterIndex
  FROM kg_relations
  WHERE source_entity_id = ? OR target_entity_id = ?
`)
const findKgRelationByEndpointsStatement = db.prepare(`
  SELECT id
  FROM kg_relations
  WHERE book_id = ? AND source_entity_id = ? AND target_entity_id = ? AND type = ?
`)
const updateKgRelationEndpointStatement = db.prepare(`
  UPDATE kg_relations
  SET source_entity_id = ?, target_entity_id = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const updateKgRelationMentionsRelationIdStatement = db.prepare(`
  UPDATE kg_relation_mentions
  SET relation_id = ?
  WHERE relation_id = ?
`)
const deleteKgRelationMentionsByRelationStatement = db.prepare(`
  DELETE FROM kg_relation_mentions WHERE relation_id = ?
`)
const getKgEntityMentionByChapterStatement = db.prepare(`
  SELECT id, evidence, confidence
  FROM kg_entity_mentions
  WHERE entity_id = ? AND chapter_id = ?
`)
const getKgEntityMentionForSplitStatement = db.prepare(`
  SELECT
    id,
    entity_id AS entityId,
    book_id AS bookId,
    chapter_id AS chapterId,
    chapter_index AS chapterIndex,
    evidence,
    confidence
  FROM kg_entity_mentions
  WHERE id = ?
`)
const updateKgEntityMentionEntityStatement = db.prepare(`
  UPDATE kg_entity_mentions
  SET entity_id = ?
  WHERE id = ?
`)
const deleteKgEntityMentionStatement = db.prepare(`
  DELETE FROM kg_entity_mentions WHERE id = ?
`)
const updateKgEntityMentionStatement = db.prepare(`
  UPDATE kg_entity_mentions
  SET evidence = ?, confidence = MAX(confidence, ?)
  WHERE id = ?
`)
const insertKgEntityMentionStatement = db.prepare(`
  INSERT INTO kg_entity_mentions (
    id,
    entity_id,
    book_id,
    chapter_id,
    chapter_index,
    evidence,
    confidence,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`)
const findKgRelationStatement = db.prepare(`
  SELECT id, confidence
  FROM kg_relations
  WHERE book_id = ? AND source_entity_id = ? AND target_entity_id = ? AND type = ?
`)
const insertKgRelationStatement = db.prepare(`
  INSERT INTO kg_relations (
    id,
    book_id,
    source_entity_id,
    target_entity_id,
    type,
    description,
    confidence,
    first_chapter_index,
    last_chapter_index,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)
const updateKgRelationStatement = db.prepare(`
  UPDATE kg_relations
  SET
    description = COALESCE(NULLIF(?, ''), description),
    confidence = MAX(confidence, ?),
    first_chapter_index = CASE
      WHEN first_chapter_index IS NULL THEN ?
      ELSE MIN(first_chapter_index, ?)
    END,
    last_chapter_index = CASE
      WHEN last_chapter_index IS NULL THEN ?
      ELSE MAX(last_chapter_index, ?)
    END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const updateKgRelationFullStatement = db.prepare(`
  UPDATE kg_relations
  SET
    type = ?,
    description = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const findKgRelationConflictStatement = db.prepare(`
  SELECT id
  FROM kg_relations
  WHERE book_id = ? AND source_entity_id = ? AND target_entity_id = ? AND type = ?
`)
const mergeKgRelationIntoStatement = db.prepare(`
  UPDATE kg_relations
  SET
    description = COALESCE(NULLIF(?, ''), description),
    confidence = MAX(confidence, ?),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const insertKgRelationMentionStatement = db.prepare(`
  INSERT INTO kg_relation_mentions (
    id,
    relation_id,
    book_id,
    chapter_id,
    chapter_index,
    evidence,
    confidence,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`)

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sendFile(response, statusCode, body, contentType, filename) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Type': `${contentType}; charset=utf-8`,
  })
  response.end(body)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''

    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk

      if (body.length > 1024 * 1024 * 250) {
        request.destroy()
        reject(new Error('Request body is too large.'))
      }
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function readBinary(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalLength = 0

    request.on('data', (chunk) => {
      chunks.push(chunk)
      totalLength += chunk.length

      if (totalLength > 1024 * 1024 * 1024) {
        request.destroy()
        reject(new Error('Database backup is too large.'))
      }
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase()
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseJsonObject(text) {
  let str = String(text ?? '').trim()
  str = str.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const cleaned = str
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // ignore
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      // ignore
    }
  }
  return null
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function safeFilename(value) {
  return String(value ?? 'knowledge-graph')
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'knowledge-graph'
}

function createDatabaseBackup(prefix = 'novel_reader-backup') {
  const backupPath = join(dataDir, `${prefix}-${Date.now()}.sqlite`)
  if (existsSync(backupPath)) unlinkSync(backupPath)
  db.exec(`VACUUM INTO ${sqliteString(backupPath)}`)
  return backupPath
}

function validateDatabaseBackup(candidatePath) {
  const candidate = new DatabaseSync(candidatePath, { readOnly: true })

  try {
    const integrity = candidate.prepare('PRAGMA integrity_check').get()
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed.')
    }

    const requiredTables = ['app_state', 'books', 'chapters']
    const rows = candidate
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('app_state', 'books', 'chapters')
      `)
      .all()
    const names = new Set(rows.map((row) => row.name))
    for (const table of requiredTables) {
      if (!names.has(table)) {
        throw new Error(`Missing required table: ${table}.`)
      }
    }
  } finally {
    candidate.close()
  }
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  )
}

function normalizeConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function normalizeEntityType(type) {
  const allowed = new Set(['character', 'sect', 'item', 'skill', 'location', 'beast', 'event', 'other'])
  return allowed.has(type) ? type : 'other'
}

function normalizeRelationType(type) {
  const allowed = new Set([
    'knows',
    'ally_of',
    'enemy_of',
    'master_of',
    'disciple_of',
    'member_of',
    'belongs_to',
    'owns',
    'uses',
    'learns',
    'created_by',
    'located_in',
    'appears_with',
    'transforms_into',
    'related_to',
  ])
  return allowed.has(type) ? type : 'related_to'
}

function firstEvidence(evidence) {
  if (Array.isArray(evidence)) return uniqueStrings(evidence).slice(0, 3).join('\n')
  return typeof evidence === 'string' ? evidence.trim() : ''
}

function l2Normalize(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return vector
  const sum = vector.reduce((acc, value) => acc + value * value, 0)
  const norm = Math.sqrt(sum)
  if (norm === 0) return vector
  return vector.map((value) => value / norm)
}

function dotProduct(a, b) {
  let result = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    result += a[i] * b[i]
  }
  return result
}

function cosineSimilarity(a, b) {
  return dotProduct(a, b)
}

function rrfScore(rankVector, rankEntity, k = 60) {
  const scoreVector = rankVector > 0 ? 1 / (k + rankVector) : 0
  const scoreEntity = rankEntity > 0 ? 1 / (k + rankEntity) : 0
  return scoreVector + scoreEntity
}

function isTemporalAppearanceQuery(query) {
  return /(?:什么时候|何时|首次|第一次|最早|哪一?章|第几章|出现在?第?几?章)/.test(query)
}

function buildSummaryText(summary) {
  const parts = []
  if (summary?.short) parts.push(summary.short)
  if (summary?.detail) parts.push(summary.detail)
  const keyPoints = safeJsonParse(summary?.keyPointsJson, [])
  if (Array.isArray(keyPoints) && keyPoints.length > 0) {
    parts.push(...keyPoints)
  }
  return parts.join(' ').trim()
}

const EMBEDDING_BATCH_SIZE_OLLAMA = 5
const EMBEDDING_BATCH_SIZE_OPENAI = 50
const EMBEDDING_REQUEST_TIMEOUT_MS = 300000

async function callOllamaEmbedding(text, config) {
  const baseUrl = (config?.baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '')
  const model = (config?.model || '').trim()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    if (!Array.isArray(data?.embedding)) {
      throw new Error('Ollama embedding response missing embedding array.')
    }
    return data.embedding
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

async function callOpenAIEmbedding(text, config) {
  const baseUrl = (config?.baseUrl || '').trim().replace(/\/+$/, '')
  const model = (config?.model || '').trim()
  const apiKey = config?.apiKey || ''
  if (!baseUrl || !model) {
    throw new Error('OpenAI-compatible embedding requires baseUrl and model.')
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text, encoding_format: 'float' }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const embedding = data?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      throw new Error('OpenAI embedding response missing embedding array.')
    }
    return embedding
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

async function generateEmbedding(text, config) {
  const provider = config?.provider
  if (provider === 'openai') {
    return callOpenAIEmbedding(text, config)
  }
  return callOllamaEmbedding(text, config)
}

const LLM_CHAT_TIMEOUT_MS = 300000
const COREFERENCE_CHAT_TIMEOUT_MS = 600000

async function callOllamaChat(messages, config) {
  const baseUrl = (config?.baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '')
  const model = (config?.model || '').trim()
  if (!model) {
    throw new Error('Missing Ollama model for coreference.')
  }

  const controller = new AbortController()
  const timeoutMs = config?.timeout || LLM_CHAT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: 'json',
        options: {
          temperature: typeof config?.temperature === 'number' ? config.temperature : 0.2,
        },
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.message?.content ?? ''
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

async function callOpenAIChat(messages, config) {
  const baseUrl = (config?.baseUrl || '').trim().replace(/\/+$/, '')
  const model = (config?.model || '').trim()
  const apiKey = config?.apiKey || ''
  if (!baseUrl || !model) {
    throw new Error('OpenAI-compatible chat requires baseUrl and model.')
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const controller = new AbortController()
  const timeoutMs = config?.timeout || LLM_CHAT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body = {
      model,
      messages,
      temperature: typeof config?.temperature === 'number' ? config.temperature : 0,
    }
    if (config?.thinkingEnabled === false) {
      body.extra_body = { enable_thinking: false }
    }
    if (config?.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`OpenAI chat failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content ?? ''
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

async function generateChatCompletion(messages, config) {
  const provider = config?.provider
  if (provider === 'openai') {
    return callOpenAIChat(messages, config)
  }
  return callOllamaChat(messages, config)
}

const COREFERENCE_ALIAS_FREQ_THRESHOLD = 2
const COREFERENCE_ORG_LOOKBACK_CHAPTERS = 120
const COREFERENCE_MAX_LLM_COMPONENT_SIZE = 50

const COREFERENCE_GENERIC_NAMES = new Set(
  [
    '老者', '少年', '女子', '男子', '少女', '青年', '中年人', '大汉', '道士', '和尚', '修士', '前辈',
    '道友', '师兄', '师姐', '师弟', '师妹', '师祖', '师傅', '师父', '弟子', '长老', '门主', '家主',
    '主人', '丫头', '姑娘', '公子', '小姐', '夫人', '妇人', '道姑', '儒生', '尼姑', '妖兽', '凡人',
    '陌生人', '某人', '此人', '那人', '一人', '之人', '女修', '男修', '男女', '黑袍人', '白袍人',
    '灰袍人', '青袍人', '黄袍人', '红袍人', '蓝袍人', '紫袍人', '绿袍人', '金袍人', '银袍人', '黑衣人',
    '白衣人', '灰衣人', '青衣人', '黄衣人', '红衣人', '蓝衣人', '紫衣人', '绿衣人', '金衣人', '银衣人',
    '结丹修士', '元婴修士', '元婴期修士', '元婴期前辈', '元婴期高人', '元婴女修', '合体老怪', '老怪',
    '老魔', '老祖', '祖师', '师叔', '师伯', '师侄', '徒弟', '徒孙', '中年人', '中年男子', '中年女子',
    '中年修士', '中年大汉', '青年男子', '青年修士', '年轻女子', '年轻男子', '白衣女子', '白衣少女',
    '黑袍少女', '白袍少女', '黄衫女子', '黄衫女修', '黄衣女子', '红衣女子', '蓝衣女子', '紫衣女子',
    '绿衣女子', '灰衣女子', '为首老者', '中年道士', '清秀青年', '貌美少妇', '妩媚少妇', '娇媚女子',
    '俊美青年', '儒衫老者', '儒装老者', '白发老者', '银发老者', '枯瘦老者', '灰袍老者', '青袍老者',
    '白袍老者', '黑袍老者', '红袍老者', '蓝袍老者', '紫袍老者', '绿袍老者', '金袍老者', '黄袍老者',
  ].map(normalizeName),
)

function buildCoreferenceAliasComponents(bookId) {
  const entities = listKgCharacterEntitiesForCoreferenceStatement.all(bookId)
  const keysByEntity = new Map()
  const keyFrequency = new Map()

  for (const entity of entities) {
    const keys = uniqueStrings([entity.name, ...safeJsonParse(entity.aliasesJson, [])])
      .map(normalizeName)
      .filter((key) => key.length >= 2 && !COREFERENCE_GENERIC_NAMES.has(key))
    keysByEntity.set(entity.id, new Set(keys))
    for (const key of keys) {
      keyFrequency.set(key, (keyFrequency.get(key) || 0) + 1)
    }
  }

  const parent = new Map()
  function find(id) {
    if (parent.get(id) === id) return id
    const root = find(parent.get(id))
    parent.set(id, root)
    return root
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const entity of entities) parent.set(entity.id, entity.id)

  for (let i = 0; i < entities.length; i++) {
    const keysA = keysByEntity.get(entities[i].id)
    if (!keysA || keysA.size === 0) continue
    for (let j = i + 1; j < entities.length; j++) {
      const keysB = keysByEntity.get(entities[j].id)
      if (!keysB || keysB.size === 0) continue
      let shared = false
      for (const key of keysA) {
        if (keysB.has(key) && keyFrequency.get(key) <= COREFERENCE_ALIAS_FREQ_THRESHOLD) {
          shared = true
          break
        }
      }
      if (shared) union(entities[i].id, entities[j].id)
    }
  }

  const groups = new Map()
  for (const entity of entities) {
    const root = find(entity.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(entity)
  }

  return Array.from(groups.values()).filter((group) => group.length > 1)
}

function chooseCanonicalCandidate(component) {
  const entityByName = new Map(component.map((entity) => [normalizeName(entity.name), entity]))
  const inDegree = new Map(component.map((entity) => [entity.id, 0]))

  for (const entity of component) {
    const aliases = uniqueStrings(safeJsonParse(entity.aliasesJson, [])).map(normalizeName)
    for (const alias of aliases) {
      const target = entityByName.get(alias)
      if (target && target.id !== entity.id) {
        inDegree.set(target.id, (inDegree.get(target.id) || 0) + 1)
      }
    }
  }

  const sorted = [...component].sort((a, b) => {
    const diff = inDegree.get(b.id) - inDegree.get(a.id)
    if (diff !== 0) return diff
    return (b.firstChapterIndex ?? 0) - (a.firstChapterIndex ?? 0)
  })
  return sorted[0]
}

function expandComponentWithOrganizationCandidates(component, bookId) {
  const canonical = chooseCanonicalCandidate(component)
  if (!canonical) return component

  const canonicalFirst = canonical.firstChapterIndex
  if (canonicalFirst == null) return component

  const inComponent = new Set(component.map((entity) => entity.id))
  const added = new Map()

  const organizations = listKgEntityOrganizationsStatement.all(canonical.id)
  for (const org of organizations) {
    const members = listKgEntityOrganizationMembersStatement.all(org.organizationId, canonical.id)
    for (const member of members) {
      if (inComponent.has(member.id)) continue
      const first = member.firstChapterIndex
      if (
        first != null &&
        first <= canonicalFirst + 5 &&
        first >= canonicalFirst - COREFERENCE_ORG_LOOKBACK_CHAPTERS
      ) {
        added.set(member.id, member)
      }
    }
  }

  return [...component, ...added.values()]
}

function buildCoreferencePrompt(component) {
  const lines = []
  for (const entity of component) {
    const aliases = uniqueStrings(safeJsonParse(entity.aliasesJson, [])).filter(
      (alias) => !COREFERENCE_GENERIC_NAMES.has(normalizeName(alias)),
    )
    const relations = listKgEntityRelationSummariesStatement
      .all(entity.id)
      .map((row) => `${row.type} ${row.targetName}`)
      .join('、')
    const parts = [
      `- 名称：${entity.name}`,
      `  章节：第 ${entity.firstChapterIndex ?? '?'} 章 到 第 ${entity.lastChapterIndex ?? '?'} 章`,
    ]
    if (aliases.length > 0) parts.push(`  别名：${aliases.join('、')}`)
    if (entity.description) parts.push(`  描述：${entity.description}`)
    if (relations) parts.push(`  关系：${relations}`)
    lines.push(parts.join('\n'))
  }

  return `你是长篇小说人物实体消歧专家。下面是一组从小说知识图谱中抽取的“人物”实体，它们可能因为使用了化名、代号、头衔或外形描述而被拆成了多个节点。
请根据实体名、别名、出现章节、描述和相关关系，判断哪些节点指向同一个人。
注意：
1. 如果多个节点是同一个人的不同阶段/化名/伪装，请合并为一组。
2. 如果一个节点明显是另一个人（即使名字相似或同门派），请单独成组。
3. 选择 canonical_name 为该组最正式/真实的姓名（通常是后期揭示的真名）。
4. 只输出 JSON，不要解释。

输出格式：
{
  "clusters": [
    {
      "canonical_name": "南宫婉",
      "members": ["精灵少女", "南宫师祖", "南宫婉", "南宫屏"],
      "confidence": 0.95,
      "reason": "同属掩月宗，精灵少女/南宫师祖是功法导致的年幼形态，南宫屏是后期化名"
    }
  ]
}

实体列表：
${lines.join('\n\n')}`
}

async function resolveCoreferenceComponent(component, config) {
  if (component.length < 2) return { clusters: [] }
  const prompt = buildCoreferencePrompt(component)
  const messages = [
    {
      role: 'system',
      content:
        '你是长篇小说阅读助手，擅长人物身份识别。请严格按要求的 JSON 格式输出，不要添加 Markdown 代码块标记。',
    },
    { role: 'user', content: `/no_think\n${prompt}` },
  ]
  const text = await generateChatCompletion(messages, { ...config, timeout: COREFERENCE_CHAT_TIMEOUT_MS })
  const parsed = parseJsonObject(text)
  const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : []
  return { clusters, raw: text }
}

function mergeKgEntityInto(bookId, targetId, sourceId) {
  const target = getKgEntityStatement.get(targetId)
  const source = getKgEntityStatement.get(sourceId)
  if (!target || !source) return

  // Move mentions to the canonical entity.
  bulkUpdateKgEntityMentionsEntityStatement.run(targetId, sourceId)

  // Move or merge relations.
  const relations = listKgRelationsForMergeStatement.all(sourceId, sourceId)
  for (const relation of relations) {
    const newSourceId = relation.sourceEntityId === sourceId ? targetId : relation.sourceEntityId
    const newTargetId = relation.targetEntityId === sourceId ? targetId : relation.targetEntityId

    if (newSourceId === newTargetId) {
      deleteKgRelationMentionsByRelationStatement.run(relation.id)
      deleteKgRelationStatement.run(relation.id)
      continue
    }

    const conflict = findKgRelationByEndpointsStatement.get(bookId, newSourceId, newTargetId, relation.type)
    if (conflict) {
      mergeKgRelationIntoStatement.run(relation.description, relation.confidence, conflict.id)
      updateKgRelationMentionsRelationIdStatement.run(conflict.id, relation.id)
      deleteKgRelationStatement.run(relation.id)
    } else {
      updateKgRelationEndpointStatement.run(newSourceId, newTargetId, relation.id)
    }
  }

  // Merge aliases and chapter range.
  const targetAliases = safeJsonParse(target.aliasesJson, [])
  const sourceAliases = safeJsonParse(source.aliasesJson, [])
  const mergedAliases = uniqueStrings([...targetAliases, ...sourceAliases, source.name])
  const mergedDescription = [target.description, source.description]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
  updateKgEntityStatement.run(
    JSON.stringify(mergedAliases),
    mergedDescription,
    source.confidence,
    source.firstChapterIndex,
    source.firstChapterIndex,
    source.lastChapterIndex,
    source.lastChapterIndex,
    targetId,
  )

  deleteKgEntityStatement.run(sourceId)
}

function applyCoreferenceClusters(bookId, component, clusters) {
  const entityByName = new Map(component.map((entity) => [normalizeName(entity.name), entity]))
  let merged = 0

  for (const cluster of clusters) {
    const memberNames = Array.isArray(cluster?.members) ? cluster.members : []
    const canonicalName = typeof cluster?.canonical_name === 'string' ? cluster.canonical_name : ''
    const canonical =
      entityByName.get(normalizeName(canonicalName)) ||
      memberNames
        .map((name) => entityByName.get(normalizeName(name)))
        .find(Boolean)
    if (!canonical) continue

    const validMembers = memberNames
      .map((name) => entityByName.get(normalizeName(name)))
      .filter(Boolean)
      .filter((entity) => entity.id !== canonical.id)

    for (const member of validMembers) {
      mergeKgEntityInto(bookId, canonical.id, member.id)
      merged++
    }
  }

  return merged
}

async function runKgCoreferenceJob(bookId, jobId, config, components, totalComponents) {
  const total = totalComponents ?? components.length
  updateKgScanJobProgressStatement.run(total, 0, 0, null, 'running', jobId)

  let completed = 0
  let failed = 0
  let totalMerged = 0
  const concurrency = Math.max(1, Math.min(5, Number(config?.concurrency) || 1))

  async function processComponent(component, index) {
    if (component.length < 2) {
      completed++
      updateKgScanJobProgressStatement.run(total, completed, failed, null, 'running', jobId)
      return
    }

    const expanded = expandComponentWithOrganizationCandidates(component, bookId)
    const limited =
      expanded.length > COREFERENCE_MAX_LLM_COMPONENT_SIZE
        ? expanded.slice(0, COREFERENCE_MAX_LLM_COMPONENT_SIZE)
        : expanded

    console.log(`[coreference ${jobId}] component ${index + 1}/${components.length}: ${limited.length} entities`)

    try {
      const { clusters } = await resolveCoreferenceComponent(limited, config)
      let merged = 0

      db.exec('BEGIN')
      try {
        merged = applyCoreferenceClusters(bookId, limited, clusters)
        totalMerged += merged
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }

      completed++
      console.log(`[coreference ${jobId}] component ${index + 1} done, merged ${merged} entities`)
    } catch (error) {
      failed++
      console.error(`[coreference ${jobId}] component ${index + 1} failed:`, error?.message || error)
    }

    updateKgScanJobProgressStatement.run(total, completed, failed, null, 'running', jobId)
  }

  // Use a shared atomic index to dispatch components to workers.
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const index = nextIndex++
      if (index >= components.length) break
      await processComponent(components[index], index)
    }
  }

  try {
    const workers = Array.from({ length: concurrency }, () => runWorker())
    await Promise.all(workers)

    if (failed > 0 && completed === 0) {
      updateKgScanJobProgressStatement.run(total, completed, failed, `全部 ${failed} 组失败`, 'failed', jobId)
    } else if (failed > 0) {
      updateKgScanJobProgressStatement.run(
        total,
        completed,
        failed,
        `完成 ${completed} 组，失败 ${failed} 组`,
        'completed',
        jobId,
      )
    } else {
      updateKgScanJobProgressStatement.run(total, completed, 0, null, 'completed', jobId)
    }
  } catch (error) {
    updateKgScanJobProgressStatement.run(
      total,
      completed,
      failed,
      String(error?.message || 'Job failed.'),
      'failed',
      jobId,
    )
    throw error
  }

  return { totalMerged, componentsProcessed: completed, componentsFailed: failed }
}

function linkEntitiesFromQuery(query, entities) {
  if (!query || !Array.isArray(entities) || entities.length === 0) return []

  const normalizedQuery = normalizeName(query)
  const matches = []

  // Sort by name length descending so longer names are matched first.
  const candidates = entities
    .flatMap((entity) => {
      const names = [entity.name]
      const aliases = safeJsonParse(entity.aliasesJson, [])
      if (Array.isArray(aliases)) {
        names.push(...aliases)
      }
      return names
        .filter(Boolean)
        .map((name) => ({ entity, name, normalized: normalizeName(name) }))
    })
    .filter((candidate) => candidate.normalized.length >= 2)
    .sort((a, b) => b.normalized.length - a.normalized.length)

  const matchedEntityIds = new Set()
  for (const candidate of candidates) {
    if (matchedEntityIds.has(candidate.entity.id)) continue
    if (normalizedQuery.includes(candidate.normalized)) {
      matches.push(candidate.entity)
      matchedEntityIds.add(candidate.entity.id)
    }
  }

  return matches
}

async function searchRag(bookId, query, topK, includeSnippets, embeddingConfig) {
  if (!bookId || typeof bookId !== 'string') {
    throw new Error('Missing bookId.')
  }
  if (!query || typeof query !== 'string') {
    throw new Error('Missing query.')
  }

  const safeTopK = Math.max(1, Math.min(50, Number(topK) || 10))
  const model = (embeddingConfig?.model || '').trim()
  if (!model) {
    throw new Error('Missing embedding model.')
  }

  const totalChapters = countChaptersForBookStatement.get(bookId)?.count ?? 0
  if (totalChapters === 0) {
    throw new Error('Book has no chapters.')
  }

  const embeddedCount = countEmbeddingsForBookStatement.get(bookId, model)?.count ?? 0
  if (embeddedCount / totalChapters < 0.8) {
    const error = new Error(`Embeddings not ready: ${embeddedCount}/${totalChapters} chapters embedded.`)
    error.code = 'EMBEDDINGS_NOT_READY'
    error.embeddedCount = embeddedCount
    error.totalChapters = totalChapters
    throw error
  }

  // Generate query embedding.
  const queryEmbeddingRaw = await generateEmbedding(query, embeddingConfig)
  const queryEmbedding = l2Normalize(queryEmbeddingRaw)

  // Entity linking.
  const allEntities = listEntitiesForBookStatement.all(bookId)
  const matchedEntities = linkEntitiesFromQuery(query, allEntities)

  // Entity recall: map chapterId -> set of matched entity ids.
  const entityRecalledChapterIds = new Map()
  for (const entity of matchedEntities) {
    const mentions = listEntityMentionsForEntityStatement.all(entity.id)
    for (const mention of mentions) {
      const set = entityRecalledChapterIds.get(mention.chapterId) || new Set()
      set.add(entity.id)
      entityRecalledChapterIds.set(mention.chapterId, set)
    }
  }

  // Vector recall.
  const embeddingRows = listEmbeddingsForBookStatement.all(bookId, model)
  const vectorRanked = embeddingRows
    .map((row) => {
      const embedding = l2Normalize(safeJsonParse(row.embeddingJson, []))
      const similarity = cosineSimilarity(queryEmbedding, embedding)
      return { chapterId: row.chapterId, similarity, chapterIndex: row.chapterIndex, chapterTitle: row.chapterTitle }
    })
    .filter((item) => Number.isFinite(item.similarity))
    .sort((a, b) => b.similarity - a.similarity)

  // Build fused ranking.
  const vectorRankByChapterId = new Map()
  vectorRanked.forEach((item, index) => {
    vectorRankByChapterId.set(item.chapterId, index + 1)
  })

  const entityRankByChapterId = new Map()
  const entityRecalledList = Array.from(entityRecalledChapterIds.entries())
    .map(([chapterId, entityIds]) => ({ chapterId, entityCount: entityIds.size }))
    .sort((a, b) => b.entityCount - a.entityCount)
  entityRecalledList.forEach((item, index) => {
    entityRankByChapterId.set(item.chapterId, index + 1)
  })

  const candidateChapterIds = new Set([
    ...vectorRanked.map((item) => item.chapterId),
    ...entityRecalledList.map((item) => item.chapterId),
  ])

  const fused = Array.from(candidateChapterIds)
    .map((chapterId) => {
      const vectorItem = vectorRanked.find((item) => item.chapterId === chapterId)
      const similarity = vectorItem?.similarity ?? 0
      const vectorRank = vectorRankByChapterId.get(chapterId) || 0
      const entityRank = entityRankByChapterId.get(chapterId) || 0
      const entityCount = entityRecalledChapterIds.get(chapterId)?.size ?? 0
      const matchType = vectorRank > 0 && entityRank > 0 ? 'both' : vectorRank > 0 ? 'vector' : 'entity'
      return {
        chapterId,
        chapterIndex: vectorItem?.chapterIndex ?? 0,
        chapterTitle: vectorItem?.chapterTitle ?? '',
        similarity,
        matchType,
        entityCount,
        score: rrfScore(vectorRank, entityRank),
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, safeTopK)

  // Enrich results with summary, matched entities, and optional snippet.
  const results = []
  for (const item of fused) {
    const summary = getSummaryForChapterStatement.get(item.chapterId)
    if (!summary) continue

    const matchedEntityNames = []
    for (const entity of matchedEntities) {
      const mentions = listEntityMentionsForEntityStatement.all(entity.id)
      if (mentions.some((mention) => mention.chapterId === item.chapterId)) {
        matchedEntityNames.push(entity.name)
      }
    }

    let contentSnippet = null
    if (includeSnippets) {
      const snippetRow = getChapterContentSnippetStatement.get(item.chapterId)
      contentSnippet = snippetRow?.snippet || null
    }

    results.push({
      chapterId: item.chapterId,
      chapterIndex: item.chapterIndex,
      chapterTitle: item.chapterTitle,
      summary: {
        short: summary.short,
        detail: summary.detail,
        keyPoints: safeJsonParse(summary.keyPointsJson, []),
      },
      similarity: item.similarity,
      matchType: item.matchType,
      matchedEntities: matchedEntityNames,
      contentSnippet,
    })
  }

  // For appearance/time queries, make sure the earliest mention of each matched entity is included,
  // even if vector ranking pushed it out of the top-K (e.g. a character first appeared under a code name).
  if (isTemporalAppearanceQuery(query) && matchedEntities.length > 0) {
    const includedChapterIds = new Set(results.map((result) => result.chapterId))
    const earliestHits = []

    for (const entity of matchedEntities) {
      const mentions = listEntityMentionsForEntityStatement.all(entity.id)
      const earliest = mentions.reduce(
        (min, mention) =>
          !min || mention.chapterIndex < min.chapterIndex ? mention : min,
        null,
      )
      if (!earliest || includedChapterIds.has(earliest.chapterId)) continue

      const chapter = getChapterStatement.get(earliest.chapterId)
      const summary = getSummaryForChapterStatement.get(earliest.chapterId)
      if (!summary) continue

      let contentSnippet = null
      if (includeSnippets) {
        const snippetRow = getChapterContentSnippetStatement.get(earliest.chapterId)
        contentSnippet = snippetRow?.snippet || null
      }

      earliestHits.push({
        chapterId: earliest.chapterId,
        chapterIndex: earliest.chapterIndex,
        chapterTitle: chapter?.title || '',
        summary: {
          short: summary.short,
          detail: summary.detail,
          keyPoints: safeJsonParse(summary.keyPointsJson, []),
        },
        similarity: 0,
        matchType: 'entity-first',
        matchedEntities: [entity.name],
        contentSnippet,
      })
      includedChapterIds.add(earliest.chapterId)
    }

    earliestHits.sort((a, b) => a.chapterIndex - b.chapterIndex)
    results.push(...earliestHits.slice(0, 3))
  }

  if (isTemporalAppearanceQuery(query)) {
    results.sort((a, b) => a.chapterIndex - b.chapterIndex)
  }

  return {
    results,
    entityMatches: matchedEntities.map((entity) => ({
      entityId: entity.id,
      entityName: entity.name,
      entityType: entity.type,
      firstChapterIndex: entity.firstChapterIndex,
      lastChapterIndex: entity.lastChapterIndex,
      aliases: safeJsonParse(entity.aliasesJson, []),
    })),
  }
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.6
const REVIEW_ALIAS_MAX_LENGTH = 30

function computeEntityReviewReasons(entity) {
  const reasons = []
  const confidence = normalizeConfidence(entity?.confidence)
  if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    reasons.push('confidence_low')
  }
  if (entity?.type === 'other') {
    reasons.push('type_unclear')
  }
  const normalizedName = normalizeName(entity?.name)
  if (normalizedName.length <= 1) {
    reasons.push('name_too_short')
  }
  const description = typeof entity?.description === 'string' ? entity.description.trim() : ''
  if (!description) {
    reasons.push('description_missing')
  }
  const aliases = uniqueStrings(Array.isArray(entity?.aliases) ? entity.aliases : [])
  for (const alias of aliases) {
    const normalizedAlias = normalizeName(alias)
    if (
      normalizedAlias === normalizedName ||
      normalizedAlias.length > REVIEW_ALIAS_MAX_LENGTH ||
      /\d|[\p{P}\p{S}]/u.test(alias)
    ) {
      reasons.push('alias_suspicious')
      break
    }
  }
  return reasons
}

function computeRelationReviewReasons(relation) {
  const reasons = []
  const confidence = normalizeConfidence(relation?.confidence)
  if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    reasons.push('confidence_low')
  }
  if (relation?.type === 'related_to') {
    reasons.push('type_unclear')
  }
  const description = typeof relation?.description === 'string' ? relation.description.trim() : ''
  if (!description) {
    reasons.push('description_missing')
  }
  if (relation?.source_entity_id && relation?.source_entity_id === relation?.target_entity_id) {
    reasons.push('self_loop')
  }
  return reasons
}

function mapEntityRow(row) {
  return {
    ...row,
    aliases: safeJsonParse(row.aliasesJson, []),
    aliasesJson: undefined,
  }
}

function mapReviewEntity(row) {
  const entity = mapEntityRow(row)
  return {
    ...entity,
    reasons: computeEntityReviewReasons(entity),
  }
}

function mapReviewRelation(row) {
  return {
    ...row,
    reasons: computeRelationReviewReasons(row),
  }
}

function getKgReviewQueue(bookId, kind, limit) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200))
  const entities =
    kind === 'relations'
      ? []
      : listKgReviewEntitiesStatement.all(bookId, safeLimit).map(mapReviewEntity)
  const relations =
    kind === 'entities'
      ? []
      : listKgReviewRelationsStatement.all(bookId, safeLimit).map(mapReviewRelation)

  return {
    entities: entities.filter((entity) => entity.reasons.length > 0),
    relations: relations.filter((relation) => relation.reasons.length > 0),
  }
}

function getKgEntityNeighborhood(entityId, options = {}) {
  const center = getKgNeighborhoodEntityStatement.get(entityId)
  if (!center) return null

  const relationType = typeof options.relationType === 'string' ? options.relationType : ''
  const entityType = typeof options.entityType === 'string' ? options.entityType : ''
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit) || 100))
  const relations = listKgNeighborhoodRelationsStatement
    .all(entityId, entityId, safeLimit)
    .filter((relation) => !relationType || relation.type === relationType)

  const entityIds = new Set([entityId])
  for (const relation of relations) {
    entityIds.add(relation.sourceId)
    entityIds.add(relation.targetId)
  }

  const entitiesById = new Map()
  for (const id of entityIds) {
    const row = getKgNeighborhoodEntityStatement.get(id)
    if (row) entitiesById.set(id, mapEntityRow(row))
  }

  const visibleEntityIds = new Set([entityId])
  for (const [id, entity] of entitiesById) {
    if (id === entityId || !entityType || entity.type === entityType) {
      visibleEntityIds.add(id)
    }
  }

  return {
    centerId: entityId,
    entities: Array.from(visibleEntityIds)
      .map((id) => entitiesById.get(id))
      .filter(Boolean),
    relations: relations.filter(
      (relation) => visibleEntityIds.has(relation.sourceId) && visibleEntityIds.has(relation.targetId),
    ),
  }
}

function getKgBookGraph(bookId, options = {}) {
  const relationType = typeof options.relationType === 'string' ? options.relationType : ''
  const entityType = typeof options.entityType === 'string' ? options.entityType : ''
  const safeLimit = Math.max(1, Math.min(300, Number(options.limit) || 150))
  const relations = listKgGraphRelationsStatement.all(
    bookId,
    relationType,
    relationType,
    entityType,
    entityType,
    entityType,
    safeLimit,
  )
  const entityIds = new Set()

  for (const relation of relations) {
    entityIds.add(relation.sourceId)
    entityIds.add(relation.targetId)
  }

  return {
    entities: Array.from(entityIds)
      .map((id) => getKgNeighborhoodEntityStatement.get(id))
      .filter(Boolean)
      .map(mapEntityRow),
    relations,
  }
}

function searchKgEvidence(bookId, options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const normalizedQuery = normalizeName(query)
  const likeQuery = `%${query}%`
  const normalizedLikeQuery = `%${normalizedQuery}%`
  const kind = typeof options.kind === 'string' ? options.kind : 'all'
  const entityType = typeof options.entityType === 'string' ? options.entityType : ''
  const relationType = typeof options.relationType === 'string' ? options.relationType : ''
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit) || 80))

  const entities =
    kind === 'relations'
      ? []
      : searchKgEntityEvidenceStatement.all(
          bookId,
          entityType,
          entityType,
          query,
          likeQuery,
          normalizedLikeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          safeLimit,
        )
  const relations =
    kind === 'entities'
      ? []
      : searchKgRelationEvidenceStatement.all(
          bookId,
          relationType,
          relationType,
          query,
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          safeLimit,
        )

  return { entities, relations }
}

function getKgExportPayload(bookId) {
  const book = getBookStatement.get(bookId)
  if (!book) return null

  const entities = listKgExportEntitiesStatement.all(bookId).map(mapEntityRow)
  const entityMentions = listKgExportEntityMentionsStatement.all(bookId)
  const relations = listKgExportRelationsStatement.all(bookId)
  const relationMentions = listKgExportRelationMentionsStatement.all(bookId)

  const entityMentionsById = new Map()
  for (const mention of entityMentions) {
    const mentions = entityMentionsById.get(mention.entityId) ?? []
    mentions.push({
      id: mention.id,
      chapterId: mention.chapterId,
      chapterIndex: mention.chapterIndex,
      chapterTitle: mention.chapterTitle,
      evidence: mention.evidence,
      confidence: mention.confidence,
    })
    entityMentionsById.set(mention.entityId, mentions)
  }

  const relationMentionsById = new Map()
  for (const mention of relationMentions) {
    const mentions = relationMentionsById.get(mention.relationId) ?? []
    mentions.push({
      id: mention.id,
      chapterId: mention.chapterId,
      chapterIndex: mention.chapterIndex,
      chapterTitle: mention.chapterTitle,
      evidence: mention.evidence,
      confidence: mention.confidence,
    })
    relationMentionsById.set(mention.relationId, mentions)
  }

  return {
    book,
    exportedAt: new Date().toISOString(),
    schema: 'novel-reader-knowledge-graph-v1',
    entities: entities.map((entity) => ({
      ...entity,
      mentions: entityMentionsById.get(entity.id) ?? [],
    })),
    relations: relations.map((relation) => ({
      ...relation,
      mentions: relationMentionsById.get(relation.id) ?? [],
    })),
  }
}

function graphMlData(key, value, indent = '      ') {
  if (value == null || value === '') return ''
  return `${indent}<data key="${key}">${escapeXml(value)}</data>\n`
}

function kgExportToGraphMl(payload) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="all" attr.name="label" attr.type="string"/>',
    '  <key id="type" for="all" attr.name="type" attr.type="string"/>',
    '  <key id="description" for="all" attr.name="description" attr.type="string"/>',
    '  <key id="confidence" for="all" attr.name="confidence" attr.type="double"/>',
    '  <key id="mentionCount" for="all" attr.name="mentionCount" attr.type="int"/>',
    '  <key id="firstChapterIndex" for="all" attr.name="firstChapterIndex" attr.type="int"/>',
    '  <key id="lastChapterIndex" for="all" attr.name="lastChapterIndex" attr.type="int"/>',
    `  <graph id="${escapeXml(payload.book.id)}" edgedefault="directed">`,
  ]

  for (const entity of payload.entities) {
    lines.push(`    <node id="${escapeXml(entity.id)}">`)
    lines.push(graphMlData('label', entity.name))
    lines.push(graphMlData('type', entity.type))
    lines.push(graphMlData('description', entity.description))
    lines.push(graphMlData('confidence', entity.confidence))
    lines.push(graphMlData('mentionCount', entity.mentionCount))
    lines.push(graphMlData('firstChapterIndex', entity.firstChapterIndex))
    lines.push(graphMlData('lastChapterIndex', entity.lastChapterIndex))
    lines.push('    </node>')
  }

  for (const relation of payload.relations) {
    lines.push(
      `    <edge id="${escapeXml(relation.id)}" source="${escapeXml(relation.sourceId)}" target="${escapeXml(relation.targetId)}">`,
    )
    lines.push(graphMlData('label', relation.type))
    lines.push(graphMlData('type', relation.type))
    lines.push(graphMlData('description', relation.description))
    lines.push(graphMlData('confidence', relation.confidence))
    lines.push(graphMlData('mentionCount', relation.mentionCount))
    lines.push(graphMlData('firstChapterIndex', relation.firstChapterIndex))
    lines.push(graphMlData('lastChapterIndex', relation.lastChapterIndex))
    lines.push('    </edge>')
  }

  lines.push('  </graph>')
  lines.push('</graphml>')
  return lines.join('\n')
}

function markKgReviewStatus(ids, kind, status) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids must be a non-empty array.')
  }
  if (!['entities', 'relations'].includes(kind)) {
    throw new Error('kind must be entities or relations.')
  }
  if (!['approved', 'ignored'].includes(status)) {
    throw new Error('status must be approved or ignored.')
  }

  const statement =
    kind === 'entities' ? markKgEntitiesReviewedStatement : markKgRelationsReviewedStatement

  for (const id of ids) {
    statement.run(status, id)
  }

  return { marked: ids.length }
}

function upsertKgEntity(bookId, chapter, entity) {
  const name = String(entity?.name ?? '').trim()
  if (!name) return null

  const type = normalizeEntityType(entity.type)
  const normalizedName = normalizeName(name)
  const aliases = uniqueStrings(Array.isArray(entity.aliases) ? entity.aliases : [])
  const description = typeof entity.description === 'string' ? entity.description.trim() : ''
  const confidence = normalizeConfidence(entity.confidence)
  const existing = findKgEntityStatement.get(bookId, type, normalizedName)

  if (!existing) {
    const id = randomUUID()
    insertKgEntityStatement.run(
      id,
      bookId,
      type,
      name,
      normalizedName,
      JSON.stringify(aliases),
      description,
      confidence,
      chapter.chapter_index,
      chapter.chapter_index,
    )
    insertKgEntityMentionStatement.run(
      randomUUID(),
      id,
      bookId,
      chapter.id,
      chapter.chapter_index,
      firstEvidence(entity.evidence),
      confidence,
    )
    return id
  }

  const mergedAliases = uniqueStrings([...safeJsonParse(existing.aliasesJson, []), ...aliases])
  updateKgEntityStatement.run(
    JSON.stringify(mergedAliases),
    description,
    confidence,
    chapter.chapter_index,
    chapter.chapter_index,
    chapter.chapter_index,
    chapter.chapter_index,
    existing.id,
  )
  insertKgEntityMentionStatement.run(
    randomUUID(),
    existing.id,
    bookId,
    chapter.id,
    chapter.chapter_index,
    firstEvidence(entity.evidence),
    confidence,
  )
  return existing.id
}

function applyChapterExtraction(bookId, chapterId, extraction, model) {
  const chapter = getChapterStatement.get(chapterId)

  if (!chapter || chapter.book_id !== bookId) {
    throw new Error('Chapter does not belong to the requested book.')
  }

  const entities = Array.isArray(extraction?.entities) ? extraction.entities : []
  const relations = Array.isArray(extraction?.relations) ? extraction.relations : []
  const entityIdByKey = new Map()
  const beforeTouchSet = getChapterGraphTouchSet(chapterId)
  const touchedEntityIds = new Set(beforeTouchSet.entityIds)
  const touchedRelationIds = new Set(beforeTouchSet.relationIds)

  deleteKgRelationMentionsForChapterStatement.run(chapterId)
  deleteKgEntityMentionsForChapterStatement.run(chapterId)
  upsertKgChapterExtractionStatement.run(
    chapterId,
    bookId,
    'completed',
    JSON.stringify(extraction),
    null,
    typeof model === 'string' ? model : null,
  )

  for (const entity of entities) {
    const entityId = upsertKgEntity(bookId, chapter, entity)
    if (!entityId) continue

    touchedEntityIds.add(entityId)
    entityIdByKey.set(`${normalizeEntityType(entity.type)}:${normalizeName(entity.name)}`, entityId)
    entityIdByKey.set(normalizeName(entity.name), entityId)

    for (const alias of uniqueStrings(Array.isArray(entity.aliases) ? entity.aliases : [])) {
      entityIdByKey.set(normalizeName(alias), entityId)
    }
  }

  for (const relation of relations) {
    const sourceName = normalizeName(relation?.source)
    const targetName = normalizeName(relation?.target)
    const sourceId = entityIdByKey.get(sourceName)
    const targetId = entityIdByKey.get(targetName)

    if (!sourceId || !targetId || sourceId === targetId) continue

    const relationType = normalizeRelationType(relation.type)
    const confidence = normalizeConfidence(relation.confidence)
    const description = typeof relation.description === 'string' ? relation.description.trim() : ''
    const existing = findKgRelationStatement.get(bookId, sourceId, targetId, relationType)
    const relationId = existing?.id ?? randomUUID()

    if (existing) {
      updateKgRelationStatement.run(
        description,
        confidence,
        chapter.chapter_index,
        chapter.chapter_index,
        chapter.chapter_index,
        chapter.chapter_index,
        relationId,
      )
    } else {
      insertKgRelationStatement.run(
        relationId,
        bookId,
        sourceId,
        targetId,
        relationType,
        description,
        confidence,
        chapter.chapter_index,
        chapter.chapter_index,
      )
    }

    touchedRelationIds.add(relationId)
    insertKgRelationMentionStatement.run(
      randomUUID(),
      relationId,
      bookId,
      chapterId,
      chapter.chapter_index,
      firstEvidence(relation.evidence),
      confidence,
    )
  }

  reconcileTouchedGraphRows(touchedEntityIds, touchedRelationIds)
}

function saveChapterExtractionTransaction(bookId, chapterId, extraction, model) {
  db.exec('BEGIN')

  try {
    applyChapterExtraction(bookId, chapterId, extraction, model)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function buildExtractionDiffItems(existingItems, nextItems) {
  const existingByKey = new Map(existingItems.map((item) => [item.key, item]))
  const nextByKey = new Map(nextItems.map((item) => [item.key, item]))
  const added = []
  const removed = []
  const unchanged = []

  for (const item of nextItems) {
    if (existingByKey.has(item.key)) {
      unchanged.push(item)
    } else {
      added.push(item)
    }
  }

  for (const item of existingItems) {
    if (!nextByKey.has(item.key)) {
      removed.push(item)
    }
  }

  return { added, removed, unchanged }
}

function getChapterExtractionDiff(bookId, chapterId, extraction) {
  const chapter = getChapterStatement.get(chapterId)
  if (!chapter || chapter.book_id !== bookId) {
    throw new Error('Chapter does not belong to the requested book.')
  }

  const entities = Array.isArray(extraction?.entities) ? extraction.entities : []
  const relations = Array.isArray(extraction?.relations) ? extraction.relations : []
  const nextEntityByName = new Map()
  const nextEntities = []

  for (const entity of entities) {
    const name = String(entity?.name ?? '').trim()
    if (!name) continue

    const type = normalizeEntityType(entity?.type)
    const item = {
      key: `${type}:${normalizeName(name)}`,
      name,
      type,
      description: typeof entity?.description === 'string' ? entity.description.trim() : '',
      evidence: firstEvidence(entity?.evidence),
      confidence: normalizeConfidence(entity?.confidence),
    }
    nextEntities.push(item)
    nextEntityByName.set(normalizeName(name), item)

    for (const alias of uniqueStrings(Array.isArray(entity?.aliases) ? entity.aliases : [])) {
      nextEntityByName.set(normalizeName(alias), item)
    }
  }

  const existingEntities = listKgChapterEntityDiffRowsStatement.all(chapterId).map((row) => ({
    key: `${normalizeEntityType(row.type)}:${normalizeName(row.name)}`,
    name: row.name,
    type: row.type,
    description: row.description ?? '',
    evidence: row.evidence ?? '',
    confidence: normalizeConfidence(row.confidence),
  }))

  const nextRelations = []
  for (const relation of relations) {
    const source = nextEntityByName.get(normalizeName(relation?.source))
    const target = nextEntityByName.get(normalizeName(relation?.target))
    if (!source || !target) continue

    const type = normalizeRelationType(relation?.type)
    nextRelations.push({
      key: `${source.key}->${target.key}:${type}`,
      sourceName: source.name,
      targetName: target.name,
      sourceType: source.type,
      targetType: target.type,
      type,
      description: typeof relation?.description === 'string' ? relation.description.trim() : '',
      evidence: firstEvidence(relation?.evidence),
      confidence: normalizeConfidence(relation?.confidence),
    })
  }

  const existingRelations = listKgChapterRelationDiffRowsStatement.all(chapterId).map((row) => ({
    key: `${normalizeEntityType(row.sourceType)}:${normalizeName(row.sourceName)}->${normalizeEntityType(row.targetType)}:${normalizeName(row.targetName)}:${normalizeRelationType(row.type)}`,
    sourceName: row.sourceName,
    targetName: row.targetName,
    sourceType: row.sourceType,
    targetType: row.targetType,
    type: row.type,
    description: row.description ?? '',
    evidence: row.evidence ?? '',
    confidence: normalizeConfidence(row.confidence),
  }))

  const entityDiff = buildExtractionDiffItems(existingEntities, nextEntities)
  const relationDiff = buildExtractionDiffItems(existingRelations, nextRelations)

  return {
    chapter: {
      id: chapter.id,
      index: chapter.chapter_index,
      title: chapter.title,
    },
    summary: {
      entitiesAdded: entityDiff.added.length,
      entitiesRemoved: entityDiff.removed.length,
      entitiesUnchanged: entityDiff.unchanged.length,
      relationsAdded: relationDiff.added.length,
      relationsRemoved: relationDiff.removed.length,
      relationsUnchanged: relationDiff.unchanged.length,
    },
    entities: entityDiff,
    relations: relationDiff,
  }
}

function replayChapterExtractionTransaction(bookId, chapterId) {
  const row = getKgChapterExtractionStatement.get(chapterId)

  if (!row || row.bookId !== bookId) {
    throw new Error('No saved extraction found for this chapter.')
  }

  if (row.status !== 'completed') {
    throw new Error('Only completed chapter extractions can be replayed.')
  }

  const extraction = safeJsonParse(row.extractionJson, null)
  if (!extraction || typeof extraction !== 'object') {
    throw new Error('Saved extraction JSON is invalid.')
  }

  db.exec('BEGIN')

  try {
    applyChapterExtraction(bookId, chapterId, extraction, row.model)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function getKgEntityWithAliases(entityId) {
  const row = getKgEntityStatement.get(entityId)
  if (!row) return null

  return {
    ...row,
    aliases: safeJsonParse(row.aliasesJson, []),
  }
}

function recomputeEntityChapterRange(entityId) {
  const result = db.prepare(`
    SELECT
      MIN(chapter_index) AS firstChapterIndex,
      MAX(chapter_index) AS lastChapterIndex
    FROM kg_entity_mentions
    WHERE entity_id = ?
  `).get(entityId)

  db.prepare(`
    UPDATE kg_entities
    SET
      first_chapter_index = ?,
      last_chapter_index = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    result?.firstChapterIndex ?? null,
    result?.lastChapterIndex ?? null,
    entityId,
  )
}

function recomputeRelationChapterRange(relationId) {
  const result = db.prepare(`
    SELECT
      MIN(chapter_index) AS firstChapterIndex,
      MAX(chapter_index) AS lastChapterIndex
    FROM kg_relation_mentions
    WHERE relation_id = ?
  `).get(relationId)

  db.prepare(`
    UPDATE kg_relations
    SET
      first_chapter_index = ?,
      last_chapter_index = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    result?.firstChapterIndex ?? null,
    result?.lastChapterIndex ?? null,
    relationId,
  )
}

function getChapterGraphTouchSet(chapterId) {
  const entityIds = new Set(
    listKgEntityIdsForChapterStatement.all(chapterId).map((row) => row.entityId),
  )
  const relationIds = new Set(
    listKgRelationIdsForChapterStatement.all(chapterId).map((row) => row.relationId),
  )

  for (const relationId of relationIds) {
    const endpoints = getKgRelationEndpointsStatement.get(relationId)
    if (endpoints?.sourceEntityId) entityIds.add(endpoints.sourceEntityId)
    if (endpoints?.targetEntityId) entityIds.add(endpoints.targetEntityId)
  }

  return { entityIds, relationIds }
}

function reconcileTouchedGraphRows(entityIds, relationIds) {
  const entitiesToCheck = new Set(entityIds)

  for (const relationId of relationIds) {
    const endpoints = getKgRelationEndpointsStatement.get(relationId)
    const mentionCount = getKgRelationMentionCountStatement.get(relationId)?.count ?? 0

    if (mentionCount === 0) {
      deleteKgRelationStatement.run(relationId)
    } else {
      recomputeRelationChapterRange(relationId)
      resetKgRelationReviewStatusStatement.run(relationId)
    }

    if (endpoints?.sourceEntityId) entitiesToCheck.add(endpoints.sourceEntityId)
    if (endpoints?.targetEntityId) entitiesToCheck.add(endpoints.targetEntityId)
  }

  for (const entityId of entitiesToCheck) {
    const mentionCount = getKgEntityMentionCountStatement.get(entityId)?.count ?? 0
    const relationCount = getKgEntityRelationCountStatement.get(entityId, entityId)?.count ?? 0

    if (mentionCount === 0 && relationCount === 0) {
      deleteKgEntityStatement.run(entityId)
      continue
    }

    recomputeEntityChapterRange(entityId)
    resetKgEntityReviewStatusStatement.run(entityId)
  }
}

function updateKgEntityTransaction(entityId, payload) {
  const entity = getKgEntityWithAliases(entityId)
  if (!entity) throw new Error('Entity not found.')

  const name = String(payload?.name ?? '').trim()
  if (!name) throw new Error('Entity name is required.')

  const type = normalizeEntityType(payload?.type)
  const normalizedName = normalizeName(name)
  const aliases = uniqueStrings(Array.isArray(payload?.aliases) ? payload.aliases : [])
  const description = typeof payload?.description === 'string' ? payload.description.trim() : entity.description

  const duplicate = findKgEntityByNormalizedStatement.get(entity.bookId, type, normalizedName)
  if (duplicate && duplicate.id !== entityId) {
    throw new Error('同书同类型下已存在相同名称的实体。')
  }

  updateKgEntityFullStatement.run(
    type,
    name,
    normalizedName,
    JSON.stringify(aliases),
    description,
    entityId,
  )

  // Editing an entity may fix the issues that flagged it for review.
  resetKgEntityReviewStatusStatement.run(entityId)

  return getKgEntityWithAliases(entityId)
}

function mergeKgEntitiesTransaction(sourceId, targetId) {
  if (sourceId === targetId) throw new Error('Cannot merge an entity into itself.')

  const source = getKgEntityWithAliases(sourceId)
  const target = getKgEntityWithAliases(targetId)

  if (!source || !target) throw new Error('Entity not found.')
  if (source.bookId !== target.bookId) throw new Error('Entities must belong to the same book.')

  const mergedAliases = uniqueStrings([
    ...target.aliases,
    ...source.aliases,
    source.name,
  ]).filter((alias) => normalizeName(alias) !== normalizeName(target.name))

  const mergedDescription = target.description || source.description || null

  // 1. Merge entity mentions
  const sourceMentions = listKgEntityMentionsForMergeStatement.all(sourceId)
  for (const mention of sourceMentions) {
    const existing = getKgEntityMentionByChapterStatement.get(targetId, mention.chapterId)
    if (existing) {
      const evidence = mention.evidence || existing.evidence
      const confidence = Math.max(mention.confidence, existing.confidence)
      updateKgEntityMentionStatement.run(evidence, confidence, existing.id)
    } else {
      insertKgEntityMentionStatement.run(
        randomUUID(),
        targetId,
        target.bookId,
        mention.chapterId,
        mention.chapterIndex,
        mention.evidence,
        mention.confidence,
      )
    }
  }

  // 2. Migrate relations
  const sourceRelations = listKgRelationsForMergeStatement.all(sourceId, sourceId)
  for (const relation of sourceRelations) {
    const newSourceId = relation.sourceEntityId === sourceId ? targetId : relation.sourceEntityId
    const newTargetId = relation.targetEntityId === sourceId ? targetId : relation.targetEntityId

    if (newSourceId === newTargetId) {
      deleteKgRelationStatement.run(relation.id)
      deleteKgRelationMentionsByRelationStatement.run(relation.id)
      continue
    }

    const existing = findKgRelationByEndpointsStatement.get(
      target.bookId,
      newSourceId,
      newTargetId,
      relation.type,
    )

    if (existing) {
      updateKgRelationMentionsRelationIdStatement.run(existing.id, relation.id)
      recomputeRelationChapterRange(existing.id)
      deleteKgRelationStatement.run(relation.id)
    } else {
      updateKgRelationEndpointStatement.run(newSourceId, newTargetId, relation.id)
    }
  }

  // 3. Update target aliases/description and delete source
  updateKgEntityFullStatement.run(
    target.type,
    target.name,
    normalizeName(target.name),
    JSON.stringify(mergedAliases),
    mergedDescription,
    targetId,
  )

  // Merging changes the target entity, so re-evaluate its review status.
  resetKgEntityReviewStatusStatement.run(targetId)

  deleteKgEntityStatement.run(sourceId)

  // 4. Recompute target chapter range
  recomputeEntityChapterRange(targetId)

  return {
    target: getKgEntityWithAliases(targetId),
    sourceName: source.name,
  }
}

function mergeKgEntitiesBatchTransaction(sourceIds, targetId) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new Error('至少选择一个要合并的源实体。')
  }

  if (sourceIds.includes(targetId)) {
    throw new Error('主实体不能在被合并的源实体中。')
  }

  const target = getKgEntityWithAliases(targetId)
  if (!target) throw new Error('主实体不存在。')

  const sourceNames = []

  for (const sourceId of sourceIds) {
    const result = mergeKgEntitiesTransaction(sourceId, targetId)
    sourceNames.push(result.sourceName)
  }

  return {
    target: getKgEntityWithAliases(targetId),
    mergedCount: sourceNames.length,
    sourceNames,
  }
}

function moveKgRelationEndpoint(relation, sourceId, targetId, bookId) {
  const newSourceId = relation.sourceId === sourceId ? targetId : relation.sourceId
  const newTargetId = relation.targetId === sourceId ? targetId : relation.targetId

  if (newSourceId === newTargetId) {
    deleteKgRelationStatement.run(relation.id)
    deleteKgRelationMentionsByRelationStatement.run(relation.id)
    return null
  }

  const existing = findKgRelationByEndpointsStatement.get(
    bookId,
    newSourceId,
    newTargetId,
    relation.type,
  )

  if (existing && existing.id !== relation.id) {
    mergeKgRelationIntoStatement.run(relation.description ?? '', relation.confidence, existing.id)
    updateKgRelationMentionsRelationIdStatement.run(existing.id, relation.id)
    deleteKgRelationStatement.run(relation.id)
    recomputeRelationChapterRange(existing.id)
    resetKgRelationReviewStatusStatement.run(existing.id)
    return existing.id
  }

  updateKgRelationEndpointStatement.run(newSourceId, newTargetId, relation.id)
  resetKgRelationReviewStatusStatement.run(relation.id)
  return relation.id
}

function splitKgEntityTransaction(sourceId, payload) {
  const source = getKgEntityWithAliases(sourceId)
  if (!source) throw new Error('源实体不存在。')

  const mentionIds = Array.isArray(payload?.mentionIds)
    ? uniqueStrings(payload.mentionIds)
    : []
  const relationIds = Array.isArray(payload?.relationIds)
    ? uniqueStrings(payload.relationIds)
    : []

  if (mentionIds.length === 0 && relationIds.length === 0) {
    throw new Error('至少选择一个要拆出的出现章节或关系。')
  }

  const targetEntityId = typeof payload?.targetEntityId === 'string' ? payload.targetEntityId : ''
  const movedAliases = uniqueStrings(Array.isArray(payload?.movedAliases) ? payload.movedAliases : [])

  let targetId = targetEntityId
  let target = targetId ? getKgEntityWithAliases(targetId) : null

  if (targetId) {
    if (!target) throw new Error('目标实体不存在。')
    if (target.id === sourceId) throw new Error('不能把实体拆到自身。')
    if (target.bookId !== source.bookId) throw new Error('目标实体必须属于同一本书。')
  } else {
    const name = String(payload?.name ?? '').trim()
    if (!name) throw new Error('新实体名称不能为空。')

    const type = normalizeEntityType(payload?.type)
    const normalizedName = normalizeName(name)
    const duplicate = findKgEntityByNormalizedStatement.get(source.bookId, type, normalizedName)
    if (duplicate) {
      throw new Error('同书同类型下已存在相同名称的实体。')
    }

    const aliases = uniqueStrings([
      ...(Array.isArray(payload?.aliases) ? payload.aliases : []),
      ...movedAliases,
    ]).filter((alias) => normalizeName(alias) !== normalizedName)
    const description = typeof payload?.description === 'string' ? payload.description.trim() : ''
    targetId = randomUUID()

    insertKgEntityStatement.run(
      targetId,
      source.bookId,
      type,
      name,
      normalizedName,
      JSON.stringify(aliases),
      description,
      source.confidence,
      null,
      null,
    )
    target = getKgEntityWithAliases(targetId)
  }

  if (!target) throw new Error('目标实体不存在。')

  if (targetEntityId && movedAliases.length > 0) {
    const mergedTargetAliases = uniqueStrings([
      ...target.aliases,
      ...movedAliases,
    ]).filter((alias) => normalizeName(alias) !== normalizeName(target.name))

    updateKgEntityFullStatement.run(
      target.type,
      target.name,
      normalizeName(target.name),
      JSON.stringify(mergedTargetAliases),
      target.description,
      target.id,
    )
  }

  if (movedAliases.length > 0) {
    const movedAliasNames = new Set(movedAliases.map(normalizeName))
    const remainingSourceAliases = source.aliases.filter((alias) => !movedAliasNames.has(normalizeName(alias)))
    updateKgEntityFullStatement.run(
      source.type,
      source.name,
      normalizeName(source.name),
      JSON.stringify(remainingSourceAliases),
      source.description,
      source.id,
    )
  }

  for (const mentionId of mentionIds) {
    const mention = getKgEntityMentionForSplitStatement.get(mentionId)
    if (!mention || mention.entityId !== sourceId || mention.bookId !== source.bookId) {
      throw new Error('选择的出现章节不属于源实体。')
    }

    const existing = getKgEntityMentionByChapterStatement.get(targetId, mention.chapterId)
    if (existing) {
      const evidence = mention.evidence || existing.evidence
      const confidence = Math.max(mention.confidence, existing.confidence)
      updateKgEntityMentionStatement.run(evidence, confidence, existing.id)
      deleteKgEntityMentionStatement.run(mention.id)
    } else {
      updateKgEntityMentionEntityStatement.run(targetId, mention.id)
    }
  }

  const touchedRelationIds = new Set()
  for (const relationId of relationIds) {
    const relation = getKgRelationStatement.get(relationId)
    if (!relation || relation.bookId !== source.bookId) {
      throw new Error('选择的关系不属于源实体所在书籍。')
    }
    if (relation.sourceId !== sourceId && relation.targetId !== sourceId) {
      throw new Error('选择的关系不连接源实体。')
    }

    const movedRelationId = moveKgRelationEndpoint(relation, sourceId, targetId, source.bookId)
    if (movedRelationId) touchedRelationIds.add(movedRelationId)
  }

  recomputeEntityChapterRange(sourceId)
  recomputeEntityChapterRange(targetId)
  resetKgEntityReviewStatusStatement.run(sourceId)
  resetKgEntityReviewStatusStatement.run(targetId)

  for (const relationId of touchedRelationIds) {
    recomputeRelationChapterRange(relationId)
  }

  return {
    source: getKgEntityWithAliases(sourceId),
    target: getKgEntityWithAliases(targetId),
  }
}

function deleteKgEntityTransaction(entityId) {
  const entity = getKgEntityWithAliases(entityId)
  if (!entity) throw new Error('Entity not found.')

  deleteKgEntityStatement.run(entityId)
  return { deleted: true }
}

function deleteKgRelationTransaction(relationId) {
  const relation = getKgRelationStatement.get(relationId)
  if (!relation) throw new Error('Relation not found.')

  deleteKgRelationStatement.run(relationId)
  return { deleted: true }
}

function updateKgRelationTransaction(relationId, payload) {
  const relation = getKgRelationStatement.get(relationId)
  if (!relation) throw new Error('Relation not found.')

  const type = normalizeRelationType(payload?.type)
  const description = typeof payload?.description === 'string' ? payload.description.trim() : relation.description
  const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : relation.sourceId
  const targetId = typeof payload?.targetId === 'string' ? payload.targetId : relation.targetId

  if (sourceId === targetId) {
    throw new Error('关系源实体和目标实体不能相同。')
  }

  const source = getKgEntityStatement.get(sourceId)
  const target = getKgEntityStatement.get(targetId)
  if (!source || !target) throw new Error('关系端点实体不存在。')
  if (source.bookId !== relation.bookId || target.bookId !== relation.bookId) {
    throw new Error('关系端点必须属于同一本书。')
  }

  const conflict = findKgRelationConflictStatement.get(
    relation.bookId,
    sourceId,
    targetId,
    type,
  )
  if (conflict && conflict.id !== relationId) {
    mergeKgRelationIntoStatement.run(description ?? '', relation.confidence, conflict.id)
    updateKgRelationMentionsRelationIdStatement.run(conflict.id, relationId)
    deleteKgRelationStatement.run(relationId)
    recomputeRelationChapterRange(conflict.id)

    // Editing a relation may fix the issues that flagged it for review.
    resetKgRelationReviewStatusStatement.run(conflict.id)

    return getKgRelationStatement.get(conflict.id)
  }

  updateKgRelationFullStatement.run(type, description, relationId)
  updateKgRelationEndpointStatement.run(sourceId, targetId, relationId)

  // Editing a relation may fix the issues that flagged it for review.
  resetKgRelationReviewStatusStatement.run(relationId)

  return getKgRelationStatement.get(relationId)
}

function loadSummariesForBook(bookId) {
  const rows = getSummariesForBookStatement.all(bookId)
  const summaries = {}
  for (const row of rows) {
    let keyPoints = []
    try {
      keyPoints = JSON.parse(row.keyPointsJson || '[]')
    } catch {
      keyPoints = []
    }
    summaries[row.chapterId] = {
      short: row.short,
      detail: row.detail,
      keyPoints,
      skippable: row.skippable,
      generatedBy: row.generatedBy,
    }
  }
  return summaries
}

function mirrorStructuredState(state) {
  const libraryBooks = Array.isArray(state?.books)
    ? state.books
    : state?.book
      ? [{ book: state.book, summaries: state.summaries ?? {} }]
      : []
  const nextBookIds = new Set(libraryBooks.map((entry) => entry?.book?.id).filter(Boolean))

  for (const row of listBookIdsStatement.all()) {
    if (!nextBookIds.has(row.id)) {
      deleteBookStatement.run(row.id)
    }
  }

  for (const libraryBook of libraryBooks) {
    const { book, summaries = {} } = libraryBook
    if (!book) continue

    upsertBookStatement.run(book.id, book.title, book.importedAt, book.chapters.length)

    for (const chapter of book.chapters) {
      upsertChapterStatement.run(
        chapter.id,
        book.id,
        chapter.index,
        chapter.title,
        chapter.content,
        chapter.wordCount,
      )

      const summary = summaries[chapter.id]
      if (summary) {
        upsertSummaryStatement.run(
          chapter.id,
          summary.short,
          summary.detail,
          JSON.stringify(summary.keyPoints ?? []),
          summary.skippable,
          summary.generatedBy,
        )
      }
    }
  }
}

function saveStateTransaction(state) {
  db.exec('BEGIN')

  try {
    saveStateStatement.run(stateKey, JSON.stringify(state))
    mirrorStructuredState(state)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  try {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const row = getStateStatement.get(stateKey)
      const state = row ? JSON.parse(row.value_json) : null

      // 用 summaries 表里的最新数据刷新 state 中的快照，
      // 这样离线扫描器 export 到数据库后前端刷新就能看到最新计数。
      if (state && Array.isArray(state.books)) {
        for (const libraryBook of state.books) {
          if (libraryBook?.book?.id) {
            libraryBook.summaries = loadSummariesForBook(libraryBook.book.id)
          }
        }

        const activeBook = state.books.find((entry) => entry?.book?.id === state.activeBookId)
        if (activeBook) {
          state.summaries = activeBook.summaries
        }
      }

      sendJson(response, 200, { state })
      return
    }

    if (request.method === 'PUT' && url.pathname === '/api/state') {
      const body = await readJson(request)

      if (!body || typeof body !== 'object' || !('state' in body)) {
        sendJson(response, 400, { error: 'Missing state payload.' })
        return
      }

      saveStateTransaction(body.state)
      sendJson(response, 200, { ok: true })
      return
    }

    const bookUpdateMatch = url.pathname.match(/^\/api\/books\/([^/]+)$/)
    if (request.method === 'PUT' && bookUpdateMatch) {
      const bookId = decodeURIComponent(bookUpdateMatch[1])
      const body = await readJson(request)
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (!title) {
        sendJson(response, 400, { error: 'Missing title.' })
        return
      }
      const book = getBookStatement.get(bookId)
      if (!book) {
        sendJson(response, 404, { error: 'Book not found.' })
        return
      }
      updateBookTitleStatement.run(title, bookId)

      // 同步更新持久化 state 中的书名，避免前端刷新后回退到旧标题。
      const row = getStateStatement.get(stateKey)
      if (row?.value_json) {
        try {
          const persistedState = JSON.parse(row.value_json)
          if (persistedState && Array.isArray(persistedState.books)) {
            let changed = false
            for (const libraryBook of persistedState.books) {
              if (libraryBook?.book?.id === bookId) {
                libraryBook.book.title = title
                changed = true
              }
            }
            if (persistedState.book?.id === bookId) {
              persistedState.book.title = title
              changed = true
            }
            if (changed) {
              saveStateTransaction(persistedState)
            }
          }
        } catch {
          // 忽略 state JSON 解析失败；数据库层面的书名已更新。
        }
      }

      sendJson(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/storage') {
      sendJson(response, 200, { dataDir, dbPath })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/database/export') {
      const backupPath = createDatabaseBackup()
      const file = readFileSync(backupPath)
      unlinkSync(backupPath)

      sendFile(
        response,
        200,
        file,
        'application/vnd.sqlite3',
        `novel_reader-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
      )
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/database/import') {
      const body = await readBinary(request)
      if (!body.length) {
        sendJson(response, 400, { error: 'Missing SQLite backup file.' })
        return
      }

      const uploadPath = join(dataDir, `novel_reader-upload-${Date.now()}.sqlite`)

      try {
        writeFileSync(uploadPath, body)
        validateDatabaseBackup(uploadPath)
        const backupPath = createDatabaseBackup('novel_reader-before-import')

        if (existsSync(pendingRestorePath)) unlinkSync(pendingRestorePath)
        renameSync(uploadPath, pendingRestorePath)

        sendJson(response, 200, {
          ok: true,
          backupPath,
          pendingRestorePath,
          requiresRestart: true,
        })
      } catch (error) {
        if (existsSync(uploadPath)) unlinkSync(uploadPath)
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Import failed.',
        })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/overview') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const overview = getKgOverviewStatement.get(bookId, bookId, bookId)
      sendJson(response, 200, { overview })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/chapters') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      sendJson(response, 200, {
        chapters: listKgScannedChaptersStatement.all(bookId),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/entities') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const type = url.searchParams.get('type') ?? ''
      const query = normalizeName(url.searchParams.get('q') ?? '')
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 100)))
      const rows = listKgEntitiesStatement.all(
        bookId,
        type,
        type,
        query,
        `%${query}%`,
        `%${query}%`,
        limit,
      )

      sendJson(response, 200, { entities: rows.map(mapEntityRow) })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/relations') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const type = url.searchParams.get('type') ?? ''
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit') ?? 150)))
      sendJson(response, 200, {
        relations: listKgRelationsStatement.all(bookId, type, type, limit),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/graph') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      sendJson(response, 200, getKgBookGraph(bookId, {
        entityType: url.searchParams.get('entityType') ?? '',
        relationType: url.searchParams.get('relationType') ?? '',
        limit: Number(url.searchParams.get('limit') ?? 150),
      }))
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/search') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      sendJson(response, 200, searchKgEvidence(bookId, {
        query: url.searchParams.get('q') ?? '',
        kind: url.searchParams.get('kind') ?? 'all',
        entityType: url.searchParams.get('entityType') ?? '',
        relationType: url.searchParams.get('relationType') ?? '',
        limit: Number(url.searchParams.get('limit') ?? 80),
      }))
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/export') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const payload = getKgExportPayload(bookId)
      if (!payload) {
        sendJson(response, 404, { error: 'Book not found.' })
        return
      }

      const format = url.searchParams.get('format') ?? 'json'
      const basename = safeFilename(`${payload.book.title}-knowledge-graph`)

      if (format === 'graphml') {
        sendFile(response, 200, kgExportToGraphMl(payload), 'application/graphml+xml', `${basename}.graphml`)
        return
      }

      sendFile(
        response,
        200,
        JSON.stringify(payload, null, 2),
        'application/json',
        `${basename}.json`,
      )
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/review-queue') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const kind = url.searchParams.get('kind') ?? 'all'
      const limit = Number(url.searchParams.get('limit') ?? 200)
      sendJson(response, 200, getKgReviewQueue(bookId, kind, limit))
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/review-queue/mark') {
      const body = await readJson(request)
      const ids = body?.ids
      const kind = body?.kind
      const status = body?.status

      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
        sendJson(response, 400, { error: 'ids must be a non-empty array of strings.' })
        return
      }
      if (kind !== 'entities' && kind !== 'relations') {
        sendJson(response, 400, { error: 'kind must be entities or relations.' })
        return
      }
      if (status !== 'approved' && status !== 'ignored') {
        sendJson(response, 400, { error: 'status must be approved or ignored.' })
        return
      }

      db.exec('BEGIN')
      try {
        const result = markKgReviewStatus(ids, kind, status)
        db.exec('COMMIT')
        sendJson(response, 200, result)
      } catch (error) {
        db.exec('ROLLBACK')
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Mark failed.' })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/review-queue/delete') {
      const body = await readJson(request)
      const ids = body?.ids
      const kind = body?.kind

      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
        sendJson(response, 400, { error: 'ids must be a non-empty array of strings.' })
        return
      }
      if (kind !== 'entities' && kind !== 'relations') {
        sendJson(response, 400, { error: 'kind must be entities or relations.' })
        return
      }

      db.exec('BEGIN')
      try {
        let deleted = 0
        for (const id of ids) {
          if (kind === 'entities') {
            deleteKgEntityTransaction(id)
          } else {
            deleteKgRelationTransaction(id)
          }
          deleted++
        }
        db.exec('COMMIT')
        sendJson(response, 200, { deleted })
      } catch (error) {
        db.exec('ROLLBACK')
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Delete failed.' })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/scan/jobs') {
      const body = await readJson(request)
      const bookId = body?.bookId
      const scope = body?.scope
      const totalChapters = body?.totalChapters

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (!scope || typeof scope !== 'string') {
        sendJson(response, 400, { error: 'Missing scope.' })
        return
      }
      if (typeof totalChapters !== 'number' || totalChapters < 1) {
        sendJson(response, 400, { error: 'Invalid totalChapters.' })
        return
      }

      deleteKgScanJobsForBookStatement.run(bookId)
      const id = randomUUID()
      insertKgScanJobStatement.run(id, bookId, scope, 'running', totalChapters, 0, 0, null)
      const job = getLatestKgScanJobStatement.get(bookId)
      sendJson(response, 200, { job })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/scan/status') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const job = getLatestKgScanJobStatement.get(bookId)
      sendJson(response, 200, { job: job ?? null })
      return
    }

    const scanJobUpdateMatch = url.pathname.match(/^\/api\/kg\/scan\/jobs\/([^/]+)$/)
    if (request.method === 'PUT' && scanJobUpdateMatch) {
      const jobId = decodeURIComponent(scanJobUpdateMatch[1])
      const body = await readJson(request)
      const status = body?.status
      const completedChapters = body?.completedChapters
      const failedChapters = body?.failedChapters
      const error = body?.error

      if (!status || typeof status !== 'string') {
        sendJson(response, 400, { error: 'Missing status.' })
        return
      }

      updateKgScanJobStatement.run(
        typeof completedChapters === 'number' ? completedChapters : 0,
        typeof failedChapters === 'number' ? failedChapters : 0,
        typeof error === 'string' ? error : null,
        status,
        jobId,
      )
      sendJson(response, 200, { ok: true })
      return
    }

    const entitySplitMatch = url.pathname.match(/^\/api\/kg\/entities\/([^/]+)\/split$/)
    if (request.method === 'POST' && entitySplitMatch) {
      const entityId = decodeURIComponent(entitySplitMatch[1])
      const body = await readJson(request)

      db.exec('BEGIN')
      try {
        const result = splitKgEntityTransaction(entityId, body)
        db.exec('COMMIT')
        sendJson(response, 200, {
          source: mapEntityRow(result.source),
          target: mapEntityRow(result.target),
        })
      } catch (error) {
        db.exec('ROLLBACK')
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Split failed.' })
      }
      return
    }

    const entityNeighborhoodMatch = url.pathname.match(/^\/api\/kg\/entities\/([^/]+)\/neighborhood$/)
    if (request.method === 'GET' && entityNeighborhoodMatch) {
      const entityId = decodeURIComponent(entityNeighborhoodMatch[1])
      const neighborhood = getKgEntityNeighborhood(entityId, {
        entityType: url.searchParams.get('entityType') ?? '',
        relationType: url.searchParams.get('relationType') ?? '',
        limit: Number(url.searchParams.get('limit') ?? 100),
      })

      if (!neighborhood) {
        sendJson(response, 404, { error: 'Entity not found.' })
        return
      }

      sendJson(response, 200, neighborhood)
      return
    }

    const entityMatch = url.pathname.match(/^\/api\/kg\/entities\/([^/]+)$/)
    if (entityMatch) {
      const entityId = decodeURIComponent(entityMatch[1])

      if (request.method === 'GET') {
        const entity = getKgEntityStatement.get(entityId)

        if (!entity) {
          sendJson(response, 404, { error: 'Entity not found.' })
          return
        }

        sendJson(response, 200, {
          entity: mapEntityRow(entity),
          mentions: getKgEntityMentionsStatement.all(entityId),
          relations: getKgEntityRelationsStatement.all(entityId, entityId),
        })
        return
      }

      if (request.method === 'PUT') {
        const body = await readJson(request)

        db.exec('BEGIN')
        try {
          const entity = updateKgEntityTransaction(entityId, body)
          db.exec('COMMIT')
          sendJson(response, 200, { entity: mapEntityRow(entity) })
        } catch (error) {
          db.exec('ROLLBACK')
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'Update failed.' })
        }
        return
      }

      if (request.method === 'DELETE') {
        db.exec('BEGIN')
        try {
          deleteKgEntityTransaction(entityId)
          db.exec('COMMIT')
          sendJson(response, 200, { ok: true })
        } catch (error) {
          db.exec('ROLLBACK')
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'Delete failed.' })
        }
        return
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/entities/merge') {
      const body = await readJson(request)
      const sourceId = body?.sourceId
      const targetId = body?.targetId

      if (!sourceId || typeof sourceId !== 'string' || !targetId || typeof targetId !== 'string') {
        sendJson(response, 400, { error: 'Missing sourceId or targetId.' })
        return
      }

      db.exec('BEGIN')
      try {
        const result = mergeKgEntitiesTransaction(sourceId, targetId)
        db.exec('COMMIT')
        sendJson(response, 200, {
          entity: mapEntityRow(result.target),
          sourceName: result.sourceName,
        })
      } catch (error) {
        db.exec('ROLLBACK')
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Merge failed.' })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/entities/merge-batch') {
      const body = await readJson(request)
      const sourceIds = body?.sourceIds
      const targetId = body?.targetId

      if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !sourceIds.every((id) => typeof id === 'string')) {
        sendJson(response, 400, { error: 'sourceIds must be a non-empty array of strings.' })
        return
      }

      if (!targetId || typeof targetId !== 'string') {
        sendJson(response, 400, { error: 'Missing targetId.' })
        return
      }

      db.exec('BEGIN')
      try {
        const result = mergeKgEntitiesBatchTransaction(sourceIds, targetId)
        db.exec('COMMIT')
        sendJson(response, 200, {
          entity: mapEntityRow(result.target),
          mergedCount: result.mergedCount,
          sourceNames: result.sourceNames,
        })
      } catch (error) {
        db.exec('ROLLBACK')
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Batch merge failed.' })
      }
      return
    }

    const relationMatch = url.pathname.match(/^\/api\/kg\/relations\/([^/]+)$/)
    if (relationMatch) {
      const relationId = decodeURIComponent(relationMatch[1])

      if (request.method === 'GET') {
        const relation = getKgRelationStatement.get(relationId)

        if (!relation) {
          sendJson(response, 404, { error: 'Relation not found.' })
          return
        }

        sendJson(response, 200, {
          relation,
          mentions: getKgRelationMentionsStatement.all(relationId),
        })
        return
      }

      if (request.method === 'PUT') {
        const body = await readJson(request)

        db.exec('BEGIN')
        try {
          const relation = updateKgRelationTransaction(relationId, body)
          db.exec('COMMIT')
          sendJson(response, 200, { relation })
        } catch (error) {
          db.exec('ROLLBACK')
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'Update failed.' })
        }
        return
      }

      if (request.method === 'DELETE') {
        db.exec('BEGIN')
        try {
          deleteKgRelationTransaction(relationId)
          db.exec('COMMIT')
          sendJson(response, 200, { ok: true })
        } catch (error) {
          db.exec('ROLLBACK')
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'Delete failed.' })
        }
        return
      }
    }

    const chapterExtractionDiffMatch = url.pathname.match(/^\/api\/kg\/chapters\/([^/]+)\/extraction\/diff$/)
    if (request.method === 'POST' && chapterExtractionDiffMatch) {
      const chapterId = decodeURIComponent(chapterExtractionDiffMatch[1])
      const body = await readJson(request)
      const bookId = body?.bookId
      const extraction = body?.extraction

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      if (!extraction || typeof extraction !== 'object') {
        sendJson(response, 400, { error: 'Missing extraction payload.' })
        return
      }

      try {
        sendJson(response, 200, getChapterExtractionDiff(bookId, chapterId, extraction))
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Diff failed.' })
      }
      return
    }

    const chapterExtractionMatch = url.pathname.match(/^\/api\/kg\/chapters\/([^/]+)\/extraction$/)
    if (chapterExtractionMatch) {
      const chapterId = decodeURIComponent(chapterExtractionMatch[1])

      if (request.method === 'GET') {
        const extraction = getKgChapterExtractionStatement.get(chapterId)
        sendJson(response, 200, {
          extraction: extraction
            ? {
                ...extraction,
                extraction: safeJsonParse(extraction.extractionJson, null),
                extractionJson: undefined,
              }
            : null,
        })
        return
      }

      if (request.method === 'PUT') {
        const body = await readJson(request)
        const bookId = body?.bookId
        const extraction = body?.extraction

        if (!bookId || typeof bookId !== 'string') {
          sendJson(response, 400, { error: 'Missing bookId.' })
          return
        }

        if (!extraction || typeof extraction !== 'object') {
          sendJson(response, 400, { error: 'Missing extraction payload.' })
          return
        }

        saveChapterExtractionTransaction(bookId, chapterId, extraction, body.model)
        sendJson(response, 200, { ok: true })
        return
      }
    }

    const chapterReplayMatch = url.pathname.match(/^\/api\/kg\/chapters\/([^/]+)\/replay$/)
    if (request.method === 'POST' && chapterReplayMatch) {
      const chapterId = decodeURIComponent(chapterReplayMatch[1])
      const body = await readJson(request)
      const bookId = body?.bookId

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      try {
        replayChapterExtractionTransaction(bookId, chapterId)
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Replay failed.' })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/rag/embeddings/batch') {
      const body = await readJson(request)
      const bookId = body?.bookId
      const provider = body?.provider
      const model = body?.model
      const baseUrl = body?.baseUrl
      const apiKey = body?.apiKey || ''
      const requestedChapterIds = Array.isArray(body?.chapterIds) ? body.chapterIds : null
      const force = body?.force === true

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (!model || typeof model !== 'string') {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }
      if (provider !== 'ollama' && provider !== 'openai') {
        sendJson(response, 400, { error: 'provider must be ollama or openai.' })
        return
      }

      let summaries
      if (requestedChapterIds && requestedChapterIds.length > 0) {
        summaries = requestedChapterIds
          .map((id) => getSummaryForChapterStatement.get(id))
          .filter(Boolean)
      } else {
        summaries = getSummariesForBookStatement.all(bookId)
      }

      const targetSummaries = force
        ? summaries
        : summaries.filter((summary) => {
            const existing = getEmbeddingForChapterStatement.get(summary.chapterId, model)
            return !existing
          })

      const embeddingConfig = { provider, model, baseUrl, apiKey }
      const batchSize = provider === 'ollama' ? EMBEDDING_BATCH_SIZE_OLLAMA : EMBEDDING_BATCH_SIZE_OPENAI
      let completed = 0
      let failed = 0

      for (let i = 0; i < targetSummaries.length; i += batchSize) {
        const batch = targetSummaries.slice(i, i + batchSize)
        await Promise.all(
          batch.map(async (summary) => {
            const text = buildSummaryText(summary)
            if (!text) {
              failed++
              return
            }
            try {
              const embeddingRaw = await generateEmbedding(text, embeddingConfig)
              const embedding = l2Normalize(embeddingRaw)
              upsertEmbeddingStatement.run(
                summary.chapterId,
                bookId,
                model,
                embedding.length,
                JSON.stringify(embedding),
              )
              completed++
            } catch {
              failed++
            }
          }),
        )
      }

      sendJson(response, 200, {
        completed,
        failed,
        total: targetSummaries.length,
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/rag/embeddings/validate') {
      const body = await readJson(request)
      const provider = body?.provider
      const model = body?.model
      const baseUrl = body?.baseUrl
      const apiKey = body?.apiKey || ''

      if (!model || typeof model !== 'string') {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }
      if (provider !== 'ollama' && provider !== 'openai') {
        sendJson(response, 400, { error: 'provider must be ollama or openai.' })
        return
      }

      try {
        const embeddingConfig = { provider, model, baseUrl, apiKey }
        const embeddingRaw = await generateEmbedding('测试', embeddingConfig)
        const embedding = l2Normalize(embeddingRaw)
        sendJson(response, 200, { ok: true, dimension: embedding.length })
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Embedding validation failed.',
        })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/rag/embeddings/status') {
      const bookId = url.searchParams.get('bookId')
      const model = url.searchParams.get('model') || ''

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (!model) {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }

      const totalChapters = countChaptersForBookStatement.get(bookId)?.count ?? 0
      const embeddedChapters = countEmbeddingsForBookStatement.get(bookId, model)?.count ?? 0
      const dimensionRow = getEmbeddingDimensionStatement.get(bookId, model)

      sendJson(response, 200, {
        totalChapters,
        embeddedChapters,
        missingChapters: Math.max(0, totalChapters - embeddedChapters),
        model,
        dimension: dimensionRow?.dimension ?? null,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/rag/embeddings/missing') {
      const bookId = url.searchParams.get('bookId')
      const model = url.searchParams.get('model') || ''

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (!model) {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }

      const rows = getMissingEmbeddingChapterIdsStatement.all(bookId, model)
      sendJson(response, 200, { chapterIds: rows.map((row) => row.chapterId) })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/rag/embeddings/summary-chapters') {
      const bookId = url.searchParams.get('bookId')

      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }

      const rows = getSummaryChapterIdsForBookStatement.all(bookId)
      sendJson(response, 200, { chapterIds: rows.map((row) => row.chapterId) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/rag/search') {
      const body = await readJson(request)
      const bookId = body?.bookId
      const query = body?.query
      const topK = body?.topK
      const includeSnippets = body?.includeSnippets === true
      const provider = body?.provider
      const model = body?.model
      const baseUrl = body?.baseUrl
      const apiKey = body?.apiKey || ''

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (!query || typeof query !== 'string') {
        sendJson(response, 400, { error: 'Missing query.' })
        return
      }
      if (provider !== 'ollama' && provider !== 'openai') {
        sendJson(response, 400, { error: 'provider must be ollama or openai.' })
        return
      }
      if (!model || typeof model !== 'string') {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }

      try {
        const embeddingConfig = { provider, model, baseUrl, apiKey }
        const result = await searchRag(bookId, query, topK, includeSnippets, embeddingConfig)
        sendJson(response, 200, result)
      } catch (error) {
        if (error?.code === 'EMBEDDINGS_NOT_READY') {
          sendJson(response, 409, {
            error: error.message,
            code: error.code,
            embeddedCount: error.embeddedCount,
            totalChapters: error.totalChapters,
          })
          return
        }
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Search failed.' })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/kg/coreference/components') {
      const bookId = url.searchParams.get('bookId')
      if (!bookId) {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      const components = buildCoreferenceAliasComponents(bookId)
      const payloadComponents = components.map((component) =>
        component.map((entity) => ({
          id: entity.id,
          name: entity.name,
          aliases: safeJsonParse(entity.aliasesJson, []),
          firstChapterIndex: entity.firstChapterIndex,
          lastChapterIndex: entity.lastChapterIndex,
          description: entity.description,
        }))
      )
      sendJson(response, 200, {
        totalComponents: components.length,
        components: payloadComponents,
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/kg/coreference/resolve') {
      const body = await readJson(request)
      const bookId = body?.bookId
      const provider = body?.provider
      const model = body?.model
      const baseUrl = body?.baseUrl
      const apiKey = body?.apiKey || ''
      const limit = typeof body?.limit === 'number' ? Math.max(1, body.limit) : 0
      const concurrency = typeof body?.concurrency === 'number' ? Math.max(1, Math.min(20, body.concurrency)) : 1
      const temperature = typeof body?.temperature === 'number' ? body.temperature : 0
      const jsonMode = body?.jsonMode === true
      const thinkingEnabled = body?.thinkingEnabled === false ? false : undefined

      if (!bookId || typeof bookId !== 'string') {
        sendJson(response, 400, { error: 'Missing bookId.' })
        return
      }
      if (provider !== 'ollama' && provider !== 'openai') {
        sendJson(response, 400, { error: 'provider must be ollama or openai.' })
        return
      }
      if (!model || typeof model !== 'string') {
        sendJson(response, 400, { error: 'Missing model.' })
        return
      }

      const runningJob = db.prepare(`
        SELECT id FROM kg_scan_jobs
        WHERE book_id = ? AND scope = 'coreference' AND status = 'running'
          AND updated_at > datetime('now', '-5 minutes')
        LIMIT 1
      `).get(bookId)
      if (runningJob) {
        sendJson(response, 409, { error: 'A coreference job is already running for this book.' })
        return
      }

      const allComponents = buildCoreferenceAliasComponents(bookId)
      const totalComponents = allComponents.length
      const componentsToProcess = limit > 0 ? allComponents.slice(0, limit) : allComponents

      const jobId = randomUUID()
      insertKgScanJobStatement.run(jobId, bookId, 'coreference', 'running', totalComponents, 0, 0, null)
      const llmConfig = { provider, model, baseUrl, apiKey, concurrency, temperature, jsonMode, thinkingEnabled }
      runKgCoreferenceJob(bookId, jobId, llmConfig, componentsToProcess, totalComponents).catch((error) => {
        console.error('Coreference job failed:', error)
        updateKgScanJobProgressStatement.run(
          totalComponents,
          0,
          0,
          String(error?.message || 'Job failed.'),
          'failed',
          jobId,
        )
      })
      sendJson(response, 202, {
        jobId,
        totalComponents,
        processedThisRun: componentsToProcess.length,
        hasMore: componentsToProcess.length < totalComponents,
      })
      return
    }

    sendJson(response, 404, { error: 'Not found.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Internal server error.',
    })
  }
})

function cleanupStaleKgScanJobs() {
  try {
    const result = db.exec(`
      UPDATE kg_scan_jobs
      SET status = 'failed',
          error = '任务中断（服务重启或超时）',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND updated_at < datetime('now', '-10 minutes')
    `)
    const changed = result?.[0]?.changes ?? 0
    if (changed > 0) {
      console.log(`Cleaned up ${changed} stale running kg_scan_jobs.`)
    }
  } catch (error) {
    console.error('Failed to clean up stale kg_scan_jobs:', error)
  }
}

server.listen(port, host, () => {
  cleanupStaleKgScanJobs()
  console.log(`Novel Reader API listening on http://${host}:${port}`)
  console.log(`SQLite database: ${dbPath}`)
})

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
