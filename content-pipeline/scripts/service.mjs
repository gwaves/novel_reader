#!/usr/bin/env node

import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pipelineScript = join(repoRoot, 'content-pipeline', 'scripts', 'content-pipeline.mjs')
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
const runOptionFlags = new Map([
  ['config', '--config'],
  ['steps', '--steps'],
  ['chapters', '--chapters'],
  ['scanType', '--scan-type'],
  ['sourceApi', '--source-api'],
  ['gatewayUrl', '--gateway-url'],
  ['gatewayToken', '--gateway-token'],
  ['gatewayAudioDir', '--gateway-audio-dir'],
  ['audioSourceRoot', '--audio-source-root'],
  ['audioOutRoot', '--audio-out-root'],
  ['ttsConfig', '--tts-config'],
  ['deviceName', '--device-name'],
  ['mainDb', '--main-db'],
  ['limit', '--limit'],
  ['batchSize', '--batch-size'],
  ['directorConcurrency', '--director-concurrency'],
  ['llmChapters', '--llm-chapters'],
  ['minBatchSize', '--min-batch-size'],
  ['ttsConcurrency', '--tts-concurrency'],
  ['ttsChapters', '--tts-chapters'],
])
const runBooleanFlags = new Map([
  ['dryRun', '--dry-run'],
  ['resume', '--resume'],
  ['skipConfigSync', '--skip-config-sync'],
])
const redactedFlags = new Set(['--gateway-token'])

export function loadServiceConfig(env = process.env) {
  const dataDir = resolve(env.CONTENT_PIPELINE_SERVICE_DATA_DIR || join(repoRoot, 'tmp', 'content-pipeline-service'))
  return {
    host: env.CONTENT_PIPELINE_HOST?.trim() || '127.0.0.1',
    port: readPort(env.CONTENT_PIPELINE_PORT, 6290),
    dataDir,
    jobsFile: join(dataDir, 'jobs.json'),
    logsDir: join(dataDir, 'logs'),
    workRoot: resolve(env.CONTENT_PIPELINE_WORK_ROOT || join(repoRoot, 'tmp', 'content-pipeline')),
    mainDbPath: resolve(
      env.CONTENT_PIPELINE_MAIN_DB ||
      env.NOVEL_READER_MAIN_DB ||
      env.NOVEL_READER_DB_PATH ||
      join(homedir(), '.novel_reader', 'novel_reader.sqlite'),
    ),
    token: env.CONTENT_PIPELINE_SERVICE_TOKEN?.trim() || '',
    logLevel: env.CONTENT_PIPELINE_LOG_LEVEL?.trim() || 'info',
  }
}

