#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ingestBookFile } from '../lib/book-ingest.mjs'

const schemaVersion = 1
const defaultWorkRoot = 'tmp/content-pipeline'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const stageNames = [
  'ingest',
  'offlineImport',
  'scan',
  'export',
  'embedding',
  'audio',
  'publishPackage',
  'publishAudio',
]
const localApiRetryStatuses = new Set([408, 429, 500, 502, 503, 504])

main().catch((error) => {
  console.error(`内容生产失败：${error.message}`)
  process.exitCode = 1
})

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'init') {
    await runInit(parseArgs(argv))
    return
  }
  if (command === 'ingest') {
    await runIngest(parseArgs(argv))
    return
  }
  if (command === 'status') {
    await runStatus(parseArgs(argv))
    return
  }
  if (command === 'run') {
    await runPipeline(parseArgs(argv))
    return
  }

  throw new Error(`未知命令：${command}`)
}

async function runInit(options) {
  const config = await loadPipelineConfig(options.config)
  const bookId = required(options.bookId, '缺少 --book-id')
  const workRoot = resolve(options.workRoot || config.workRoot || defaultWorkRoot)
  const workspace = resolve(options.workspace || join(workRoot, safePathSegment(bookId)))
  const manifestPath = resolve(options.manifest || join(workspace, 'production-manifest.json'))
  const now = new Date().toISOString()
  const sourceFile = options.sourceFile ? resolve(options.sourceFile) : ''
  const source = sourceFile
    ? {
        type: inferSourceType(sourceFile),
        fileName: basename(sourceFile),
        path: sourceFile,
        sha256: await hashFile(sourceFile),
      }
    : { type: 'main-db' }

  const manifest = {
    schemaVersion,
    kind: 'novel-reader-content-production-manifest',
    createdAt: now,
    updatedAt: now,
    book: {
      id: bookId,
      title: options.title || bookId,
      source,
    },
    workspace,
    stages: Object.fromEntries(stageNames.map((name) => [name, createStage(name)])),
    artifacts: {
      packageFile: '',
      audioRoot: '',
      gatewayAudioDir: '',
    },
    runs: [],
  }

  manifest.stages.ingest = {
    ...manifest.stages.ingest,
    status: source.type === 'main-db' ? 'completed' : 'pending',
    startedAt: source.type === 'main-db' ? now : '',
    finishedAt: source.type === 'main-db' ? now : '',
    message: source.type === 'main-db'
      ? '已记录主数据库书籍，等待后续生产步骤。'
      : '已记录原始文件，等待导入器接入。',
  }

  await writeManifest(manifestPath, manifest)
  console.log(`已创建内容生产 manifest：${manifestPath}`)
}

