import { randomUUID } from 'node:crypto'
import {
  createJob,
  getLatestJob,
  getPendingChapters,
  markChapterRunning,
  markChapterCompleted,
  markChapterFailed,
  updateJob,
  initScanChapters,
  getSourceChapter,
  getSourceChaptersByBook,
  saveSummary,
  saveKgExtraction,
  saveKgExtractionError,
  getOfflineSummary,
  getOfflineExtraction,
  db,
  cancelRunningJobs,
  isJobCancelled,
  resetFailedChapters,
} from './db.mjs'
import { generateSummary, generateKgExtraction } from './llm.mjs'
import { getConfig } from './config.mjs'

let shouldStop = false

export function stopScan() {
  shouldStop = true
  cancelRunningJobs()
}

export function resetStop() {
  shouldStop = false
}

export function isStopped() {
  return shouldStop
}

// ========================
// 并发 Worker 池
// ========================

async function runWorkers(chapters, concurrency, workerFn, onProgress, jobId) {
  let nextIndex = 0
  let completed = 0
  let failed = 0
  let wasCancelled = false

  async function worker() {
    while (nextIndex < chapters.length) {
      if (shouldStop || (jobId && isJobCancelled(jobId))) {
        wasCancelled = true
        break
      }

      const chapter = chapters[nextIndex]
      nextIndex += 1

      try {
        await workerFn(chapter)
        completed += 1
      } catch (error) {
        failed += 1
        console.error(`  ❌ 第 ${chapter.chapter_index} 章失败: ${error.message}`)
      }

      if (onProgress) {
        onProgress({ completed, failed, total: chapters.length, current: chapter })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()),
  )

  return { completed, failed, wasCancelled }
}

// ========================
// Summary 扫描
// ========================

export async function scanSummary(bookId, jobId) {
  const config = getConfig()
  const chapters = getPendingChapters(jobId)
    .filter(c => c.scan_type === 'summary')
    .map(c => getSourceChapter(c.chapter_id))
    .filter(Boolean)

  if (!chapters.length) {
    console.log('  📚 没有需要扫描的 Summary 章节。')
    return { completed: 0, failed: 0 }
  }

  console.log(`  📝 开始 Summary 扫描，并发 ${config.concurrency}，共 ${chapters.length} 章`)

  let completed = 0
  let failed = 0

  const { completed: wc, failed: wf, wasCancelled } = await runWorkers(
    chapters,
    config.concurrency,
    async (chapter) => {
      markChapterRunning(jobId, chapter.id, 'summary')
      try {
        const summary = await generateSummary(chapter, config)
        saveSummary(chapter.id, summary)
        markChapterCompleted(jobId, chapter.id, 'summary', JSON.stringify(summary), config.model)
      } catch (error) {
        markChapterFailed(jobId, chapter.id, 'summary', error.message)
        throw error
      }
    },
    ({ completed: c, failed: f, total, current }) => {
      completed = c
      failed = f
      process.stdout.write(`\r  📊 Summary 进度: ${c}/${total} 完成, ${f} 失败 | 当前: 第 ${current.chapter_index} 章`)
    },
    jobId,
  )

  console.log('')
  return { completed: wc, failed: wf, wasCancelled }
}

// ========================
// Knowledge Graph 扫描
// ========================

// 工具函数：normalize（与 local-db-server.mjs 一致）
function normalizeName(name) {
  return String(name ?? '').trim().replace(/\s+/g, '').toLowerCase()
}

function normalizeEntityType(type) {
  const allowed = new Set(['character', 'sect', 'item', 'skill', 'location', 'beast', 'event', 'other'])
  return allowed.has(type) ? type : 'other'
}

function normalizeRelationType(type) {
  const allowed = new Set([
    'knows', 'ally_of', 'enemy_of', 'master_of', 'disciple_of', 'member_of',
    'belongs_to', 'owns', 'uses', 'learns', 'created_by', 'located_in',
    'appears_with', 'transforms_into', 'related_to',
  ])
  return allowed.has(type) ? type : 'related_to'
}

function normalizeConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .filter(v => typeof v === 'string')
        .map(v => v.trim())
        .filter(Boolean),
    ),
  )
}