export async function buildContentPipelineService(config = loadServiceConfig()) {
  const store = new JobStore(config)
  await store.load()

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
  })

  app.addHook('preHandler', async (request) => {
    if (!config.token || request.url === '/' || request.url === '/health') return
    const token = parseBearerToken(request.headers.authorization) || readQueryValue(request.query, 'token')
    if (token !== config.token) {
      const error = new Error('Missing or invalid content pipeline service token.')
      error.statusCode = token ? 401 : 401
      error.code = token ? 'invalid_token' : 'missing_authorization'
      throw error
    }
  })

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'content pipeline service request failed')
    const statusCode = Number(error.statusCode) || 500
    reply.status(statusCode).send({
      error: {
        code: error.code || 'content_pipeline_error',
        message: error.message,
        statusCode,
      },
    })
  })

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(renderConsoleHtml())
  })

  app.get('/health', async () => ({
    status: 'ok',
    service: 'novel-reader-content-pipeline',
    time: new Date().toISOString(),
  }))

  app.get('/api/stages', async () => ({
    stages: stageNames,
  }))

  app.get('/api/books', async (request) => {
    const query = readString(readQueryValue(request.query, 'query'))
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 50)
    return {
      generatedAt: new Date().toISOString(),
      mainDbPath: config.mainDbPath,
      books: listMainBooks(config.mainDbPath, { query, limit }),
    }
  })

  app.post('/api/system/choose-file', async () => ({
    path: await chooseLocalBookFile(),
  }))

  app.get('/api/jobs', async (request) => {
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 50)
    return {
      generatedAt: new Date().toISOString(),
      jobs: store.listJobs(limit),
    }
  })

  app.get('/api/jobs/:jobId', async (request) => {
    return store.readJobResponse(request.params.jobId)
  })

  app.get('/api/jobs/:jobId/log', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    reply.type('text/plain; charset=utf-8')
    return reply.send(createReadStream(job.logFile))
  })

  app.get('/api/jobs/:jobId/events', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })

    const send = async () => {
      reply.raw.write(`event: job\n`)
      reply.raw.write(`data: ${JSON.stringify(await store.readJobResponse(job.id))}\n\n`)
    }
    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: {}\n\n`)
    }, 15_000)
    const listener = (updatedJob) => {
      if (updatedJob.id === job.id) void send()
    }

    store.events.on('job', listener)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      store.events.off('job', listener)
    })
    await send()
  })

  app.post('/api/jobs', async (request, reply) => {
    const body = readObjectBody(request.body)
    const spec = createJobSpec(body, config)
    const activeJob = store.findActiveJobByManifest(spec.manifestPath)
    if (activeJob) {
      reply.status(202).send({
        ...(await store.readJobResponse(activeJob.id)),
        duplicateOf: activeJob.id,
      })
      return
    }
    const job = await store.createJob(spec)
    void runJob(store, job).catch((error) => {
      app.log.error({ err: error, jobId: job.id }, 'content pipeline job runner crashed')
    })
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  return app
}

class JobStore {
  constructor(config) {
    this.config = config
    this.jobs = new Map()
    this.events = new EventEmitter()
  }

  async load() {
    await mkdir(this.config.logsDir, { recursive: true })
    let records = []
    try {
      records = JSON.parse(await readFile(this.config.jobsFile, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    for (const job of Array.isArray(records) ? records : []) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed'
        job.updatedAt = new Date().toISOString()
        job.error = '服务重启时该任务仍在运行，已标记为中断。'
      }
      this.jobs.set(job.id, job)
    }
    await this.persist()
  }

  async createJob(spec) {
    const now = new Date().toISOString()
    const job = {
      id: randomUUID(),
      action: spec.action,
      title: spec.title,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      manifestPath: spec.manifestPath,
      logFile: join(this.config.logsDir, `${Date.now()}-${spec.action}-${safePathSegment(spec.title)}.log`),
      commands: spec.commands.map((command) => ({
        command: command.command,
        args: command.args,
        display: redactCommand(command.command, command.args),
        cwd: command.cwd,
      })),
      currentCommand: 0,
      exitCode: null,
      pid: null,
      error: '',
      logs: [],
    }
    this.jobs.set(job.id, job)
    await this.persistAndEmit(job)
    return job
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null
  }

  listJobs(limit) {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => summarizeJob(job))
  }

  findActiveJobByManifest(manifestPath) {
    const resolvedManifestPath = resolve(manifestPath)
    return [...this.jobs.values()]
      .filter((job) => (job.status === 'queued' || job.status === 'running') && resolve(job.manifestPath) === resolvedManifestPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null
  }

  async readJobResponse(jobId) {
    const job = this.getJob(jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${jobId}`)
    return {
      job,
      manifest: await readJsonIfExists(job.manifestPath),
    }
  }

  appendLog(job, stream, chunk) {
    const text = chunk.toString()
    const lines = text.split(/\r?\n/)
    const now = new Date().toISOString()
    for (const line of lines) {
      if (!line) continue
      job.logs.push({ at: now, stream, line })
    }
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500)
  }

  async appendLogFile(job, stream, chunk) {
    const prefix = chunk
      .toString()
      .split(/\r?\n/)
      .map((line) => (line ? `[${new Date().toISOString()}] ${stream}: ${line}` : ''))
      .filter(Boolean)
      .join('\n')
    if (prefix) await writeFile(job.logFile, `${prefix}\n`, { flag: 'a' })
  }

  async persistAndEmit(job) {
    job.updatedAt = new Date().toISOString()
    await this.persist()
    this.events.emit('job', job)
  }

  async persist() {
    await mkdir(dirname(this.config.jobsFile), { recursive: true })
    const payload = JSON.stringify([...this.jobs.values()], null, 2)
    const tmpFile = `${this.config.jobsFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    await writeFile(tmpFile, `${payload}\n`, 'utf8')
    await rename(tmpFile, this.config.jobsFile)
  }
}

async function runJob(store, job) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  await store.persistAndEmit(job)

  try {
    for (let index = 0; index < job.commands.length; index += 1) {
      job.currentCommand = index
      await store.persistAndEmit(job)
      const result = await runCommand(store, job, job.commands[index])
      if (result.code !== 0) {
        job.status = 'failed'
        job.exitCode = result.code
        job.error = `命令退出码 ${result.code}`
        job.finishedAt = new Date().toISOString()
        await store.persistAndEmit(job)
        return
      }
    }
    job.status = 'completed'
    job.exitCode = 0
    job.finishedAt = new Date().toISOString()
    await store.persistAndEmit(job)
  } catch (error) {
    job.status = 'failed'
    job.error = error.message
    job.finishedAt = new Date().toISOString()
    await store.persistAndEmit(job)
  } finally {
    job.pid = null
    await store.persistAndEmit(job)
  }
}

function runCommand(store, job, commandSpec) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    job.pid = child.pid || null
    void store.persistAndEmit(job)

    child.stdout.on('data', (chunk) => {
      store.appendLog(job, 'stdout', chunk)
      void store.appendLogFile(job, 'stdout', chunk).then(() => store.persistAndEmit(job))
    })
    child.stderr.on('data', (chunk) => {
      store.appendLog(job, 'stderr', chunk)
      void store.appendLogFile(job, 'stderr', chunk).then(() => store.persistAndEmit(job))
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code: code ?? 1 }))
  })
}

function createJobSpec(body, config) {
  const action = readString(body.action || body.mode || 'produce')
  if (action === 'init') return createInitSpec(body, config)
  if (action === 'ingest') return createIngestSpec(body, config)
  if (action === 'run') return createRunSpec(body, config)
  if (action === 'produce') return createProduceSpec(body, config)
  throw httpError(400, 'invalid_job_action', `Unsupported job action: ${action}`)
}

function createInitSpec(body, config) {
  const bookId = requiredString(body.bookId, 'bookId is required.')
  const manifestPath = resolveManifestPath(body.manifestPath || body.manifest, bookId, config)
  const args = ['init', '--book-id', bookId, '--title', readString(body.title || bookId), '--manifest', manifestPath]
  appendOptionalArg(args, '--config', body.config)
  appendOptionalArg(args, '--source-file', body.sourceFile)
  appendOptionalArg(args, '--work-root', body.workRoot)
  return {
    action: 'init',
    title: readString(body.title || bookId),
    manifestPath,
    commands: [pipelineCommand(args)],
  }
}

function createIngestSpec(body, config) {
  const sourceFile = requiredString(body.file || body.sourceFile, 'file is required.')
  const title = readString(body.title || sourceFile)
  const bookId = readString(body.bookId || '')
  const manifestPath = resolveManifestPath(body.manifestPath || body.manifest, bookId || safePathSegment(title), config)
  const args = ['ingest', '--file', sourceFile, '--manifest', manifestPath]
  appendOptionalArg(args, '--book-id', bookId)
  appendOptionalArg(args, '--title', body.title)
  appendOptionalArg(args, '--config', body.config)
  appendOptionalArg(args, '--work-root', body.workRoot)
  appendOptionalArg(args, '--main-db', body.mainDb)
  return {
    action: 'ingest',
    title,
    manifestPath,
    commands: [pipelineCommand(args)],
  }
}

function createRunSpec(body, config) {
  const manifestPath = resolve(requiredString(body.manifestPath || body.manifest, 'manifestPath is required.'))
  return {
    action: 'run',
    title: readString(body.title || body.bookId || 'pipeline-run'),
    manifestPath,
    commands: [pipelineCommand(createRunArgs(body, manifestPath))],
  }
}

function createProduceSpec(body, config) {
  const sourceFile = readString(body.file || body.sourceFile || '')
  const bookId = readString(body.bookId || '')
  if (!sourceFile && !bookId) throw httpError(400, 'missing_input', 'Provide bookId for an existing book or file/sourceFile for ingest.')

  const title = readString(body.title || bookId || sourceFile)
  const manifestPath = resolveManifestPath(body.manifestPath || body.manifest, bookId || safePathSegment(title), config)
  const commands = []
  if (sourceFile) {
    commands.push(createIngestSpec({ ...body, file: sourceFile, manifestPath }, config).commands[0])
  } else {
    commands.push(createInitSpec({ ...body, bookId, manifestPath }, config).commands[0])
  }
  commands.push(pipelineCommand(createRunArgs(body, manifestPath)))
  return {
    action: 'produce',
    title,
    manifestPath,
    commands,
  }
}

function createRunArgs(body, manifestPath) {
  const steps = readString(body.steps || 'import,scan,export,publish-package')
  if (splitList(steps).includes('audio') && !readString(body.chapters)) {
    throw httpError(400, 'missing_audio_chapters', 'MP3 音频步骤需要填写章节范围，例如 1-10。')
  }
  const args = ['run', '--manifest', manifestPath, '--steps', steps]
  for (const [key, flag] of runOptionFlags) {
    if (key === 'steps') continue
    appendOptionalArg(args, flag, body[key])
  }
  for (const [key, flag] of runBooleanFlags) {
    if (body[key] === true || body[key] === 'true') args.push(flag)
  }
  return args
}

function pipelineCommand(args) {
  return {
    command: process.execPath,
    args: [pipelineScript, ...args],
    cwd: repoRoot,
  }
}

function renderConsoleHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Novel Reader Content Pipeline</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2433; background: #f6f7f9; }
    body { margin: 0; }
    button, input, select { font: inherit; }
    .shell { display: grid; grid-template-columns: 360px minmax(0, 1fr); min-height: 100vh; }
    aside { background: #ffffff; border-right: 1px solid #d9dee8; padding: 20px; overflow: auto; }
    main { padding: 24px; overflow: auto; }
    h1 { font-size: 20px; margin: 0 0 18px; }
    h2 { font-size: 15px; margin: 20px 0 10px; }
    label { display: grid; gap: 6px; margin: 10px 0; font-size: 13px; color: #4b5565; }
    input, select { box-sizing: border-box; width: 100%; border: 1px solid #cfd6e3; border-radius: 6px; background: #fff; color: #1d2433; padding: 9px 10px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    button { border: 1px solid #1f5eff; background: #1f5eff; color: #fff; border-radius: 6px; padding: 9px 12px; cursor: pointer; }
    button.secondary { background: #fff; color: #1f5eff; }
    .step-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
    .step-option { display: flex; align-items: center; gap: 8px; border: 1px solid #d9dee8; border-radius: 6px; padding: 8px 10px; color: #1d2433; margin: 0; cursor: pointer; }
    .step-option input { width: auto; margin: 0; }
    .preset-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 10px; }
    .preset-row button { padding: 6px 8px; font-size: 12px; }
    .jobs { display: grid; gap: 8px; margin-top: 12px; }
    .job { border: 1px solid #d9dee8; background: #fff; border-radius: 8px; padding: 10px; cursor: pointer; }
    .job.active { border-color: #1f5eff; box-shadow: 0 0 0 2px #dbe6ff; }
    .meta { color: #667085; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-width: 76px; justify-content: center; border-radius: 999px; padding: 3px 8px; font-size: 12px; background: #e8edf5; color: #314056; }
    .status.running, .status.queued { background: #fff3c4; color: #735b00; }
    .status.completed { background: #dbf5e7; color: #11603c; }
    .status.failed { background: #ffe1e1; color: #9b1c1c; }
    .topline { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .panel { background: #fff; border: 1px solid #d9dee8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .stages { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; }
    .stage { border: 1px solid #d9dee8; border-radius: 8px; padding: 10px; min-height: 78px; }
    .stage strong { display: block; font-size: 13px; margin-bottom: 8px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #101828; color: #e5e7eb; border-radius: 8px; padding: 14px; min-height: 280px; max-height: 480px; overflow: auto; }
    .empty { color: #667085; padding: 24px; text-align: center; }
    @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #d9dee8; } .stages { grid-template-columns: repeat(2, minmax(120px, 1fr)); } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Content Pipeline</h1>
      <label>Token <input id="token" type="password" autocomplete="off" placeholder="CONTENT_PIPELINE_SERVICE_TOKEN" /></label>
      <label>模式
        <select id="action">
          <option value="produce">创建并运行</option>
          <option value="run">继续现有 manifest</option>
          <option value="ingest">只导入文件</option>
          <option value="init">只创建 manifest</option>
        </select>
      </label>
      <label>Book ID <input id="bookId" placeholder="已有书籍 ID" /></label>
      <label>标题 <input id="title" placeholder="书名，可选" /></label>
      <label>文件路径 <input id="sourceFile" placeholder="/path/to/book.txt、.epub、.mobi、.azw3" /></label>
      <div class="actions">
        <button class="secondary" id="chooseFile">选择文件</button>
      </div>
      <label>Manifest <input id="manifestPath" placeholder="默认 tmp/content-pipeline/<bookId>/production-manifest.json" /></label>
      <label>步骤 <input id="steps" value="import,scan,export,publish-package" hidden /></label>
      <div class="preset-row">
        <button class="secondary" type="button" data-preset="package">数据包</button>
        <button class="secondary" type="button" data-preset="full">全流程</button>
        <button class="secondary" type="button" data-preset="audio">只音频</button>
      </div>
      <div class="step-grid" id="stepOptions">
        <label class="step-option"><input type="checkbox" value="import" checked />导入离线库</label>
        <label class="step-option"><input type="checkbox" value="scan" checked />概要/图谱</label>
        <label class="step-option"><input type="checkbox" value="export" checked />导回主库</label>
        <label class="step-option"><input type="checkbox" value="embedding" />Embedding</label>
        <label class="step-option"><input type="checkbox" value="audio" />MP3 音频</label>
        <label class="step-option"><input type="checkbox" value="publish-package" checked />发布数据包</label>
        <label class="step-option"><input type="checkbox" value="publish-audio" />发布音频</label>
      </div>
      <div class="row">
        <label>章节 <input id="chapters" placeholder="1-10" /></label>
        <label>扫描 <select id="scanType"><option value="">all</option><option>summary</option><option>kg</option></select></label>
      </div>
      <div class="actions">
        <button id="start">启动</button>
        <button class="secondary" id="refresh">刷新</button>
      </div>
      <h2>主数据库书籍</h2>
      <label>搜索 <input id="bookQuery" placeholder="书名或 book id" /></label>
      <div class="actions">
        <button class="secondary" id="searchBooks">查询书籍</button>
      </div>
      <div id="books" class="jobs"></div>
      <h2>任务</h2>
      <div id="jobs" class="jobs"></div>
    </aside>
    <main>
      <div id="detail" class="empty">选择或启动一个任务。</div>
    </main>
  </div>
  <script>
    const state = { selectedJobId: '', eventSource: null };
    const fields = ['token','action','bookId','title','sourceFile','manifestPath','steps','chapters','scanType','bookQuery'];
    for (const id of fields) {
      const saved = localStorage.getItem('pipeline.' + id);
      const el = document.getElementById(id);
      if (saved !== null) el.value = saved;
      el.addEventListener('input', () => localStorage.setItem('pipeline.' + id, el.value));
    }
    const stepInput = document.getElementById('steps');
    const stepBoxes = Array.from(document.querySelectorAll('#stepOptions input[type="checkbox"]'));
    function syncStepBoxesFromInput() {
      const selected = new Set(stepInput.value.split(',').map(item => item.trim()).filter(Boolean));
      stepBoxes.forEach(box => { box.checked = selected.has(box.value); });
    }
    function syncStepInputFromBoxes() {
      stepInput.value = stepBoxes.filter(box => box.checked).map(box => box.value).join(',');
      localStorage.setItem('pipeline.steps', stepInput.value);
    }
    syncStepBoxesFromInput();
    stepBoxes.forEach(box => box.addEventListener('change', syncStepInputFromBoxes));
    const presets = {
      package: ['import', 'scan', 'export', 'publish-package'],
      full: ['import', 'scan', 'export', 'embedding', 'audio', 'publish-package', 'publish-audio'],
      audio: ['audio', 'publish-audio'],
    };
    document.querySelectorAll('[data-preset]').forEach(button => {
      button.addEventListener('click', () => {
        const selected = new Set(presets[button.dataset.preset] || []);
        stepBoxes.forEach(box => { box.checked = selected.has(box.value); });
        syncStepInputFromBoxes();
      });
    });
    const authHeaders = () => {
      const token = document.getElementById('token').value.trim();
      return token ? { authorization: 'Bearer ' + token } : {};
    };
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || response.statusText);
      return body;
    }
    async function loadJobs() {
      const body = await api('/api/jobs?limit=50');
      const root = document.getElementById('jobs');
      root.innerHTML = body.jobs.map(job => '<div class="job ' + (job.id === state.selectedJobId ? 'active' : '') + '" data-id="' + job.id + '"><div class="topline"><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + job.status + '">' + job.status + '</span></div><div class="meta">' + job.action + ' · ' + job.createdAt + '</div><div class="meta">' + escapeHtml(job.manifestPath || '') + '</div></div>').join('') || '<div class="meta">暂无任务</div>';
      root.querySelectorAll('.job').forEach(el => el.addEventListener('click', () => selectJob(el.dataset.id)));
    }
    async function loadBooks() {
      const query = encodeURIComponent(document.getElementById('bookQuery').value.trim());
      const body = await api('/api/books?limit=50' + (query ? '&query=' + query : ''));
      const root = document.getElementById('books');
      root.innerHTML = body.books.map(book => '<div class="job book-choice" data-id="' + escapeHtml(book.id) + '" data-title="' + escapeHtml(book.title) + '"><div class="topline"><strong>' + escapeHtml(book.title) + '</strong><span class="status">' + book.chapterCount + ' 章</span></div><div class="meta">' + escapeHtml(book.id) + '</div><div class="meta">' + escapeHtml(book.importedAt || '') + ' · ' + (book.wordCount || 0) + ' 字</div></div>').join('') || '<div class="meta">没有找到书籍。主数据库：' + escapeHtml(body.mainDbPath) + '</div>';
      root.querySelectorAll('.book-choice').forEach(el => el.addEventListener('click', () => {
        document.getElementById('bookId').value = el.dataset.id || '';
        document.getElementById('title').value = el.dataset.title || '';
        document.getElementById('sourceFile').value = '';
        document.getElementById('action').value = 'produce';
        for (const id of ['bookId','title','sourceFile','action']) localStorage.setItem('pipeline.' + id, document.getElementById(id).value);
      }));
    }
    async function selectJob(jobId) {
      state.selectedJobId = jobId;
      if (state.eventSource) state.eventSource.close();
      await renderJob(await api('/api/jobs/' + jobId));
      const token = document.getElementById('token').value.trim();
      const url = '/api/jobs/' + jobId + '/events' + (token ? '?token=' + encodeURIComponent(token) : '');
      state.eventSource = new EventSource(url);
      state.eventSource.addEventListener('job', event => renderJob(JSON.parse(event.data)));
      loadJobs().catch(console.error);
    }
    async function renderJob(body) {
      const job = body.job;
      const manifest = body.manifest || {};
      const stages = ${JSON.stringify(stageNames)}.map(name => {
        const stage = manifest.stages?.[name] || { status: 'pending', message: '', error: '' };
        return '<div class="stage"><strong>' + name + '</strong><span class="status ' + stage.status + '">' + stage.status + '</span><div class="meta">' + escapeHtml(stage.error || stage.message || '') + '</div></div>';
      }).join('');
      const logs = (job.logs || []).map(item => '[' + item.at + '] ' + item.stream + ': ' + item.line).join('\\n');
      document.getElementById('detail').className = '';
      document.getElementById('detail').innerHTML = '<div class="panel"><div class="topline"><div><h1>' + escapeHtml(job.title) + '</h1><div class="meta">' + job.id + '</div></div><span class="status ' + job.status + '">' + job.status + '</span></div><div class="meta">' + escapeHtml(job.manifestPath || '') + '</div>' + (job.error ? '<div class="meta">' + escapeHtml(job.error) + '</div>' : '') + '</div><div class="panel"><h2>阶段</h2><div class="stages">' + stages + '</div></div><div class="panel"><h2>日志</h2><pre>' + escapeHtml(logs || '等待日志...') + '</pre></div>';
      await loadJobs();
    }
    document.getElementById('start').addEventListener('click', async () => {
      const startButton = document.getElementById('start');
      startButton.disabled = true;
      const payload = {};
      syncStepInputFromBoxes();
      try {
        for (const id of fields) {
          if (id === 'token') continue;
          const value = document.getElementById(id).value.trim();
          if (value) payload[id === 'sourceFile' ? 'file' : id] = value;
        }
        payload.action = document.getElementById('action').value;
        const body = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        await selectJob(body.job.id);
      } finally {
        startButton.disabled = false;
      }
    });
    document.getElementById('refresh').addEventListener('click', loadJobs);
    document.getElementById('searchBooks').addEventListener('click', loadBooks);
    document.getElementById('chooseFile').addEventListener('click', async () => {
      try {
        const body = await api('/api/system/choose-file', { method: 'POST' });
        if (body.path) {
          document.getElementById('sourceFile').value = body.path;
          document.getElementById('action').value = 'produce';
          document.getElementById('bookId').value = '';
          localStorage.setItem('pipeline.sourceFile', body.path);
          localStorage.setItem('pipeline.action', 'produce');
          localStorage.setItem('pipeline.bookId', '');
        }
      } catch (error) {
        document.getElementById('books').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
      }
    });
    document.getElementById('bookQuery').addEventListener('keydown', event => {
      if (event.key === 'Enter') loadBooks().catch(error => { document.getElementById('books').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>'; });
    });
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    loadBooks().catch(error => { document.getElementById('books').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>'; });
    loadJobs().catch(error => { document.getElementById('jobs').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>'; });
  </script>
</body>
</html>`
}

