#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const defaultRunRoot = 'tmp/production-pipeline/runs'
const defaultMainDbPath = '~/.novel_reader/novel_reader.sqlite'
const defaultRemoteRoot = '/home/gwaves/novel-reader-gateway'
const cliFilePath = fileURLToPath(import.meta.url)
const execFileAsync = promisify(execFile)
let DatabaseSyncCtor
let bookIngestModule
let embeddingUtilsModule

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
  if (command === 'run') {
    await runJob(options)
    return
  }
  if (command === 'doctor') {
    await runDoctor(options)
    return
  }
  if (command === 'resume') {
    await runResume(options)
    return
  }
  if (command === 'package') {
    await runPackage(options)
    return
  }
  if (command === 'summary') {
    await runSummary(options)
    return
  }
  if (command === 'kg') {
    await runKg(options)
    return
  }
  if (command === 'audio') {
    await runAudio(options)
    return
  }
  if (command === 'embedding') {
    await runEmbedding(options)
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
      dryRun: isFlagEnabled(options.dryRun),
      replace: isFlagEnabled(options.replace),
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
      status: isFlagEnabled(options.dryRun) ? 'skipped' : 'running',
      attempts: 1,
      startedAt,
      metadata: { chapterCount: chapters.length, sourceSha256: sha256 },
    })

    if (!isFlagEnabled(options.dryRun)) {
      await writeBookToMainDb(mainDbPath, {
        id: bookId,
        title,
        importedAt,
        chapters,
        replace: isFlagEnabled(options.replace),
      })
    }

    const finishedAt = new Date().toISOString()
    await recordStageItem(run.itemsDbPath, {
      stage: 'import',
      itemId: bookId,
      itemType: 'book',
      status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: { chapterCount: chapters.length, sourceSha256: sha256 },
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'import',
      status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, title, source: importReport.source },
      stages: {
        import: {
          status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
          startedAt,
          finishedAt,
          message: isFlagEnabled(options.dryRun)
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
    if (isFlagEnabled(options.dryRun)) console.log('dry-run: main database was not modified')
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

async function runJob(options) {
  const jobPath = resolve(required(options.job, 'run requires --job <path>'))
  const job = normalizeJobConfig(JSON.parse(await readFile(jobPath, 'utf8')))
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || job.mainDbPath || job.source?.mainDbPath || defaultMainDbPath)
  const run = await createRun({
    command: 'run',
    options: redactSensitiveOptions(options),
    mainDbPath,
    bookId: job.bookId,
  })
  await writeRunJson(run.runJsonPath, {
    runId: run.runId,
    command: 'run',
    status: 'running',
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    mainDbPath,
    jobPath,
    job,
    stages: {},
  })
  await executeJobStages({ runInfo: await loadRunInfo(run.runJsonPath), job, mainDbPath, resume: false })
}

async function runDoctor(options) {
  const jobPath = resolve(required(options.job, 'doctor requires --job <path>'))
  const rawJob = JSON.parse(await readFile(jobPath, 'utf8'))
  const checks = []
  let job = null
  try {
    job = normalizeJobConfig(rawJob)
    addDoctorCheck(checks, 'job.parse', true, `loaded ${jobPath}`)
  } catch (error) {
    addDoctorCheck(checks, 'job.parse', false, error.message)
  }
  if (job) {
    const mainDbPath = expandPath(options.mainDb || options.mainDbPath || job.mainDbPath || job.source?.mainDbPath || defaultMainDbPath)
    await inspectJobPreflight({ checks, job, jobPath, mainDbPath })
  }
  const failed = checks.filter((check) => !check.ok)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    jobPath,
    ok: failed.length === 0,
    checks,
  }
  if (isFlagEnabled(options.json)) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`job: ${jobPath}`)
    console.log(`checks: ${checks.length - failed.length}/${checks.length}`)
    for (const check of checks) {
      console.log(`${check.ok ? 'ok' : 'fail'}: ${check.name}${check.message ? ` - ${check.message}` : ''}`)
    }
  }
  if (failed.length) throw new Error(`Doctor failed: ${failed.length} check(s) failed.`)
}

async function runResume(options) {
  const runInfo = await loadRunInfo(required(options.run, 'resume requires --run <runId or run path>'))
  const job = normalizeJobConfig(runInfo.runJson.job || {})
  const mainDbPath = runInfo.runJson.mainDbPath || expandPath(job.mainDbPath || job.source?.mainDbPath || defaultMainDbPath)
  await executeJobStages({ runInfo, job, mainDbPath, resume: true })
}

async function executeJobStages({ runInfo, job, mainDbPath, resume }) {
  const stages = normalizeStageList(job.stages)
  const stageResults = { ...(runInfo.runJson.stages || {}) }
  const context = {
    packageRunJson: findLatestChildRun(stageResults.package),
    audioRunJson: findLatestChildRun(stageResults.audio),
  }

  for (const stage of stages) {
    if (resume && stageResults[stage]?.status === 'completed') {
      console.log(`skip: ${stage} already completed`)
      continue
    }

    const startedAt = new Date().toISOString()
    stageResults[stage] = {
      status: 'running',
      startedAt,
    }
    await writeRunJson(runInfo.runJsonPath, {
      ...runInfo.runJson,
      status: 'running',
      updatedAt: startedAt,
      stages: stageResults,
    })

    try {
      const result = await executePipelineStage({
        stage,
        runInfo,
        job,
        mainDbPath,
        context,
        onChildStart: async (child) => {
          const runningStage = stageResults[stage] || { status: 'running', startedAt }
          stageResults[stage] = mergeRunningChildStage(runningStage, child)
          await writeRunJson(runInfo.runJsonPath, {
            ...runInfo.runJson,
            status: 'running',
            updatedAt: new Date().toISOString(),
            stages: stageResults,
          })
        },
      })
      const finishedAt = new Date().toISOString()
      stageResults[stage] = {
        status: 'completed',
        startedAt,
        finishedAt,
        ...result,
      }
      if (stage === 'package') context.packageRunJson = result.childRunJson
      if (stage === 'audio') context.audioRunJson = result.childRunJson
      await writeRunJson(runInfo.runJsonPath, {
        ...runInfo.runJson,
        status: 'running',
        updatedAt: finishedAt,
        stages: stageResults,
      })
      console.log(`completed: ${stage}`)
    } catch (error) {
      const finishedAt = new Date().toISOString()
      stageResults[stage] = {
        status: 'failed',
        startedAt,
        finishedAt,
        error: error.message,
        ...childFailureMetadata(error),
      }
      await writeRunJson(runInfo.runJsonPath, {
        ...runInfo.runJson,
        status: 'failed',
        updatedAt: finishedAt,
        stages: stageResults,
      })
      throw error
    }
  }

  const finishedAt = new Date().toISOString()
  await writeRunJson(runInfo.runJsonPath, {
    ...runInfo.runJson,
    status: 'completed',
    updatedAt: finishedAt,
    stages: stageResults,
  })
  console.log(`run: ${runInfo.runJson.runId}`)
  console.log(`runDir: ${runInfo.rootDir}`)
  console.log('status: completed')
}

async function executePipelineStage({ stage, runInfo, job, mainDbPath, context, onChildStart }) {
  if (stage === 'publish') {
    const childRuns = []
    if (context.packageRunJson) childRuns.push(await executeChildStage(stage, buildPublishArgs(job, context.packageRunJson), runInfo, { onStart: onChildStart }))
    if (context.audioRunJson) childRuns.push(await executeChildStage(stage, buildPublishArgs(job, context.audioRunJson), runInfo, { onStart: onChildStart }))
    if (!childRuns.length) throw new Error('publish requires a completed package or audio stage.')
    return {
      message: `published ${childRuns.length} artifact run(s).`,
      childRuns,
    }
  }
  if (stage === 'verify') {
    const childRuns = []
    if (context.packageRunJson) childRuns.push(await executeChildStage(stage, buildVerifyArgs(job, context.packageRunJson), runInfo, { onStart: onChildStart }))
    if (context.audioRunJson) childRuns.push(await executeChildStage(stage, buildVerifyArgs(job, context.audioRunJson), runInfo, { onStart: onChildStart }))
    if (!childRuns.length) throw new Error('verify requires a completed package or audio stage.')
    return {
      message: `verified ${childRuns.length} artifact run(s).`,
      childRuns,
    }
  }

  const args = buildStageArgs(stage, job, mainDbPath, runInfo)
  const childRun = await executeChildStage(stage, args, runInfo, { onStart: onChildStart })
  return {
    message: `completed ${stage}.`,
    childRunJson: childRun.childRunJson,
    childRunDir: childRun.childRunDir,
    logFile: childRun.logFile,
  }
}

function mergeRunningChildStage(stageValue, child) {
  if (stageValue.childRuns || child.childRunJson) {
    return {
      ...stageValue,
      childRuns: [...(stageValue.childRuns || []), child],
    }
  }
  return {
    ...stageValue,
    ...child,
  }
}

async function executeChildStage(stage, args, runInfo, { onStart } = {}) {
  const logFile = join(runInfo.rootDir, 'logs', `${stage}-${Date.now()}.log`)
  await mkdir(dirname(logFile), { recursive: true })
  const initialChildRunJson = readArgValue(args, '--run')
  await onStart?.({
    stage,
    ...(initialChildRunJson ? { childRunJson: initialChildRunJson, childRunDir: dirname(initialChildRunJson) } : {}),
    logFile: relativeRunPath(runInfo.rootDir, logFile),
  })
  let stdout = ''
  let stderr = ''
  try {
    ;({ stdout, stderr } = await execFileStreaming(process.execPath, [cliFilePath, ...args], logFile))
  } catch (error) {
    stdout = error.stdout || ''
    stderr = error.stderr || error.message
    attachChildStageFailureMetadata(error, { stdout, stage, runInfo, logFile, args })
    throw error
  }
  const childRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
    || dirname(stdout.match(/(?:package|audio|report): (.+)/)?.[1]?.trim() || '')
  const childRunId = stdout.match(/run: (.+)/)?.[1]?.trim()
  const childRunJson = childRunDir && existsSync(join(childRunDir, 'run.json'))
    ? join(childRunDir, 'run.json')
    : findChildRunJson(runInfo.rootDir, stage, childRunId) || readArgValue(args, '--run')
  return {
    stage,
    childRunId,
    childRunDir: childRunJson ? dirname(childRunJson) : childRunDir,
    childRunJson,
    logFile: relativeRunPath(runInfo.rootDir, logFile),
  }
}

async function execFileStreaming(command, args, logFile) {
  const logStream = createWriteStream(logFile, { flags: 'w' })
  let stdout = ''
  let stderr = ''
  let wroteStderrHeader = false
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    logStream.write(text)
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderr += text
    if (!wroteStderrHeader) {
      logStream.write('\n--- stderr ---\n')
      wroteStderrHeader = true
    }
    logStream.write(text)
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  await new Promise((resolve) => logStream.end(resolve))
  if (code !== 0) {
    const error = new Error(`Command failed: ${command} ${args.join(' ')}`)
    error.stdout = stdout
    error.stderr = stderr
    throw error
  }
  return { stdout, stderr }
}

