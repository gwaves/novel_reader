#!/usr/bin/env node

import Fastify from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const productionPipelineScript = resolve(repoRoot, 'production-pipeline', 'src', 'cli.mjs')

export function loadServiceConfig(env = process.env) {
  const dataDir = resolve(env.PRODUCTION_PIPELINE_CONSOLE_DATA_DIR || joinPath('tmp', 'production-pipeline-console'))
  return {
    host: env.PRODUCTION_PIPELINE_CONSOLE_HOST?.trim() || '127.0.0.1',
    port: readPort(env.PRODUCTION_PIPELINE_CONSOLE_PORT, 6290),
    dataDir,
    jobsFile: resolve(dataDir, 'jobs.json'),
    logsDir: resolve(dataDir, 'logs'),
    productionRunRoot: resolve(env.PRODUCTION_PIPELINE_RUN_ROOT || joinPath('tmp', 'production-pipeline', 'runs')),
    mainDbPath: resolve(
      env.PRODUCTION_PIPELINE_MAIN_DB ||
      env.NOVEL_READER_MAIN_DB ||
      env.NOVEL_READER_DB_PATH ||
      resolve(homedir(), '.novel_reader', 'novel_reader.sqlite'),
    ),
    token: env.PRODUCTION_PIPELINE_CONSOLE_TOKEN?.trim() || '',
    logLevel: env.PRODUCTION_PIPELINE_CONSOLE_LOG_LEVEL?.trim() || 'info',
    discoverRuns: env.PRODUCTION_PIPELINE_CONSOLE_DISCOVER_RUNS !== 'false',
  }
}