function listMainBooks(mainDbPath, { query = '', limit = 50 } = {}) {
  let db
  try {
    db = new DatabaseSync(mainDbPath, { readOnly: true })
    const hasWordCount = tableHasColumn(db, 'chapters', 'word_count')
    const wordCountSelect = hasWordCount ? 'COALESCE(SUM(c.word_count), 0)' : '0'
    const normalizedQuery = `%${query.replace(/[%_]/g, '\\$&')}%`
    const rows = query
      ? db.prepare(`
          SELECT b.id, b.title, b.imported_at, b.chapter_count, b.updated_at, ${wordCountSelect} AS word_count
          FROM books b
          LEFT JOIN chapters c ON c.book_id = b.id
          WHERE b.id LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\'
          GROUP BY b.id
          ORDER BY b.updated_at DESC, b.imported_at DESC
          LIMIT ?
        `).all(normalizedQuery, normalizedQuery, limit)
      : db.prepare(`
          SELECT b.id, b.title, b.imported_at, b.chapter_count, b.updated_at, ${wordCountSelect} AS word_count
          FROM books b
          LEFT JOIN chapters c ON c.book_id = b.id
          GROUP BY b.id
          ORDER BY b.updated_at DESC, b.imported_at DESC
          LIMIT ?
        `).all(limit)

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      importedAt: String(row.imported_at || ''),
      updatedAt: String(row.updated_at || ''),
      chapterCount: Number(row.chapter_count) || 0,
      wordCount: Number(row.word_count) || 0,
    }))
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' || error.code === 'ENOENT') {
      throw httpError(404, 'main_db_unavailable', `Cannot read main database: ${mainDbPath}. ${error.message}`)
    }
    throw error
  } finally {
    db?.close()
  }
}

