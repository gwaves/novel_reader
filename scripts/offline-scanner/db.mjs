import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const OFFLINE_DB_PATH = process.env.NOVEL_READER_OFFLINE_DB
  || join(homedir(), '.novel_reader', 'offline.sqlite')

const MAIN_DB_PATH = process.env.NOVEL_READER_MAIN_DB
  || join(homedir(), '.novel_reader', 'novel_reader.sqlite')

export const mainDbPath = MAIN_DB_PATH
export const offlineDbPath = OFFLINE_DB_PATH

mkdirSync(dirname(OFFLINE_DB_PATH), { recursive: true })

const db = new DatabaseSync(OFFLINE_DB_PATH)

// 创建与主项目兼容的离线数据库 schema
// 离线数据库包含：
// 1. source_books / source_chapters — 从主项目导入的只读数据
// 2. scan_jobs / scan_chapters — 扫描任务和进度
// 3. summaries / kg_* — 扫描结果，结构与主项目完全一致

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- 从主项目导入的源数据（只读镜像）
  CREATE TABLE IF NOT EXISTS source_books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    chapter_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS source_chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    UNIQUE(book_id, chapter_index)
  );

  CREATE INDEX IF NOT EXISTS idx_source_chapters_book_index ON source_chapters(book_id, chapter_index);

  -- 扫描任务
  CREATE TABLE IF NOT EXISTS scan_jobs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    scan_type TEXT NOT NULL, -- 'summary' | 'kg' | 'both'
    status TEXT NOT NULL, -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    total_chapters INTEGER NOT NULL DEFAULT 0,
    completed_chapters INTEGER NOT NULL DEFAULT 0,
    failed_chapters INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scan_jobs_book_status ON scan_jobs(book_id, status);

  -- 每章扫描状态
  CREATE TABLE IF NOT EXISTS scan_chapters (
    job_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    scan_type TEXT NOT NULL, -- 'summary' | 'kg'
    status TEXT NOT NULL, -- 'pending' | 'running' | 'completed' | 'failed'
    result_json TEXT,
    error TEXT,
    model TEXT,
    scanned_at TEXT,
    PRIMARY KEY (job_id, chapter_id, scan_type)
  );

  CREATE INDEX IF NOT EXISTS idx_scan_chapters_job_status ON scan_chapters(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_scan_chapters_pending ON scan_chapters(job_id, scan_type, status)
    WHERE status = 'pending';

  -- 概要结果（与主项目 summaries 表完全兼容）
  CREATE TABLE IF NOT EXISTS summaries (
    chapter_id TEXT PRIMARY KEY,
    short TEXT NOT NULL,
    detail TEXT NOT NULL,
    key_points_json TEXT NOT NULL,
    skippable TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 知识图谱：与主项目完全兼容的 schema
  CREATE TABLE IF NOT EXISTS kg_chapter_extractions (
    chapter_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    status TEXT NOT NULL,
    extraction_json TEXT,
    error TEXT,
    model TEXT,
    scanned_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_entities (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
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
    entity_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    evidence TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kg_relations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    first_chapter_index INTEGER,
    last_chapter_index INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(book_id, source_entity_id, target_entity_id, type)
  );

  CREATE TABLE IF NOT EXISTS kg_relation_mentions (
    id TEXT PRIMARY KEY,
    relation_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    evidence TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entities_book_type ON kg_entities(book_id, type);
  CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(book_id, normalized_name);
  CREATE INDEX IF NOT EXISTS idx_kg_entity_mentions_entity ON kg_entity_mentions(entity_id, chapter_index);
  CREATE INDEX IF NOT EXISTS idx_kg_relations_book_type ON kg_relations(book_id, type);
  CREATE INDEX IF NOT EXISTS idx_kg_relation_mentions_relation ON kg_relation_mentions(relation_id, chapter_index);
`)

// Migration: add first/last chapter index to relations if missing
try {
  db.exec(`ALTER TABLE kg_relations ADD COLUMN first_chapter_index INTEGER`)
  db.exec(`ALTER TABLE kg_relations ADD COLUMN last_chapter_index INTEGER`)
} catch {
  // columns may already exist
}

// --- prepared statements for scan_chapters ---
const getPendingScanChaptersStmt = db.prepare(`
  SELECT chapter_id, chapter_index, scan_type
  FROM scan_chapters
  WHERE job_id = ? AND status = 'pending'
  ORDER BY chapter_index ASC
`)

const setChapterRunningStmt = db.prepare(`
  UPDATE scan_chapters SET status = 'running', scanned_at = CURRENT_TIMESTAMP
  WHERE job_id = ? AND chapter_id = ? AND scan_type = ?
`)

const setChapterCompletedStmt = db.prepare(`
  UPDATE scan_chapters SET status = 'completed', result_json = ?, model = ?, scanned_at = CURRENT_TIMESTAMP
  WHERE job_id = ? AND chapter_id = ? AND scan_type = ?
`)

const setChapterFailedStmt = db.prepare(`
  UPDATE scan_chapters SET status = 'failed', error = ?, scanned_at = CURRENT_TIMESTAMP
  WHERE job_id = ? AND chapter_id = ? AND scan_type = ?
`)

const updateJobStmt = db.prepare(`
  UPDATE scan_jobs
  SET completed_chapters = ?, failed_chapters = ?, status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)

const resetFailedChaptersStmt = db.prepare(`
  UPDATE scan_chapters
  SET status = 'pending', error = NULL, scanned_at = NULL
  WHERE job_id = ? AND status = 'failed'
`)

const countChapterStatusStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
  FROM scan_chapters
  WHERE job_id = ?
`)

const createJobStmt = db.prepare(`
  INSERT INTO scan_jobs (id, book_id, scan_type, status, total_chapters, completed_chapters, failed_chapters, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)

const getLatestJobStmt = db.prepare(`
  SELECT id, book_id, scan_type, status, total_chapters, completed_chapters, failed_chapters, error
  FROM scan_jobs
  WHERE book_id = ? AND scan_type = ?
  ORDER BY created_at DESC
  LIMIT 1
`)

const getJobChaptersStmt = db.prepare(`
  SELECT chapter_id, chapter_index, scan_type, status, result_json, error, model, scanned_at
  FROM scan_chapters
  WHERE job_id = ?
  ORDER BY chapter_index ASC
`)

const getSummaryStmt = db.prepare(`
  SELECT short, detail, key_points_json, skippable, generated_by
  FROM summaries
  WHERE chapter_id = ?
`)

const getExtractionStmt = db.prepare(`
  SELECT status, extraction_json, model, scanned_at
  FROM kg_chapter_extractions
  WHERE chapter_id = ?
`)

const getBookStmt = db.prepare(`
  SELECT id, title, imported_at, chapter_count
  FROM source_books
  WHERE id = ?
`)

const getChapterStmt = db.prepare(`
  SELECT id, book_id, chapter_index, title, content, word_count
  FROM source_chapters
  WHERE id = ?
`)

const getChaptersByBookStmt = db.prepare(`
  SELECT id, book_id, chapter_index, title, content, word_count
  FROM source_chapters
  WHERE book_id = ?
  ORDER BY chapter_index ASC
`)

// --- public functions ---

export function createJob(bookId, scanType, totalChapters) {
  const jobId = randomUUID()
  createJobStmt.run(jobId, bookId, scanType, 'pending', totalChapters)
  return jobId
}

export function getLatestJob(bookId, scanType) {
  return getLatestJobStmt.get(bookId, scanType) ?? null
}

export function getJobChapters(jobId) {
  return getJobChaptersStmt.all(jobId)
}

export function getPendingChapters(jobId) {
  return getPendingScanChaptersStmt.all(jobId)
}

export function markChapterRunning(jobId, chapterId, scanType) {
  setChapterRunningStmt.run(jobId, chapterId, scanType)
}

export function markChapterCompleted(jobId, chapterId, scanType, resultJson, model) {
  setChapterCompletedStmt.run(resultJson, model, jobId, chapterId, scanType)
}

export function markChapterFailed(jobId, chapterId, scanType, error) {
  setChapterFailedStmt.run(error, jobId, chapterId, scanType)
}

export function updateJob(jobId, status, completed, failed, error) {
  updateJobStmt.run(completed, failed, status, error, jobId)
}

export function resetFailedChapters(jobId) {
  resetFailedChaptersStmt.run(jobId)
  return countChapterStatusStmt.get(jobId)
}

export function getSourceChapter(chapterId) {
  return getChapterStmt.get(chapterId)
}

export function getSourceChaptersByBook(bookId) {
  return getChaptersByBookStmt.all(bookId)
}

export function getSourceBook(bookId) {
  return getBookStmt.get(bookId)
}

export function getOfflineSummary(chapterId) {
  return getSummaryStmt.get(chapterId) ?? null
}

export function getOfflineExtraction(chapterId) {
  return getExtractionStmt.get(chapterId) ?? null
}

// --- import from main database ---

export function importBookFromMain(mainDbPath, bookId) {
  const mainDb = new DatabaseSync(mainDbPath)

  // 导入 book
  const book = mainDb.prepare(`
    SELECT id, title, imported_at, chapter_count
    FROM books
    WHERE id = ?
  `).get(bookId)

  if (!book) {
    mainDb.close()
    throw new Error(`Book ${bookId} not found in main database.`)
  }

  db.prepare(`
    INSERT INTO source_books (id, title, imported_at, chapter_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      imported_at = excluded.imported_at,
      chapter_count = excluded.chapter_count
  `).run(book.id, book.title, book.imported_at, book.chapter_count)

  // 导入 chapters
  const chapters = mainDb.prepare(`
    SELECT id, book_id, chapter_index, title, content, word_count
    FROM chapters
    WHERE book_id = ?
    ORDER BY chapter_index ASC
  `).all(bookId)

  for (const chapter of chapters) {
    db.prepare(`
      INSERT INTO source_chapters (id, book_id, chapter_index, title, content, word_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        book_id = excluded.book_id,
        chapter_index = excluded.chapter_index,
        title = excluded.title,
        content = excluded.content,
        word_count = excluded.word_count
    `).run(chapter.id, chapter.book_id, chapter.chapter_index, chapter.title, chapter.content, chapter.word_count)
  }

  // 导入已有 summaries（避免重复扫描）
  const summaries = mainDb.prepare(`
    SELECT chapter_id, short, detail, key_points_json, skippable, generated_by
    FROM summaries
    WHERE chapter_id IN (
      SELECT id FROM chapters WHERE book_id = ?
    )
  `).all(bookId)

  for (const s of summaries) {
    db.prepare(`
      INSERT INTO summaries (chapter_id, short, detail, key_points_json, skippable, generated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        short = excluded.short,
        detail = excluded.detail,
        key_points_json = excluded.key_points_json,
        skippable = excluded.skippable,
        generated_by = excluded.generated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(s.chapter_id, s.short, s.detail, s.key_points_json, s.skippable, s.generated_by)
  }

  // 导入已有 kg 数据
  const extractions = mainDb.prepare(`
    SELECT chapter_id, book_id, status, extraction_json, error, model, scanned_at
    FROM kg_chapter_extractions
    WHERE book_id = ?
  `).all(bookId)

  for (const e of extractions) {
    db.prepare(`
      INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, extraction_json, error, model, scanned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        book_id = excluded.book_id,
        status = excluded.status,
        extraction_json = excluded.extraction_json,
        error = excluded.error,
        model = excluded.model,
        scanned_at = excluded.scanned_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(e.chapter_id, e.book_id, e.status, e.extraction_json, e.error, e.model, e.scanned_at)
  }

  // 导入 entities（先清空再导入）
  db.prepare(`DELETE FROM kg_entity_mentions WHERE book_id = ?`).run(bookId)
  db.prepare(`DELETE FROM kg_relations WHERE book_id = ?`).run(bookId)
  db.prepare(`DELETE FROM kg_relation_mentions WHERE book_id = ?`).run(bookId)
  db.prepare(`DELETE FROM kg_entities WHERE book_id = ?`).run(bookId)

  const entities = mainDb.prepare(`
    SELECT id, book_id, type, name, normalized_name, aliases_json, description, confidence,
           first_chapter_index, last_chapter_index, created_at, updated_at
    FROM kg_entities
    WHERE book_id = ?
  `).all(bookId)

  for (const e of entities) {
    db.prepare(`
      INSERT INTO kg_entities (id, book_id, type, name, normalized_name, aliases_json, description,
                               confidence, first_chapter_index, last_chapter_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, e.book_id, e.type, e.name, e.normalized_name, e.aliases_json, e.description,
           e.confidence, e.first_chapter_index, e.last_chapter_index, e.created_at, e.updated_at)
  }

  const entityMentions = mainDb.prepare(`
    SELECT id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
    FROM kg_entity_mentions
    WHERE book_id = ?
  `).all(bookId)

  for (const m of entityMentions) {
    db.prepare(`
      INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(m.id, m.entity_id, m.book_id, m.chapter_id, m.chapter_index, m.evidence, m.confidence, m.created_at)
  }

  const relations = mainDb.prepare(`
    SELECT id, book_id, source_entity_id, target_entity_id, type, description, confidence,
           first_chapter_index, last_chapter_index, created_at, updated_at
    FROM kg_relations
    WHERE book_id = ?
  `).all(bookId)

  for (const r of relations) {
    db.prepare(`
      INSERT INTO kg_relations (id, book_id, source_entity_id, target_entity_id, type, description,
                              confidence, first_chapter_index, last_chapter_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.id, r.book_id, r.source_entity_id, r.target_entity_id, r.type, r.description,
           r.confidence, r.first_chapter_index, r.last_chapter_index, r.created_at, r.updated_at)
  }

  const relationMentions = mainDb.prepare(`
    SELECT id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
    FROM kg_relation_mentions
    WHERE book_id = ?
  `).all(bookId)

  for (const m of relationMentions) {
    db.prepare(`
      INSERT INTO kg_relation_mentions (id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(m.id, m.relation_id, m.book_id, m.chapter_id, m.chapter_index, m.evidence, m.confidence, m.created_at)
  }

  mainDb.close()

  return { book, chapterCount: chapters.length, summaryCount: summaries.length, extractionCount: extractions.length }
}

// --- export to main database ---

export function exportResultsToMain(mainDbPath, bookId) {
  const mainDb = new DatabaseSync(mainDbPath)
  let summaries = []
  let extractions = []
  let entities = []
  let relations = []

  try {
    mainDb.exec('BEGIN')

    // 导出 summaries
    summaries = db.prepare(`
      SELECT chapter_id, short, detail, key_points_json, skippable, generated_by
      FROM summaries
      WHERE chapter_id IN (
        SELECT id FROM source_chapters WHERE book_id = ?
      )
    `).all(bookId)

    const insertSummary = mainDb.prepare(`
      INSERT INTO summaries (chapter_id, short, detail, key_points_json, skippable, generated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        short = excluded.short,
        detail = excluded.detail,
        key_points_json = excluded.key_points_json,
        skippable = excluded.skippable,
        generated_by = excluded.generated_by,
        updated_at = CURRENT_TIMESTAMP
    `)

    for (const s of summaries) {
      insertSummary.run(s.chapter_id, s.short, s.detail, s.key_points_json, s.skippable, s.generated_by)
    }

    // 导出 kg_chapter_extractions
    extractions = db.prepare(`
      SELECT chapter_id, book_id, status, extraction_json, error, model, scanned_at
      FROM kg_chapter_extractions
      WHERE book_id = ?
    `).all(bookId)

    const insertExtraction = mainDb.prepare(`
      INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, extraction_json, error, model, scanned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        book_id = excluded.book_id,
        status = excluded.status,
        extraction_json = excluded.extraction_json,
        error = excluded.error,
        model = excluded.model,
        scanned_at = excluded.scanned_at,
        updated_at = CURRENT_TIMESTAMP
    `)

    for (const e of extractions) {
      insertExtraction.run(e.chapter_id, e.book_id, e.status, e.extraction_json, e.error, e.model, e.scanned_at)
    }

    // 导出 kg_entities (先清空，再全量写入)
    mainDb.prepare(`DELETE FROM kg_entity_mentions WHERE book_id = ?`).run(bookId)
    mainDb.prepare(`DELETE FROM kg_relations WHERE book_id = ?`).run(bookId)
    mainDb.prepare(`DELETE FROM kg_relation_mentions WHERE book_id = ?`).run(bookId)
    mainDb.prepare(`DELETE FROM kg_entities WHERE book_id = ?`).run(bookId)

    entities = db.prepare(`
      SELECT id, book_id, type, name, normalized_name, aliases_json, description, confidence,
             first_chapter_index, last_chapter_index, created_at, updated_at
      FROM kg_entities
      WHERE book_id = ?
    `).all(bookId)

    const insertEntity = mainDb.prepare(`
      INSERT INTO kg_entities (id, book_id, type, name, normalized_name, aliases_json, description,
                               confidence, first_chapter_index, last_chapter_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const e of entities) {
      insertEntity.run(e.id, e.book_id, e.type, e.name, e.normalized_name, e.aliases_json, e.description,
                       e.confidence, e.first_chapter_index, e.last_chapter_index, e.created_at, e.updated_at)
    }

    const entityMentions = db.prepare(`
      SELECT id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
      FROM kg_entity_mentions
      WHERE book_id = ?
    `).all(bookId)

    const insertEntityMention = mainDb.prepare(`
      INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const m of entityMentions) {
      insertEntityMention.run(m.id, m.entity_id, m.book_id, m.chapter_id, m.chapter_index, m.evidence, m.confidence, m.created_at)
    }

    relations = db.prepare(`
      SELECT id, book_id, source_entity_id, target_entity_id, type, description, confidence,
             first_chapter_index, last_chapter_index, created_at, updated_at
      FROM kg_relations
      WHERE book_id = ?
    `).all(bookId)

    const insertRelation = mainDb.prepare(`
      INSERT INTO kg_relations (id, book_id, source_entity_id, target_entity_id, type, description,
                              confidence, first_chapter_index, last_chapter_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const r of relations) {
      insertRelation.run(r.id, r.book_id, r.source_entity_id, r.target_entity_id, r.type, r.description,
                         r.confidence, r.first_chapter_index, r.last_chapter_index, r.created_at, r.updated_at)
    }

    const relationMentions = db.prepare(`
      SELECT id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
      FROM kg_relation_mentions
      WHERE book_id = ?
    `).all(bookId)

    const insertRelationMention = mainDb.prepare(`
      INSERT INTO kg_relation_mentions (id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const m of relationMentions) {
      insertRelationMention.run(m.id, m.relation_id, m.book_id, m.chapter_id, m.chapter_index, m.evidence, m.confidence, m.created_at)
    }

    mainDb.exec('COMMIT')
  } catch (error) {
    mainDb.exec('ROLLBACK')
    mainDb.close()
    throw error
  }

  mainDb.close()

  return {
    summaryCount: summaries.length,
    extractionCount: extractions.length,
    entityCount: entities.length,
    relationCount: relations.length,
  }
}

export function createBookDataPackage(bookId) {
  const book = getSourceBook(bookId)
  if (!book) {
    throw new Error(`Book ${bookId} is not imported into the offline database.`)
  }

  const chapters = db.prepare(`
    SELECT id, book_id, chapter_index, title, word_count
    FROM source_chapters
    WHERE book_id = ?
    ORDER BY chapter_index ASC
  `).all(bookId)

  const summaries = db.prepare(`
    SELECT chapter_id, short, detail, key_points_json, skippable, generated_by
    FROM summaries
    WHERE chapter_id IN (
      SELECT id FROM source_chapters WHERE book_id = ?
    )
    ORDER BY chapter_id ASC
  `).all(bookId)

  const kgChapterExtractions = db.prepare(`
    SELECT chapter_id, book_id, status, extraction_json, error, model, scanned_at
    FROM kg_chapter_extractions
    WHERE book_id = ?
    ORDER BY chapter_id ASC
  `).all(bookId)

  const kgEntities = db.prepare(`
    SELECT id, book_id, type, name, normalized_name, aliases_json, description, confidence,
           first_chapter_index, last_chapter_index, created_at, updated_at
    FROM kg_entities
    WHERE book_id = ?
    ORDER BY name ASC
  `).all(bookId)

  const kgEntityMentions = db.prepare(`
    SELECT id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
    FROM kg_entity_mentions
    WHERE book_id = ?
    ORDER BY chapter_index ASC
  `).all(bookId)

  const kgRelations = db.prepare(`
    SELECT id, book_id, source_entity_id, target_entity_id, type, description, confidence,
           first_chapter_index, last_chapter_index, created_at, updated_at
    FROM kg_relations
    WHERE book_id = ?
    ORDER BY type ASC
  `).all(bookId)

  const kgRelationMentions = db.prepare(`
    SELECT id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at
    FROM kg_relation_mentions
    WHERE book_id = ?
    ORDER BY chapter_index ASC
  `).all(bookId)

  return {
    kind: 'novel-reader-offline-book-data',
    version: 1,
    exportedAt: new Date().toISOString(),
    book: {
      id: book.id,
      title: book.title,
      imported_at: book.imported_at,
      chapter_count: chapters.length,
    },
    chapters,
    summaries,
    kgChapterExtractions,
    kgEntities,
    kgEntityMentions,
    kgRelations,
    kgRelationMentions,
    counts: {
      chapters: chapters.length,
      summaries: summaries.length,
      kgChapterExtractions: kgChapterExtractions.length,
      kgEntities: kgEntities.length,
      kgEntityMentions: kgEntityMentions.length,
      kgRelations: kgRelations.length,
      kgRelationMentions: kgRelationMentions.length,
    },
  }
}

// --- summary store ---

export function saveSummary(chapterId, summary) {
  db.prepare(`
    INSERT INTO summaries (chapter_id, short, detail, key_points_json, skippable, generated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id) DO UPDATE SET
      short = excluded.short,
      detail = excluded.detail,
      key_points_json = excluded.key_points_json,
      skippable = excluded.skippable,
      generated_by = excluded.generated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(chapterId, summary.short, summary.detail, JSON.stringify(summary.keyPoints), summary.skippable, summary.generatedBy)
}

// --- kg extraction store ---

export function saveKgExtraction(chapterId, bookId, extraction, model) {
  db.prepare(`
    INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, extraction_json, model, scanned_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id) DO UPDATE SET
      book_id = excluded.book_id,
      status = excluded.status,
      extraction_json = excluded.extraction_json,
      error = excluded.error,
      model = excluded.model,
      scanned_at = excluded.scanned_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(chapterId, bookId, JSON.stringify(extraction), model)
}

export function saveKgExtractionError(chapterId, bookId, error) {
  db.prepare(`
    INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, error, scanned_at, updated_at)
    VALUES (?, ?, 'failed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id) DO UPDATE SET
      book_id = excluded.book_id,
      status = excluded.status,
      error = excluded.error,
      scanned_at = excluded.scanned_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(chapterId, bookId, error)
}

// --- init scan chapters for a job ---

export function initScanChapters(jobId, bookId, scanType, chapters) {
  const insert = db.prepare(`
    INSERT INTO scan_chapters (job_id, chapter_id, chapter_index, scan_type, status, result_json, error, model, scanned_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    ON CONFLICT(job_id, chapter_id, scan_type) DO UPDATE SET
      status = CASE WHEN status = 'completed' THEN 'completed' ELSE excluded.status END,
      chapter_index = excluded.chapter_index
  `)

  for (const chapter of chapters) {
    const status = (() => {
      if (scanType === 'summary' || scanType === 'both') {
        const summary = getOfflineSummary(chapter.id)
        if (summary) return 'completed'
      }
      if (scanType === 'kg' || scanType === 'both') {
        const extraction = getOfflineExtraction(chapter.id)
        if (extraction && extraction.status === 'completed') return 'completed'
      }
      return 'pending'
    })()

    insert.run(jobId, chapter.id, chapter.chapter_index, scanType === 'both' ? 'summary' : scanType, status)

    if (scanType === 'both') {
      insert.run(jobId, chapter.id, chapter.chapter_index, 'kg', status)
    }
  }
}

export function listJobs() {
  return db.prepare(`
    SELECT id, book_id, scan_type, status, total_chapters, completed_chapters, failed_chapters, error, created_at, updated_at
    FROM scan_jobs
    ORDER BY updated_at DESC
  `).all()
}

export function getJobStatus(jobId) {
  return db.prepare(`
    SELECT id, book_id, scan_type, status, total_chapters, completed_chapters, failed_chapters, error
    FROM scan_jobs
    WHERE id = ?
  `).get(jobId)
}

export function cancelRunningJobs(bookId = null) {
  db.prepare(`
    UPDATE scan_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running' AND (? IS NULL OR book_id = ?)
  `).run(bookId, bookId)
}

export function isJobCancelled(jobId) {
  const row = db.prepare(`SELECT status FROM scan_jobs WHERE id = ?`).get(jobId)
  return row?.status === 'cancelled'
}

export function listMainBooks() {
  const mainDb = new DatabaseSync(MAIN_DB_PATH)
  const rows = mainDb.prepare(`
    SELECT id, title, imported_at, chapter_count
    FROM books
    ORDER BY imported_at DESC
  `).all()
  mainDb.close()
  return rows
}

export { db }