function firstEvidence(evidence) {
  if (Array.isArray(evidence)) return uniqueStrings(evidence).slice(0, 3).join('\n')
  return typeof evidence === 'string' ? evidence.trim() : ''
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

// 在离线数据库中应用章节提取结果（与主项目的 applyChapterExtraction 完全一致）

const findKgEntityStmt = db.prepare(`
  SELECT id, aliases_json, description, confidence, first_chapter_index, last_chapter_index
  FROM kg_entities
  WHERE book_id = ? AND type = ? AND normalized_name = ?
`)

const insertKgEntityStmt = db.prepare(`
  INSERT INTO kg_entities (
    id, book_id, type, name, normalized_name, aliases_json, description, confidence,
    first_chapter_index, last_chapter_index, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)

const updateKgEntityStmt = db.prepare(`
  UPDATE kg_entities
  SET
    aliases_json = ?,
    description = COALESCE(NULLIF(?, ''), description),
    confidence = MAX(confidence, ?),
    first_chapter_index = CASE WHEN first_chapter_index IS NULL THEN ? ELSE MIN(first_chapter_index, ?) END,
    last_chapter_index = CASE WHEN last_chapter_index IS NULL THEN ? ELSE MAX(last_chapter_index, ?) END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)

const insertKgEntityMentionStmt = db.prepare(`
  INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`)

const findKgRelationStmt = db.prepare(`
  SELECT id, confidence
  FROM kg_relations
  WHERE book_id = ? AND source_entity_id = ? AND target_entity_id = ? AND type = ?
`)

const insertKgRelationStmt = db.prepare(`
  INSERT INTO kg_relations (
    id, book_id, source_entity_id, target_entity_id, type, description, confidence,
    first_chapter_index, last_chapter_index, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)

const updateKgRelationStmt = db.prepare(`
  UPDATE kg_relations
  SET
    description = COALESCE(NULLIF(?, ''), description),
    confidence = MAX(confidence, ?),
    first_chapter_index = CASE WHEN first_chapter_index IS NULL THEN ? ELSE MIN(first_chapter_index, ?) END,
    last_chapter_index = CASE WHEN last_chapter_index IS NULL THEN ? ELSE MAX(last_chapter_index, ?) END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)

const insertKgRelationMentionStmt = db.prepare(`
  INSERT INTO kg_relation_mentions (id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`)

const deleteKgRelationMentionsForChapterStmt = db.prepare(`
  DELETE FROM kg_relation_mentions WHERE chapter_id = ?
`)

const deleteKgEntityMentionsForChapterStmt = db.prepare(`
  DELETE FROM kg_entity_mentions WHERE chapter_id = ?
`)

function upsertKgEntity(bookId, chapter, entity) {
  const name = String(entity?.name ?? '').trim()
  if (!name) return null

  const type = normalizeEntityType(entity.type)
  const normalizedName = normalizeName(name)
  const aliases = uniqueStrings(Array.isArray(entity.aliases) ? entity.aliases : [])
  const description = typeof entity.description === 'string' ? entity.description.trim() : ''
  const confidence = normalizeConfidence(entity.confidence)

  const existing = findKgEntityStmt.get(bookId, type, normalizedName)

  if (!existing) {
    const id = randomUUID()
    insertKgEntityStmt.run(
      id, bookId, type, name, normalizedName, JSON.stringify(aliases), description, confidence,
      chapter.chapter_index, chapter.chapter_index,
    )
    insertKgEntityMentionStmt.run(
      randomUUID(), id, bookId, chapter.id, chapter.chapter_index, firstEvidence(entity.evidence), confidence,
    )
    return id
  }

  const mergedAliases = uniqueStrings([...safeJsonParse(existing.aliases_json, []), ...aliases])
  updateKgEntityStmt.run(
    JSON.stringify(mergedAliases), description, confidence,
    chapter.chapter_index, chapter.chapter_index,
    chapter.chapter_index, chapter.chapter_index,
    existing.id,
  )
  insertKgEntityMentionStmt.run(
    randomUUID(), existing.id, bookId, chapter.id, chapter.chapter_index, firstEvidence(entity.evidence), confidence,
  )
  return existing.id
}

function applyChapterExtraction(bookId, chapterId, extraction, model) {
  const chapter = db.prepare(`
    SELECT id, book_id, chapter_index, title, content, word_count
    FROM source_chapters
    WHERE id = ?
  `).get(chapterId)

  if (!chapter || chapter.book_id !== bookId) {
    throw new Error('Chapter does not belong to the requested book.')
  }

  const entities = Array.isArray(extraction?.entities) ? extraction.entities : []
  const relations = Array.isArray(extraction?.relations) ? extraction.relations : []
  const entityIdByKey = new Map()

  deleteKgRelationMentionsForChapterStmt.run(chapterId)
  deleteKgEntityMentionsForChapterStmt.run(chapterId)

  saveKgExtraction(chapterId, bookId, extraction, model)

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
    const existing = findKgRelationStmt.get(bookId, sourceId, targetId, relationType)
    const relationId = existing?.id ?? randomUUID()

    if (existing) {
      updateKgRelationStmt.run(
        description, confidence,
        chapter.chapter_index, chapter.chapter_index,
        chapter.chapter_index, chapter.chapter_index,
        relationId,
      )
    } else {
      insertKgRelationStmt.run(
        relationId, bookId, sourceId, targetId, relationType, description, confidence,
        chapter.chapter_index, chapter.chapter_index,
      )
    }

    insertKgRelationMentionStmt.run(
      randomUUID(), relationId, bookId, chapterId, chapter.chapter_index, firstEvidence(relation.evidence), confidence,
    )
  }
}