async function chooseLocalBookFile() {
  if (process.platform !== 'darwin') {
    throw httpError(501, 'file_picker_unavailable', 'File picker is currently implemented for macOS only.')
  }
  const script = [
    'set selectedFile to choose file with prompt "选择要导入 Novel Reader 的电子书" of type {"txt", "epub", "mobi", "azw", "azw3", "pdf"}',
    'POSIX path of selectedFile',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    const message = String(error.stderr || error.message || '').trim()
    if (message.includes('User canceled') || error.code === 1) {
      throw httpError(499, 'file_picker_cancelled', 'File selection was cancelled.')
    }
    throw httpError(500, 'file_picker_failed', `Failed to open file picker: ${message}`)
  }
}

function tableHasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all()
  return rows.some((row) => row.name === columnName)
}

function summarizeJob(job) {
  return {
    id: job.id,
    action: job.action,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    manifestPath: job.manifestPath,
    error: job.error,
  }
}

async function readJsonIfExists(filePath) {
  if (!filePath) return null
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    return { error: error.message }
  }
}

function readObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request_body', 'Request body must be a JSON object.')
  }
  return body
}

function resolveManifestPath(value, bookId, config) {
  if (readString(value)) return resolve(readString(value))
  return join(config.workRoot, safePathSegment(bookId), 'production-manifest.json')
}