async function runIngest(options) {
  const config = await loadPipelineConfig(options.config)
  const sourceFile = resolve(required(options.file || options.sourceFile, '缺少 --file'))
  const sourceSha256 = await hashFile(sourceFile)
  const bookId = options.bookId || `file-${sourceSha256.slice(0, 24)}`
  const source = {
    type: inferSourceType(sourceFile),
    fileName: basename(sourceFile),
    path: sourceFile,
    sha256: sourceSha256,
  }
  const dbPath = resolve(
    options.mainDb ||
    options.mainDbPath ||
    config.mainDbPath ||
    process.env.NOVEL_READER_MAIN_DB ||
    join(homedir(), '.novel_reader', 'novel_reader.sqlite'),
  )
  const workRoot = resolve(options.workRoot || config.workRoot || defaultWorkRoot)
  const workspace = resolve(options.workspace || join(workRoot, safePathSegment(bookId)))
  const manifestPath = resolve(options.manifest || join(workspace, 'production-manifest.json'))
  const now = new Date().toISOString()
  let manifest

  try {
    manifest = await readManifest(manifestPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    manifest = createManifest({
      bookId,
      title: options.title || basename(sourceFile),
      source,
      workspace,
      now,
    })
  }

  let result
  try {
    result = await ingestBookFile(sourceFile, {
      bookId,
      title: options.title,
      dbPath,
    })
  } catch (error) {
    manifest.book = {
      id: bookId,
      title: options.title || manifest.book?.title || basename(sourceFile),
      source,
    }
    manifest.workspace = workspace
    manifest.stages.ingest = {
      ...createStage('ingest'),
      ...(manifest.stages?.ingest || {}),
      status: 'failed',
      startedAt: now,
      finishedAt: new Date().toISOString(),
      message: '',
      error: error.message,
      artifacts: {
        mainDbPath: dbPath,
        sourceSha256,
      },
    }
    manifest.runs ||= []
    manifest.runs.push({
      step: 'ingest',
      status: 'failed',
      startedAt: now,
      finishedAt: manifest.stages.ingest.finishedAt,
      command: `ingest ${source.fileName}`,
      exitCode: null,
    })
    await writeManifest(manifestPath, manifest)
    throw error
  }

  manifest.book = {
    id: bookId,
    title: result.book.title,
    source: result.source,
  }
  manifest.workspace = workspace
  manifest.stages.ingest = {
    ...createStage('ingest'),
    ...(manifest.stages?.ingest || {}),
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    message: `已导入 ${result.book.chapterCount} 章，${result.book.wordCount} 字。`,
    error: '',
    artifacts: {
      mainDbPath: dbPath,
      chapterCount: result.book.chapterCount,
      wordCount: result.book.wordCount,
      sourceSha256: result.source.sha256,
    },
  }
  manifest.artifacts ||= {}
  manifest.artifacts.mainDbPath = dbPath
  manifest.runs ||= []
  manifest.runs.push({
    step: 'ingest',
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    command: `ingest ${result.source.fileName}`,
    exitCode: 0,
  })

  await writeManifest(manifestPath, manifest)
  console.log(`已导入书籍：${result.book.title} (${bookId})`)
  console.log(`章节：${result.book.chapterCount}，字数：${result.book.wordCount}`)
  console.log(`manifest：${manifestPath}`)
}

async function runStatus(options) {
  const manifestPath = resolve(required(options.manifest, '缺少 --manifest'))
  const manifest = await readManifest(manifestPath)
  console.log(`书籍：${manifest.book?.title || manifest.book?.id} (${manifest.book?.id})`)
  console.log(`manifest：${manifestPath}`)
  console.log(`workspace：${manifest.workspace}`)
  console.log('')
  for (const name of stageNames) {
    const stage = manifest.stages?.[name] || createStage(name)
    const suffix = stage.error
      ? ` | ERROR: ${stage.error}`
      : (stage.message ? ` | ${stage.message}` : '')
    console.log(`${name.padEnd(15)} ${stage.status}${suffix}`)
    for (const detail of formatStageDetails(stage)) {
      console.log(`  ${detail}`)
    }
  }
  if (manifest.runs?.length) {
    const last = manifest.runs.at(-1)
    console.log('')
    console.log(`最近运行：${last.step} | ${last.status} | ${last.finishedAt || last.startedAt}`)
  }
}

async function runPipeline(options) {
  const config = await loadPipelineConfig(options.config)
  const manifestPath = resolve(required(options.manifest, '缺少 --manifest'))
  const manifest = await readManifest(manifestPath)
  const steps = splitList(options.steps || 'import,scan,export,publish-package')
  const dryRun = Boolean(options.dryRun)

  for (const step of steps) {
    await runStep({ manifestPath, manifest, step, options, config, dryRun })
    await writeManifest(manifestPath, manifest)
  }

  await writeManifest(manifestPath, manifest)
  console.log(`内容生产步骤完成：${steps.join(', ')}`)
}

async function runStep({ manifestPath, manifest, step, options, config, dryRun }) {
  const bookId = required(manifest.book?.id, 'manifest 缺少 book.id')
  const nodeBin = process.execPath
  const scannerScript = options.scannerScript || config.offlineScanner?.script || 'scripts/offline-scanner.mjs'
  const ttsScript = options.ttsScript || config.tts?.script || 'offline-tts/scripts/tts-director.mjs'
  const packageScript = options.packageScript || config.publish?.packageScript || 'gateway/scripts/publish-package.mjs'
  const audioScript = options.audioScript || config.publish?.audioScript || 'gateway/scripts/publish-audio.mjs'
  const sourceApi = options.sourceApi || config.sourceApi || process.env.NOVEL_READER_API_BASE_URL || 'http://127.0.0.1:5174'
  const gatewayUrl = options.gatewayUrl || config.gatewayUrl || process.env.GATEWAY_BASE_URL || ''
  const gatewayToken = options.gatewayToken || process.env.GATEWAY_DEV_ACCESS_TOKEN || ''
  const gatewayAudioDir = options.gatewayAudioDir || config.gatewayAudioDir || process.env.GATEWAY_AUDIO_DIR || 'gateway/data/audio'
  const gatewayRemoteHost = options.gatewayRemoteHost || config.gatewayRemoteHost || process.env.GATEWAY_REMOTE_HOST || ''
  const gatewayRemoteUser = options.gatewayRemoteUser || config.gatewayRemoteUser || process.env.GATEWAY_REMOTE_USER || ''
  const gatewayRemoteAudioDir = options.gatewayRemoteAudioDir || config.gatewayRemoteAudioDir || process.env.GATEWAY_REMOTE_AUDIO_DIR || ''
  const gatewayRemoteSshPort = options.gatewayRemoteSshPort || config.gatewayRemoteSshPort || process.env.GATEWAY_REMOTE_SSH_PORT || ''
  const ttsConfig = options.ttsConfig || config.tts?.config || 'offline-tts/config.example.json'
  const chapters = options.chapters || ''

  if (step === 'import') {
    await runCommandStage({
      manifest,
      stageName: 'offlineImport',
      step,
      command: nodeBin,
      args: [scannerScript, 'import', bookId],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  if (step === 'scan') {
    const scanType = options.scanType || 'all'
    if (!['summary', 'kg', 'all'].includes(scanType)) {
      await failBeforeCommand({
        manifest,
        manifestPath,
        stageName: 'scan',
        step,
        error: `scan-type 无效：${scanType}，可选 summary、kg、all`,
      })
    }

    const coverage = getOfflineCoverage(bookId)
    const scanAlreadyComplete =
      coverage.totalChapters > 0 &&
      ((scanType === 'summary' && coverage.summaryCompleted >= coverage.totalChapters) ||
        (scanType === 'kg' && coverage.kgCompleted >= coverage.totalChapters) ||
        (scanType === 'all' && coverage.summaryCompleted >= coverage.totalChapters && coverage.kgCompleted >= coverage.totalChapters))

    if (!options.forceScan && scanAlreadyComplete) {
      await completeWithoutCommand({
        manifest,
        manifestPath,
        stageName: 'scan',
        step,
        message: `已有离线扫描结果完整，跳过 ${scanType} 扫描：Summary ${coverage.summaryCompleted}/${coverage.totalChapters}，KG ${coverage.kgCompleted}/${coverage.totalChapters}。`,
        artifacts: { coverage },
      })
      return
    }

    if (!dryRun && !options.skipConfigSync) {
      await runCommandStage({
        manifest,
        stageName: 'scan',
        step: 'sync-model-config',
        command: nodeBin,
        args: [scannerScript, 'sync'],
        cwd: repoRoot,
        manifestPath,
        dryRun,
      })
    }

    await runCommandStage({
      manifest,
      stageName: 'scan',
      step,
      command: nodeBin,
      args: [scannerScript, options.resume ? 'resume' : 'scan', scanType, bookId],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  if (step === 'export') {
    await runCommandStage({
      manifest,
      stageName: 'export',
      step,
      command: nodeBin,
      args: [scannerScript, 'export', bookId],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  if (step === 'embedding') {
    await runEmbeddingStage({
      manifest,
      manifestPath,
      step,
      options,
      config,
      sourceApi,
      dryRun,
    })
    return
  }

  if (step === 'audio') {
    const audioChapters = chapters || resolveAllAudioChapters(bookId, options, config)
    const outRoot = resolve(
      options.audioOutRoot ||
      (config.tts?.outRoot ? join(config.tts.outRoot, safePathSegment(bookId)) : join(manifest.workspace, 'audio')),
    )
    manifest.artifacts.audioRoot = outRoot
    manifest.artifacts.audioChapters = audioChapters
    await runCommandStage({
      manifest,
      stageName: 'audio',
      step,
      command: nodeBin,
      args: [
        ttsScript,
        '--config',
        ttsConfig,
        'batch-pipeline',
        '--book-id',
        bookId,
        '--chapters',
        audioChapters,
        '--out-root',
        outRoot,
        '--resume',
        ...optionalNumberArgs(options, [
          ['directorConcurrency', '--director-concurrency'],
          ['llmChapters', '--llm-chapters'],
          ['minBatchSize', '--min-batch-size'],
          ['ttsConcurrency', '--tts-concurrency'],
          ['ttsChapters', '--tts-chapters'],
          ['limit', '--limit'],
          ['batchSize', '--batch-size'],
        ]),
      ],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  if (step === 'publish-package') {
    if (!dryRun) {
      if (!gatewayUrl) {
        await failBeforeCommand({
          manifest,
          manifestPath,
          stageName: 'publishPackage',
          step,
          error: 'publish-package 需要 --gateway-url、配置 gatewayUrl 或 GATEWAY_BASE_URL',
        })
      }
      if (!gatewayToken) {
        await failBeforeCommand({
          manifest,
          manifestPath,
          stageName: 'publishPackage',
          step,
          error: 'publish-package 需要 --gateway-token 或 GATEWAY_DEV_ACCESS_TOKEN',
        })
      }
    }
    await runCommandStage({
      manifest,
      stageName: 'publishPackage',
      step,
      command: nodeBin,
      args: [
        packageScript,
        '--book-id',
        bookId,
        '--source-api',
        sourceApi,
        '--gateway-url',
        gatewayUrl,
        '--gateway-token',
        gatewayToken,
        '--device-name',
        options.deviceName || config.deviceName || 'Content Pipeline',
      ],
      redactArgs: ['--gateway-token'],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  if (step === 'publish-audio') {
    const fallbackAudioRoot = manifest.workspace ? join(manifest.workspace, 'audio') : ''
    const rawSourceRoot = options.audioSourceRoot || manifest.artifacts.audioRoot || fallbackAudioRoot
    if (!rawSourceRoot) {
      await failBeforeCommand({
        manifest,
        manifestPath,
        stageName: 'publishAudio',
        step,
        error: 'publish-audio 需要先运行 audio 或传入 --audio-source-root',
      })
    }
    const sourceRoot = resolve(rawSourceRoot)
    if (!dryRun) {
      try {
        await assertDirectory(sourceRoot, 'publish-audio 音频来源目录不存在')
      } catch (error) {
        await failBeforeCommand({ manifest, manifestPath, stageName: 'publishAudio', step, error: error.message })
      }
    }
    manifest.artifacts.gatewayAudioDir = gatewayAudioDir
    const publishAudioArtifacts = { gatewayAudioDir }
    if (gatewayRemoteHost) {
      publishAudioArtifacts.gatewayRemoteAudioTarget = `${gatewayRemoteUser ? `${gatewayRemoteUser}@` : ''}${gatewayRemoteHost}:${joinRemotePath(gatewayRemoteAudioDir, 'books', bookId)}`
      manifest.artifacts.gatewayRemoteAudioTarget = publishAudioArtifacts.gatewayRemoteAudioTarget
    }
    manifest.stages.publishAudio.artifacts = publishAudioArtifacts
    await runCommandStage({
      manifest,
      stageName: 'publishAudio',
      step,
      command: nodeBin,
      args: [
        audioScript,
        '--book-id',
        bookId,
        '--source-root',
        sourceRoot,
        '--gateway-audio-dir',
        gatewayAudioDir,
        '--source-api',
        sourceApi,
        ...optionalArgs([
          ['--remote-host', gatewayRemoteHost],
          ['--remote-user', gatewayRemoteUser],
          ['--remote-audio-dir', gatewayRemoteAudioDir],
          ['--remote-ssh-port', gatewayRemoteSshPort],
        ]),
      ],
      cwd: repoRoot,
      manifestPath,
      dryRun,
    })
    return
  }

  throw new Error(`未知生产步骤：${step}`)
}

async function runEmbeddingStage({ manifest, manifestPath, step, options, config, sourceApi, dryRun }) {
  const bookId = required(manifest.book?.id, 'manifest 缺少 book.id')
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const stage = {
    ...createStage('embedding'),
    ...(manifest.stages?.embedding || {}),
    status: dryRun ? 'skipped' : 'running',
    startedAt,
    finishedAt: '',
    message: dryRun ? 'dry-run，未生成 embedding。' : '',
    error: '',
  }
  const run = {
    step,
    status: dryRun ? 'skipped' : 'running',
    startedAt,
    finishedAt: '',
    command: `embedding ${bookId}`,
    exitCode: null,
  }
  manifest.stages.embedding = stage
  manifest.runs.push(run)
  await writeManifest(manifestPath, manifest)

  if (dryRun) {
    const finishedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs
    stage.finishedAt = finishedAt
    stage.durationMs = durationMs
    run.finishedAt = finishedAt
    run.durationMs = durationMs
    run.exitCode = 0
    await writeManifest(manifestPath, manifest)
    return
  }

  try {
    const mainDbPath = resolve(
      options.mainDb ||
      options.mainDbPath ||
      config.mainDbPath ||
      process.env.NOVEL_READER_MAIN_DB ||
      join(homedir(), '.novel_reader', 'novel_reader.sqlite'),
    )
    const embeddingConfig = readEmbeddingConfigFromMainDb(mainDbPath)
    const limit = Number(options.limit || options.embeddingLimit || 0)
    const force = options.forceEmbedding === 'true'
    const sourceApiBase = sourceApi.replace(/\/+$/, '')
    await assertSourceApiReady(sourceApiBase)
    const validation = await postJson(`${sourceApiBase}/api/rag/embeddings/validate`, embeddingConfig)
    const listPath = force
      ? `/api/rag/embeddings/summary-chapters?bookId=${encodeURIComponent(bookId)}`
      : `/api/rag/embeddings/missing?bookId=${encodeURIComponent(bookId)}&model=${encodeURIComponent(embeddingConfig.model)}`
    const listPayload = await getJson(`${sourceApiBase}${listPath}`)
    let chapterIds = Array.isArray(listPayload.chapterIds) ? listPayload.chapterIds : []
    if (Number.isFinite(limit) && limit > 0) chapterIds = chapterIds.slice(0, Math.floor(limit))

    let completed = 0
    let failed = 0
    let chunkCompleted = 0
    let chunkFailed = 0
    const batchSize = Math.max(1, Math.min(20, Number(embeddingConfig.concurrency) || 3))
    console.log(`embedding 待处理章节：${chapterIds.length}，并发/批大小：${batchSize}`)
    for (let index = 0; index < chapterIds.length; index += batchSize) {
      const batch = chapterIds.slice(index, index + batchSize)
      const batchNumber = Math.floor(index / batchSize) + 1
      const batchCount = Math.ceil(chapterIds.length / batchSize)
      console.log(`embedding batch ${batchNumber}/${batchCount}: ${index + 1}-${index + batch.length}/${chapterIds.length}`)
      const payload = await postJson(`${sourceApiBase}/api/rag/embeddings/batch`, {
        bookId,
        ...embeddingConfig,
        chapterIds: batch,
        force,
      })
      completed += Number(payload.completed) || 0
      failed += Number(payload.failed) || 0
      chunkCompleted += Number(payload.chunkCompleted) || 0
      chunkFailed += Number(payload.chunkFailed) || 0
      console.log(
        `embedding batch ${batchNumber}/${batchCount} 完成：章节 ${payload.completed ?? 0} 成功/${payload.failed ?? 0} 失败，正文片段 ${payload.chunkCompleted ?? 0} 成功/${payload.chunkFailed ?? 0} 失败；累计章节 ${completed}/${chapterIds.length}`,
      )
      const firstError = payload.errors?.[0]?.error || payload.chunkErrors?.[0]?.error
      if (firstError) throw new Error(firstError)
    }

    const coverage = await getJson(
      `${sourceApiBase}/api/rag/embeddings/status?bookId=${encodeURIComponent(bookId)}&model=${encodeURIComponent(embeddingConfig.model)}`,
    )
    const finishedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs
    stage.status = 'completed'
    stage.finishedAt = finishedAt
    stage.durationMs = durationMs
    stage.message = `embedding 完成：处理 ${completed}/${chapterIds.length} 章，正文片段 ${chunkCompleted} 个。`
    stage.artifacts = {
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      baseUrl: embeddingConfig.baseUrl,
      dimension: validation.dimension ?? coverage.dimension ?? null,
      requestedChapters: chapterIds.length,
      completed,
      failed,
      chunkCompleted,
      chunkFailed,
      coverage,
    }
    run.status = 'completed'
    run.finishedAt = finishedAt
    run.durationMs = durationMs
    run.exitCode = 0
    await writeManifest(manifestPath, manifest)
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs
    stage.status = 'failed'
    stage.finishedAt = finishedAt
    stage.durationMs = durationMs
    stage.error = error.message
    run.status = 'failed'
    run.finishedAt = finishedAt
    run.durationMs = durationMs
    run.exitCode = null
    await writeManifest(manifestPath, manifest)
    throw error
  }
}

function readEmbeddingConfigFromMainDb(mainDbPath) {
  const db = new DatabaseSync(mainDbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value_json FROM app_state WHERE key = 'novel-reader-mvp-state'").get()
    if (!row) throw new Error(`主数据库缺少 app_state 模型配置：${mainDbPath}`)
    const state = JSON.parse(row.value_json)
    const embeddingConfig = state.embeddingConfig || {}
    const provider = embeddingConfig.provider === 'openai' ? 'openai' : 'ollama'
    const model = String(embeddingConfig.model || '').trim()
    const baseUrl = String(embeddingConfig.baseUrl || '').trim().replace(/\/+$/, '')
    if (!model || !baseUrl) throw new Error('PC 端 embedding 配置缺少 model 或 baseUrl。')
    return {
      provider,
      model,
      baseUrl,
      apiKey: String(embeddingConfig.apiKey || ''),
      concurrency: Math.max(1, Math.min(20, Number(embeddingConfig.concurrency) || 3)),
    }
  } finally {
    db.close()
  }
}

async function getJson(url) {
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`无法连接本地 API：${url}。请先启动 npm run api，或通过 --source-api 指定地址。`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status} ${url}`)
  return payload
}

async function postJson(url, body) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`无法连接本地 API：${url}。请先启动 npm run api，或通过 --source-api 指定地址。`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status} ${url}`)
  return payload
}

async function assertSourceApiReady(sourceApiBase) {
  await getJson(`${sourceApiBase}/api/state?source=structured&content=metadata`)
}

async function completeWithoutCommand({ manifest, manifestPath, stageName, step, message, artifacts = {} }) {
  const now = new Date().toISOString()
  const stage = {
    ...createStage(stageName),
    ...(manifest.stages?.[stageName] || {}),
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    message,
    error: '',
    artifacts,
  }
  manifest.stages[stageName] = stage
  manifest.runs.push({
    step,
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    command: 'skip-complete',
    exitCode: 0,
  })
  await writeManifest(manifestPath, manifest)
}

async function failBeforeCommand({ manifest, manifestPath, stageName, step, error }) {
  const now = new Date().toISOString()
  const stage = {
    ...createStage(stageName),
    ...(manifest.stages?.[stageName] || {}),
    status: 'failed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    error,
    message: '',
  }
  manifest.stages[stageName] = stage
  manifest.runs.push({
    step,
    status: 'failed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    command: 'preflight',
    exitCode: null,
  })
  await writeManifest(manifestPath, manifest)
  throw new Error(error)
}

async function runCommandStage({ manifest, manifestPath, stageName, step, command, args, cwd, dryRun, redactArgs = [] }) {
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const stage = {
    ...createStage(stageName),
    ...(manifest.stages?.[stageName] || {}),
    status: dryRun ? 'skipped' : 'running',
    startedAt,
    finishedAt: '',
    error: '',
    message: dryRun ? 'dry-run，未执行命令。' : '',
  }
  manifest.stages[stageName] = stage
  const run = {
    step,
    status: dryRun ? 'skipped' : 'running',
    startedAt,
    finishedAt: '',
    command: redactCommand(command, args, redactArgs),
    exitCode: null,
  }
  manifest.runs.push(run)
  manifest.updatedAt = startedAt
  await writeManifest(manifestPath, manifest)

  console.log(`\n==> ${step}`)
  console.log(run.command)
  if (dryRun) {
    const finishedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs
    stage.finishedAt = finishedAt
    stage.durationMs = durationMs
    run.finishedAt = finishedAt
    run.durationMs = durationMs
    run.exitCode = 0
    await writeManifest(manifestPath, manifest)
    return
  }

  let result
  try {
    result = await spawnCommand(command, args, cwd)
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs
    stage.status = 'failed'
    stage.finishedAt = finishedAt
    stage.durationMs = durationMs
    stage.error = error.message
    run.status = 'failed'
    run.finishedAt = finishedAt
    run.durationMs = durationMs
    run.exitCode = null
    await writeManifest(manifestPath, manifest)
    throw error
  }
  const finishedAt = new Date().toISOString()
  const durationMs = Date.now() - startedMs
  run.finishedAt = finishedAt
  run.durationMs = durationMs
  run.exitCode = result.code
  stage.finishedAt = finishedAt
  stage.durationMs = durationMs

  if (result.code === 0) {
    stage.status = 'completed'
    run.status = 'completed'
    stage.message = '执行完成。'
    await writeManifest(manifestPath, manifest)
    return
  }

  stage.status = 'failed'
  run.status = 'failed'
  stage.error = `命令退出码 ${result.code}`
  await writeManifest(manifestPath, manifest)
  throw new Error(`${step} 失败，退出码 ${result.code}`)
}

function spawnCommand(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code }))
  })
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--resume') {
      options.resume = true
    } else if (arg.startsWith('--')) {
      const key = toCamelCase(arg.slice(2))
      options[key] = readArgValue(argv, ++index, arg)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

async function loadPipelineConfig(configPath) {
  const explicitPath = configPath || process.env.CONTENT_PIPELINE_CONFIG || ''
  if (!explicitPath) return {}

  const resolvedPath = resolve(explicitPath)
  try {
    const config = JSON.parse(await readFile(resolvedPath, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('配置文件必须是 JSON object')
    }
    return config
  } catch (error) {
    throw new Error(`读取内容生产配置失败 ${resolvedPath}：${error.message}`)
  }
}

function readArgValue(argv, index, name) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

async function readManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== schemaVersion) {
    throw new Error(`manifest schemaVersion 不支持：${manifest.schemaVersion}`)
  }
  for (const name of stageNames) {
    manifest.stages[name] ||= createStage(name)
  }
  manifest.artifacts ||= {}
  manifest.runs ||= []
  return manifest
}

async function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString()
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function createStage(name) {
  return {
    name,
    status: 'pending',
    startedAt: '',
    finishedAt: '',
    durationMs: null,
    message: '',
    error: '',
    artifacts: {},
  }
}

function formatStageDetails(stage) {
  const artifacts = stage.artifacts || {}
  const details = []

  if (stage.name === 'ingest' && artifacts.chapterCount != null) {
    details.push(`ingest: ${artifacts.chapterCount} 章，${artifacts.wordCount ?? 0} 字，sha256 ${String(artifacts.sourceSha256 || '').slice(0, 12)}...`)
  }
  if (stage.name === 'scan' && artifacts.coverage) {
    const coverage = artifacts.coverage
    details.push(`scan coverage: Summary ${coverage.summaryCompleted}/${coverage.totalChapters}，KG ${coverage.kgCompleted}/${coverage.totalChapters}`)
  }
  if (stage.name === 'embedding' && artifacts.coverage) {
    const coverage = artifacts.coverage
    details.push(`embedding model: ${artifacts.model}，维度 ${artifacts.dimension ?? coverage.dimension ?? 'unknown'}`)
    details.push(`embedding coverage: 章节 ${coverage.embeddedChapters}/${coverage.totalChapters}，正文片段 ${coverage.embeddedChunks}/${coverage.totalChunks}`)
  }
  if (stage.name === 'audio' && artifacts.audioRoot) {
    details.push(`audio output: ${artifacts.audioRoot}`)
  }
  if (stage.name === 'publishAudio' && artifacts.gatewayAudioDir) {
    details.push(`gateway audio dir: ${artifacts.gatewayAudioDir}`)
  }
  if (stage.name === 'publishAudio' && artifacts.gatewayRemoteAudioTarget) {
    details.push(`gateway remote audio: ${artifacts.gatewayRemoteAudioTarget}`)
  }

  return details
}

function createManifest({ bookId, title, source, workspace, now }) {
  return {
    schemaVersion,
    kind: 'novel-reader-content-production-manifest',
    createdAt: now,
    updatedAt: now,
    book: {
      id: bookId,
      title,
      source,
    },
    workspace,
    stages: Object.fromEntries(stageNames.map((name) => [name, createStage(name)])),
    artifacts: {
      packageFile: '',
      audioRoot: '',
      gatewayAudioDir: '',
      gatewayRemoteAudioTarget: '',
    },
    runs: [],
  }
}

async function hashFile(filePath) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error(`${filePath} 不是文件`)
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function assertDirectory(path, message) {
  try {
    const currentStat = await stat(path)
    if (!currentStat.isDirectory()) throw new Error(`${path} 不是目录`)
  } catch (error) {
    throw new Error(`${message}: ${path} (${error.message})`)
  }
}

function getOfflineCoverage(bookId) {
  const offlineDbPath = process.env.NOVEL_READER_OFFLINE_DB || join(homedir(), '.novel_reader', 'offline.sqlite')
  let db
  try {
    db = new DatabaseSync(offlineDbPath, { readOnly: true })
    const totalChapters = db.prepare(`SELECT COUNT(*) AS count FROM source_chapters WHERE book_id = ?`).get(bookId)?.count ?? 0
    const summaryCompleted = db.prepare(`
      SELECT COUNT(*) AS count
      FROM source_chapters c
      JOIN summaries s ON s.chapter_id = c.id
      WHERE c.book_id = ?
    `).get(bookId)?.count ?? 0
    const kgCompleted = db.prepare(`
      SELECT COUNT(*) AS count
      FROM source_chapters c
      JOIN kg_chapter_extractions kg ON kg.chapter_id = c.id AND kg.status = 'completed'
      WHERE c.book_id = ?
    `).get(bookId)?.count ?? 0
    return {
      offlineDbPath,
      totalChapters,
      summaryCompleted,
      kgCompleted,
    }
  } catch {
    return {
      offlineDbPath,
      totalChapters: 0,
      summaryCompleted: 0,
      kgCompleted: 0,
    }
  } finally {
    db?.close()
  }
}

function resolveAllAudioChapters(bookId, options, config) {
  const mainDbPath = resolve(
    options.mainDb ||
    options.mainDbPath ||
    config.mainDbPath ||
    process.env.NOVEL_READER_MAIN_DB ||
    join(homedir(), '.novel_reader', 'novel_reader.sqlite'),
  )
  let db
  try {
    db = new DatabaseSync(mainDbPath, { readOnly: true })
    const book = db.prepare(`
      SELECT chapter_count
      FROM books
      WHERE id = ?
    `).get(bookId)
    const chapterCount =
      typeof book?.chapter_count === 'number' && book.chapter_count > 0
        ? book.chapter_count
        : db.prepare(`SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?`).get(bookId)?.count ?? 0
    if (!Number.isInteger(chapterCount) || chapterCount <= 0) {
      throw new Error(`主数据库没有可用章节：book=${bookId}`)
    }
    return `1-${chapterCount}`
  } catch (error) {
    throw new Error(`未填写 --chapters，且无法从主数据库推断全书章节范围：${mainDbPath} (${error.message})`)
  } finally {
    db?.close()
  }
}

function inferSourceType(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.txt')) return 'txt'
  if (lower.endsWith('.epub')) return 'epub'
  if (lower.endsWith('.mobi') || lower.endsWith('.azw') || lower.endsWith('.azw3')) return 'mobi'
  if (lower.endsWith('.pdf')) return 'pdf'
  return 'file'
}

function optionalNumberArgs(options, pairs) {
  const args = []
  for (const [key, flag] of pairs) {
    if (options[key] != null && options[key] !== '') {
      args.push(flag, String(options[key]))
    }
  }
  return args
}

function optionalArgs(pairs) {
  const args = []
  for (const [flag, value] of pairs) {
    if (value != null && value !== '') args.push(flag, String(value))
  }
  return args
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function safePathSegment(value) {
  return String(value || 'book')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120) || 'book'
}

function joinRemotePath(...parts) {
  return parts
    .map((part, index) => {
      const text = String(part || '').trim()
      if (index === 0) return text.replace(/\/+$/, '')
      return text.replace(/^\/+|\/+$/g, '')
    })
    .filter(Boolean)
    .join('/')
}

function required(value, message) {
  if (value == null || String(value).trim() === '') throw new Error(message)
  return String(value).trim()
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function redactCommand(command, args, redactArgs) {
  const redacted = []
  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index])
    if (redactArgs.includes(args[index]) && index + 1 < args.length) {
      index += 1
      redacted.push('[redacted]')
    }
  }
  return [command, ...redacted].join(' ')
}

function printHelp() {
  console.log(`内容生产流水线

用法：
  node content-pipeline/scripts/content-pipeline.mjs <command> [args...]

命令：
  init      创建 production-manifest.json
  ingest    导入 TXT/EPUB 到主数据库并创建/更新 manifest
  status    查看生产状态
  run       执行一个或多个生产步骤
  help      显示帮助

init 参数：
  --config <path>            内容生产配置 JSON，可用 CONTENT_PIPELINE_CONFIG
  --book-id <id>             书籍 ID
  --title <title>            书名，可选
  --source-file <path>       原始 TXT/EPUB/PDF 文件，可选，第一版只记录不解析
  --work-root <path>         工作根目录，默认 ${defaultWorkRoot}
  --manifest <path>          manifest 输出路径，可选

ingest 参数：
  --config <path>            内容生产配置 JSON，可用 CONTENT_PIPELINE_CONFIG
  --file <path>              原始 TXT/EPUB 文件
  --book-id <id>             书籍 ID，可选；默认按文件 sha256 稳定生成
  --title <title>            书名，可选；默认从文件名或 EPUB metadata 推断
  --main-db <path>           主数据库路径，默认 ~/.novel_reader/novel_reader.sqlite
  --work-root <path>         工作根目录，默认 ${defaultWorkRoot}
  --manifest <path>          manifest 输出路径，可选

run 参数：
  --config <path>            内容生产配置 JSON，可用 CONTENT_PIPELINE_CONFIG
  --manifest <path>          manifest 路径
  --steps <list>             逗号分隔步骤，默认 import,scan,export,publish-package
                            可选：import,scan,export,embedding,audio,publish-package,publish-audio
  --dry-run                  只打印命令并更新 skipped 记录
  --resume                   scan 使用 resume，audio 默认带 --resume
  --force-scan               即使离线结果已完整，也强制调用扫描器
  --scan-type <type>         scan 类型：summary、kg、all，默认 all
  --skip-config-sync         scan 前不从 PC 主数据库同步模型配置
  --limit <n>                embedding 只处理前 n 个缺失章节，便于小成本验证
  --force-embedding true     embedding 重新生成已有章节
  --chapters <list>          audio 章节列表，如 1-10,20；不填则生产全书
  --tts-config <path>        TTS 配置文件
  --audio-out-root <path>    audio 输出目录
  --audio-source-root <path> publish-audio 的音频来源目录
  --source-api <url>         本地 API 地址
  --gateway-url <url>        Gateway 地址
  --gateway-token <token>    Gateway token，也可用 GATEWAY_DEV_ACCESS_TOKEN
  --gateway-audio-dir <path> Gateway 音频目录
  --gateway-remote-host <h>  发布音频后 rsync 到远端 Gateway 主机
  --gateway-remote-user <u>  远端 SSH 用户，可用 GATEWAY_REMOTE_USER
  --gateway-remote-audio-dir <path>
                            远端 Gateway 音频根目录，例如 ~/novel-reader-gateway/audio
  --gateway-remote-ssh-port <port>
                            远端 SSH 端口，可用 GATEWAY_REMOTE_SSH_PORT

示例：
  npm run content:pipeline -- init --book-id <bookId> --title 妖刀记
  npm run content:pipeline -- ingest --file ~/Books/example.txt
  npm run content:pipeline -- status --manifest tmp/content-pipeline/<bookId>/production-manifest.json
  npm run content:pipeline -- run --manifest tmp/content-pipeline/<bookId>/production-manifest.json --steps import,scan,export --dry-run
`)
}