export async function scanKg(bookId, jobId) {
  const config = getConfig()
  const chapters = getPendingChapters(jobId)
    .filter(c => c.scan_type === 'kg')
    .map(c => getSourceChapter(c.chapter_id))
    .filter(Boolean)

  if (!chapters.length) {
    console.log('  🕸️  没有需要扫描的 KG 章节。')
    return { completed: 0, failed: 0 }
  }

  console.log(`  🕸️  开始 KG 扫描，并发 ${config.concurrency}，共 ${chapters.length} 章`)

  const { completed, failed, wasCancelled } = await runWorkers(
    chapters,
    config.concurrency,
    async (chapter) => {
      markChapterRunning(jobId, chapter.id, 'kg')
      try {
        const extraction = await generateKgExtraction(chapter, config)
        // 在事务中应用提取结果
        db.exec('BEGIN')
        try {
          applyChapterExtraction(bookId, chapter.id, extraction, config.model)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        markChapterCompleted(jobId, chapter.id, 'kg', JSON.stringify(extraction), config.model)
      } catch (error) {
        saveKgExtractionError(chapter.id, bookId, error.message)
        markChapterFailed(jobId, chapter.id, 'kg', error.message)
        throw error
      }
    },
    ({ completed: c, failed: f, total, current }) => {
      process.stdout.write(`\r  📊 KG 进度: ${c}/${total} 完成, ${f} 失败 | 当前: 第 ${current.chapter_index} 章`)
    },
    jobId,
  )

  console.log('')
  return { completed, failed, wasCancelled }
}

// ========================
// 完整扫描（both）
// ========================

export async function scanAll(bookId, jobId) {
  const summaryResult = await scanSummary(bookId, jobId)
  const kgResult = await scanKg(bookId, jobId)
  return { summaryResult, kgResult }
}

// ========================
// 创建扫描任务
// ========================

export function createScanJob(bookId, scanType) {
  const chapters = getSourceChaptersByBook(bookId)
  if (!chapters.length) {
    throw new Error(`Book ${bookId} has no chapters in offline database. Run 'import' first.`)
  }

  // 先检查是否有运行中的任务
  const existingJob = getLatestJob(bookId, scanType)
  if (existingJob && existingJob.status === 'running') {
    console.log(`  ⚠️  已有运行中的 ${scanType} 任务 (${existingJob.id})，将使用现有任务继续。`)
    return existingJob.id
  }

  const jobId = createJob(bookId, scanType, chapters.length)
  initScanChapters(jobId, bookId, scanType, chapters)
  // 更新初始 completed count（已有数据自动跳过）
  const completedCount = db.prepare(`SELECT COUNT(*) as c FROM scan_chapters WHERE job_id = ? AND status = 'completed'`).get(jobId).c
  if (completedCount > 0) {
    updateJob(jobId, 'pending', completedCount, 0, null)
  }
  console.log(`  ✅ 创建 ${scanType} 扫描任务: ${jobId}，共 ${chapters.length} 章，其中 ${completedCount} 章已有数据`)
  return jobId
}

export function getOrCreateJob(bookId, scanType) {
  const job = getLatestJob(bookId, scanType)
  if (job && (job.status === 'running' || job.status === 'pending')) {
    return job.id
  }
  return createScanJob(bookId, scanType)
}

export function resumeJob(bookId, scanType) {
  const job = getLatestJob(bookId, scanType)
  if (!job) {
    console.log(`  ⚠️  没有 ${scanType} 历史任务，创建新任务。`)
    return createScanJob(bookId, scanType)
  }
  if (job.status === 'completed') {
    console.log(`  ✅ ${scanType} 任务 (${job.id}) 已完成。`)
    return job.id
  }
  // 把上次失败的章节重置为 pending，以便断点续传时重试
  const { completed, failed } = resetFailedChapters(job.id)
  console.log(`  🔄 恢复 ${scanType} 任务: ${job.id} (${completed || 0}/${job.total_chapters})`)
  if (failed > 0) {
    console.log(`     已重置 ${failed} 个失败章节为待扫描。`)
  }
  updateJob(job.id, 'pending', completed || 0, 0, null)
  return job.id
}

export function getJobReport(jobId) {
  const chapters = db.prepare(`
    SELECT chapter_id, chapter_index, scan_type, status, error, model, scanned_at
    FROM scan_chapters
    WHERE job_id = ?
    ORDER BY chapter_index ASC
  `).all(jobId)

  const pending = chapters.filter(c => c.status === 'pending')
  const completed = chapters.filter(c => c.status === 'completed')
  const failed = chapters.filter(c => c.status === 'failed')

  return { pending, completed, failed, all: chapters }
}

export { db }