function appendOptionalArg(args, flag, value) {
  const text = readString(value)
  if (text) args.push(flag, text)
}

function redactCommand(command, args) {
  const parts = [command]
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    parts.push(arg)
    if (redactedFlags.has(arg) && args[index + 1]) {
      parts.push('[redacted]')
      index += 1
    }
  }
  return parts.join(' ')
}

function readString(value) {
  return value == null ? '' : String(value).trim()
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function requiredString(value, message) {
  const text = readString(value)
  if (!text) throw httpError(400, 'missing_required_field', message)
  return text
}

function readPort(value, fallback) {
  const port = value ? Number(value) : fallback
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CONTENT_PIPELINE_PORT must be a valid TCP port.')
  return port
}

function readQueryValue(query, key) {
  if (!query || typeof query !== 'object') return undefined
  const value = query[key]
  return Array.isArray(value) ? value[0] : value
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function parseBearerToken(authorization) {
  if (!authorization) return null
  const [scheme, token, extra] = String(authorization).trim().split(/\s+/)
  if (extra || scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function safePathSegment(value) {
  return String(value || 'job')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120) || 'job'
}

function httpError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadServiceConfig()
  const app = await buildContentPipelineService(config)
  try {
    await app.listen({ host: config.host, port: config.port })
    app.log.info(`content pipeline service listening on http://${config.host}:${config.port}`)
  } catch (error) {
    app.log.error(error, 'failed to start content pipeline service')
    process.exitCode = 1
  }
}