function attachChildStageFailureMetadata(error, { stdout, stage, runInfo, logFile, args }) {
  const childRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
    || dirname(stdout.match(/(?:package|audio|report): (.+)/)?.[1]?.trim() || '')
  const childRunId = stdout.match(/run: (.+)/)?.[1]?.trim()
  const childRunJson = childRunDir && existsSync(join(childRunDir, 'run.json'))
    ? join(childRunDir, 'run.json')
    : findChildRunJson(runInfo.rootDir, stage, childRunId) || readArgValue(args, '--run')
  error.childRunId = childRunId || undefined
  error.childRunDir = childRunJson ? dirname(childRunJson) : (childRunDir || undefined)
  error.childRunJson = childRunJson || undefined
  error.logFile = relativeRunPath(runInfo.rootDir, logFile)
}

function childFailureMetadata(error) {
  return {
    ...(error.childRunId ? { childRunId: error.childRunId } : {}),
    ...(error.childRunDir ? { childRunDir: error.childRunDir } : {}),
    ...(error.childRunJson ? { childRunJson: error.childRunJson } : {}),
    ...(error.logFile ? { logFile: error.logFile } : {}),
  }
}

function readArgValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] || '' : ''
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
        summaryCount: book.summaries.length,
        summaryEmbeddingCount: book.embeddingCoverage.summary.embeddedSummaries,
        chunkEmbeddingCount: book.embeddingCoverage.chunks.embeddedChunks,
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
    console.log(`summaries: ${book.summaries.length}`)
    console.log(`summary embeddings: ${book.embeddingCoverage.summary.embeddedSummaries}/${book.summaries.length}`)
    console.log(`chunk embeddings: ${book.embeddingCoverage.chunks.embeddedChunks}`)
    console.log(`package: ${packagePath}`)
    console.log(`runDir: ${run.rootDir}`)
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

