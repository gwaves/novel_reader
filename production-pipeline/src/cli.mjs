#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const defaultRunRoot = 'tmp/production-pipeline/runs'
const defaultMainDbPath = '~/.novel_reader/novel_reader.sqlite'
let DatabaseSyncCtor
let bookIngestModule

main().catch((error) => {
  console.error(`production-pipeline failed: ${error.message}`)
  process.exitCode = 1
})

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  const options = parseArgs(argv)
  if (!command || command === 'help' || options.help) {
    printHelp()
    return
  }

  if (command === 'import') {
    await runImport(options)
    return
  }
  if (command === 'status') {
    await runStatus(options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

async function runImport(options) {
  const filePath = resolve(required(options.file, 'import requires --file <path>'))
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'import', options, mainDbPath })
  const startedAt = new Date().toISOString()

  try {
    const sourceBuffer = await readFile(filePath)
    const sha256 = hashBuffer(sourceBuffer)
    const { parseBookFile, inferSourceType } = await loadBookIngest()
    const parsed = await parseBookFile(filePath, sourceBuffer)
    const bookId = options.bookId || `file-${sha256.slice(0, 24)}`
    const title = options.title || parsed.title || basename(filePath).replace(/\.[^.]+$/, '') || bookId
    const importedAt = new Date().toISOString()
    const chapters = normalizeParsedChapters(parsed.chapters, bookId)

    if (!chapters.length) throw new Error('No chapters were detected.')

    const importReport = {
      book: {
        id: bookId,
        title,
        importedAt,
        chapterCount: chapters.length,
        wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      },
      source: {
        type: inferSourceType(filePath),
        fileName: basename(filePath),
        path: filePath,
        sha256,
        sizeBytes: sourceBuffer.byteLength,
      },
      dryRun: Boolean(options.dryRun),
      replace: Boolean(options.replace),
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        wordCount: chapter.wordCount,
      })),
    }

    await writeJson(join(run.artifactsDir, 'import-report.json'), importReport)
    await writeJson(join(run.artifactsDir, 'chapter-preview.json'), {
      bookId,
      title,
      chapters: chapters.slice(0, 20).map((chapter) => ({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        wordCount: chapter.wordCount,
        preview: chapter.content.slice(0, 240),
      })),
      omittedChapters: Math.max(0, chapters.length - 20),
    })

    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'import',
      itemId: bookId,
      itemType: 'book',
      status: options.dryRun ? 'skipped' : 'running',
      attempts: 1,
      startedAt,
      metadata: { chapterCount: chapters.length, sourceSha256: sha256 },
    })

    if (!options.dryRun) {
      await writeBookToMainDb(mainDbPath, {
        id: bookId,
        title,
        importedAt,
        chapters,
        replace: Boolean(options.replace),
      })
    }

    const finishedAt = new Date().toISOString()
    await recordStageItem(run.itemsDbPath, {
      stage: 'import',
      itemId: bookId,
      itemType: 'book',
      status: options.dryRun ? 'skipped' : 'completed',
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: { chapterCount: chapters.length, sourceSha256: sha256 },
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'import',
      status: options.dryRun ? 'skipped' : 'completed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, title, source: importReport.source },
      stages: {
        import: {
          status: options.dryRun ? 'skipped' : 'completed',
          startedAt,
          finishedAt,
          message: options.dryRun
            ? `dry-run parsed ${chapters.length} chapters.`
            : `imported ${chapters.length} chapters.`,
          artifacts: {
            importReport: relativeRunPath(run.rootDir, join(run.artifactsDir, 'import-report.json')),
            chapterPreview: relativeRunPath(run.rootDir, join(run.artifactsDir, 'chapter-preview.json')),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId} ${title}`)
    console.log(`chapters: ${chapters.length}`)
    console.log(`runDir: ${run.rootDir}`)
    if (options.dryRun) console.log('dry-run: main database was not modified')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'import',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      stages: {
        import: {
          status: 'failed',
          startedAt,
          finishedAt,
          error: error.message,
        },
      },
    })
    throw error
  }
}

async function runStatus(options) {
  const runPath = required(options.run, 'status requires --run <runId or run path>')
  const runJsonPath = runPath.endsWith('.json')
    ? resolve(runPath)
    : existsSync(resolve(runPath, 'run.json'))
      ? resolve(runPath, 'run.json')
      : resolve(defaultRunRoot, runPath, 'run.json')
  const run = JSON.parse(await readFile(runJsonPath, 'utf8'))
  console.log(JSON.stringify(run, null, 2))
}

async function createRun({ command, options, mainDbPath }) {
  const runId = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const rootDir = resolve(options.runRoot || defaultRunRoot, runId)
  const artifactsDir = join(rootDir, 'artifacts')
  const logsDir = join(rootDir, 'logs')
  const checkpointsDir = join(rootDir, 'checkpoints')
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await mkdir(checkpointsDir, { recursive: true })
  const createdAt = new Date().toISOString()
  const runJsonPath = join(rootDir, 'run.json')
  const itemsDbPath = join(rootDir, 'items.sqlite')
  await writeRunJson(runJsonPath, {
    runId,
    command,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    mainDbPath,
    stages: {},
  })
  return { runId, rootDir, artifactsDir, logsDir, checkpointsDir, runJsonPath, itemsDbPath, createdAt }
}

function normalizeParsedChapters(parsedChapters, bookId) {
  return (Array.isArray(parsedChapters) ? parsedChapters : [])
    .map((chapter, index) => {
      const title = String(chapter.title || `第 ${index + 1} 章`).trim()
      const content = String(chapter.content || '').trim()
      return {
        id: `${index + 1}-${title}`,
        bookId,
        index: index + 1,
        title,
        content,
        wordCount: countWords(content),
      }
    })
    .filter((chapter) => chapter.title && chapter.content)
}

async function writeBookToMainDb(dbPath, book) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    ensureMainDbSchema(db)
    const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(book.id)
    if (existing && !book.replace) {
      throw new Error(`Book already exists: ${book.id}. Use --replace to overwrite.`)
    }

    db.exec('BEGIN')
    if (existing) {
      db.prepare('DELETE FROM books WHERE id = ?').run(book.id)
    }
    db.prepare(`
      INSERT INTO books (id, title, imported_at, chapter_count, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(book.id, book.title, book.importedAt, book.chapters.length)

    const insertChapter = db.prepare(`
      INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)
    for (const chapter of book.chapters) {
      insertChapter.run(chapter.id, book.id, chapter.index, chapter.title, chapter.content, chapter.wordCount)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // No active transaction.
    }
    throw error
  } finally {
    db.close()
  }
}

function ensureMainDbSchema(db) {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_chapters_book_index ON chapters(book_id, chapter_index);
    CREATE INDEX IF NOT EXISTS idx_chapters_title ON chapters(title);
  `)
}

async function initializeItemsDb(itemsDbPath) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(itemsDbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stage_items (
        stage TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (stage, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stage_items_status ON stage_items(stage, status);
    `)
  } finally {
    db.close()
  }
}

async function recordStageItem(itemsDbPath, item) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(itemsDbPath)
  try {
    db.prepare(`
      INSERT INTO stage_items (
        stage,
        item_id,
        item_type,
        status,
        attempts,
        started_at,
        finished_at,
        error,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stage, item_id) DO UPDATE SET
        item_type = excluded.item_type,
        status = excluded.status,
        attempts = excluded.attempts,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        error = excluded.error,
        metadata_json = excluded.metadata_json
    `).run(
      item.stage,
      item.itemId,
      item.itemType,
      item.status,
      item.attempts ?? 0,
      item.startedAt ?? null,
      item.finishedAt ?? null,
      item.error ?? null,
      JSON.stringify(item.metadata ?? {}),
    )
  } finally {
    db.close()
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = toCamelCase(arg.slice(2))
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      index += 1
    }
  }
  return options
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function required(value, message) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(message)
}

function expandPath(path) {
  const value = String(path || '')
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function countWords(text) {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  const words = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + words
}

async function loadDatabaseSync() {
  if (!DatabaseSyncCtor) {
    ;({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'))
  }
  return DatabaseSyncCtor
}

async function loadBookIngest() {
  if (!bookIngestModule) {
    bookIngestModule = await import('../../content-pipeline/lib/book-ingest.mjs')
  }
  return bookIngestModule
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeRunJson(path, value) {
  await writeJson(path, value)
}

function relativeRunPath(runDir, path) {
  return path.startsWith(`${runDir}/`) ? path.slice(runDir.length + 1) : path
}

function printHelp() {
  console.log(`Production Pipeline v2

Usage:
  npm run production-pipeline -- import --file <path> [--book-id <id>] [--title <title>] [--dry-run] [--replace]
  npm run production-pipeline -- status --run <runId|runDir|run.json>

Options:
  --main-db <path>     Main Novel Reader SQLite database.
  --run-root <path>    Run storage root. Default: ${defaultRunRoot}
  --dry-run            Parse and write run artifacts without modifying the main DB.
  --replace            Replace an existing book with the same bookId.
`)
}
