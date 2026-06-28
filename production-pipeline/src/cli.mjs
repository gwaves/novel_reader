#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const defaultRunRoot = 'tmp/production-pipeline/runs'
const defaultMainDbPath = '~/.novel_reader/novel_reader.sqlite'
const defaultRemoteRoot = '/home/gwaves/novel-reader-gateway'
const execFileAsync = promisify(execFile)
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
  if (command === 'package') {
    await runPackage(options)
    return
  }
  if (command === 'audio') {
    await runAudio(options)
    return
  }
  if (command === 'publish') {
    await runPublish(options)
    return
  }
  if (command === 'verify') {
    await runVerify(options)
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

async function runPackage(options) {
  const bookId = required(options.bookId, 'package requires --book-id <id>')
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'package', options, mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const book = await readBookFromMainDb(mainDbPath, bookId)
    const generatedAt = new Date().toISOString()
    const bookPackage = buildGatewayBookPackage(book, generatedAt)
    const gatewayDataDir = join(run.artifactsDir, 'gateway-data')
    const packagePath = join(gatewayDataDir, 'books', bookId, 'package.json')
    const bookSummaryPath = join(gatewayDataDir, 'book-summary.json')

    await writeJson(packagePath, bookPackage)
    await writeJson(bookSummaryPath, bookPackage.book)
    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'package',
      itemId: bookId,
      itemType: 'book',
      status: 'completed',
      attempts: 1,
      startedAt,
      finishedAt: generatedAt,
      metadata: {
        chapterCount: book.chapters.length,
        wordCount: bookPackage.book.wordCount,
      },
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'package',
      status: 'completed',
      createdAt: run.createdAt,
      updatedAt: generatedAt,
      mainDbPath,
      job: { bookId, title: book.title },
      stages: {
        package: {
          status: 'completed',
          startedAt,
          finishedAt: generatedAt,
          message: `packaged ${book.chapters.length} chapters.`,
          artifacts: {
            gatewayDataDir: relativeRunPath(run.rootDir, gatewayDataDir),
            packageFile: relativeRunPath(run.rootDir, packagePath),
            bookSummary: relativeRunPath(run.rootDir, bookSummaryPath),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId} ${book.title}`)
    console.log(`chapters: ${book.chapters.length}`)
    console.log(`package: ${packagePath}`)
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'package',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId },
      stages: {
        package: {
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

async function runAudio(options) {
  const bookId = required(options.bookId, 'audio requires --book-id <id>')
  const sourceRoot = resolve(required(options.sourceRoot, 'audio requires --source-root <path>'))
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'audio', options, mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const book = await readBookFromMainDb(mainDbPath, bookId)
    const artifacts = await collectAudioArtifacts(sourceRoot)
    if (!artifacts.length) throw new Error(`No audio/chapter.mp3 files found under ${sourceRoot}`)

    const bookAudioDir = join(run.artifactsDir, 'gateway-audio', 'books', bookId)
    const catalog = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      chapters: [],
    }
    const chaptersByIndex = new Map(book.chapters.map((chapter, index) => [numberOrDefault(chapter.chapterIndex, index + 1), chapter]))
    let copiedFiles = 0

    for (const artifact of artifacts) {
      const chapter = chaptersByIndex.get(artifact.chapterNumber)
      if (!chapter) {
        if (options.strict) throw new Error(`No chapter ${artifact.chapterNumber} found in main DB for ${bookId}`)
        continue
      }
      const chapterId = String(chapter.id)
      const targetSegment = `ch${String(artifact.chapterNumber).padStart(3, '0')}-${safePathSegment(chapterId)}`
      const targetDir = join(bookAudioDir, targetSegment)
      const targetMp3 = join(targetDir, 'chapter.mp3')
      const targetManifest = artifact.manifestPath ? join(targetDir, 'manifest.json') : ''
      const mp3Stat = await stat(artifact.mp3Path)
      const manifest = artifact.manifestPath ? await readJsonIfPresent(artifact.manifestPath) : null

      catalog.chapters.push({
        chapterId,
        title: String(chapter.title || `第 ${artifact.chapterNumber} 章`),
        fileName: relative(bookAudioDir, targetMp3),
        ...(targetManifest
          ? {
              manifestFileName: relative(bookAudioDir, targetManifest),
              timelineVersion: readTimelineVersion(manifest),
            }
          : {}),
        ...durationField(manifest),
        sizeBytes: mp3Stat.size,
        updatedAt: mp3Stat.mtime.toISOString(),
      })

      if (!options.dryRun) {
        await mkdir(targetDir, { recursive: true })
        await copyFile(artifact.mp3Path, targetMp3)
        copiedFiles += 1
        if (artifact.manifestPath && targetManifest) {
          await copyFile(artifact.manifestPath, targetManifest)
          copiedFiles += 1
        }
      }
    }

    catalog.chapters.sort((left, right) => {
      const leftIndex = chapterIndexForAudio(book.chapters, left.chapterId)
      const rightIndex = chapterIndexForAudio(book.chapters, right.chapterId)
      return leftIndex - rightIndex || String(left.title).localeCompare(String(right.title))
    })
    if (!catalog.chapters.length) throw new Error('No audio chapters matched the main DB chapters.')

    const catalogPath = join(bookAudioDir, 'audio.json')
    await writeJson(catalogPath, catalog)
    const finishedAt = new Date().toISOString()
    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'audio',
      itemId: bookId,
      itemType: 'book',
      status: options.dryRun ? 'skipped' : 'completed',
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: {
        audioChapterCount: catalog.chapters.length,
        copiedFiles,
        sourceRoot,
      },
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'audio',
      status: options.dryRun ? 'skipped' : 'completed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, title: book.title, sourceRoot },
      stages: {
        audio: {
          status: options.dryRun ? 'skipped' : 'completed',
          startedAt,
          finishedAt,
          message: `prepared ${catalog.chapters.length} audio chapters.`,
          artifacts: {
            gatewayAudioDir: relativeRunPath(run.rootDir, join(run.artifactsDir, 'gateway-audio')),
            audioCatalog: relativeRunPath(run.rootDir, catalogPath),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId} ${book.title}`)
    console.log(`audio chapters: ${catalog.chapters.length}`)
    console.log(`audio: ${catalogPath}`)
    if (options.dryRun) console.log('dry-run: audio files were not copied')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'audio',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, sourceRoot },
      stages: {
        audio: {
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

async function runPublish(options) {
  const runInfo = await loadRunInfo(required(options.run, 'publish requires --run <runId or run path>'))
  const bookId = runInfo.job?.bookId || required(options.bookId, 'publish requires a packaged run with job.bookId or --book-id <id>')
  const gatewayDataDir = resolveRunArtifact(
    runInfo.rootDir,
    runInfo.stages?.package?.artifacts?.gatewayDataDir || join('artifacts', 'gateway-data'),
  )
  const gatewayAudioDir = resolveRunArtifact(
    runInfo.rootDir,
    runInfo.stages?.audio?.artifacts?.gatewayAudioDir || join('artifacts', 'gateway-audio'),
  )
  const packageDir = join(gatewayDataDir, 'books', bookId)
  const packagePath = join(packageDir, 'package.json')
  const bookSummaryPath = join(gatewayDataDir, 'book-summary.json')
  const audioDir = join(gatewayAudioDir, 'books', bookId)
  const audioCatalogPath = join(audioDir, 'audio.json')
  const hasPackage = existsSync(packagePath) && existsSync(bookSummaryPath)
  const hasAudio = existsSync(audioCatalogPath)
  if (!hasPackage && !hasAudio) {
    throw new Error(`No package or audio artifacts found for ${bookId} in run ${runInfo.rootDir}`)
  }

  let booksJsonPath = ''
  if (hasPackage) {
    const bookSummary = JSON.parse(await readFile(bookSummaryPath, 'utf8'))
    booksJsonPath = join(gatewayDataDir, 'books.json')
    const existingCatalog = await readExistingGatewayCatalog(options)
    await writeJson(booksJsonPath, mergeBookCatalog(existingCatalog, bookSummary))
  }

  const startedAt = new Date().toISOString()
  const publishPlan = buildPublishPlan(options, {
    bookId,
    packageDir: hasPackage ? packageDir : '',
    booksJsonPath,
    audioDir: hasAudio ? audioDir : '',
  })
  if (options.dryRun) {
    console.log(`book: ${bookId}`)
    if (hasPackage) {
      console.log(`package: ${packagePath}`)
      console.log(`catalog: ${booksJsonPath}`)
    }
    if (hasAudio) console.log(`audio: ${audioCatalogPath}`)
    for (const command of publishPlan.commands) console.log(`dry-run: ${command.join(' ')}`)
    return
  }

  for (const command of publishPlan.commands) {
    const [bin, ...args] = command
    await execFileAsync(bin, args, { maxBuffer: 20 * 1024 * 1024 })
  }

  const finishedAt = new Date().toISOString()
  await writeRunJson(runInfo.runJsonPath, mergeRunStage(runInfo.runJson, 'publish', {
    status: 'completed',
    startedAt,
    finishedAt,
    message: `published ${bookId} artifacts with rsync.`,
    target: publishPlan.target,
    artifacts: {
      ...(booksJsonPath ? { booksJson: relativeRunPath(runInfo.rootDir, booksJsonPath) } : {}),
    },
  }))

  console.log(`book: ${bookId}`)
  console.log(`published: ${publishPlan.target}`)
}

async function runVerify(options) {
  const runInfo = await loadRunInfo(required(options.run, 'verify requires --run <runId or run path>'))
  const bookId = runInfo.job?.bookId || required(options.bookId, 'verify requires a run with job.bookId or --book-id <id>')
  const gatewayUrl = trimTrailingSlash(
    options.gatewayUrl || options.gatewayURL || process.env.GATEWAY_BASE_URL || process.env.GATEWAY_URL || '',
  )
  const gatewayToken = options.gatewayToken || process.env.GATEWAY_DEV_ACCESS_TOKEN || ''
  if (!gatewayUrl) throw new Error('verify requires --gateway-url <url> or GATEWAY_BASE_URL')
  if (!gatewayToken) throw new Error('verify requires --gateway-token <token> or GATEWAY_DEV_ACCESS_TOKEN')

  const startedAt = new Date().toISOString()
  const expected = await loadExpectedGatewayArtifacts(runInfo, bookId)
  const checks = []
  const health = await fetchGatewayJson(gatewayUrl, '/health')
  checks.push(assertCheck('health', health.status === 'ok', { status: health.status }))

  const library = await fetchGatewayJson(gatewayUrl, '/mobile/books', gatewayToken)
  const libraryBook = Array.isArray(library.books) ? library.books.find((book) => book?.id === bookId) : null
  checks.push(assertCheck('library.bookListed', Boolean(libraryBook), { bookId }))

  if (expected.package) {
    const packageResponse = await fetchGatewayJson(
      gatewayUrl,
      `/mobile/books/${encodeURIComponent(bookId)}/package?include=full`,
      gatewayToken,
    )
    const remotePackage = packageResponse.package
    const remoteChapters = Array.isArray(remotePackage?.chapters) ? remotePackage.chapters : []
    const expectedChapters = expected.package.chapters
    checks.push(assertCheck('package.bookId', remotePackage?.book?.id === bookId, { actual: remotePackage?.book?.id, expected: bookId }))
    checks.push(assertCheck('package.chapterCount', remoteChapters.length === expectedChapters.length, {
      actual: remoteChapters.length,
      expected: expectedChapters.length,
    }))
    checks.push(assertCheck('package.chapterIds', sameOrderedStrings(remoteChapters.map((chapter) => chapter.id), expectedChapters.map((chapter) => chapter.id)), {
      actual: remoteChapters.map((chapter) => chapter.id),
      expected: expectedChapters.map((chapter) => chapter.id),
    }))
  }

  if (expected.audio) {
    const audioResponse = await fetchGatewayJson(gatewayUrl, `/mobile/books/${encodeURIComponent(bookId)}/audio`, gatewayToken)
    const remoteAudioChapters = Array.isArray(audioResponse.chapters) ? audioResponse.chapters : []
    const expectedAudioChapters = expected.audio.chapters
    checks.push(assertCheck('audio.chapterCount', remoteAudioChapters.length === expectedAudioChapters.length, {
      actual: remoteAudioChapters.length,
      expected: expectedAudioChapters.length,
    }))
    checks.push(assertCheck('audio.chapterIds', sameOrderedStrings(
      remoteAudioChapters.map((chapter) => chapter.chapterId),
      expectedAudioChapters.map((chapter) => chapter.chapterId),
    ), {
      actual: remoteAudioChapters.map((chapter) => chapter.chapterId),
      expected: expectedAudioChapters.map((chapter) => chapter.chapterId),
    }))
  }

  const failedChecks = checks.filter((check) => !check.ok)
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    generatedAt: finishedAt,
    gatewayUrl,
    bookId,
    ok: failedChecks.length === 0,
    checks,
  }
  const reportPath = join(runInfo.rootDir, 'artifacts', 'verify-report.json')
  await writeJson(reportPath, report)
  await writeRunJson(runInfo.runJsonPath, mergeRunStage(runInfo.runJson, 'verify', {
    status: report.ok ? 'completed' : 'failed',
    startedAt,
    finishedAt,
    message: report.ok ? 'Gateway verification passed.' : `Gateway verification failed: ${failedChecks.length} checks failed.`,
    gatewayUrl,
    artifacts: {
      verifyReport: relativeRunPath(runInfo.rootDir, reportPath),
    },
    checks,
  }))

  console.log(`book: ${bookId}`)
  console.log(`gateway: ${gatewayUrl}`)
  console.log(`checks: ${checks.filter((check) => check.ok).length}/${checks.length}`)
  console.log(`report: ${reportPath}`)
  if (!report.ok) {
    for (const check of failedChecks) console.error(`failed: ${check.name}`)
    throw new Error(`Gateway verification failed: ${failedChecks.length} checks failed.`)
  }
}

async function runStatus(options) {
  const runInfo = await loadRunInfo(required(options.run, 'status requires --run <runId or run path>'))
  console.log(JSON.stringify(runInfo.runJson, null, 2))
}

async function createRun({ command, options, mainDbPath, bookId }) {
  const runId = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const rootDir = resolve(options.runRoot || defaultRunRoot, bookId || '', runId)
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

async function readBookFromMainDb(dbPath, bookId) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const book = db.prepare(`
      SELECT id, title, imported_at AS importedAt, chapter_count AS chapterCount, updated_at AS updatedAt
      FROM books
      WHERE id = ?
    `).get(bookId)
    if (!book) throw new Error(`Book not found in main DB: ${bookId}`)

    const chapters = db.prepare(`
      SELECT id, chapter_index AS chapterIndex, title, content, word_count AS wordCount, updated_at AS updatedAt
      FROM chapters
      WHERE book_id = ?
      ORDER BY chapter_index, title
    `).all(bookId)
    if (!chapters.length) throw new Error(`Book has no chapters in main DB: ${bookId}`)

    return {
      ...plainObject(book),
      chapters: chapters.map(plainObject),
    }
  } finally {
    db.close()
  }
}

function buildGatewayBookPackage(book, generatedAt) {
  const chapters = book.chapters.map((chapter, index) => ({
    id: String(chapter.id),
    index: numberOrDefault(chapter.chapterIndex, index + 1),
    chapterIndex: numberOrDefault(chapter.chapterIndex, index + 1),
    title: String(chapter.title || `第 ${index + 1} 章`),
    content: String(chapter.content || ''),
    wordCount: numberOrDefault(chapter.wordCount, countWords(String(chapter.content || ''))),
    updatedAt: chapter.updatedAt || generatedAt,
  }))
  const wordCount = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  return {
    schemaVersion: 1,
    generatedAt,
    book: {
      id: String(book.id),
      title: String(book.title || book.id),
      ...(book.author ? { author: String(book.author) } : {}),
      chapterCount: chapters.length,
      wordCount,
      updatedAt: book.updatedAt || book.importedAt || generatedAt,
    },
    chapters,
  }
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

async function loadRunInfo(runPath) {
  const runJsonPath = await resolveRunJsonPath(runPath)
  const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
  return {
    runJson,
    runJsonPath,
    rootDir: dirname(runJsonPath),
    job: runJson.job || {},
    stages: runJson.stages || {},
  }
}

async function loadExpectedGatewayArtifacts(runInfo, bookId) {
  const packageRoot = resolveRunArtifact(
    runInfo.rootDir,
    runInfo.stages?.package?.artifacts?.gatewayDataDir || join('artifacts', 'gateway-data'),
  )
  const audioRoot = resolveRunArtifact(
    runInfo.rootDir,
    runInfo.stages?.audio?.artifacts?.gatewayAudioDir || join('artifacts', 'gateway-audio'),
  )
  const packagePath = join(packageRoot, 'books', bookId, 'package.json')
  const audioPath = join(audioRoot, 'books', bookId, 'audio.json')
  return {
    package: existsSync(packagePath) ? JSON.parse(await readFile(packagePath, 'utf8')) : null,
    audio: existsSync(audioPath) ? JSON.parse(await readFile(audioPath, 'utf8')) : null,
  }
}

async function resolveRunJsonPath(runPath) {
  if (runPath.endsWith('.json')) return resolve(runPath)
  const directRunDir = resolve(runPath, 'run.json')
  if (existsSync(directRunDir)) return directRunDir
  const defaultRunDir = resolve(defaultRunRoot, runPath, 'run.json')
  if (existsSync(defaultRunDir)) return defaultRunDir
  const runRoot = resolve(defaultRunRoot)
  if (existsSync(runRoot)) {
    for (const entry of await readdir(runRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nestedRunJson = join(runRoot, entry.name, runPath, 'run.json')
      if (existsSync(nestedRunJson)) return nestedRunJson
    }
  }
  return defaultRunDir
}

function resolveRunArtifact(runDir, artifactPath) {
  if (artifactPath.startsWith('/')) return artifactPath
  return resolve(runDir, artifactPath)
}

async function fetchGatewayJson(gatewayUrl, path, token = '') {
  const response = await fetch(`${gatewayUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Gateway ${path} returned ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

function assertCheck(name, ok, detail = {}) {
  return {
    name,
    ok: Boolean(ok),
    detail,
  }
}

function sameOrderedStrings(actual, expected) {
  if (actual.length !== expected.length) return false
  return actual.every((value, index) => String(value) === String(expected[index]))
}

async function readExistingGatewayCatalog(options) {
  if (options.catalogFile) {
    return parseCatalog(await readFile(expandPath(options.catalogFile), 'utf8'))
  }
  if (options.gatewayDataDir) {
    const catalogPath = join(expandPath(options.gatewayDataDir), 'books.json')
    if (!existsSync(catalogPath)) return { schemaVersion: 1, books: [] }
    return parseCatalog(await readFile(catalogPath, 'utf8'))
  }
  if (options.remoteHost) {
    if (options.dryRun) return { schemaVersion: 1, books: [] }
    const remoteDataDir = remoteDataDirFromOptions(options)
    try {
      const sshArgs = sshBaseArgs(options).concat(['cat', remoteShellQuote(remoteDataDir + '/books.json')])
      const { stdout } = await execFileAsync('ssh', sshArgs, { maxBuffer: 20 * 1024 * 1024 })
      return parseCatalog(stdout)
    } catch {
      return { schemaVersion: 1, books: [] }
    }
  }
  return { schemaVersion: 1, books: [] }
}

function parseCatalog(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.books)) return parsed
  } catch {
    // Fall through to an empty catalog.
  }
  return { schemaVersion: 1, books: [] }
}

function mergeBookCatalog(existingCatalog, bookSummary) {
  const books = (Array.isArray(existingCatalog?.books) ? existingCatalog.books : [])
    .filter((book) => book?.id && book.id !== bookSummary.id)
  books.push(bookSummary)
  books.sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '')
    return updatedDiff || String(left.title || left.id).localeCompare(String(right.title || right.id))
  })
  return {
    schemaVersion: 1,
    books,
  }
}

function buildPublishPlan(options, artifacts) {
  const { bookId, packageDir, booksJsonPath, audioDir } = artifacts
  if (options.gatewayDataDir) {
    const dataDir = expandPath(options.gatewayDataDir)
    const commands = []
    if (packageDir) {
      commands.push(
        ['mkdir', '-p', join(dataDir, 'books', bookId)],
        ['rsync', '-a', `${packageDir}/`, `${join(dataDir, 'books', bookId)}/`],
        ['rsync', '-a', booksJsonPath, `${join(dataDir, 'books.json')}`],
      )
    }
    if (audioDir) {
      const audioRoot = expandPath(options.gatewayAudioDir || join(dirname(dataDir), 'audio'))
      commands.push(
        ['mkdir', '-p', join(audioRoot, 'books', bookId)],
        ['rsync', '-a', '--delete', `${audioDir}/`, `${join(audioRoot, 'books', bookId)}/`],
      )
    }
    return {
      target: dataDir,
      commands,
    }
  }
  if (!options.remoteHost) {
    throw new Error('publish requires --gateway-data-dir <path> or --remote-host <host>')
  }

  const remoteDataDir = remoteDataDirFromOptions(options)
  const remoteAudioDir = remoteAudioDirFromOptions(options)
  const remoteBookDir = join(remoteDataDir, 'books', bookId)
  const remoteBookAudioDir = join(remoteAudioDir, 'books', bookId)
  const remoteHost = remoteLogin(options)
  const sshArgs = sshBaseArgs(options)
  const rsyncSsh = rsyncSshCommand(options)
  const commands = []
  if (packageDir) {
    commands.push(
      ['ssh', ...sshArgs, 'mkdir', '-p', remoteShellQuote(remoteBookDir)],
      ['rsync', '-az', '--delete', '-e', rsyncSsh, `${packageDir}/`, `${remoteHost}:${remoteShellQuote(remoteBookDir)}/`],
      ['rsync', '-az', '-e', rsyncSsh, booksJsonPath, `${remoteHost}:${remoteShellQuote(join(remoteDataDir, 'books.json'))}`],
    )
  }
  if (audioDir) {
    commands.push(
      ['ssh', ...sshArgs, 'mkdir', '-p', remoteShellQuote(remoteBookAudioDir)],
      ['rsync', '-az', '--delete', '-e', rsyncSsh, `${audioDir}/`, `${remoteHost}:${remoteShellQuote(remoteBookAudioDir)}/`],
    )
  }
  return {
    target: `${remoteHost}:${remoteDataDir}`,
    commands,
  }
}

function remoteDataDirFromOptions(options) {
  return options.remoteDataDir || join(options.remoteRoot || defaultRemoteRoot, 'data')
}

function remoteAudioDirFromOptions(options) {
  return options.remoteAudioDir || join(options.remoteRoot || defaultRemoteRoot, 'audio')
}

function remoteLogin(options) {
  return options.remoteUser ? `${options.remoteUser}@${options.remoteHost}` : options.remoteHost
}

function sshBaseArgs(options) {
  const args = []
  if (options.remoteSshPort || options.sshPort) args.push('-p', String(options.remoteSshPort || options.sshPort))
  args.push(remoteLogin(options))
  return args
}

function rsyncSshCommand(options) {
  const args = ['ssh']
  if (options.remoteSshPort || options.sshPort) args.push('-p', String(options.remoteSshPort || options.sshPort))
  return args.join(' ')
}

function remoteShellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function mergeRunStage(runJson, stage, stageValue) {
  return {
    ...runJson,
    status: stageValue.status === 'failed' ? 'failed' : runJson.status,
    updatedAt: stageValue.finishedAt || new Date().toISOString(),
    stages: {
      ...(runJson.stages || {}),
      [stage]: stageValue,
    },
  }
}

async function collectAudioArtifacts(root) {
  const artifacts = []
  await walkFiles(root, 6, async (filePath) => {
    if (!filePath.replace(/\\/g, '/').endsWith('/audio/chapter.mp3')) return
    const chapterNumber = inferAudioChapterNumber(filePath)
    if (!chapterNumber) return
    const manifestPath = join(dirname(filePath), 'manifest.json')
    artifacts.push({
      chapterNumber,
      mp3Path: filePath,
      manifestPath: existsSync(manifestPath) ? manifestPath : '',
    })
  })
  artifacts.sort((left, right) => left.chapterNumber - right.chapterNumber)
  return artifacts
}

async function walkFiles(dir, depth, onFile) {
  if (depth < 0) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'segments' || entry.name === 'work') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(fullPath, depth - 1, onFile)
    } else if (entry.isFile()) {
      await onFile(fullPath)
    }
  }
}

function inferAudioChapterNumber(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const match =
    normalized.match(/(?:^|\/)ch(?:apter)?[-_ ]?0*(\d+)[^/]*(?:\/audio\/chapter\.mp3)$/i) ||
    normalized.match(/(?:^|\/)(?:第)?0*(\d+)(?:章|[-_ ]?chapter)[^/]*(?:\/audio\/chapter\.mp3)$/i)
  if (!match) return null
  const number = Number(match[1])
  return Number.isInteger(number) && number > 0 ? number : null
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function durationField(manifest) {
  const seconds = Number(manifest?.duration)
  if (Number.isFinite(seconds) && seconds >= 0) return { durationMs: Math.round(seconds * 1000) }
  const durationMs = Number(manifest?.durationMs)
  if (Number.isFinite(durationMs) && durationMs >= 0) return { durationMs: Math.round(durationMs) }
  return {}
}

function readTimelineVersion(manifest) {
  const version = Number(manifest?.timelineVersion ?? manifest?.version)
  return Number.isInteger(version) && version >= 0 ? version : undefined
}

function chapterIndexForAudio(chapters, chapterId) {
  const index = chapters.findIndex((chapter) => String(chapter.id) === String(chapterId))
  return index >= 0 ? numberOrDefault(chapters[index].chapterIndex, index + 1) : Number.MAX_SAFE_INTEGER
}

function safePathSegment(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chapter'
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
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

function plainObject(value) {
  return Object.assign({}, value)
}

function numberOrDefault(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
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
  npm run production-pipeline -- package --book-id <id>
  npm run production-pipeline -- audio --book-id <id> --source-root <path>
  npm run production-pipeline -- publish --run <runId|runDir|run.json> [--dry-run]
  npm run production-pipeline -- verify --run <runId|runDir|run.json> --gateway-url <url>
  npm run production-pipeline -- status --run <runId|runDir|run.json>

Options:
  --main-db <path>     Main Novel Reader SQLite database.
  --run-root <path>    Run storage root. Default: ${defaultRunRoot}
  --gateway-data-dir   Local Gateway data directory for publish.
  --gateway-audio-dir  Local Gateway audio directory for publish.
  --gateway-url        Gateway base URL for verify.
  --gateway-token      Gateway bearer token for verify.
  --remote-host        Remote Gateway host for rsync publish.
  --remote-user        Remote SSH user.
  --remote-root        Remote Gateway root. Default: ${defaultRemoteRoot}
  --dry-run            Parse and write run artifacts without modifying the main DB.
  --replace            Replace an existing book with the same bookId.
`)
}