export async function buildProductionPipelineService(config = loadServiceConfig()) {
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
      throw httpError(401, token ? 'invalid_token' : 'missing_authorization', 'Missing or invalid production pipeline console token.')
    }
  })

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'production pipeline console request failed')
    const statusCode = Number(error.statusCode) || 500
    reply.status(statusCode).send({
      error: {
        code: error.code || 'production_pipeline_console_error',
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
    service: 'novel-reader-production-pipeline',
    time: new Date().toISOString(),
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
    path: await chooseLocalFile({ prompt: '选择 Production Pipeline v2 Job JSON' }),
  }))

  app.get('/api/jobs', async (request) => {
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 50)
    if (config.discoverRuns) {
      await store.discoverProductionRuns()
    }
    return {
      generatedAt: new Date().toISOString(),
      jobs: store.listJobs(limit),
    }
  })

  app.get('/api/jobs/:jobId', async (request) => store.readJobResponse(request.params.jobId))

  app.get('/api/jobs/:jobId/log', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    reply.type('text/plain; charset=utf-8')
    return reply.send(createReadStream(job.logFile))
  })

  app.get('/api/jobs/:jobId/production-file', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    const productionRun = await readProductionRunState(job)
    if (!productionRun?.runDir) throw httpError(404, 'production_run_not_found', `Production run not found for job: ${job.id}`)
    const filePath = resolveProductionRunFile(productionRun.runDir, requiredString(readQueryValue(request.query, 'path'), 'path is required.'))
    reply.type(filePath.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
    return reply.send(createReadStream(filePath))
  })

  app.get('/api/jobs/:jobId/production-log-viewer', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    const productionRun = await readProductionRunState(job)
    if (!productionRun?.runDir) throw httpError(404, 'production_run_not_found', `Production run not found for job: ${job.id}`)
    const requestedPath = requiredString(readQueryValue(request.query, 'path'), 'path is required.')
    const filePath = resolveProductionRunFile(productionRun.runDir, requestedPath)
    const token = readString(readQueryValue(request.query, 'token'))
    const dataUrl = `/api/jobs/${encodeURIComponent(job.id)}/production-file?path=${encodeURIComponent(requestedPath)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
    reply.type('text/html; charset=utf-8').send(renderProductionLogViewerHtml({
      title: `${job.title || job.id} log`,
      path: filePath.slice(productionRun.runDir.length + 1),
      dataUrl,
      intervalMs: 5_000,
    }))
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
      reply.raw.write('event: job\n')
      reply.raw.write(`data: ${JSON.stringify(await store.readJobResponse(job.id))}\n\n`)
    }
    const refresh = setInterval(() => {
      void send()
    }, 5_000)
    const listener = (updatedJob) => {
      if (updatedJob.id === job.id) void send()
    }

    store.events.on('job', listener)
    request.raw.on('close', () => {
      clearInterval(refresh)
      store.events.off('job', listener)
    })
    await send()
  })

  app.post('/api/jobs/:jobId/stop', async (request, reply) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    await store.stopJob(job.id)
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  app.post('/api/jobs', async (request, reply) => {
    const spec = createProductionV2Spec(readObjectBody(request.body), config)
    const activeJob = store.findActiveJobByProductionJob(spec.productionJobPath)
    if (activeJob) {
      reply.status(202).send({
        ...(await store.readJobResponse(activeJob.id)),
        duplicateOf: activeJob.id,
      })
      return
    }
    const job = await store.createJob(spec)
    void runJob(store, job).catch((error) => {
      app.log.error({ err: error, jobId: job.id }, 'production pipeline job runner crashed')
    })
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  return app
}

class JobStore {
  constructor(config) {
    this.config = config
    this.jobs = new Map()
    this.activeChildren = new Map()
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
    if (this.config.discoverRuns) {
      await this.discoverProductionRuns()
    }
    await this.persist()
  }

  async discoverProductionRuns() {
    const discovered = await listProductionRunJsonFiles(this.config.productionRunRoot, 50)
    for (const runJsonPath of discovered) {
      const runJson = await readJsonIfExists(runJsonPath).catch(() => null)
      if (!runJson) continue
      const runDir = dirname(runJsonPath)
      const bookId = basename(dirname(runDir))
      const runId = readString(runJson.runId || basename(runDir))
      const id = `run-${createHash('sha1').update(runJsonPath).digest('hex').slice(0, 16)}`
      const discoveredJob = {
        id,
        action: 'production-v2-run',
        title: readString(runJson.job?.title || runJson.title || bookId),
        status: readString(runJson.status || 'unknown'),
        createdAt: readString(runJson.createdAt || runId),
        updatedAt: readString(runJson.updatedAt || runJson.createdAt || runId),
        startedAt: readString(runJson.startedAt || ''),
        finishedAt: readString(runJson.finishedAt || ''),
        productionRunRoot: this.config.productionRunRoot,
        productionRunDir: runDir,
        productionBookId: bookId,
        productionJobPath: readString(runJson.jobPath || ''),
        logFile: '',
        commands: [],
        currentCommand: 0,
        exitCode: null,
        pid: null,
        error: '',
        logs: [],
        readOnly: true,
      }
      const existing = this.jobs.get(id)
      this.jobs.set(id, existing ? { ...existing, ...discoveredJob } : discoveredJob)
    }
  }

  async createJob(spec) {
    const now = new Date().toISOString()
    const job = {
      id: randomUUID(),
      action: 'production-v2',
      title: spec.title,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      productionRunRoot: spec.productionRunRoot,
      productionBookId: spec.productionBookId,
      productionJobPath: spec.productionJobPath,
      logFile: resolve(this.config.logsDir, `${Date.now()}-production-v2-${safePathSegment(spec.title)}.log`),
      commands: spec.commands.map((command) => ({
        command: command.command,
        args: command.args,
        display: [command.command, ...command.args].join(' '),
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

  findActiveJobByProductionJob(jobPath) {
    const resolvedJobPath = resolve(jobPath)
    return [...this.jobs.values()]
      .filter((job) => isActiveJob(job) && resolve(job.productionJobPath || '') === resolvedJobPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null
  }

  async readJobResponse(jobId) {
    const job = this.getJob(jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${jobId}`)
    return {
      job,
      productionRun: await readProductionRunState(job),
    }
  }

  registerChild(job, child) {
    this.activeChildren.set(job.id, child)
  }

  unregisterChild(job, child) {
    if (this.activeChildren.get(job.id) === child) this.activeChildren.delete(job.id)
  }

  async stopJob(jobId) {
    const job = this.getJob(jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${jobId}`)
    if (!isActiveJob(job)) throw httpError(409, 'job_not_active', `Job is not running: ${jobId}`)

    job.stopRequested = true
    job.status = 'stopping'
    job.error = '用户请求停止任务。'
    await this.appendLogFile(job, 'system', '用户请求停止任务。')
    const child = this.activeChildren.get(job.id)
    if (!child?.pid) {
      job.status = 'stopped'
      job.finishedAt = new Date().toISOString()
      await this.persistAndEmit(job)
      return
    }
    await this.persistAndEmit(job)
    await killProcessTree(child.pid)
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
    const payload = JSON.stringify([...this.jobs.values()].filter((job) => !job.readOnly), null, 2)
    const tmpFile = `${this.config.jobsFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    await writeFile(tmpFile, `${payload}\n`, 'utf8')
    await rename(tmpFile, this.config.jobsFile)
  }
}

async function runJob(store, job) {
  if (job.stopRequested) {
    job.status = 'stopped'
    job.finishedAt = new Date().toISOString()
    await store.persistAndEmit(job)
    return
  }
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  await store.persistAndEmit(job)

  try {
    for (let index = 0; index < job.commands.length; index += 1) {
      job.currentCommand = index
      await store.persistAndEmit(job)
      const result = await runCommand(store, job, job.commands[index])
      if (job.stopRequested) {
        job.status = 'stopped'
        job.exitCode = result.code
        job.error = '任务已停止。'
        job.finishedAt = new Date().toISOString()
        await store.persistAndEmit(job)
        return
      }
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
    job.status = job.stopRequested ? 'stopped' : 'failed'
    job.error = job.stopRequested ? '任务已停止。' : error.message
    job.finishedAt = new Date().toISOString()
    await store.persistAndEmit(job)
  } finally {
    job.pid = null
    job.stopRequested = false
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
    store.registerChild(job, child)
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
    child.on('close', (code, signal) => {
      store.unregisterChild(job, child)
      resolvePromise({ code: code ?? (signal ? 128 : 1), signal: signal || '' })
    })
  })
}

function createProductionV2Spec(body, config) {
  const jobPath = resolve(requiredString(body.jobPath || body.productionJobPath || body.manifestPath || body.manifest, 'jobPath is required.'))
  const jobConfig = readProductionJobConfig(jobPath)
  const bookId = resolveProductionJobBookId(body, jobConfig)
  const title = readString(body.title || jobConfig.title || bookId)
  const runRoot = resolve(readString(body.productionRunRoot || body.runRoot) || config.productionRunRoot)
  return {
    title,
    productionRunRoot: runRoot,
    productionBookId: bookId,
    productionJobPath: jobPath,
    commands: [{
      command: process.execPath,
      args: [productionPipelineScript, 'run', '--job', jobPath, '--run-root', runRoot],
      cwd: repoRoot,
    }],
  }
}

function renderConsoleHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Novel Reader Production Pipeline</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2433; background: #f6f7f9; }
    body { margin: 0; }
    button, input { font: inherit; }
    .shell { display: grid; grid-template-columns: 360px minmax(0, 1fr); min-height: 100vh; }
    aside { background: #fff; border-right: 1px solid #d9dee8; padding: 20px; overflow: auto; }
    main { padding: 24px; overflow: auto; }
    h1 { font-size: 20px; margin: 0 0 18px; }
    h2 { font-size: 15px; margin: 20px 0 10px; }
    label { display: grid; gap: 6px; margin: 10px 0; font-size: 13px; color: #4b5565; }
    input { box-sizing: border-box; width: 100%; border: 1px solid #cfd6e3; border-radius: 6px; background: #fff; color: #1d2433; padding: 9px 10px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    button { border: 1px solid #1f5eff; background: #1f5eff; color: #fff; border-radius: 6px; padding: 9px 12px; cursor: pointer; }
    button.secondary { background: #fff; color: #1f5eff; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .jobs { display: grid; gap: 8px; margin-top: 12px; }
    .job { border: 1px solid #d9dee8; background: #fff; border-radius: 8px; padding: 10px; cursor: pointer; }
    .job.active { border-color: #1f5eff; box-shadow: 0 0 0 2px #dbe6ff; }
    .meta { color: #667085; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-width: 76px; justify-content: center; border-radius: 999px; padding: 3px 8px; font-size: 12px; background: #e8edf5; color: #314056; }
    .status.running, .status.queued { background: #fff3c4; color: #735b00; }
    .status.completed { background: #dbf5e7; color: #11603c; }
    .status.failed { background: #ffe1e1; color: #9b1c1c; }
    .status.stopping { background: #fdebd3; color: #8a4b08; }
    .status.stopped { background: #e8edf5; color: #475467; }
    .topline { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .panel { background: #fff; border: 1px solid #d9dee8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .error-panel { border: 1px solid #f0b8ae; border-radius: 8px; background: #fff4f1; color: #9a3324; padding: 14px 16px; margin-bottom: 16px; }
    .stages { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; }
    .stage { border: 1px solid #d9dee8; border-radius: 8px; padding: 10px; min-height: 78px; }
    .stage strong { display: block; font-size: 13px; margin-bottom: 8px; }
    .stage .child { border-top: 1px solid #edf0f5; margin-top: 8px; padding-top: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; margin-top: 12px; }
    .metric { border: 1px solid #d9dee8; border-radius: 8px; padding: 10px; background: #fbfcfe; }
    .metric strong { display: block; font-size: 13px; margin-bottom: 8px; }
    .metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-top: 1px solid #edf0f5; padding-top: 7px; margin-top: 7px; }
    .metric-value { font-variant-numeric: tabular-nums; font-weight: 700; color: #1f5eff; }
    .concurrency { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px; margin: 12px 0; }
    .concurrency-card { border: 1px solid #d9dee8; border-radius: 8px; padding: 10px; background: #fff; }
    .concurrency-card strong { display: block; font-size: 13px; margin-bottom: 8px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid #ccd6e4; border-radius: 999px; padding: 4px 8px; font-size: 12px; background: #f8fafc; color: #344054; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #101828; color: #e5e7eb; border-radius: 8px; padding: 14px; min-height: 280px; max-height: 480px; overflow: auto; }
    .empty { color: #667085; padding: 24px; text-align: center; }
    @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #d9dee8; } .stages, .metrics, .concurrency { grid-template-columns: repeat(2, minmax(120px, 1fr)); } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Production Pipeline</h1>
      <label>Token <input id="token" type="password" autocomplete="off" placeholder="PRODUCTION_PIPELINE_CONSOLE_TOKEN" /></label>
      <label>V2 Job JSON <input id="jobPath" placeholder="production-pipeline/config/example.job.json" /></label>
      <div class="actions">
        <button class="secondary" id="chooseJob" type="button">选择 JSON</button>
        <button id="startV2" type="button">启动</button>
        <button class="secondary" id="refresh" type="button">刷新</button>
      </div>
      <h2>任务</h2>
      <div id="jobs" class="jobs"></div>
    </aside>
    <main>
      <div id="detail" class="empty">选择或启动一个任务。</div>
    </main>
  </div>
  <script>
    const state = { selectedJobId: '', eventSource: null };
    const fields = ['token','jobPath'];
    for (const id of fields) {
      const saved = localStorage.getItem('productionPipeline.' + id);
      const el = document.getElementById(id);
      if (saved !== null) el.value = saved;
      el.addEventListener('input', () => localStorage.setItem('productionPipeline.' + id, el.value));
    }
    const authHeaders = () => {
      const token = document.getElementById('token').value.trim();
      return token ? { authorization: 'Bearer ' + token } : {};
    };
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || response.statusText || '请求失败');
      return body;
    }
    function showError(title, error) {
      document.getElementById('detail').className = '';
      document.getElementById('detail').innerHTML = '<div class="error-panel"><strong>' + escapeHtml(title) + '</strong><div>' + escapeHtml(error.message || String(error)) + '</div></div>' + document.getElementById('detail').innerHTML;
    }
    async function loadJobs() {
      const body = await api('/api/jobs?limit=50');
      const root = document.getElementById('jobs');
      root.innerHTML = body.jobs.map(job => '<div class="job ' + (job.id === state.selectedJobId ? 'active' : '') + '" data-id="' + job.id + '"><div class="topline"><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + job.status + '">' + job.status + '</span></div><div class="meta">' + job.createdAt + '</div><div class="meta">' + escapeHtml(job.productionJobPath || '') + '</div>' + (isActiveJob(job) ? '<div class="actions"><button class="secondary stop-job" type="button" data-id="' + job.id + '">停止任务</button></div>' : '') + '</div>').join('') || '<div class="meta">暂无任务</div>';
      root.querySelectorAll('.job').forEach(el => el.addEventListener('click', () => selectJob(el.dataset.id)));
      root.querySelectorAll('.stop-job').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        stopJob(button.dataset.id).catch(error => showError('停止任务失败', error));
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
      const previousLog = document.getElementById('jobLog');
      const shouldStickToBottom = !previousLog || previousLog.scrollHeight - previousLog.scrollTop - previousLog.clientHeight < 24;
      const productionRun = renderProductionRun(job.id, body.productionRun);
      const logs = (job.logs || []).map(item => '[' + item.at + '] ' + item.stream + ': ' + item.line).join('\\n');
      document.getElementById('detail').className = '';
      const stopButton = isActiveJob(job) ? '<div class="actions"><button class="secondary" id="stopSelectedJob" type="button">停止任务</button></div>' : '';
      document.getElementById('detail').innerHTML = '<div class="panel"><div class="topline"><div><h1>' + escapeHtml(job.title) + '</h1><div class="meta">' + job.id + '</div></div><span class="status ' + job.status + '">' + job.status + '</span></div><div class="meta">' + escapeHtml(job.productionJobPath || '') + '</div>' + (job.error ? '<div class="meta">' + escapeHtml(job.error) + '</div>' : '') + stopButton + '</div>' + productionRun + '<div class="panel"><h2>日志</h2><pre id="jobLog">' + escapeHtml(logs || '等待日志...') + '</pre></div>';
      const stopSelectedJob = document.getElementById('stopSelectedJob');
      if (stopSelectedJob) stopSelectedJob.addEventListener('click', () => stopJob(job.id).catch(error => showError('停止任务失败', error)));
      const nextLog = document.getElementById('jobLog');
      if (nextLog && shouldStickToBottom) nextLog.scrollTop = nextLog.scrollHeight;
      await loadJobs();
    }
    function isActiveJob(job) {
      return job && (job.status === 'queued' || job.status === 'running' || job.status === 'stopping');
    }
    async function stopJob(jobId) {
      await api('/api/jobs/' + encodeURIComponent(jobId) + '/stop', { method: 'POST' });
      await selectJob(jobId);
    }
    function renderProductionRun(jobId, productionRun) {
      if (!productionRun) return '';
      const run = productionRun.runJson || {};
      const stages = run.stages || {};
      const stageCards = Object.keys(stages).map(name => {
        const stage = stages[name] || {};
        const children = normalizeProductionChildren(stage).map((child, index) => {
          const label = child.childRunJson ? renderProductionFileLink(jobId, 'runJson', child.childRunJson) : (child.childRunDir ? 'runDir: ' + escapeHtml(child.childRunDir) : '');
          return '<div class="child"><div class="meta mono">' + (label || ('child ' + (index + 1))) + '</div>' + (child.logFile ? '<div class="meta mono">' + renderProductionLogLink(jobId, 'log', child.logFile) + '</div>' : '') + '</div>';
        }).join('');
        return '<div class="stage"><strong>' + escapeHtml(name) + '</strong><span class="status ' + escapeHtml(stage.status || 'unknown') + '">' + escapeHtml(stage.status || 'unknown') + '</span><div class="meta">' + escapeHtml(stage.error || stage.message || '') + '</div>' + children + '</div>';
      }).join('');
      const runJsonLink = productionRun.runJsonPath ? renderProductionFileLink(jobId, 'run.json', productionRun.runJsonPath) : '等待 run.json...';
      const metrics = renderProductionMetrics(productionRun.metrics);
      const concurrency = renderRuntimeConcurrency(productionRun.metrics && productionRun.metrics.concurrency);
      return '<div class="panel"><div class="topline"><div><h2>Production v2</h2><div class="meta mono">' + runJsonLink + '</div></div><span class="status ' + escapeHtml(run.status || 'pending') + '">' + escapeHtml(run.status || 'pending') + '</span></div>' + concurrency + metrics + (stageCards ? '<div class="stages">' + stageCards + '</div>' : '<div class="meta">等待 v2 任务启动。</div>') + '</div>';
    }
    function renderRuntimeConcurrency(concurrency) {
      if (!concurrency || (!concurrency.kg && !concurrency.audio)) return '';
      const cards = [];
      if (concurrency.kg) {
        const kg = concurrency.kg;
        cards.push('<div class="concurrency-card"><strong>KG 当前并发</strong><div class="chips"><span class="chip">LLM ' + escapeHtml(formatConcurrencyValue(kg.concurrency)) + '</span></div>' + renderUpdatedAt(kg.updatedAt) + '</div>');
      }
      if (concurrency.audio) {
        const audio = concurrency.audio;
        cards.push('<div class="concurrency-card"><strong>Audio 当前并发</strong><div class="chips"><span class="chip">导演 LLM ' + escapeHtml(formatConcurrencyValue(audio.directorConcurrency)) + '</span><span class="chip">LLM 章节 ' + escapeHtml(formatConcurrencyValue(audio.llmChapters)) + '</span><span class="chip">TTS API ' + escapeHtml(formatConcurrencyValue(audio.ttsConcurrency)) + '</span><span class="chip">TTS 章节 ' + escapeHtml(formatConcurrencyValue(audio.ttsChapters)) + '</span></div>' + renderUpdatedAt(audio.updatedAt) + '</div>');
      }
      return '<h2>当前并发</h2><div class="concurrency">' + cards.join('') + '</div>';
    }
    function renderUpdatedAt(value) {
      return value ? '<div class="meta">更新于 ' + escapeHtml(value) + '</div>' : '';
    }
    function formatConcurrencyValue(value) {
      const number = Number(value);
      return Number.isFinite(number) ? String(number) : '未知';
    }
    function renderProductionMetrics(metrics) {
      if (!metrics || !metrics.stages || !Object.keys(metrics.stages).length) return '';
      const windows = metrics.windows || [
        { key: '5m', label: '近 5 分钟' },
        { key: '15m', label: '近 15 分钟' },
        { key: 'overall', label: '全程平均' },
      ];
      const cards = Object.entries(metrics.stages).map(([name, metric]) => {
        const latest = metric.latest || {};
        const unit = metric.unit || '项';
        const total = Number(latest.total) > 0 ? '/' + latest.total : '';
        const rows = windows.map(windowInfo => {
          const rate = metric.rates && metric.rates[windowInfo.key];
          const value = rate ? formatRate(rate.perMinute) + ' ' + unit + '/分钟' : '暂无';
          const detail = rate ? '<div class="meta">' + escapeHtml(rate.produced + ' ' + unit + ' / ' + formatMinutes(rate.minutes) + ' 分钟') + '</div>' : '';
          return '<div class="metric-row"><span class="meta">' + escapeHtml(windowInfo.label) + '</span><span class="metric-value">' + escapeHtml(value) + '</span></div>' + detail;
        }).join('');
        return '<div class="metric"><strong>' + escapeHtml(name) + '</strong><div class="meta">完成 ' + escapeHtml(String(latest.completed ?? latest.done ?? 0)) + escapeHtml(total) + (latest.failed ? '，失败 ' + escapeHtml(String(latest.failed)) : '') + '</div>' + rows + '</div>';
      }).join('');
      return '<h2>产出速度</h2><div class="metrics">' + cards + '</div><div class="meta">统计时间：' + escapeHtml(metrics.generatedAt || '') + '</div>';
    }
    function formatRate(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      if (number >= 10) return number.toFixed(1);
      if (number >= 1) return number.toFixed(2);
      return number.toFixed(3);
    }
    function formatMinutes(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      return number >= 10 ? number.toFixed(1) : number.toFixed(2);
    }
    function renderProductionFileLink(jobId, label, path) {
      const token = document.getElementById('token').value.trim();
      const url = '/api/jobs/' + encodeURIComponent(jobId) + '/production-file?path=' + encodeURIComponent(path) + (token ? '&token=' + encodeURIComponent(token) : '');
      return '<a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(label) + ': ' + escapeHtml(path) + '</a>';
    }
    function renderProductionLogLink(jobId, label, path) {
      const token = document.getElementById('token').value.trim();
      const url = '/api/jobs/' + encodeURIComponent(jobId) + '/production-log-viewer?path=' + encodeURIComponent(path) + (token ? '&token=' + encodeURIComponent(token) : '');
      return '<a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(label) + ': ' + escapeHtml(path) + '</a>';
    }
    function normalizeProductionChildren(stage) {
      const children = [];
      if (stage.childRunJson || stage.childRunDir || stage.logFile) children.push(stage);
      if (Array.isArray(stage.childRuns)) children.push(...stage.childRuns);
      return children;
    }
    document.getElementById('startV2').addEventListener('click', async () => {
      const startButton = document.getElementById('startV2');
      startButton.disabled = true;
      try {
        const jobPath = document.getElementById('jobPath').value.trim();
        const body = await api('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobPath }),
        });
        await selectJob(body.job.id);
      } catch (error) {
        showError('启动失败', error);
      } finally {
        startButton.disabled = false;
      }
    });
    document.getElementById('refresh').addEventListener('click', loadJobs);
    document.getElementById('chooseJob').addEventListener('click', async () => {
      try {
        const body = await api('/api/system/choose-file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'job' }),
        });
        if (body.path) {
          document.getElementById('jobPath').value = body.path;
          localStorage.setItem('productionPipeline.jobPath', body.path);
        }
      } catch (error) {
        showError('选择 JSON 失败', error);
      }
    });
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    loadJobs().catch(error => { document.getElementById('jobs').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>'; });
  </script>
</body>
</html>`
}

function renderProductionLogViewerHtml({ title, path, dataUrl, intervalMs }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtmlText(title)}</title>
  <style>
    body { margin: 0; background: #f6f8fb; color: #17212f; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position: sticky; top: 0; z-index: 1; display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #d8e0ea; background: rgba(246, 248, 251, 0.94); backdrop-filter: blur(10px); }
    h1 { margin: 0; font-size: 18px; line-height: 1.3; }
    .meta { color: #607086; font-size: 13px; overflow-wrap: anywhere; }
    button { border: 1px solid #c8d3df; border-radius: 6px; background: #fff; color: #17212f; padding: 8px 12px; font-weight: 700; cursor: pointer; }
    pre { box-sizing: border-box; height: calc(100vh - 75px); margin: 0; padding: 18px; overflow: auto; background: #0f1726; color: #dbe7ff; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtmlText(title)}</h1>
      <div class="meta">${escapeHtmlText(path)} · 每 5 秒自动刷新 · <span id="status">等待刷新</span></div>
    </div>
    <button id="refresh" type="button">刷新</button>
  </header>
  <pre id="log">加载中...</pre>
  <script>
    const dataUrl = ${JSON.stringify(dataUrl)};
    const intervalMs = ${Number(intervalMs) || 5000};
    const log = document.getElementById('log');
    const status = document.getElementById('status');
    async function refreshLog() {
      const shouldStickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      try {
        const response = await fetch(dataUrl, { cache: 'no-store' });
        const text = await response.text();
        if (!response.ok) throw new Error(text || response.statusText);
        log.textContent = text || '暂无日志';
        status.textContent = '已刷新 ' + new Date().toLocaleTimeString();
        if (shouldStickToBottom) log.scrollTop = log.scrollHeight;
      } catch (error) {
        status.textContent = '刷新失败：' + error.message;
      }
    }
    document.getElementById('refresh').addEventListener('click', refreshLog);
    refreshLog();
    setInterval(refreshLog, intervalMs);
  </script>
</body>
</html>`
}

async function readProductionRunState(job) {
  if (job.productionRunDir) {
    const runJsonPath = resolve(job.productionRunDir, 'run.json')
    const runJson = await readJsonIfExists(runJsonPath)
    return {
      runRoot: dirname(job.productionRunDir),
      runDir: job.productionRunDir,
      runJsonPath,
      runJson,
      metrics: runJson ? await buildProductionRunMetrics({ runDir: job.productionRunDir, runJson }) : null,
    }
  }
  if (!job.productionBookId || !job.productionRunRoot) return null
  const bookRunRoot = resolve(job.productionRunRoot, job.productionBookId)
  let runJsonPath = ''
  try {
    const entries = await readdir(bookRunRoot, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    runJsonPath = resolve(bookRunRoot, dirs.at(-1) || '', 'run.json')
  } catch {
    return {
      runRoot: bookRunRoot,
      runDir: '',
      runJsonPath: '',
      runJson: null,
    }
  }

  const runJson = await readJsonIfExists(runJsonPath)
  const runDir = dirname(runJsonPath)
  return {
    runRoot: bookRunRoot,
    runDir,
    runJsonPath,
    runJson,
    metrics: runJson ? await buildProductionRunMetrics({ runDir, runJson }) : null,
  }
}

async function buildProductionRunMetrics({ runDir, runJson }) {
  const stages = runJson?.stages && typeof runJson.stages === 'object' ? runJson.stages : {}
  const generatedAt = new Date().toISOString()
  const stageMetrics = {}
  for (const [stageName, stage] of Object.entries(stages)) {
    const logFile = readString(stage?.logFile)
    if (!logFile) continue
    const logPath = resolveProductionRunFile(runDir, logFile)
    const metric = await readStageMetricFromLog({ stageName, logPath }).catch(() => null)
    if (metric) stageMetrics[stageName] = metric
  }
  const audioMetric = await readAudioMetricFromArtifacts(runDir).catch(() => null)
  if (audioMetric) stageMetrics.audio = {
    ...(stageMetrics.audio || {}),
    ...audioMetric,
  }
  return {
    generatedAt,
    windows: [
      { key: '5m', label: '近 5 分钟' },
      { key: '15m', label: '近 15 分钟' },
      { key: 'overall', label: '全程平均' },
    ],
    concurrency: await readRuntimeConcurrency(runDir),
    stages: stageMetrics,
  }
}

async function readRuntimeConcurrency(runDir) {
  const runtimeDir = resolve(runDir, 'artifacts', 'runtime')
  const [kgControl, audioControl] = await Promise.all([
    readJsonIfExists(resolve(runtimeDir, 'kg-control.json')).catch(() => null),
    readJsonIfExists(resolve(runtimeDir, 'audio-control.json')).catch(() => null),
  ])
  return {
    kg: kgControl ? {
      concurrency: readFiniteNumber(kgControl.concurrency),
      updatedAt: readString(kgControl.updatedAt),
    } : null,
    audio: audioControl ? {
      directorConcurrency: readFiniteNumber(audioControl.directorConcurrency ?? audioControl.director_concurrency),
      llmChapters: readFiniteNumber(audioControl.llmChapters ?? audioControl.llm_chapters),
      ttsConcurrency: readFiniteNumber(audioControl.ttsConcurrency ?? audioControl.tts_concurrency),
      ttsChapters: readFiniteNumber(audioControl.ttsChapters ?? audioControl.tts_chapters),
      updatedAt: readString(audioControl.updatedAt),
    } : null,
  }
}

async function readStageMetricFromLog({ stageName, logPath }) {
  const content = await readFile(logPath, 'utf8')
  const samples = []
  const acceptedStageNames = stageName === 'chunkEmbedding' || stageName === 'summaryEmbedding'
    ? new Set([stageName, 'embedding'])
    : new Set([stageName])
  const pattern = /^\[([^\]]+)]\s+([A-Za-z][\w-]*)\s+(?:start|progress|finish):\s+(\d+)\/(\d+)\s+completed=(\d+)\s+failed=(\d+)/gm
  let match
  while ((match = pattern.exec(content))) {
    if (!acceptedStageNames.has(match[2])) continue
    const atMs = Date.parse(match[1])
    if (!Number.isFinite(atMs)) continue
    const completed = Number(match[5]) || 0
    const failed = Number(match[6]) || 0
    samples.push({
      at: new Date(atMs).toISOString(),
      atMs,
      done: completed + failed,
      completed,
      failed,
      total: Number(match[4]) || 0,
    })
  }
  return buildRateMetric({ unit: stageUnit(stageName), samples })
}

async function readAudioMetricFromArtifacts(runDir) {
  const root = resolve(runDir, 'stage-runs', 'audio')
  const files = await findFiles(root, (filePath) => /\/tts-source\/ch\d+-full\/audio\/chapter\.mp3$/.test(filePath))
  const samples = []
  for (const filePath of files) {
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat) continue
    const chapterMatch = /\/tts-source\/ch(\d+)-full\/audio\/chapter\.mp3$/.exec(filePath)
    samples.push({
      at: fileStat.mtime.toISOString(),
      atMs: fileStat.mtimeMs,
      done: samples.length + 1,
      completed: samples.length + 1,
      failed: 0,
      total: 0,
      chapter: chapterMatch ? Number(chapterMatch[1]) : 0,
    })
  }
  samples.sort((a, b) => a.atMs - b.atMs || a.chapter - b.chapter)
  samples.forEach((sample, index) => {
    sample.done = index + 1
    sample.completed = index + 1
  })
  return buildRateMetric({ unit: '章', samples })
}

function buildRateMetric({ unit, samples }) {
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs)
  if (!sorted.length) return null
  const first = sorted[0]
  const latest = sorted.at(-1)
  return {
    unit,
    latest: {
      at: latest.at,
      completed: latest.completed,
      failed: latest.failed,
      done: latest.done,
      total: latest.total,
    },
    rates: {
      '5m': computeWindowRate(sorted, 5),
      '15m': computeWindowRate(sorted, 15),
      overall: computeOverallRate(first, latest),
    },
  }
}

function computeWindowRate(samples, minutes) {
  if (samples.length < 2) return null
  const latest = samples.at(-1)
  const floor = latest.atMs - minutes * 60_000
  const start = [...samples].reverse().find((sample) => sample.atMs <= floor) || samples[0]
  return buildRate(start, latest)
}

function computeOverallRate(first, latest) {
  return buildRate(first, latest)
}

function buildRate(start, end) {
  const minutes = (end.atMs - start.atMs) / 60_000
  const produced = end.done - start.done
  if (!(minutes > 0) || produced < 0) return null
  return {
    produced,
    minutes,
    perMinute: produced / minutes,
    from: start.at,
    to: end.at,
  }
}

function stageUnit(stageName) {
  if (stageName === 'chunkEmbedding') return '章'
  if (stageName === 'summaryEmbedding') return '章'
  return '章'
}

async function findFiles(root, predicate) {
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    await Promise.all(entries.map(async (entry) => {
      const filePath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(filePath)
      } else if (entry.isFile() && predicate(filePath)) {
        files.push(filePath)
      }
    }))
  }
  await walk(root)
  return files
}

function resolveProductionRunFile(runDir, requestedPath) {
  const resolvedRunDir = resolve(runDir)
  const filePath = resolve(requestedPath.startsWith('/') ? requestedPath : resolve(resolvedRunDir, requestedPath))
  if (!filePath.startsWith(`${resolvedRunDir}/`) && filePath !== resolvedRunDir) {
    throw httpError(403, 'outside_production_run', 'Requested file is outside the production run directory.')
  }
  return filePath
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

async function chooseLocalFile({ prompt }) {
  if (process.platform !== 'darwin') {
    throw httpError(501, 'file_picker_unavailable', 'File picker is currently implemented for macOS only.')
  }
  const script = [
    `set selectedFile to choose file with prompt "${escapeAppleScriptString(prompt)}"`,
    'POSIX path of selectedFile',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    if (error.code === 1 || error.message.includes('User canceled')) return ''
    throw error
  }
}

function readProductionJobConfig(jobPath) {
  try {
    return JSON.parse(readFileSync(jobPath, 'utf8'))
  } catch (error) {
    throw httpError(400, 'invalid_job_file', `Cannot read production job file: ${jobPath}. ${error.message}`)
  }
}

function productionJobImports(jobConfig) {
  const stages = Array.isArray(jobConfig.stages)
    ? jobConfig.stages.map((stage) => String(stage).trim())
    : String(jobConfig.stages || '').split(',').map((stage) => stage.trim())
  return stages.includes('import')
}

function deriveFileBookId(jobConfig) {
  if (!productionJobImports(jobConfig)) {
    throw httpError(400, 'missing_required_field', 'bookId is required unless the v2 job imports job.source.file.')
  }
  const file = readString(jobConfig.source?.file || jobConfig.source?.path || jobConfig.file)
  if (!file) throw httpError(400, 'missing_required_field', 'bookId is required unless the v2 job imports job.source.file.')
  const hash = createHash('sha256').update(readFileSync(expandPath(file))).digest('hex')
  return `file-${hash.slice(0, 24)}`
}

function resolveProductionJobBookId(body, jobConfig) {
  const bodyBookId = readString(body.bookId)
  const jobBookId = readString(jobConfig.bookId)
  if (!productionJobImports(jobConfig)) return readString(bodyBookId || jobBookId)
  const derivedBookId = deriveFileBookId(jobConfig)
  const configuredBookId = bodyBookId || jobBookId
  if (configuredBookId && configuredBookId !== derivedBookId) {
    throw httpError(
      400,
      'invalid_book_id',
      `import job bookId (${configuredBookId}) must match source file id (${derivedBookId}). Remove bookId or set it to ${derivedBookId}.`,
    )
  }
  return derivedBookId
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function tableHasColumn(db, tableName, columnName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName)
  } catch {
    return false
  }
}

function summarizeJob(job) {
  return {
    id: job.id,
    action: job.action,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    productionJobPath: job.productionJobPath,
    productionBookId: job.productionBookId,
    readOnly: Boolean(job.readOnly),
  }
}

function isActiveJob(job) {
  return !job.readOnly && (job.status === 'queued' || job.status === 'running' || job.status === 'stopping')
}

async function listProductionRunJsonFiles(runRoot, limit = 50) {
  let bookDirs
  try {
    bookDirs = await readdir(runRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  await Promise.all(bookDirs.filter((entry) => entry.isDirectory()).map(async (bookEntry) => {
    const bookDir = resolve(runRoot, bookEntry.name)
    let runDirs
    try {
      runDirs = await readdir(bookDir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(runDirs.filter((entry) => entry.isDirectory()).map(async (runEntry) => {
      const runJsonPath = resolve(bookDir, runEntry.name, 'run.json')
      const fileStat = await stat(runJsonPath).catch(() => null)
      if (fileStat) files.push({ path: runJsonPath, mtimeMs: fileStat.mtimeMs })
    }))
  }))
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path)
}

async function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
}

function readObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  return body
}

function requiredString(value, message) {
  const text = readString(value)
  if (!text) throw httpError(400, 'missing_required_field', message)
  return text
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function readFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readPort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function readQueryValue(query, key) {
  if (!query || typeof query !== 'object') return ''
  const value = query[key]
  return Array.isArray(value) ? value[0] : value
}

function parseBearerToken(value) {
  const text = readString(value)
  const match = /^Bearer\s+(.+)$/i.exec(text)
  return match ? match[1].trim() : ''
}

function safePathSegment(value) {
  return readString(value || 'job').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'job'
}

function expandPath(path) {
  const value = readString(path)
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}

function httpError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function joinPath(...parts) {
  return resolve(repoRoot, ...parts)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadServiceConfig()
  const app = await buildProductionPipelineService(config)
  try {
    await app.listen({ host: config.host, port: config.port })
    app.log.info(`production pipeline console listening on http://${config.host}:${config.port}`)
  } catch (error) {
    app.log.error(error, 'failed to start production pipeline console')
    process.exitCode = 1
  }
}