async function runSummary(options) {
  const bookId = required(options.bookId, 'summary requires --book-id <id>')
  const model = required(options.model, 'summary requires --model <name>')
  const provider = String(options.provider || 'openai-compatible').trim()
  const baseUrl = required(options.baseUrl, 'summary requires --base-url <url>')
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'summary', options: redactSensitiveOptions(options), mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const concurrency = clampInteger(options.concurrency, 4, 1, 32)
    const limit = clampInteger(options.limit, 0, 0, Number.MAX_SAFE_INTEGER)
    const timeoutMs = clampInteger(options.timeoutMs, 300_000, 1_000, 900_000)
    const maxAttempts = clampInteger(options.maxAttempts || options.retries, 3, 1, 10)
    const force = isFlagEnabled(options.force)
    const llmConfig = {
      provider,
      model,
      baseUrl,
      apiKey: options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0,
      thinkingEnabled: !isFlagEnabled(options.disableThinking),
      timeoutMs,
      maxAttempts,
    }

    const db = await openMainDbForSummary(mainDbPath)
    let targets
    try {
      targets = readSummaryTargets(db, { bookId, force, limit })
    } finally {
      db.close()
    }

    const results = {
      completed: 0,
      failed: 0,
      total: targets.length,
      errors: [],
    }
    const progress = createStageProgressLogger({
      stage: 'summary',
      total: targets.length,
      getProgress: () => ({
        completed: results.completed,
        failed: results.failed,
      }),
    })
    progress.start()

    if (!isFlagEnabled(options.dryRun) && targets.length > 0) {
      await runPool(targets, concurrency, async (chapter) => {
        try {
          const summary = await generateChapterSummary(chapter, llmConfig)
          const writeDb = await openMainDbForSummary(mainDbPath)
          try {
            writeSummary(writeDb, chapter.id, summary)
          } finally {
            writeDb.close()
          }
          results.completed += 1
        } catch (error) {
          results.failed += 1
          pushLimited(results.errors, {
            chapterId: chapter.id,
            chapterIndex: chapter.chapterIndex,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        progress.tick()
      })
    }
    progress.finish()

    const finishedAt = new Date().toISOString()
    const report = {
      schemaVersion: 1,
      generatedAt: finishedAt,
      bookId,
      provider,
      model,
      concurrency,
      force,
      dryRun: isFlagEnabled(options.dryRun),
      targetChapters: targets.length,
      ...results,
    }
    const reportPath = join(run.artifactsDir, 'summary-report.json')
    await writeJson(reportPath, report)
    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'summary',
      itemId: bookId,
      itemType: 'book',
      status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: report,
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'summary',
      status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        summary: {
          status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
          startedAt,
          finishedAt,
          message: `summary targets ${targets.length}, completed ${results.completed}, failed ${results.failed}.`,
          artifacts: {
            summaryReport: relativeRunPath(run.rootDir, reportPath),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId}`)
    console.log(`summary targets: ${targets.length}`)
    console.log(`completed: ${results.completed}`)
    console.log(`failed: ${results.failed}`)
    console.log(`report: ${reportPath}`)
    console.log(`runDir: ${run.rootDir}`)
    if (isFlagEnabled(options.dryRun)) console.log('dry-run: summaries were not generated or written')
    if (results.failed) throw new Error('Summary completed with failures.')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'summary',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        summary: {
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

async function runKg(options) {
  const bookId = required(options.bookId, 'kg requires --book-id <id>')
  const model = required(options.model, 'kg requires --model <name>')
  const provider = String(options.provider || 'openai-compatible').trim()
  const baseUrl = required(options.baseUrl, 'kg requires --base-url <url>')
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'kg', options: redactSensitiveOptions(options), mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const concurrency = clampInteger(options.concurrency, 3, 1, 16)
    const limit = clampInteger(options.limit, 0, 0, Number.MAX_SAFE_INTEGER)
    const timeoutMs = clampInteger(options.timeoutMs, 300_000, 1_000, 900_000)
    const maxAttempts = clampInteger(options.maxAttempts || options.retries, 3, 1, 10)
    const force = isFlagEnabled(options.force)
    const llmConfig = {
      provider,
      model,
      baseUrl,
      apiKey: options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0,
      thinkingEnabled: !isFlagEnabled(options.disableThinking),
      timeoutMs,
      maxAttempts,
    }

    const db = await openMainDbForKg(mainDbPath)
    let targets
    try {
      targets = readKgTargets(db, { bookId, force, limit })
    } finally {
      db.close()
    }

    const results = {
      completed: 0,
      failed: 0,
      total: targets.length,
      entityMentions: 0,
      relationMentions: 0,
      errors: [],
    }
    const progress = createStageProgressLogger({
      stage: 'kg',
      total: targets.length,
      getProgress: () => ({
        completed: results.completed,
        failed: results.failed,
        entityMentions: results.entityMentions,
        relationMentions: results.relationMentions,
      }),
    })
    progress.start()

    if (!isFlagEnabled(options.dryRun) && targets.length > 0) {
      await runPool(targets, concurrency, async (chapter) => {
        try {
          const extraction = await generateChapterKnowledgeGraph(chapter, llmConfig)
          const writeDb = await openMainDbForKg(mainDbPath)
          try {
            const writeResult = writeKgExtraction(writeDb, chapter, {
              ...extraction,
              model,
            })
            results.entityMentions += writeResult.entityMentions
            results.relationMentions += writeResult.relationMentions
          } finally {
            writeDb.close()
          }
          results.completed += 1
        } catch (error) {
          results.failed += 1
          pushLimited(results.errors, {
            chapterId: chapter.id,
            chapterIndex: chapter.chapterIndex,
            error: error instanceof Error ? error.message : String(error),
          })
          const errorDb = await openMainDbForKg(mainDbPath)
          try {
            writeKgExtractionError(errorDb, chapter, model, error)
          } finally {
            errorDb.close()
          }
        }
        progress.tick()
      })
    }
    progress.finish()

    const finishedAt = new Date().toISOString()
    const report = {
      schemaVersion: 1,
      generatedAt: finishedAt,
      bookId,
      provider,
      model,
      concurrency,
      force,
      dryRun: isFlagEnabled(options.dryRun),
      targetChapters: targets.length,
      ...results,
    }
    const reportPath = join(run.artifactsDir, 'kg-report.json')
    await writeJson(reportPath, report)
    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'kg',
      itemId: bookId,
      itemType: 'book',
      status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: report,
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'kg',
      status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        kg: {
          status: results.failed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
          startedAt,
          finishedAt,
          message: `kg targets ${targets.length}, completed ${results.completed}, failed ${results.failed}.`,
          artifacts: {
            kgReport: relativeRunPath(run.rootDir, reportPath),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId}`)
    console.log(`kg targets: ${targets.length}`)
    console.log(`completed: ${results.completed}`)
    console.log(`failed: ${results.failed}`)
    console.log(`entity mentions: ${results.entityMentions}`)
    console.log(`relation mentions: ${results.relationMentions}`)
    console.log(`report: ${reportPath}`)
    console.log(`runDir: ${run.rootDir}`)
    if (isFlagEnabled(options.dryRun)) console.log('dry-run: knowledge graph was not generated or written')
    if (results.failed) throw new Error('KG completed with failures.')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'kg',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        kg: {
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
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'audio', options, mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const book = await readBookFromMainDb(mainDbPath, bookId)
    const sourceRoot = await prepareAudioSourceRoot({ options, run, book })
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
        if (isFlagEnabled(options.strict)) throw new Error(`No chapter ${artifact.chapterNumber} found in main DB for ${bookId}`)
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

      if (!isFlagEnabled(options.dryRun)) {
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
      status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: {
        audioChapterCount: catalog.chapters.length,
        copiedFiles,
        sourceRoot,
        generatedTts: shouldGenerateTts(options),
      },
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'audio',
      status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, title: book.title, sourceRoot },
      stages: {
        audio: {
          status: isFlagEnabled(options.dryRun) ? 'skipped' : 'completed',
          startedAt,
          finishedAt,
          message: `prepared ${catalog.chapters.length} audio chapters.`,
          artifacts: {
            gatewayAudioDir: relativeRunPath(run.rootDir, join(run.artifactsDir, 'gateway-audio')),
            audioCatalog: relativeRunPath(run.rootDir, catalogPath),
            ...(shouldGenerateTts(options)
              ? {
                  ttsSourceRoot: relativeRunPath(run.rootDir, sourceRoot),
                  ...(options.ttsSummaryPath ? { ttsSummary: relativeRunPath(run.rootDir, options.ttsSummaryPath) } : {}),
                }
              : {}),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId} ${book.title}`)
    console.log(`audio chapters: ${catalog.chapters.length}`)
    console.log(`audio: ${catalogPath}`)
    console.log(`runDir: ${run.rootDir}`)
    if (isFlagEnabled(options.dryRun)) console.log('dry-run: audio files were not copied')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'audio',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, sourceRoot: options.sourceRoot || options.ttsOutRoot },
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

async function runEmbedding(options) {
  const bookId = required(options.bookId, 'embedding requires --book-id <id>')
  const model = required(options.model, 'embedding requires --model <name>')
  const provider = String(options.provider || 'ollama').trim()
  const baseUrl = required(options.baseUrl, 'embedding requires --base-url <url>')
  const mainDbPath = expandPath(options.mainDb || options.mainDbPath || defaultMainDbPath)
  const run = await createRun({ command: 'embedding', options: redactSensitiveOptions(options), mainDbPath, bookId })
  const startedAt = new Date().toISOString()

  try {
    const concurrency = clampInteger(options.concurrency, provider === 'ollama' ? 3 : 8, 1, 32)
    const limit = clampInteger(options.limit, 0, 0, Number.MAX_SAFE_INTEGER)
    const timeoutMs = clampInteger(options.timeoutMs, 300_000, 1_000, 900_000)
    const maxAttempts = clampInteger(options.maxAttempts || options.retries, 4, 1, 10)
    const force = isFlagEnabled(options.force)
    const embeddingConfig = {
      provider,
      model,
      baseUrl,
      apiKey: options.apiKey || process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
      timeoutMs,
      maxAttempts,
    }
    const utils = await loadEmbeddingUtils()
    const db = await openMainDbForEmbedding(mainDbPath)
    let targets
    try {
      targets = readEmbeddingTargets(db, { bookId, model, force, limit, utils })
    } finally {
      db.close()
    }

    const results = {
      completed: 0,
      failed: 0,
      total: targets.length,
      chunkCompleted: 0,
      chunkFailed: 0,
      errors: [],
      chunkErrors: [],
      dimension: null,
    }
    const progress = createStageProgressLogger({
      stage: 'embedding',
      total: targets.length,
      getProgress: () => ({
        completed: results.completed,
        failed: results.failed,
        chunkCompleted: results.chunkCompleted,
        chunkFailed: results.chunkFailed,
      }),
    })
    progress.start()

    if (!isFlagEnabled(options.dryRun) && targets.length > 0) {
      await runPool(targets, concurrency, async (target) => {
        await embedChapterTarget({
          dbPath: mainDbPath,
          bookId,
          model,
          force,
          target,
          embeddingConfig,
          utils,
          results,
        })
        progress.tick()
      })
    }
    progress.finish()

    const finishedAt = new Date().toISOString()
    const report = {
      schemaVersion: 1,
      generatedAt: finishedAt,
      bookId,
      provider,
      model,
      concurrency,
      force,
      dryRun: isFlagEnabled(options.dryRun),
      targetChapters: targets.length,
      ...results,
    }
    const reportPath = join(run.artifactsDir, 'embedding-report.json')
    await writeJson(reportPath, report)
    await initializeItemsDb(run.itemsDbPath)
    await recordStageItem(run.itemsDbPath, {
      stage: 'embedding',
      itemId: bookId,
      itemType: 'book',
      status: results.failed || results.chunkFailed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      attempts: 1,
      startedAt,
      finishedAt,
      metadata: report,
    })
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'embedding',
      status: results.failed || results.chunkFailed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        embedding: {
          status: results.failed || results.chunkFailed ? 'failed' : (isFlagEnabled(options.dryRun) ? 'skipped' : 'completed'),
          startedAt,
          finishedAt,
          message: `embedding targets ${targets.length}, completed ${results.completed}, failed ${results.failed}.`,
          artifacts: {
            embeddingReport: relativeRunPath(run.rootDir, reportPath),
          },
        },
      },
    })

    console.log(`run: ${run.runId}`)
    console.log(`book: ${bookId}`)
    console.log(`embedding targets: ${targets.length}`)
    console.log(`completed: ${results.completed}`)
    console.log(`failed: ${results.failed}`)
    console.log(`chunks: ${results.chunkCompleted}/${results.chunkCompleted + results.chunkFailed}`)
    console.log(`report: ${reportPath}`)
    console.log(`runDir: ${run.rootDir}`)
    if (isFlagEnabled(options.dryRun)) console.log('dry-run: embeddings were not generated or written')
    if (results.failed || results.chunkFailed) throw new Error('Embedding completed with failures.')
  } catch (error) {
    const finishedAt = new Date().toISOString()
    await writeRunJson(run.runJsonPath, {
      runId: run.runId,
      command: 'embedding',
      status: 'failed',
      createdAt: run.createdAt,
      updatedAt: finishedAt,
      mainDbPath,
      job: { bookId, provider, model },
      stages: {
        embedding: {
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
  if (isFlagEnabled(options.dryRun)) {
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
    if (Array.isArray(expected.package.summaries)) {
      const remoteSummaries = Array.isArray(remotePackage?.summaries) ? remotePackage.summaries : []
      checks.push(assertCheck('package.summaryCount', remoteSummaries.length === expected.package.summaries.length, {
        actual: remoteSummaries.length,
        expected: expected.package.summaries.length,
      }))
      checks.push(assertCheck('package.summaryChapterIds', sameOrderedStrings(
        remoteSummaries.map((summary) => summary.chapterId),
        expected.package.summaries.map((summary) => summary.chapterId),
      ), {
        actual: remoteSummaries.map((summary) => summary.chapterId),
        expected: expected.package.summaries.map((summary) => summary.chapterId),
      }))
    }
    if (expected.package.embeddings?.coverage) {
      checks.push(assertCheck(
        'package.embeddingCoverage',
        sameJson(remotePackage?.embeddings?.coverage, expected.package.embeddings.coverage),
        {
          actual: remotePackage?.embeddings?.coverage,
          expected: expected.package.embeddings.coverage,
        },
      ))
    }
    if (expected.package.knowledgeGraph) {
      const remoteKg = remotePackage?.knowledgeGraph || {}
      const expectedKg = expected.package.knowledgeGraph
      for (const key of ['entities', 'entityMentions', 'relations', 'relationMentions']) {
        const actualCount = Array.isArray(remoteKg[key]) ? remoteKg[key].length : 0
        const expectedCount = Array.isArray(expectedKg[key]) ? expectedKg[key].length : 0
        checks.push(assertCheck(`package.knowledgeGraph.${key}`, actualCount === expectedCount, {
          actual: actualCount,
          expected: expectedCount,
        }))
      }
    }
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
    const audioSampleCount = clampInteger(options.audioSampleCount || options.audioSamples, 1, 0, 20)
    for (const chapter of expectedAudioChapters.slice(0, audioSampleCount)) {
      const encodedChapterId = encodeURIComponent(chapter.chapterId)
      if (chapter.manifestFileName) {
        try {
          const manifest = await fetchGatewayJson(
            gatewayUrl,
            `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodedChapterId}/manifest`,
            gatewayToken,
          )
          const actualTimelineVersion = readTimelineVersion(manifest)
          const expectedTimelineVersion = chapter.timelineVersion
          checks.push(assertCheck(`audio.manifest.${chapter.chapterId}`, Boolean(manifest && typeof manifest === 'object'), {
            chapterId: chapter.chapterId,
          }))
          if (expectedTimelineVersion !== undefined) {
            checks.push(assertCheck(`audio.manifestTimelineVersion.${chapter.chapterId}`, actualTimelineVersion === expectedTimelineVersion, {
              actual: actualTimelineVersion,
              expected: expectedTimelineVersion,
            }))
          }
        } catch (error) {
          checks.push(assertCheck(`audio.manifest.${chapter.chapterId}`, false, {
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }
      try {
        const download = await fetchGatewayResponse(
          gatewayUrl,
          `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodedChapterId}/download`,
          gatewayToken,
        )
        const bytes = await download.arrayBuffer()
        checks.push(assertCheck(`audio.download.${chapter.chapterId}`, bytes.byteLength > 0, {
          chapterId: chapter.chapterId,
          contentType: download.headers.get('content-type') || '',
          bytes: bytes.byteLength,
        }))
      } catch (error) {
        checks.push(assertCheck(`audio.download.${chapter.chapterId}`, false, {
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
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
  if (isFlagEnabled(options.json)) {
    console.log(JSON.stringify(runInfo.runJson, null, 2))
    return
  }
  const lines = await buildStatusLines(runInfo, {
    logLines: clampInteger(options.logLines, 8, 0, 80),
  })
  console.log(lines.join('\n'))
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
    const summaries = readSummariesForPackage(db, bookId)
    const embeddingCoverage = readEmbeddingCoverageForPackage(db, bookId, chapters.length, summaries.length)
    const knowledgeGraph = readKnowledgeGraphForPackage(db, bookId)

    return {
      ...plainObject(book),
      chapters: chapters.map(plainObject),
      summaries,
      embeddingCoverage,
      knowledgeGraph,
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
  const summaries = book.summaries.map((summary) => ({
    chapterId: String(summary.chapterId),
    short: String(summary.short || ''),
    detail: String(summary.detail || ''),
    keyPoints: safeJsonParse(summary.keyPointsJson, []),
    skippable: summary.skippable,
    generatedBy: summary.generatedBy,
    updatedAt: summary.updatedAt || generatedAt,
  }))
  const knowledgeGraph = normalizeKnowledgeGraphForPackage(book.knowledgeGraph)
  const embeddingCoverage = normalizeEmbeddingCoverage(book.embeddingCoverage, chapters.length, summaries.length)
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
      summaryCoverage: coverageRatio(summaries.length, chapters.length),
      embeddingCoverage: embeddingCoverage.summary.coverage,
      updatedAt: book.updatedAt || book.importedAt || generatedAt,
    },
    chapters,
    summaries,
    knowledgeGraph,
    embeddings: {
      coverage: embeddingCoverage,
      summaries: [],
      chunks: [],
    },
  }
}

function readSummariesForPackage(db, bookId) {
  if (!sqliteTableExists(db, 'summaries')) return []
  return db.prepare(`
    SELECT
      s.chapter_id AS chapterId,
      s.short,
      s.detail,
      s.key_points_json AS keyPointsJson,
      s.skippable,
      s.generated_by AS generatedBy,
      s.updated_at AS updatedAt
    FROM summaries s
    JOIN chapters c ON c.id = s.chapter_id
    WHERE c.book_id = ?
    ORDER BY c.chapter_index, c.title
  `).all(bookId).map(plainObject)
}

function readEmbeddingCoverageForPackage(db, bookId, totalChapters, totalSummaries) {
  const summary = sqliteTableExists(db, 'summary_embeddings')
    ? db.prepare(`
      SELECT
        COUNT(*) AS embeddedSummaries,
        COUNT(DISTINCT chapter_id) AS embeddedChapters
      FROM summary_embeddings
      WHERE book_id = ?
    `).get(bookId)
    : { embeddedSummaries: 0, embeddedChapters: 0 }
  const chunks = sqliteTableExists(db, 'chapter_chunk_embeddings')
    ? db.prepare(`
      SELECT
        COUNT(*) AS embeddedChunks,
        COUNT(DISTINCT chapter_id) AS embeddedChapters
      FROM chapter_chunk_embeddings
      WHERE book_id = ?
    `).get(bookId)
    : { embeddedChunks: 0, embeddedChapters: 0 }
  return normalizeEmbeddingCoverage({
    summary: {
      embeddedSummaries: numberOrDefault(summary.embeddedSummaries, 0),
      embeddedChapters: numberOrDefault(summary.embeddedChapters, 0),
      models: readEmbeddingModelStats(db, 'summary_embeddings', bookId),
    },
    chunks: {
      embeddedChunks: numberOrDefault(chunks.embeddedChunks, 0),
      embeddedChapters: numberOrDefault(chunks.embeddedChapters, 0),
      models: readEmbeddingModelStats(db, 'chapter_chunk_embeddings', bookId),
    },
  }, totalChapters, totalSummaries)
}

function readKnowledgeGraphForPackage(db, bookId) {
  if (!sqliteTableExists(db, 'kg_entities')) return emptyKnowledgeGraph()
  return normalizeKnowledgeGraphForPackage({
    entities: db.prepare(`
      SELECT
        id,
        book_id AS bookId,
        type,
        name,
        normalized_name AS normalizedName,
        aliases_json AS aliasesJson,
        description,
        confidence,
        first_chapter_index AS firstChapterIndex,
        last_chapter_index AS lastChapterIndex,
        review_status AS reviewStatus,
        updated_at AS updatedAt
      FROM kg_entities
      WHERE book_id = ?
      ORDER BY type ASC, name ASC
    `).all(bookId).map(plainObject),
    entityMentions: sqliteTableExists(db, 'kg_entity_mentions') ? db.prepare(`
      SELECT
        id,
        entity_id AS entityId,
        book_id AS bookId,
        chapter_id AS chapterId,
        chapter_index AS chapterIndex,
        evidence,
        confidence
      FROM kg_entity_mentions
      WHERE book_id = ?
      ORDER BY chapter_index ASC
    `).all(bookId).map(plainObject) : [],
    relations: sqliteTableExists(db, 'kg_relations') ? db.prepare(`
      SELECT
        id,
        book_id AS bookId,
        source_entity_id AS sourceEntityId,
        target_entity_id AS targetEntityId,
        type,
        description,
        confidence,
        first_chapter_index AS firstChapterIndex,
        last_chapter_index AS lastChapterIndex,
        review_status AS reviewStatus,
        updated_at AS updatedAt
      FROM kg_relations
      WHERE book_id = ?
      ORDER BY type ASC, updated_at DESC
    `).all(bookId).map(plainObject) : [],
    relationMentions: sqliteTableExists(db, 'kg_relation_mentions') ? db.prepare(`
      SELECT
        id,
        relation_id AS relationId,
        book_id AS bookId,
        chapter_id AS chapterId,
        chapter_index AS chapterIndex,
        evidence,
        confidence
      FROM kg_relation_mentions
      WHERE book_id = ?
      ORDER BY chapter_index ASC
    `).all(bookId).map(plainObject) : [],
  })
}

function normalizeKnowledgeGraphForPackage(knowledgeGraph) {
  return {
    entities: safeArray(knowledgeGraph?.entities).map((entity) => ({
      ...entity,
      aliases: Array.isArray(entity.aliases)
        ? entity.aliases
        : safeJsonParse(entity.aliasesJson ?? entity.aliases_json, []),
      aliasesJson: undefined,
      aliases_json: undefined,
    })),
    entityMentions: safeArray(knowledgeGraph?.entityMentions),
    relations: safeArray(knowledgeGraph?.relations),
    relationMentions: safeArray(knowledgeGraph?.relationMentions),
  }
}

function emptyKnowledgeGraph() {
  return {
    entities: [],
    entityMentions: [],
    relations: [],
    relationMentions: [],
  }
}

function readEmbeddingModelStats(db, tableName, bookId) {
  if (!sqliteTableExists(db, tableName)) return []
  return db.prepare(`
    SELECT model, dimension, COUNT(*) AS count
    FROM ${tableName}
    WHERE book_id = ?
    GROUP BY model, dimension
    ORDER BY count DESC, model ASC, dimension ASC
  `).all(bookId).map((row) => ({
    model: String(row.model || ''),
    dimension: numberOrDefault(row.dimension, 0),
    count: numberOrDefault(row.count, 0),
  }))
}

function normalizeEmbeddingCoverage(coverage, totalChapters, totalSummaries) {
  const summary = coverage?.summary || {}
  const chunks = coverage?.chunks || {}
  const embeddedSummaryChapters = numberOrDefault(summary.embeddedChapters, 0)
  const embeddedSummaries = numberOrDefault(summary.embeddedSummaries, embeddedSummaryChapters)
  const embeddedChunkChapters = numberOrDefault(chunks.embeddedChapters, 0)
  const embeddedChunks = numberOrDefault(chunks.embeddedChunks, 0)
  return {
    summary: {
      embeddedSummaries,
      embeddedChapters: embeddedSummaryChapters,
      totalSummaries,
      totalChapters,
      coverage: coverageRatio(embeddedSummaryChapters, totalChapters),
      availableSummaryCoverage: coverageRatio(embeddedSummaries, totalSummaries),
      models: Array.isArray(summary.models) ? summary.models : [],
    },
    chunks: {
      embeddedChunks,
      embeddedChapters: embeddedChunkChapters,
      totalChapters,
      coverage: coverageRatio(embeddedChunkChapters, totalChapters),
      models: Array.isArray(chunks.models) ? chunks.models : [],
    },
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

async function openMainDbForEmbedding(dbPath) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  ensureEmbeddingSchema(db)
  return db
}

async function openMainDbForSummary(dbPath) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  ensureSummarySchema(db)
  return db
}

async function openMainDbForKg(dbPath) {
  const DatabaseSync = await loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  ensureKgSchema(db)
  return db
}

function ensureSummarySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
      short TEXT NOT NULL,
      detail TEXT NOT NULL,
      key_points_json TEXT NOT NULL,
      skippable TEXT NOT NULL,
      generated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function readSummaryTargets(db, { bookId, force, limit }) {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.book_id AS bookId,
      c.chapter_index AS chapterIndex,
      c.title,
      c.content,
      c.word_count AS wordCount
    FROM chapters c
    LEFT JOIN summaries s ON s.chapter_id = c.id
    WHERE c.book_id = ?
      AND (? = 1 OR s.chapter_id IS NULL)
    ORDER BY c.chapter_index, c.title
  `).all(bookId, force ? 1 : 0).map(plainObject)
  return limit > 0 ? rows.slice(0, limit) : rows
}

function writeSummary(db, chapterId, summary) {
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
  `).run(
    chapterId,
    summary.short,
    summary.detail,
    JSON.stringify(summary.keyPoints),
    summary.skippable,
    summary.generatedBy,
  )
}

function ensureKgSchema(db) {
  db.exec(`
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
      review_status TEXT,
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
      first_chapter_index INTEGER,
      last_chapter_index INTEGER,
      review_status TEXT,
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
  ensureSqliteColumn(db, 'kg_entities', 'review_status', 'TEXT')
  ensureSqliteColumn(db, 'kg_relations', 'first_chapter_index', 'INTEGER')
  ensureSqliteColumn(db, 'kg_relations', 'last_chapter_index', 'INTEGER')
  ensureSqliteColumn(db, 'kg_relations', 'review_status', 'TEXT')
}

function readKgTargets(db, { bookId, force, limit }) {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.book_id AS bookId,
      c.chapter_index AS chapterIndex,
      c.title,
      c.content,
      c.word_count AS wordCount
    FROM chapters c
    LEFT JOIN kg_chapter_extractions kgc ON kgc.chapter_id = c.id AND kgc.status = 'completed'
    WHERE c.book_id = ?
      AND (? = 1 OR kgc.chapter_id IS NULL)
    ORDER BY c.chapter_index, c.title
  `).all(bookId, force ? 1 : 0).map(plainObject)
  return limit > 0 ? rows.slice(0, limit) : rows
}

function writeKgExtraction(db, chapter, extraction) {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM kg_relation_mentions WHERE chapter_id = ?').run(chapter.id)
    db.prepare('DELETE FROM kg_entity_mentions WHERE chapter_id = ?').run(chapter.id)
    const entityIdsByKey = new Map()
    let entityMentions = 0
    let relationMentions = 0

    for (const entity of extraction.entities) {
      const normalizedName = normalizeKgName(entity.name)
      if (!normalizedName) continue
      const type = normalizeKgType(entity.type, 'entity')
      const entityId = upsertKgEntity(db, chapter, {
        ...entity,
        type,
        normalizedName,
      })
      entityIdsByKey.set(kgEntityKey(type, normalizedName), entityId)
      upsertKgEntityMention(db, chapter, entityId, entity)
      entityMentions += 1
    }

    for (const relation of extraction.relations) {
      const sourceType = normalizeKgType(relation.sourceType || relation.source_type || relation.sourceEntityType, 'entity')
      const targetType = normalizeKgType(relation.targetType || relation.target_type || relation.targetEntityType, 'entity')
      const sourceName = normalizeKgName(relation.source || relation.sourceName || relation.source_entity)
      const targetName = normalizeKgName(relation.target || relation.targetName || relation.target_entity)
      if (!sourceName || !targetName) continue
      const sourceId = entityIdsByKey.get(kgEntityKey(sourceType, sourceName))
        || upsertKgEntity(db, chapter, { name: relation.source || relation.sourceName, type: sourceType, normalizedName: sourceName, confidence: relation.confidence })
      const targetId = entityIdsByKey.get(kgEntityKey(targetType, targetName))
        || upsertKgEntity(db, chapter, { name: relation.target || relation.targetName, type: targetType, normalizedName: targetName, confidence: relation.confidence })
      entityIdsByKey.set(kgEntityKey(sourceType, sourceName), sourceId)
      entityIdsByKey.set(kgEntityKey(targetType, targetName), targetId)
      const relationId = upsertKgRelation(db, chapter, sourceId, targetId, relation)
      upsertKgRelationMention(db, chapter, relationId, relation)
      relationMentions += 1
    }

    db.prepare(`
      INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, extraction_json, error, model, scanned_at, updated_at)
      VALUES (?, ?, 'completed', ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(chapter_id) DO UPDATE SET
        book_id = excluded.book_id,
        status = excluded.status,
        extraction_json = excluded.extraction_json,
        error = excluded.error,
        model = excluded.model,
        scanned_at = excluded.scanned_at,
        updated_at = excluded.updated_at
    `).run(chapter.id, chapter.bookId, JSON.stringify({
      entities: extraction.entities,
      relations: extraction.relations,
    }), extraction.model)
    db.exec('COMMIT')
    return { entityMentions, relationMentions }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // No active transaction.
    }
    throw error
  }
}

function writeKgExtractionError(db, chapter, model, error) {
  db.prepare(`
    INSERT INTO kg_chapter_extractions (chapter_id, book_id, status, extraction_json, error, model, scanned_at, updated_at)
    VALUES (?, ?, 'failed', NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id) DO UPDATE SET
      book_id = excluded.book_id,
      status = excluded.status,
      extraction_json = excluded.extraction_json,
      error = excluded.error,
      model = excluded.model,
      scanned_at = excluded.scanned_at,
      updated_at = excluded.updated_at
  `).run(chapter.id, chapter.bookId, error instanceof Error ? error.message : String(error), model)
}

function upsertKgEntity(db, chapter, entity) {
  const type = normalizeKgType(entity.type, 'entity')
  const normalizedName = entity.normalizedName || normalizeKgName(entity.name)
  const name = String(entity.name || normalizedName)
  const existing = db.prepare(`
    SELECT id, aliases_json AS aliasesJson
    FROM kg_entities
    WHERE book_id = ? AND type = ? AND normalized_name = ?
  `).get(chapter.bookId, type, normalizedName)
  const aliases = uniqueStrings([...(safeArray(entity.aliases)), name])
  const confidence = clampConfidence(entity.confidence)
  if (existing) {
    const mergedAliases = uniqueStrings([...safeJsonParse(existing.aliasesJson, []), ...aliases])
    db.prepare(`
      UPDATE kg_entities
      SET
        aliases_json = ?,
        description = COALESCE(NULLIF(?, ''), description),
        confidence = MAX(confidence, ?),
        first_chapter_index = CASE WHEN first_chapter_index IS NULL THEN ? ELSE MIN(first_chapter_index, ?) END,
        last_chapter_index = CASE WHEN last_chapter_index IS NULL THEN ? ELSE MAX(last_chapter_index, ?) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      JSON.stringify(mergedAliases),
      String(entity.description || ''),
      confidence,
      chapter.chapterIndex,
      chapter.chapterIndex,
      chapter.chapterIndex,
      chapter.chapterIndex,
      existing.id,
    )
    return existing.id
  }
  const id = stableKgId('entity', chapter.bookId, type, normalizedName)
  db.prepare(`
    INSERT INTO kg_entities (
      id, book_id, type, name, normalized_name, aliases_json, description, confidence,
      first_chapter_index, last_chapter_index, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    chapter.bookId,
    type,
    name,
    normalizedName,
    JSON.stringify(aliases),
    String(entity.description || ''),
    confidence,
    chapter.chapterIndex,
    chapter.chapterIndex,
  )
  return id
}

function upsertKgEntityMention(db, chapter, entityId, entity) {
  const id = stableKgId('entity-mention', chapter.id, entityId)
  const existing = db.prepare('SELECT id FROM kg_entity_mentions WHERE id = ?').get(id)
  if (existing) {
    db.prepare('UPDATE kg_entity_mentions SET evidence = ?, confidence = MAX(confidence, ?) WHERE id = ?')
      .run(String(entity.evidence || ''), clampConfidence(entity.confidence), id)
    return
  }
  db.prepare(`
    INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, entityId, chapter.bookId, chapter.id, chapter.chapterIndex, String(entity.evidence || ''), clampConfidence(entity.confidence))
}

function upsertKgRelation(db, chapter, sourceId, targetId, relation) {
  const type = normalizeKgType(relation.type, 'related_to')
  const existing = db.prepare(`
    SELECT id
    FROM kg_relations
    WHERE book_id = ? AND source_entity_id = ? AND target_entity_id = ? AND type = ?
  `).get(chapter.bookId, sourceId, targetId, type)
  const confidence = clampConfidence(relation.confidence)
  if (existing) {
    db.prepare(`
      UPDATE kg_relations
      SET
        description = COALESCE(NULLIF(?, ''), description),
        confidence = MAX(confidence, ?),
        first_chapter_index = CASE WHEN first_chapter_index IS NULL THEN ? ELSE MIN(first_chapter_index, ?) END,
        last_chapter_index = CASE WHEN last_chapter_index IS NULL THEN ? ELSE MAX(last_chapter_index, ?) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      String(relation.description || ''),
      confidence,
      chapter.chapterIndex,
      chapter.chapterIndex,
      chapter.chapterIndex,
      chapter.chapterIndex,
      existing.id,
    )
    return existing.id
  }
  const id = stableKgId('relation', chapter.bookId, sourceId, targetId, type)
  db.prepare(`
    INSERT INTO kg_relations (
      id, book_id, source_entity_id, target_entity_id, type, description, confidence,
      first_chapter_index, last_chapter_index, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    chapter.bookId,
    sourceId,
    targetId,
    type,
    String(relation.description || ''),
    confidence,
    chapter.chapterIndex,
    chapter.chapterIndex,
  )
  return id
}

function upsertKgRelationMention(db, chapter, relationId, relation) {
  const id = stableKgId('relation-mention', chapter.id, relationId)
  const existing = db.prepare('SELECT id FROM kg_relation_mentions WHERE id = ?').get(id)
  if (existing) {
    db.prepare('UPDATE kg_relation_mentions SET evidence = ?, confidence = MAX(confidence, ?) WHERE id = ?')
      .run(String(relation.evidence || ''), clampConfidence(relation.confidence), id)
    return
  }
  db.prepare(`
    INSERT INTO kg_relation_mentions (id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, relationId, chapter.bookId, chapter.id, chapter.chapterIndex, String(relation.evidence || ''), clampConfidence(relation.confidence))
}

function ensureEmbeddingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_embeddings (
      chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_summary_embeddings_book ON summary_embeddings(book_id);

    CREATE TABLE IF NOT EXISTS chapter_chunk_embeddings (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chapter_id, chunk_index, model)
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_book_model ON chapter_chunk_embeddings(book_id, model);
    CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chapter ON chapter_chunk_embeddings(chapter_id, model);
  `)
}

function readEmbeddingTargets(db, { bookId, model, force, limit, utils }) {
  const summaries = db.prepare(`
    SELECT
      s.chapter_id AS chapterId,
      s.short,
      s.detail,
      s.key_points_json AS keyPointsJson
    FROM summaries s
    JOIN chapters c ON c.id = s.chapter_id
    WHERE c.book_id = ?
    ORDER BY c.chapter_index
  `).all(bookId).map(plainObject)
  const summaryByChapterId = new Map(summaries.map((summary) => [summary.chapterId, summary]))
  const chapters = db.prepare(`
    SELECT
      id,
      book_id AS bookId,
      chapter_index AS chapterIndex,
      title,
      content,
      word_count AS wordCount
    FROM chapters
    WHERE book_id = ?
    ORDER BY chapter_index, title
  `).all(bookId).map(plainObject)
  const getSummaryEmbedding = db.prepare('SELECT chapter_id AS chapterId, dimension FROM summary_embeddings WHERE chapter_id = ? AND model = ?')
  const countChunks = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE chapter_id = ? AND model = ?')
  const targets = []

  for (const chapter of chapters) {
    const summary = summaryByChapterId.get(chapter.id)
    if (!summary) continue
    const chunks = utils.splitChapterIntoChunks(chapter)
    const existingSummary = getSummaryEmbedding.get(chapter.id, model)
    const existingChunks = countChunks.get(chapter.id, model)?.count ?? 0
    if (!force && existingSummary && existingChunks >= chunks.length) continue
    targets.push({ chapter, summary, chunks })
    if (limit > 0 && targets.length >= limit) break
  }
  return targets
}

async function embedChapterTarget({ dbPath, bookId, model, force, target, embeddingConfig, utils, results }) {
  const summaryText = utils.buildSummaryText(target.summary)
  if (!summaryText) {
    results.failed += 1
    pushLimited(results.errors, {
      chapterId: target.chapter.id,
      chapterIndex: target.chapter.chapterIndex,
      error: 'Summary text is empty.',
    })
    return
  }

  try {
    const db = await openMainDbForEmbedding(dbPath)
    try {
      const existingSummary = db.prepare('SELECT chapter_id AS chapterId FROM summary_embeddings WHERE chapter_id = ? AND model = ?')
        .get(target.chapter.id, model)
      if (force || !existingSummary) {
        const summaryEmbedding = utils.l2Normalize(await callEmbeddingProvider(summaryText, embeddingConfig, utils))
        writeSummaryEmbedding(db, {
          chapterId: target.chapter.id,
          bookId,
          model,
          embedding: summaryEmbedding,
        })
        results.dimension ??= summaryEmbedding.length
      }

      const existingChunks = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE chapter_id = ? AND model = ?')
        .get(target.chapter.id, model)?.count ?? 0
      if (force || existingChunks < target.chunks.length) {
        db.prepare('DELETE FROM chapter_chunk_embeddings WHERE chapter_id = ? AND model = ?').run(target.chapter.id, model)
        for (const chunk of target.chunks) {
          try {
            const chunkText = `第 ${target.chapter.chapterIndex} 章：${target.chapter.title}\n\n${chunk.text}`
            const chunkEmbedding = utils.l2Normalize(await callEmbeddingProvider(chunkText, embeddingConfig, utils))
            writeChunkEmbedding(db, {
              id: utils.buildChunkEmbeddingId(chunk.id, model),
              bookId,
              chapterId: target.chapter.id,
              chapterIndex: target.chapter.chapterIndex,
              chunk,
              model,
              embedding: chunkEmbedding,
            })
            results.dimension ??= chunkEmbedding.length
            results.chunkCompleted += 1
          } catch (error) {
            results.chunkFailed += 1
            pushLimited(results.chunkErrors, {
              chapterId: target.chapter.id,
              chapterIndex: target.chapter.chapterIndex,
              chunkIndex: chunk.chunkIndex,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      results.completed += 1
    } finally {
      db.close()
    }
  } catch (error) {
    results.failed += 1
    pushLimited(results.errors, {
      chapterId: target.chapter.id,
      chapterIndex: target.chapter.chapterIndex,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function writeSummaryEmbedding(db, { chapterId, bookId, model, embedding }) {
  db.prepare(`
    INSERT INTO summary_embeddings (chapter_id, book_id, model, dimension, embedding_json, generated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id) DO UPDATE SET
      book_id = excluded.book_id,
      model = excluded.model,
      dimension = excluded.dimension,
      embedding_json = excluded.embedding_json,
      generated_at = excluded.generated_at
  `).run(chapterId, bookId, model, embedding.length, JSON.stringify(embedding))
}

function writeChunkEmbedding(db, { id, bookId, chapterId, chapterIndex, chunk, model, embedding }) {
  db.prepare(`
    INSERT INTO chapter_chunk_embeddings (
      id,
      book_id,
      chapter_id,
      chapter_index,
      chunk_index,
      start_offset,
      end_offset,
      text,
      model,
      dimension,
      embedding_json,
      generated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chapter_id, chunk_index, model) DO UPDATE SET
      id = excluded.id,
      book_id = excluded.book_id,
      chapter_index = excluded.chapter_index,
      start_offset = excluded.start_offset,
      end_offset = excluded.end_offset,
      text = excluded.text,
      dimension = excluded.dimension,
      embedding_json = excluded.embedding_json,
      generated_at = excluded.generated_at
  `).run(
    id,
    bookId,
    chapterId,
    chapterIndex,
    chunk.chunkIndex,
    chunk.startOffset,
    chunk.endOffset,
    chunk.text,
    model,
    embedding.length,
    JSON.stringify(embedding),
  )
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

async function buildStatusLines(runInfo, { logLines }) {
  const runJson = runInfo.runJson
  const lines = [
    `run: ${runJson.runId || basename(runInfo.rootDir)}`,
    `command: ${runJson.command || 'unknown'}`,
    `status: ${runJson.status || 'unknown'}`,
    `runDir: ${runInfo.rootDir}`,
  ]
  if (runJson.job?.bookId) lines.push(`book: ${runJson.job.bookId}${runJson.job.title ? ` ${runJson.job.title}` : ''}`)
  if (runJson.updatedAt) lines.push(`updatedAt: ${runJson.updatedAt}`)
  const stages = runJson.stages || {}
  const stageNames = Object.keys(stages)
  if (!stageNames.length) {
    lines.push('stages: none')
    return lines
  }
  lines.push('stages:')
  for (const stageName of stageNames) {
    const stage = stages[stageName] || {}
    lines.push(`- ${stageName}: ${stage.status || 'unknown'}${stage.message ? ` - ${stage.message}` : ''}`)
    if (stage.error) lines.push(`  error: ${stage.error}`)
    if (stage.startedAt) lines.push(`  startedAt: ${stage.startedAt}`)
    if (stage.finishedAt) lines.push(`  finishedAt: ${stage.finishedAt}`)
    appendArtifacts(lines, stage.artifacts, '  ')
    const childRuns = normalizeChildRuns(stage)
    for (const [index, child] of childRuns.entries()) {
      await appendChildRunStatus(lines, runInfo.rootDir, child, {
        label: childRuns.length > 1 ? `child ${index + 1}` : 'child',
        logLines,
      })
    }
  }
  return lines
}

function appendArtifacts(lines, artifacts, indent) {
  if (!artifacts || typeof artifacts !== 'object' || !Object.keys(artifacts).length) return
  lines.push(`${indent}artifacts:`)
  for (const [key, value] of Object.entries(artifacts)) {
    lines.push(`${indent}  ${key}: ${value}`)
  }
}

function normalizeChildRuns(stage) {
  const childRuns = []
  if (stage.childRunJson || stage.childRunDir || stage.logFile) childRuns.push(stage)
  if (Array.isArray(stage.childRuns)) childRuns.push(...stage.childRuns)
  return childRuns
}

async function appendChildRunStatus(lines, parentRunDir, child, { label, logLines }) {
  lines.push(`  ${label}:`)
  if (child.childRunJson) lines.push(`    runJson: ${child.childRunJson}`)
  if (child.childRunDir) lines.push(`    runDir: ${child.childRunDir}`)
  const childRunJsonPath = child.childRunJson && existsSync(child.childRunJson) ? child.childRunJson : ''
  if (childRunJsonPath) {
    try {
      const childRunJson = JSON.parse(await readFile(childRunJsonPath, 'utf8'))
      lines.push(`    status: ${childRunJson.status || 'unknown'}`)
      const childStage = firstObjectValue(childRunJson.stages)
      if (childStage?.message) lines.push(`    message: ${childStage.message}`)
      if (childStage?.error) lines.push(`    error: ${childStage.error}`)
      appendArtifacts(lines, childStage?.artifacts, '    ')
    } catch (error) {
      lines.push(`    statusError: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const logPath = child.logFile ? resolveRunArtifact(parentRunDir, child.logFile) : ''
  if (logPath) {
    lines.push(`    log: ${logPath}`)
    const tail = logLines > 0 ? await readTailLines(logPath, logLines) : []
    if (tail.length) {
      lines.push('    logTail:')
      for (const line of tail) lines.push(`      ${line}`)
    }
  }
}

function firstObjectValue(value) {
  if (!value || typeof value !== 'object') return null
  return Object.values(value).find((entry) => entry && typeof entry === 'object') || null
}

async function readTailLines(path, count) {
  try {
    const text = await readFile(path, 'utf8')
    return text.trimEnd().split(/\r?\n/).slice(-count)
  } catch {
    return []
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
  const response = await fetchGatewayResponse(gatewayUrl, path, token)
  return response.json()
}

async function fetchGatewayResponse(gatewayUrl, path, token = '') {
  const response = await fetch(`${gatewayUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Gateway ${path} returned ${response.status}: ${await response.text()}`)
  }
  return response
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

function sameJson(actual, expected) {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null)
}

async function inspectJobPreflight({ checks, job, jobPath, mainDbPath }) {
  addDoctorCheck(checks, 'job.bookId', Boolean(job.bookId), job.bookId || 'missing')
  addDoctorCheck(checks, 'job.stages', job.stages.length > 0, job.stages.join(', ') || 'missing')
  addDoctorCheck(checks, 'mainDb.path', Boolean(mainDbPath), mainDbPath)
  const sourceFile = job.source?.file || job.source?.path || job.file
  if (job.stages.includes('import')) {
    addDoctorCheck(checks, 'import.sourceFile', Boolean(sourceFile), sourceFile || 'missing job.source.file')
    if (sourceFile) addDoctorCheck(checks, 'import.sourceFile.exists', existsSync(expandPath(sourceFile)), expandPath(sourceFile))
  } else {
    addDoctorCheck(checks, 'mainDb.exists', existsSync(mainDbPath), mainDbPath)
  }

  const fakeRunInfo = { rootDir: dirname(jobPath) }
  for (const stage of job.stages) {
    if (stage === 'publish' || stage === 'verify') continue
    try {
      buildStageArgs(stage, job, mainDbPath, fakeRunInfo)
      addDoctorCheck(checks, `stage.${stage}.config`, true, 'ok')
    } catch (error) {
      addDoctorCheck(checks, `stage.${stage}.config`, false, error.message)
    }
  }

  if (job.stages.includes('audio')) {
    const audio = job.audio || {}
    const sourceRoot = audio.sourceRoot || audio.source_root
    const ttsConfig = audio.ttsConfig || audio.tts_config
    if (sourceRoot) addDoctorCheck(checks, 'audio.sourceRoot.exists', existsSync(expandPath(sourceRoot)), expandPath(sourceRoot))
    if (ttsConfig) {
      addDoctorCheck(checks, 'audio.ttsConfig.exists', existsSync(expandPath(ttsConfig)), expandPath(ttsConfig))
      const directorScript = audio.ttsDirectorScript || audio.tts_director_script || join(dirname(cliFilePath), '..', '..', 'offline-tts', 'scripts', 'tts-director.mjs')
      addDoctorCheck(checks, 'audio.ttsDirector.exists', existsSync(expandPath(directorScript)), expandPath(directorScript))
    }
  }

  if (job.stages.includes('embedding')) {
    await inspectEmbeddingPreflight(checks, job)
  }

  if (job.stages.includes('publish')) {
    const publish = { ...(job.gateway || {}), ...(job.publish || {}) }
    const hasLocal = Boolean(publish.gatewayDataDir)
    const hasRemote = Boolean(publish.remoteHost || publish.host)
    addDoctorCheck(checks, 'publish.target', hasLocal || hasRemote, hasLocal ? publish.gatewayDataDir : (publish.remoteHost || publish.host || 'missing'))
  }

  if (job.stages.includes('verify')) {
    const verify = { ...(job.gateway || {}), ...(job.verify || {}) }
    addDoctorCheck(checks, 'verify.gatewayUrl', Boolean(verify.gatewayUrl || verify.url), verify.gatewayUrl || verify.url || 'missing')
    addDoctorCheck(checks, 'verify.gatewayToken', Boolean(verify.gatewayToken || verify.token), (verify.gatewayToken || verify.token) ? '[present]' : 'missing')
  }
}

async function inspectEmbeddingPreflight(checks, job) {
  const embedding = job.embedding || {}
  const provider = String(embedding.provider || 'ollama').toLowerCase()
  if (provider !== 'ollama') return
  const baseUrl = embedding.baseUrl || embedding.base_url
  const model = embedding.model
  if (!baseUrl || !model) return
  try {
    const models = await fetchOllamaModelNames(baseUrl)
    addDoctorCheck(checks, 'embedding.ollama.model', models.includes(model), models.includes(model) ? model : `missing ${model}; available: ${models.join(', ') || 'none'}`)
  } catch (error) {
    addDoctorCheck(checks, 'embedding.ollama.model', false, error instanceof Error ? error.message : String(error))
  }
}

async function fetchOllamaModelNames(baseUrl) {
  const response = await fetch(`${trimTrailingSlash(baseUrl)}/api/tags`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Ollama tags failed: ${response.status} ${response.statusText}`)
  const data = await response.json()
  return (Array.isArray(data?.models) ? data.models : [])
    .map((model) => String(model.name || model.model || '').trim())
    .filter(Boolean)
}

function addDoctorCheck(checks, name, ok, message = '') {
  checks.push({
    name,
    ok: Boolean(ok),
    message: String(message || ''),
  })
}

function normalizeJobConfig(job) {
  if (!job || typeof job !== 'object') throw new Error('Job config must be an object.')
  const bookId = required(job.bookId, 'job requires bookId')
  return {
    ...job,
    bookId,
    stages: normalizeStageList(job.stages),
  }
}

function normalizeStageList(stages) {
  if (Array.isArray(stages)) return stages.map((stage) => String(stage).trim()).filter(Boolean)
  if (typeof stages === 'string') return stages.split(',').map((stage) => stage.trim()).filter(Boolean)
  return ['package']
}

function buildStageArgs(stage, job, mainDbPath, runInfo) {
  const common = ['--book-id', job.bookId, '--main-db', mainDbPath, '--run-root', join(runInfo.rootDir, 'stage-runs', stage)]
  if (stage === 'import') {
    const file = job.source?.file || job.source?.path || job.file
    const title = job.title || job.source?.title
    const args = ['import', '--file', required(file, 'import stage requires job.source.file'), ...common]
    if (title) args.push('--title', title)
    if (isFlagEnabled(job.import?.replace ?? job.replace)) args.push('--replace')
    return args
  }
  if (stage === 'package') return ['package', ...common]
  if (stage === 'summary') {
    const summary = { ...(job.llm || {}), ...(job.summary || {}) }
    const args = [
      'summary',
      ...common,
      '--provider',
      summary.provider || 'openai-compatible',
      '--base-url',
      required(summary.baseUrl || summary.base_url, 'summary stage requires job.llm.baseUrl or job.summary.baseUrl'),
      '--model',
      required(summary.model, 'summary stage requires job.llm.model or job.summary.model'),
      '--concurrency',
      String(summary.concurrency ?? 4),
    ]
    if (summary.apiKey) args.push('--api-key', summary.apiKey)
    if (summary.temperature !== undefined) args.push('--temperature', String(summary.temperature))
    if (summary.timeoutMs) args.push('--timeout-ms', String(summary.timeoutMs))
    if (summary.maxAttempts || summary.retries) args.push('--max-attempts', String(summary.maxAttempts || summary.retries))
    if (summary.limit) args.push('--limit', String(summary.limit))
    if (isFlagEnabled(summary.force)) args.push('--force')
    if (summary.thinkingEnabled === false || isFlagEnabled(summary.disableThinking)) args.push('--disable-thinking')
    return args.filter((arg) => arg !== '')
  }
  if (stage === 'kg') {
    const kg = { ...(job.llm || {}), ...(job.kg || {}) }
    const args = [
      'kg',
      ...common,
      '--provider',
      kg.provider || 'openai-compatible',
      '--base-url',
      required(kg.baseUrl || kg.base_url, 'kg stage requires job.llm.baseUrl or job.kg.baseUrl'),
      '--model',
      required(kg.model, 'kg stage requires job.llm.model or job.kg.model'),
      '--concurrency',
      String(kg.concurrency ?? 3),
    ]
    if (kg.apiKey) args.push('--api-key', kg.apiKey)
    if (kg.temperature !== undefined) args.push('--temperature', String(kg.temperature))
    if (kg.timeoutMs) args.push('--timeout-ms', String(kg.timeoutMs))
    if (kg.maxAttempts || kg.retries) args.push('--max-attempts', String(kg.maxAttempts || kg.retries))
    if (kg.limit) args.push('--limit', String(kg.limit))
    if (isFlagEnabled(kg.force)) args.push('--force')
    if (kg.thinkingEnabled === false || isFlagEnabled(kg.disableThinking)) args.push('--disable-thinking')
    return args.filter((arg) => arg !== '')
  }
  if (stage === 'audio') {
    const audio = job.audio || {}
    const sourceRoot = audio.sourceRoot || audio.source_root
    const ttsConfig = audio.ttsConfig || audio.tts_config
    const args = ['audio', ...common]
    if (sourceRoot) args.push('--source-root', sourceRoot)
    if (ttsConfig) args.push('--tts-config', ttsConfig)
    if (audio.ttsOutRoot || audio.tts_out_root) args.push('--tts-out-root', audio.ttsOutRoot || audio.tts_out_root)
    if (audio.ttsDirectorScript || audio.tts_director_script) args.push('--tts-director-script', audio.ttsDirectorScript || audio.tts_director_script)
    if (audio.chapters) args.push('--chapters', String(audio.chapters))
    if (audio.chapter) args.push('--chapter', String(audio.chapter))
    if (audio.limit) args.push('--limit', String(audio.limit))
    if (audio.batchSize || audio.batch_size) args.push('--batch-size', String(audio.batchSize || audio.batch_size))
    if (audio.directorConcurrency || audio.director_concurrency) args.push('--director-concurrency', String(audio.directorConcurrency || audio.director_concurrency))
    if (audio.llmChapters || audio.llm_chapters) args.push('--llm-chapters', String(audio.llmChapters || audio.llm_chapters))
    if (audio.minBatchSize || audio.min_batch_size) args.push('--min-batch-size', String(audio.minBatchSize || audio.min_batch_size))
    if (audio.ttsConcurrency || audio.tts_concurrency) args.push('--tts-concurrency', String(audio.ttsConcurrency || audio.tts_concurrency))
    if (audio.ttsChapters || audio.tts_chapters) args.push('--tts-chapters', String(audio.ttsChapters || audio.tts_chapters))
    if (isFlagEnabled(audio.strict)) args.push('--strict')
    if (isFlagEnabled(audio.resume)) args.push('--resume')
    if (isFlagEnabled(audio.allowPartial || audio.allow_partial)) args.push('--allow-partial')
    if (isFlagEnabled(audio.noAdaptiveTts || audio.no_adaptive_tts)) args.push('--no-adaptive-tts')
    if (!sourceRoot && !ttsConfig) throw new Error('audio stage requires job.audio.sourceRoot or job.audio.ttsConfig')
    return args
  }
  if (stage === 'embedding') {
    const embedding = job.embedding || {}
    const args = [
      'embedding',
      ...common,
      '--provider',
      embedding.provider || 'ollama',
      '--base-url',
      required(embedding.baseUrl || embedding.base_url, 'embedding stage requires job.embedding.baseUrl'),
      '--model',
      required(embedding.model, 'embedding stage requires job.embedding.model'),
      '--concurrency',
      String(embedding.concurrency ?? ''),
    ]
    if (embedding.apiKey) args.push('--api-key', embedding.apiKey)
    if (embedding.timeoutMs) args.push('--timeout-ms', String(embedding.timeoutMs))
    if (embedding.maxAttempts || embedding.retries) args.push('--max-attempts', String(embedding.maxAttempts || embedding.retries))
    if (embedding.limit) args.push('--limit', String(embedding.limit))
    if (isFlagEnabled(embedding.force)) args.push('--force')
    return args.filter((arg) => arg !== '')
  }
  throw new Error(`Unsupported run stage: ${stage}`)
}

function buildPublishArgs(job, childRunJson) {
  const publish = { ...(job.gateway || {}), ...(job.publish || {}) }
  const args = ['publish', '--run', childRunJson]
  if (publish.gatewayDataDir) args.push('--gateway-data-dir', publish.gatewayDataDir)
  if (publish.gatewayAudioDir) args.push('--gateway-audio-dir', publish.gatewayAudioDir)
  if (publish.remoteHost || publish.host) args.push('--remote-host', publish.remoteHost || publish.host)
  if (publish.remoteUser || publish.user) args.push('--remote-user', publish.remoteUser || publish.user)
  if (publish.remoteRoot || publish.root) args.push('--remote-root', publish.remoteRoot || publish.root)
  if (publish.remoteDataDir) args.push('--remote-data-dir', publish.remoteDataDir)
  if (publish.remoteAudioDir) args.push('--remote-audio-dir', publish.remoteAudioDir)
  if (publish.sshPort || publish.remoteSshPort) args.push('--ssh-port', String(publish.sshPort || publish.remoteSshPort))
  if (isFlagEnabled(publish.dryRun ?? job.dryRun)) args.push('--dry-run')
  return args
}

function buildVerifyArgs(job, childRunJson) {
  const verify = { ...(job.gateway || {}), ...(job.verify || {}) }
  const args = ['verify', '--run', childRunJson]
  if (verify.gatewayUrl || verify.url) args.push('--gateway-url', verify.gatewayUrl || verify.url)
  if (verify.gatewayToken || verify.token) args.push('--gateway-token', verify.gatewayToken || verify.token)
  return args
}

function findLatestChildRun(stageResult) {
  if (!stageResult) return ''
  if (stageResult.childRunJson) return stageResult.childRunJson
  if (Array.isArray(stageResult.childRuns)) {
    return stageResult.childRuns.find((child) => child.childRunJson)?.childRunJson || ''
  }
  return ''
}

function findChildRunJson(parentRunDir, stage, childRunId) {
  if (!childRunId) return ''
  const stageRoot = join(parentRunDir, 'stage-runs', stage)
  return findRunJsonUnder(stageRoot, childRunId)
}

function findRunJsonUnder(root, runId) {
  if (!existsSync(root)) return ''
  const direct = join(root, runId, 'run.json')
  if (existsSync(direct)) return direct
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const entries = safeReadDirSync(current)
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name === runId && existsSync(join(fullPath, 'run.json'))) return join(fullPath, 'run.json')
      stack.push(fullPath)
    }
  }
  return ''
}

function safeReadDirSync(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
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
    if (isFlagEnabled(options.dryRun)) return { schemaVersion: 1, books: [] }
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

async function prepareAudioSourceRoot({ options, run, book }) {
  if (!shouldGenerateTts(options)) {
    return resolve(required(options.sourceRoot, 'audio requires --source-root <path>, or --tts-config <path> to generate MP3 first'))
  }
  const sourceRoot = resolve(options.ttsOutRoot || join(run.artifactsDir, 'tts-source'))
  if (isFlagEnabled(options.dryRun)) return sourceRoot

  const chapters = audioChapterSelection(options, book.chapters.length)
  const directorScript = resolve(options.ttsDirectorScript || join(dirname(cliFilePath), '..', '..', 'offline-tts', 'scripts', 'tts-director.mjs'))
  const args = [
    directorScript,
    'batch-pipeline',
    '--config',
    expandPath(required(options.ttsConfig, 'audio TTS generation requires --tts-config <path>')),
    '--book-id',
    book.id,
    '--chapters',
    chapters,
    '--out-root',
    sourceRoot,
  ]
  if (isFlagEnabled(options.resume)) args.push('--resume')
  if (isFlagEnabled(options.allowPartial)) args.push('--allow-partial')
  if (options.limit) args.push('--limit', String(options.limit))
  if (options.batchSize) args.push('--batch-size', String(options.batchSize))
  if (options.directorConcurrency) args.push('--director-concurrency', String(options.directorConcurrency))
  if (options.llmChapters) args.push('--llm-chapters', String(options.llmChapters))
  if (options.minBatchSize) args.push('--min-batch-size', String(options.minBatchSize))
  if (options.ttsConcurrency) args.push('--tts-concurrency', String(options.ttsConcurrency))
  if (options.ttsChapters) args.push('--tts-chapters', String(options.ttsChapters))
  if (isFlagEnabled(options.noAdaptiveTts)) args.push('--no-adaptive-tts')

  const logPath = join(run.artifactsDir, 'tts-director.log')
  let stdout = ''
  let stderr = ''
  try {
    ;({ stdout, stderr } = await execFileAsync(process.execPath, args, { maxBuffer: 100 * 1024 * 1024 }))
  } catch (error) {
    stdout = error.stdout || ''
    stderr = error.stderr || error.message
    await writeFile(logPath, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`, 'utf8')
    throw error
  }
  await writeFile(logPath, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`, 'utf8')
  const summaryPath = stdout.match(/汇总文件：(.+)/)?.[1]?.trim()
    || join(sourceRoot, `batch-pipeline-${chapters.split(',')[0]}-${chapters.split(',').at(-1)}.summary.json`)
  if (existsSync(summaryPath)) options.ttsSummaryPath = summaryPath
  return sourceRoot
}

function shouldGenerateTts(options) {
  return Boolean(options.ttsConfig || options.generateTts || options.ttsOutRoot)
}

function audioChapterSelection(options, totalChapters) {
  if (options.chapters) return String(options.chapters)
  if (options.chapter) return String(options.chapter)
  if (totalChapters <= 0) throw new Error('Book has no chapters for TTS generation.')
  return `1-${totalChapters}`
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

async function callEmbeddingProvider(text, config, utils) {
  return retryEmbeddingRequest(async () => {
    const provider = String(config.provider || '').toLowerCase()
    if (provider === 'openai' || provider === 'openai-compatible') {
      return callOpenAICompatibleEmbedding(text, config)
    }
    return callOllamaEmbedding(text, config)
  }, config, utils)
}

async function generateChapterSummary(chapter, config) {
  const prompt = buildSummaryPrompt(chapter, config.thinkingEnabled)
  const raw = await retryTransientRequest(async () => {
    if (String(config.provider || '').toLowerCase() === 'ollama') {
      return callOllamaGenerate(prompt, config)
    }
    return callOpenAICompatibleChat(
      [
        { role: 'system', content: '你是长篇网络小说陪读助手。你必须只输出符合要求的 JSON。' },
        { role: 'user', content: prompt },
      ],
      config,
    )
  }, config)
  const parsed = parseSummaryResponse(raw)
  return {
    ...parsed,
    generatedBy: String(config.provider || 'openai-compatible').toLowerCase() === 'ollama' ? 'ollama' : 'openai',
  }
}

async function generateChapterKnowledgeGraph(chapter, config) {
  const prompt = buildKgPrompt(chapter, config.thinkingEnabled)
  const raw = await retryTransientRequest(async () => {
    if (String(config.provider || '').toLowerCase() === 'ollama') {
      return callOllamaGenerate(prompt, config)
    }
    return callOpenAICompatibleChat(
      [
        { role: 'system', content: '你是长篇小说知识图谱抽取器。你必须只输出符合要求的 JSON。' },
        { role: 'user', content: prompt },
      ],
      config,
    )
  }, config)
  return parseKgResponse(raw)
}

function buildKgPrompt(chapter, thinkingEnabled) {
  const thinkingInstruction = thinkingEnabled
    ? '请先用 /think 判断核心人物、地点、势力和关系，但最终输出必须是 JSON，不要输出任何其他内容。'
    : '请直接输出 JSON，不要输出任何推理过程。'

  return `${thinkingInstruction}

请从下面章节中抽取适合小说检索和移动端阅读的知识图谱。只保留本章明确出现或强烈指向的信息，不要编造。

JSON 字段：
- entities: 数组，每项包含 name, type, aliases, description, evidence, confidence。
  - type 建议使用 person, place, organization, object, event, concept。
  - aliases 是字符串数组，没有则 []。
  - evidence 是本章中能支持该实体的一小段原文或概括。
  - confidence 是 0 到 1。
- relations: 数组，每项包含 source, sourceType, target, targetType, type, description, evidence, confidence。
  - source/target 必须能对应 entities 中的实体，若关系端点未列入 entities，也请补入 entities。
  - type 使用短英文或拼音式关系名，例如 sworn_brother, located_in, member_of, enemy_of, helps, owns。

最多输出 20 个实体、30 条关系。只返回 JSON，不要 markdown 代码块，不要解释。

章节标题：${chapter.title}
章节字数：${chapter.wordCount ?? countWords(chapter.content)}

正文：
${String(chapter.content || '').slice(0, 14000)}`
}

function buildSummaryPrompt(chapter, thinkingEnabled) {
  const thinkingInstruction = thinkingEnabled
    ? '请先用 /think 进行推理，但最终输出必须是 JSON，不要输出任何其他内容。'
    : '请直接输出 JSON，不要输出任何推理过程。'

  return `${thinkingInstruction}

你是资深网络小说阅读助手。请严格根据下面这一章的内容生成一份概要 JSON，JSON 字段如下：
- short: 一句话概括本章核心情节（不超过 60 字）。
- detail: 详细概要，包含起因、经过、结果（150-300 字）。
- keyPoints: 字符串数组，列出本章 3-6 个必须记住的关键信息点。
- skippable: 判断本章是否可跳读。如果是过渡章、纯回忆、重复描写，返回"可跳读：简要说明原因"；否则返回"不可跳读：简要说明原因"。

只返回 JSON，不要加 markdown 代码块，不要解释。

章节标题：${chapter.title}
章节字数：${chapter.wordCount ?? countWords(chapter.content)}

正文：
${String(chapter.content || '').slice(0, 12000)}`
}

async function callOpenAICompatibleChat(messages, config) {
  const baseUrl = trimTrailingSlash(config.baseUrl)
  const headers = { 'content-type': 'application/json' }
  if (config.apiKey?.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0,
    response_format: { type: 'json_object' },
  }
  if (config.thinkingEnabled === false) {
    body.extra_body = { enable_thinking: false }
    body.chat_template_kwargs = { enable_thinking: false }
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`OpenAI-compatible chat failed: ${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function callOllamaGenerate(prompt, config) {
  const baseUrl = trimTrailingSlash(config.baseUrl || 'http://127.0.0.1:11434')
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: config.temperature ?? 0 },
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`Ollama generate failed: ${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  const data = await response.json()
  return data.response || ''
}

function parseSummaryResponse(raw) {
  const jsonText = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(jsonText)
    return {
      short: String(parsed.short || '模型没有返回一句话概要。'),
      detail: String(parsed.detail || '模型没有返回详细概要。'),
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6).map(String) : [],
      skippable: String(parsed.skippable || '暂无跳读建议。'),
    }
  } catch {
    return {
      short: '模型已返回内容，但不是标准 JSON。',
      detail: String(raw || '').slice(0, 600),
      keyPoints: [],
      skippable: '请重试，或换一个更擅长中文指令的模型。',
    }
  }
}

function parseKgResponse(raw) {
  const jsonText = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(jsonText)
    return {
      entities: safeArray(parsed.entities).slice(0, 20).map(normalizeKgEntity).filter((entity) => entity.name),
      relations: safeArray(parsed.relations).slice(0, 30).map(normalizeKgRelation).filter((relation) => relation.source && relation.target),
    }
  } catch {
    return {
      entities: [],
      relations: [],
    }
  }
}

function normalizeKgEntity(entity) {
  return {
    name: String(entity?.name || '').trim(),
    type: normalizeKgType(entity?.type, 'entity'),
    aliases: uniqueStrings(safeArray(entity?.aliases).map(String)),
    description: String(entity?.description || '').trim(),
    evidence: String(entity?.evidence || '').trim(),
    confidence: clampConfidence(entity?.confidence),
  }
}

function normalizeKgRelation(relation) {
  return {
    source: String(relation?.source || relation?.sourceName || relation?.source_entity || '').trim(),
    sourceType: normalizeKgType(relation?.sourceType || relation?.source_type || relation?.sourceEntityType, 'entity'),
    target: String(relation?.target || relation?.targetName || relation?.target_entity || '').trim(),
    targetType: normalizeKgType(relation?.targetType || relation?.target_type || relation?.targetEntityType, 'entity'),
    type: normalizeKgType(relation?.type, 'related_to'),
    description: String(relation?.description || '').trim(),
    evidence: String(relation?.evidence || '').trim(),
    confidence: clampConfidence(relation?.confidence),
  }
}

async function callOpenAICompatibleEmbedding(text, config) {
  const baseUrl = trimTrailingSlash(config.baseUrl)
  const headers = { 'content-type': 'application/json' }
  if (config.apiKey?.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, input: text, encoding_format: 'float' }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`OpenAI-compatible embedding failed: ${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  const data = await response.json()
  const embedding = data?.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('OpenAI-compatible embedding response missing data[0].embedding.')
  return embedding
}

async function callOllamaEmbedding(text, config) {
  const baseUrl = trimTrailingSlash(config.baseUrl || 'http://127.0.0.1:11434')
  const response = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: text }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  const data = await response.json()
  if (!Array.isArray(data?.embedding)) throw new Error('Ollama embedding response missing embedding.')
  return data.embedding
}

async function retryEmbeddingRequest(request, config, utils) {
  let lastError
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await request(attempt)
    } catch (error) {
      lastError = error
      const retryable = utils.isRetryableEmbeddingError
        ? utils.isRetryableEmbeddingError(error)
        : isRetryableEmbeddingError(error)
      if (attempt >= config.maxAttempts || !retryable) throw error
      await sleep(config.retryBaseDelayMs || 1000)
    }
  }
  throw lastError
}

async function retryTransientRequest(request, config) {
  let lastError
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await request(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= config.maxAttempts || !isRetryableEmbeddingError(error)) throw error
      await sleep(config.retryBaseDelayMs || 1000)
    }
  }
  throw lastError
}

function isRetryableEmbeddingError(error) {
  if (error?.name === 'AbortError') return true
  if ([408, 429, 500, 502, 503, 504].includes(Number(error?.status))) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /\b(408|429|500|502|503|504)\b|Bad Gateway|ECONNRESET|ETIMEDOUT|timeout/i.test(message)
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  })
  await Promise.all(workers)
}

function createStageProgressLogger({ stage, total, getProgress, intervalMs = 30_000, every = 10 }) {
  let lastLoggedAt = 0
  let lastLoggedDone = -1

  const readProgress = () => {
    const progress = getProgress()
    const completed = Number(progress.completed) || 0
    const failed = Number(progress.failed) || 0
    return {
      ...progress,
      completed,
      failed,
      done: completed + failed,
    }
  }

  const log = (label) => {
    const progress = readProgress()
    lastLoggedAt = Date.now()
    lastLoggedDone = progress.done
    console.log(`[${new Date().toISOString()}] ${stage} ${label}: ${formatStageProgress(progress, total)}`)
  }

  return {
    start() {
      log('start')
    },
    tick() {
      const progress = readProgress()
      if (progress.done === lastLoggedDone) return
      const dueByCount = every > 0 && progress.done > 0 && progress.done % every === 0
      const dueByTime = Date.now() - lastLoggedAt >= intervalMs
      const finished = total === 0 || progress.done >= total
      if (dueByCount || dueByTime || finished) log('progress')
    },
    finish() {
      log('finish')
    },
  }
}

function formatStageProgress(progress, total) {
  const parts = [
    `${progress.done}/${total}`,
    `completed=${progress.completed}`,
    `failed=${progress.failed}`,
  ]
  for (const [key, value] of Object.entries(progress)) {
    if (['completed', 'failed', 'done'].includes(key)) continue
    if (value == null || value === '') continue
    parts.push(`${key}=${value}`)
  }
  return parts.join(' ')
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

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function isFlagEnabled(value) {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  return !['', '0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function pushLimited(array, value, limit = 5) {
  if (array.length < limit) array.push(value)
}

function redactSensitiveOptions(options) {
  const redacted = { ...options }
  if (redacted.apiKey) redacted.apiKey = '[redacted]'
  if (redacted.gatewayToken) redacted.gatewayToken = '[redacted]'
  return redacted
}

function redactSensitiveJob(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveJob)
  if (!value || typeof value !== 'object') return value
  const redacted = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = /token|apiKey|api_key|secret|password/i.test(key)
      ? '[redacted]'
      : redactSensitiveJob(nestedValue)
  }
  return redacted
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

function coverageRatio(done, total) {
  const denominator = numberOrDefault(total, 0)
  if (denominator <= 0) return 0
  return Number((numberOrDefault(done, 0) / denominator).toFixed(4))
}

function stableKgId(...parts) {
  return createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32)
}

function kgEntityKey(type, normalizedName) {
  return `${type}\u001f${normalizedName}`
}

function normalizeKgName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase()
}

function normalizeKgType(value, fallback) {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.7
  return Math.max(0, Math.min(1, number))
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function sqliteTableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName))
}

function sqliteColumnExists(db, tableName, columnName) {
  if (!sqliteTableExists(db, tableName)) return false
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName)
}

function ensureSqliteColumn(db, tableName, columnName, columnType) {
  if (sqliteColumnExists(db, tableName, columnName)) return
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`)
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

async function loadEmbeddingUtils() {
  if (!embeddingUtilsModule) {
    embeddingUtilsModule = await import('./embedding-utils.mjs')
  }
  return embeddingUtilsModule
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
  npm run production-pipeline -- run --job <path>
  npm run production-pipeline -- doctor --job <path>
  npm run production-pipeline -- resume --run <runId|runDir|run.json>
  npm run production-pipeline -- import --file <path> [--book-id <id>] [--title <title>] [--dry-run] [--replace]
  npm run production-pipeline -- package --book-id <id>
  npm run production-pipeline -- summary --book-id <id> --provider <openai|ollama> --base-url <url> --model <name>
  npm run production-pipeline -- kg --book-id <id> --provider <openai|ollama> --base-url <url> --model <name>
  npm run production-pipeline -- audio --book-id <id> --source-root <path>
  npm run production-pipeline -- audio --book-id <id> --tts-config <path> [--chapters 1-10]
  npm run production-pipeline -- embedding --book-id <id> --provider <ollama|openai> --base-url <url> --model <name>
  npm run production-pipeline -- publish --run <runId|runDir|run.json> [--dry-run]
  npm run production-pipeline -- verify --run <runId|runDir|run.json> --gateway-url <url>
  npm run production-pipeline -- status --run <runId|runDir|run.json>

Options:
  --job <path>        Job JSON for run.
  --main-db <path>     Main Novel Reader SQLite database.
  --run-root <path>    Run storage root. Default: ${defaultRunRoot}
  --gateway-data-dir   Local Gateway data directory for publish.
  --gateway-audio-dir  Local Gateway audio directory for publish.
  --gateway-url        Gateway base URL for verify.
  --gateway-token      Gateway bearer token for verify.
  --audio-samples      Number of audio chapters whose manifest/download should be sampled in verify. Default: 1.
  --concurrency        Summary/KG/embedding request concurrency.
  --json               Print raw run JSON for status.
  --log-lines          Include this many child log tail lines in status. Default: 8.
  --tts-config         Generate MP3 first with offline-tts batch-pipeline, then package it.
  --chapters           Chapter list/range for TTS generation. Default: full book.
  --tts-concurrency    TTS segment concurrency passed to offline-tts.
  --tts-chapters       TTS chapter concurrency passed to offline-tts.
  --force              Regenerate existing embedding rows.
  --remote-host        Remote Gateway host for rsync publish.
  --remote-user        Remote SSH user.
  --remote-root        Remote Gateway root. Default: ${defaultRemoteRoot}
  --dry-run            Parse and write run artifacts without modifying the main DB.
  --replace            Replace an existing book with the same bookId.
`)
}
