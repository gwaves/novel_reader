import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const host = process.env.NOVEL_READER_API_HOST || '127.0.0.1'
const port = Number(process.env.NOVEL_READER_API_PORT || 5174)
const dataDir = process.env.NOVEL_READER_DATA_DIR || join(homedir(), '.novel_reader')
const dbPath = process.env.NOVEL_READER_DB_PATH || join(dataDir, 'novel_reader.sqlite')
const stateKey = 'novel-reader-mvp-state'

mkdirSync(dirname(dbPath), { recursive: true })

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
const getChapterStatement = db.prepare(`
  SELECT id, book_id, chapter_index, title
  FROM chapters
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
const updateKgScanJobStatement = db.prepare(`
  UPDATE kg_scan_jobs
  SET completed_chapters = ?, failed_chapters = ?, error = ?, status = ?, updated_at = CURRENT_TIMESTAMP
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

  const conflict = findKgRelationConflictStatement.get(
    relation.bookId ?? relation.book_id,
    relation.sourceId,
    relation.targetId,
    type,
  )
  if (conflict && conflict.id !== relationId) {
    throw new Error('同书同类型下已存在相同端点的关系。')
  }

  updateKgRelationFullStatement.run(type, description, relationId)

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

    if (request.method === 'GET' && url.pathname === '/api/storage') {
      sendJson(response, 200, { dataDir, dbPath })
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

    sendJson(response, 404, { error: 'Not found.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Internal server error.',
    })
  }
})

server.listen(port, host, () => {
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
