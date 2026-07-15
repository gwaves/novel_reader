#!/usr/bin/env node

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const productionPipelineScript = resolve(repoRoot, 'production-pipeline', 'src', 'cli.mjs')
const supportedSourceExtensions = new Set(['.txt', '.epub', '.pdf', '.mobi', '.azw', '.azw3'])
const productionStageMetadata = [
  ['import', '导入正文', '把上传文件导入主库'],
  ['summary', '章节摘要', '生成章节摘要和全书摘要'],
  ['summary-locate', '摘要定位', '补充摘要对应的正文位置'],
  ['kg', '知识图谱', '抽取实体和关系'],
  ['embedding', '向量索引', '生成检索向量'],
  ['audio', '有声书', '生成章节音频'],
  ['package', '打包', '生成移动端内容包'],
  ['publish', '发布', '发布到 Gateway'],
  ['verify', '验证', '验证发布结果'],
].map(([id, label, description]) => ({ id, label, description }))

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
    viewerToken: env.PRODUCTION_PIPELINE_CONSOLE_VIEWER_TOKEN?.trim() || '',
    logLevel: env.PRODUCTION_PIPELINE_CONSOLE_LOG_LEVEL?.trim() || 'info',
    discoverRuns: env.PRODUCTION_PIPELINE_CONSOLE_DISCOVER_RUNS !== 'false',
    maxConcurrentJobs: readPositiveInteger(env.PRODUCTION_PIPELINE_MAX_CONCURRENT_JOBS, 1),
    autoResumeInterrupted: env.PRODUCTION_PIPELINE_AUTO_RESUME_INTERRUPTED !== 'false',
    autoRetryFailures: env.PRODUCTION_PIPELINE_AUTO_RETRY_FAILURES !== 'false',
    maxAutomaticRetries: readNonNegativeInteger(env.PRODUCTION_PIPELINE_MAX_AUTOMATIC_RETRIES, 5),
    automaticRetryBaseDelayMs: readPositiveInteger(env.PRODUCTION_PIPELINE_AUTOMATIC_RETRY_BASE_DELAY_MS, 30_000),
    automaticRetryMaxDelayMs: readPositiveInteger(env.PRODUCTION_PIPELINE_AUTOMATIC_RETRY_MAX_DELAY_MS, 10 * 60_000),
    eventLogFile: resolve(dataDir, 'events.jsonl'),
    credentialsFile: resolve(env.PRODUCTION_PIPELINE_CREDENTIALS_FILE || resolve(dataDir, 'credentials.env')),
    modelProfilesFile: resolve(env.PRODUCTION_PIPELINE_MODEL_PROFILES_FILE || resolve(dataDir, 'model-profiles.json')),
    jobsDir: resolve(env.PRODUCTION_PIPELINE_JOBS_DIR || joinPath('production-pipeline', 'config')),
    sourcesDir: resolve(env.PRODUCTION_PIPELINE_SOURCES_DIR || joinPath('tmp', 'production-pipeline-service', 'sources')),
    backupsDir: resolve(env.PRODUCTION_PIPELINE_BACKUPS_DIR || joinPath('tmp', 'production-pipeline-service', 'backups')),
    maxUploadBytes: readPositiveInteger(env.PRODUCTION_PIPELINE_MAX_UPLOAD_BYTES, 4 * 1024 * 1024 * 1024),
    gatewayRoot: resolve(env.PRODUCTION_PIPELINE_GATEWAY_ROOT || '/home/gwaves/novel-reader-gateway'),
  }
}

export async function buildProductionPipelineService(config = loadServiceConfig()) {
  const store = new JobStore(config)
  await store.load()
  await Promise.all([
    mkdir(config.jobsDir, { recursive: true }),
    mkdir(config.sourcesDir, { recursive: true }),
    mkdir(config.backupsDir, { recursive: true }),
  ])

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
  })

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.maxUploadBytes,
    },
  })

  app.addHook('preHandler', async (request) => {
    if (!config.token || request.url === '/' || request.url === '/health') return
    const token = parseBearerToken(request.headers.authorization) || readQueryValue(request.query, 'token')
    const role = token === config.token ? 'admin' : (config.viewerToken && token === config.viewerToken ? 'viewer' : '')
    if (!role) {
      throw httpError(401, token ? 'invalid_token' : 'missing_authorization', 'Missing or invalid production pipeline console token.')
    }
    request.consoleRole = role
    if (role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) throw httpError(403, 'read_only', '当前凭据为只读权限，不能执行写操作。')
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
    scheduler: store.schedulerStatus(),
  }))

  app.get('/api/session', async (request) => ({ role: request.consoleRole || 'admin' }))

  app.get('/api/audit', async (request) => {
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 30)
    const content = await readFile(config.eventLogFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
    return {
      events: content.split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean),
    }
  })

  app.get('/api/books', async (request) => {
    const query = readString(readQueryValue(request.query, 'query'))
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 50)
    return {
      generatedAt: new Date().toISOString(),
      mainDbPath: config.mainDbPath,
      books: listMainBooks(config.mainDbPath, { query, limit, gatewayRoot: config.gatewayRoot }),
    }
  })

  app.get('/api/sources', async () => ({
    generatedAt: new Date().toISOString(),
    sources: await listManagedFiles(config.sourcesDir, supportedSourceExtensions),
  }))

  app.post('/api/sources', async (request, reply) => {
    const part = await request.file()
    if (!part) throw httpError(400, 'missing_file', 'A source file is required.')
    const fileName = safeManagedFileName(part.filename, supportedSourceExtensions)
    const finalPath = resolveManagedFile(config.sourcesDir, fileName)
    const tempPath = `${finalPath}.${process.pid}.${randomUUID()}.upload`
    try {
      await pipeline(part.file, createWriteStream(tempPath, { flags: 'wx' }))
      if (part.file.truncated) throw httpError(413, 'file_too_large', 'Uploaded source file exceeds the configured limit.')
      await rename(tempPath, finalPath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw error
    }
    const file = await describeManagedFile(finalPath)
    request.log.info({ fileName, sizeBytes: file.sizeBytes }, 'production source uploaded')
    reply.status(201).send({ source: file })
  })

  app.delete('/api/sources/:name', async (request, reply) => {
    const fileName = safeManagedFileName(request.params.name, supportedSourceExtensions)
    const templates = await listJobTemplates(config.jobsDir)
    if (templates.some((template) => template.sourceFile === fileName)) throw httpError(409, 'source_in_use', '该源文件仍被生产模板引用，请先删除或修改对应模板。')
    await unlink(resolveManagedFile(config.sourcesDir, fileName)).catch((error) => {
      if (error.code === 'ENOENT') throw httpError(404, 'source_not_found', `Source not found: ${fileName}`)
      throw error
    })
    reply.status(204).send()
  })

  app.get('/api/templates', async () => ({
    generatedAt: new Date().toISOString(),
    templates: await listJobTemplates(config.jobsDir),
  }))

  app.get('/api/builder-metadata', async () => {
    const mainDatabaseAvailable = existsSync(config.mainDbPath)
    return {
      generatedAt: new Date().toISOString(),
      stages: productionStageMetadata,
      sources: await listManagedFiles(config.sourcesDir, supportedSourceExtensions),
      books: mainDatabaseAvailable ? listMainBooks(config.mainDbPath, { limit: 200, gatewayRoot: config.gatewayRoot }) : [],
      defaults: {
        llm: { provider: 'openai-compatible', baseUrl: 'http://192.168.88.24:30000/v1', model: 'qwen3.6-27b', concurrency: 8, apiKeyEnv: 'LLM_API_KEY' },
        embedding: { provider: 'openai-compatible', baseUrl: 'http://192.168.88.100:11434/v1', model: 'qwen3-embedding:8b', concurrency: 16, apiKeyEnv: 'EMBEDDING_API_KEY' },
        audio: { ttsConfig: '/home/node/.novel_reader/tts-director.config.json', llmChapters: 1, ttsConcurrency: 16, ttsChapters: 1 },
        gateway: { host: '192.168.88.100', user: 'gwaves', root: '/home/gwaves/novel-reader-gateway', url: 'http://192.168.88.100:6180', tokenEnv: 'GATEWAY_TOKEN' },
      },
      modelProfiles: readModelProfiles(config.modelProfilesFile),
      environmentStatus: {
        llmCredential: Boolean(process.env.LLM_API_KEY || readRuntimeCredentials(config.credentialsFile).LLM_API_KEY),
        embeddingCredential: Boolean(process.env.EMBEDDING_API_KEY || readRuntimeCredentials(config.credentialsFile).EMBEDDING_API_KEY),
        gatewayToken: Boolean(process.env.GATEWAY_TOKEN),
        gatewayAdminToken: Boolean(process.env.GATEWAY_ADMIN_TOKEN),
        ttsConfig: existsSync('/home/node/.novel_reader/tts-director.config.json'),
        mainDatabase: mainDatabaseAvailable,
      },
    }
  })

  app.put('/api/model-profiles', async (request) => {
    const body = readObjectBody(request.body)
    const profiles = normalizeModelProfiles(body.profiles)
    if (!profiles.length) throw httpError(400, 'model_profile_required', '至少需要保留一组 LLM 配置。')
    const credentials = readRuntimeCredentials(config.credentialsFile)
    for (const profile of profiles) {
      if (readString(profile.apiKey)) credentials[profile.apiKeyEnv] = readString(profile.apiKey)
      delete profile.apiKey
    }
    await writeFile(config.modelProfilesFile, `${JSON.stringify({ profiles }, null, 2)}\n`, { mode: 0o600 })
    await chmod(config.modelProfilesFile, 0o600)
    await writeRuntimeCredentials(config.credentialsFile, credentials)
    return { profiles: readModelProfiles(config.modelProfilesFile) }
  })

  app.put('/api/runtime-credentials', async (request) => {
    const body = readObjectBody(request.body)
    const current = readRuntimeCredentials(config.credentialsFile)
    const next = { ...current }
    const updated = []
    if (body.clearLlm === true) { delete next.LLM_API_KEY; updated.push('LLM_API_KEY cleared') }
    else if (readString(body.llmApiKey)) { next.LLM_API_KEY = readString(body.llmApiKey); updated.push('LLM_API_KEY updated') }
    if (body.clearEmbedding === true) { delete next.EMBEDDING_API_KEY; updated.push('EMBEDDING_API_KEY cleared') }
    else if (readString(body.embeddingApiKey)) { next.EMBEDDING_API_KEY = readString(body.embeddingApiKey); updated.push('EMBEDDING_API_KEY updated') }
    if (!updated.length) throw httpError(400, 'credential_update_required', '请输入要保存的 API Key，或选择清除现有凭据。')
    await writeRuntimeCredentials(config.credentialsFile, next)
    request.log.info({ updated }, 'production runtime credentials updated')
    return { environmentStatus: runtimeCredentialStatus(config, next), updated }
  })

  app.get('/api/templates/:name', async (request) => {
    const fileName = safeManagedFileName(request.params.name, new Set(['.json']))
    const templatePath = resolveManagedFile(config.jobsDir, fileName)
    const template = await readJsonIfExists(templatePath)
    if (!template) throw httpError(404, 'template_not_found', `Template not found: ${fileName}`)
    return { template: redactSecrets(template), validation: validateServiceJobTemplate(template, config) }
  })

  app.post('/api/templates/validate', async (request) => {
    const template = normalizeServiceJobTemplate(readObjectBody(request.body).template || request.body, config)
    return validateServiceJobTemplate(template, config)
  })

  app.post('/api/templates', async (request, reply) => {
    const body = readObjectBody(request.body)
    const name = requiredString(body.name, 'name is required.')
    const fileName = safeManagedFileName(name.endsWith('.json') ? name : `${name}.json`, new Set(['.json']))
    const template = normalizeServiceJobTemplate(readObjectBody(body.template), config)
    const templatePath = resolveManagedFile(config.jobsDir, fileName)
    await writeJsonAtomic(templatePath, template)
    reply.status(201).send({ template: await describeJobTemplate(templatePath) })
  })

  app.delete('/api/templates/:name', async (request, reply) => {
    const fileName = safeManagedFileName(request.params.name, new Set(['.json']))
    const templatePath = resolveManagedFile(config.jobsDir, fileName)
    if (store.findActiveJobByProductionJob(templatePath)) throw httpError(409, 'template_active', '该模板正被运行中或排队中的任务使用，请先暂停任务。')
    await unlink(templatePath).catch((error) => {
      if (error.code === 'ENOENT') throw httpError(404, 'template_not_found', `Template not found: ${fileName}`)
      throw error
    })
    reply.status(204).send()
  })

  app.post('/api/templates/:name/start', async (request, reply) => {
    const fileName = safeManagedFileName(request.params.name, new Set(['.json']))
    const templatePath = resolveManagedFile(config.jobsDir, fileName)
    await stat(templatePath).catch(() => {
      throw httpError(404, 'template_not_found', `Template not found: ${fileName}`)
    })
    const spec = createProductionV2Spec({ jobPath: templatePath }, config)
    const activeJob = store.findActiveJobByProductionJob(spec.productionJobPath)
    if (activeJob) return reply.status(202).send({ ...(await store.readJobResponse(activeJob.id)), duplicateOf: activeJob.id })
    const job = await store.createJob(spec)
    store.schedule(app.log)
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  app.get('/api/backups', async () => ({
    generatedAt: new Date().toISOString(),
    backups: await listManagedFiles(config.backupsDir, new Set(['.sqlite'])),
  }))

  app.post('/api/backups', async (request, reply) => {
    const createdAt = new Date().toISOString()
    const fileName = `novel-reader-${createdAt.replace(/[:.]/g, '-')}.sqlite`
    const backupPath = resolveManagedFile(config.backupsDir, fileName)
    const db = new DatabaseSync(config.mainDbPath, { readOnly: true, timeout: 30_000 })
    try {
      await backup(db, backupPath, { rate: 4096 })
    } finally {
      db.close()
    }
    const file = await describeManagedFile(backupPath)
    request.log.info({ fileName, sizeBytes: file.sizeBytes }, 'production database backup completed')
    reply.status(201).send({ backup: file })
  })

  app.get('/api/backups/:name/download', async (request, reply) => {
    const fileName = safeManagedFileName(request.params.name, new Set(['.sqlite']))
    const filePath = resolveManagedFile(config.backupsDir, fileName)
    await stat(filePath).catch(() => {
      throw httpError(404, 'backup_not_found', `Backup not found: ${fileName}`)
    })
    reply.header('content-disposition', `attachment; filename="${fileName}"`)
    reply.type('application/vnd.sqlite3')
    return reply.send(createReadStream(filePath))
  })

  app.delete('/api/backups/:name', async (request, reply) => {
    const fileName = safeManagedFileName(request.params.name, new Set(['.sqlite']))
    await unlink(resolveManagedFile(config.backupsDir, fileName)).catch((error) => {
      if (error.code === 'ENOENT') throw httpError(404, 'backup_not_found', `Backup not found: ${fileName}`)
      throw error
    })
    reply.status(204).send()
  })

  app.post('/api/system/choose-file', async () => ({
    path: await chooseLocalFile({ prompt: '选择 Production Pipeline v2 Job JSON' }),
  }))

  app.get('/api/jobs', async (request) => {
    const limit = clampInteger(readQueryValue(request.query, 'limit'), 1, 200, 50)
    if (config.discoverRuns) {
      await store.discoverProductionRuns()
    }
    const jobs = store.listJobs(limit)
    return {
      generatedAt: new Date().toISOString(),
      jobs: await Promise.all(jobs.map(async (job) => ({ ...job, runSummary: await readJobRunSummary(store.getJob(job.id)) }))),
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
      try {
        const response = await store.readJobResponse(job.id)
        if (reply.raw.destroyed) return
        reply.raw.write('event: job\n')
        reply.raw.write(`data: ${JSON.stringify(response)}\n\n`)
      } catch (error) {
        request.log.warn({ err: error, jobId: job.id }, 'production pipeline event refresh skipped')
      }
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

  app.post('/api/jobs/:jobId/retry', async (request, reply) => {
    const job = await store.retryJob(request.params.jobId)
    store.schedule(app.log)
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  app.patch('/api/jobs/:jobId/runtime-concurrency', async (request) => {
    const job = store.getJob(request.params.jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${request.params.jobId}`)
    if (job.readOnly) throw httpError(409, 'job_read_only', '发现的历史任务不能修改运行并发。')
    if (job.status !== 'running') throw httpError(409, 'job_not_running', '只有运行中的任务可以调整并发。')
    const productionRun = await readProductionRunState(job)
    if (!productionRun?.runDir || !productionRun.runJson) throw httpError(404, 'production_run_not_found', `Production run not found for job: ${job.id}`)
    const updated = await updateRuntimeConcurrency(productionRun.runDir, productionRun.runJson, readObjectBody(request.body))
    await store.appendEvent(job, 'job.concurrency.updated', 'info', `运行并发已更新：${formatRuntimeConcurrencyUpdate(updated)}`)
    await store.persistAndEmit(job)
    return { jobId: job.id, updatedAt: updated.updatedAt, concurrency: await readRuntimeConcurrency(productionRun.runDir, productionRun.runJson) }
  })

  app.delete('/api/jobs/:jobId', async (request, reply) => {
    await store.deleteJob(request.params.jobId, { cleanup: true })
    reply.status(204).send()
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
    store.schedule(app.log)
    reply.status(202).send(await store.readJobResponse(job.id))
  })

  app.addHook('onClose', async () => {
    await store.shutdown()
  })

  store.schedule(app.log)

  return app
}

class JobStore {
  constructor(config) {
    this.config = config
    this.jobs = new Map()
    this.activeChildren = new Map()
    this.runningJobs = new Map()
    this.events = new EventEmitter()
    this.shuttingDown = false
    this.retryTimer = null
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
      if (job.status === 'running' || job.status === 'stopping') {
        job.status = this.config.autoResumeInterrupted ? 'queued' : 'failed'
        job.updatedAt = new Date().toISOString()
        job.pid = null
        job.stopRequested = false
        job.recoveryRequested = this.config.autoResumeInterrupted
        job.error = this.config.autoResumeInterrupted
          ? '服务重启时任务被中断，已排队等待从 run.json 恢复。'
          : '服务重启时该任务仍在运行，已标记为中断。'
      }
      this.jobs.set(job.id, job)
    }
    if (this.config.discoverRuns) {
      await this.discoverProductionRuns()
    }
    await this.persist()
  }

  async discoverProductionRuns() {
    for (const [jobId, job] of this.jobs) if (job.readOnly) this.jobs.delete(jobId)
    const managedJobs = [...this.jobs.values()].filter((job) => !job.readOnly)
    const discovered = await listProductionRunJsonFiles(this.config.productionRunRoot, 50)
    for (const runJsonPath of discovered) {
      const runJson = await readJsonIfExists(runJsonPath).catch(() => null)
      if (!runJson) continue
      const runDir = dirname(runJsonPath)
      const bookId = basename(dirname(runDir))
      const runId = readString(runJson.runId || basename(runDir))
      const productionJobPath = readString(runJson.jobPath || '')
      const duplicateManagedJob = managedJobs.some((job) => (
        readString(job.productionBookId) === bookId &&
        productionJobPath &&
        resolve(readString(job.productionJobPath)) === resolve(productionJobPath)
      ))
      if (duplicateManagedJob) continue
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
        productionJobPath,
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
      attempts: 0,
      automaticRetryCount: 0,
      nextAttemptAt: '',
      recoveryRequested: false,
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
      .filter((job) => !job.hidden)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => summarizeJob(job))
  }

  findActiveJobByProductionJob(jobPath) {
    const resolvedJobPath = resolve(jobPath)
    return [...this.jobs.values()]
      .filter((job) => !job.hidden && isActiveJob(job) && resolve(job.productionJobPath || '') === resolvedJobPath)
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
    job.error = '用户请求暂停任务。'
    await this.appendLogFile(job, 'system', '用户请求暂停任务；已完成成果将在继续时复用。')
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

  async retryJob(jobId) {
    const job = this.getJob(jobId)
    if (!job) throw httpError(404, 'job_not_found', `Job not found: ${jobId}`)
    if (job.readOnly) throw httpError(409, 'job_read_only', `Job is read-only: ${jobId}`)
    if (isActiveJob(job)) throw httpError(409, 'job_active', `Job is already active: ${jobId}`)
    job.status = 'queued'
    job.startedAt = ''
    job.finishedAt = ''
    job.exitCode = null
    job.pid = null
    job.error = ''
    job.stopRequested = false
    job.automaticRetryCount = 0
    job.nextAttemptAt = ''
    job.recoveryRequested = true
    await this.appendEvent(job, 'job.queued', 'info', '任务已排队继续生产，已完成成果将复用。')
    await this.persistAndEmit(job)
    return job
  }

  async deleteJob(jobId, { cleanup = false } = {}) {
    const job = this.getJob(jobId)
    if (!job || job.hidden) throw httpError(404, 'job_not_found', `Job not found: ${jobId}`)
    if (job.readOnly) throw httpError(409, 'job_read_only', `Discovered run cannot be deleted here: ${jobId}`)
    if (isActiveJob(job)) throw httpError(409, 'job_active', '请先暂停运行中的任务，再执行删除。')
    if (cleanup) await cleanupProductionJob(this.config, job)
    job.hidden = true
    job.deletedAt = new Date().toISOString()
    await this.appendEvent(job, 'job.deleted', 'info', cleanup
      ? '任务记录及对应的主库、运行目录和 Gateway 发布产物已删除。'
      : '任务记录已从管理列表删除，运行产物保留。')
    await this.persistAndEmit(job)
  }

  schedulerStatus() {
    const jobs = [...this.jobs.values()].filter((job) => !job.readOnly && !job.hidden)
    return {
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      running: jobs.filter((job) => job.status === 'running' || job.status === 'stopping').length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      acceptingJobs: !this.shuttingDown,
    }
  }

  schedule(logger) {
    if (this.shuttingDown) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const now = Date.now()
    const available = Math.max(0, this.config.maxConcurrentJobs - this.runningJobs.size)
    const queued = [...this.jobs.values()]
      .filter((job) => (
        !job.readOnly &&
        !job.hidden &&
        job.status === 'queued' &&
        !this.runningJobs.has(job.id) &&
        (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now)
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, available)
    for (const job of queued) {
      const promise = runJob(this, job)
        .catch((error) => logger?.error?.({ err: error, jobId: job.id }, 'production pipeline job runner crashed'))
        .finally(() => {
          this.runningJobs.delete(job.id)
          this.schedule(logger)
        })
      this.runningJobs.set(job.id, promise)
    }
    const nextAttemptMs = [...this.jobs.values()]
      .filter((job) => !job.readOnly && !job.hidden && job.status === 'queued' && !this.runningJobs.has(job.id))
      .map((job) => Date.parse(job.nextAttemptAt || ''))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0]
    if (nextAttemptMs) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.schedule(logger)
      }, Math.max(1, nextAttemptMs - now))
      this.retryTimer.unref?.()
    }
  }

  async shutdown() {
    this.shuttingDown = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const active = [...this.activeChildren.entries()]
    await Promise.all(active.map(async ([jobId, child]) => {
      const job = this.getJob(jobId)
      if (job && (job.status === 'running' || job.status === 'stopping')) {
        job.serviceShutdownRequested = true
        job.recoveryRequested = true
        job.error = '服务关闭时任务被中断，下次启动将自动恢复。'
        await this.persistAndEmit(job)
      }
      if (child?.pid) await killProcessTree(child.pid)
    }))
    await Promise.allSettled(this.runningJobs.values())
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

  async appendEvent(job, action, level, message, extra = {}) {
    const record = {
      '@timestamp': new Date().toISOString(),
      'service.name': 'production-pipeline-service',
      'event.dataset': 'production.pipeline.job',
      'event.action': action,
      'log.level': level,
      message,
      job_id: job.id,
      book_id: job.productionBookId || '',
      status: job.status,
      attempt: Number(job.attempts || 0),
      ...extra,
    }
    await writeFile(this.config.eventLogFile, `${JSON.stringify(record)}\n`, { flag: 'a' })
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

async function cleanupProductionJob(config, job) {
  const bookId = readString(job.productionBookId)
  if (!bookId) throw httpError(409, 'job_cleanup_book_missing', '任务缺少 bookId，无法安全清理生产内容。')

  let template = {}
  const jobPath = readString(job.productionJobPath)
  if (jobPath) {
    const hostJobPath = resolveManagedContainerPath(jobPath, '/app/jobs', config.jobsDir)
    try {
      template = JSON.parse(await readFile(hostJobPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const gatewayUrl = readString(template.gateway?.url)
  const gatewayTokenEnv = readString(template.gateway?.tokenEnv) || 'GATEWAY_ADMIN_TOKEN'
  const credentials = { ...process.env, ...readRuntimeCredentials(config.credentialsFile) }
  const gatewayToken = readString(credentials.GATEWAY_ADMIN_TOKEN || credentials[gatewayTokenEnv])
  if (gatewayUrl && !gatewayToken) {
    throw httpError(409, 'gateway_cleanup_token_missing', `缺少 ${gatewayTokenEnv}，无法确认 Gateway 已清理。`)
  }
  if (gatewayUrl && gatewayToken) {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, '')}/admin/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${gatewayToken}` },
    })
    if (!response.ok && response.status !== 404) {
      throw httpError(502, 'gateway_cleanup_failed', `Gateway 清理失败：${response.status} ${await response.text()}`)
    }
  }

  const db = new DatabaseSync(config.mainDbPath)
  try {
    db.exec('PRAGMA busy_timeout = 60000; PRAGMA foreign_keys = ON;')
    const hasBooks = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books'").get()
    if (hasBooks) db.prepare('DELETE FROM books WHERE id = ?').run(bookId)
  } finally {
    db.close()
  }

  const bookRunRoot = resolve(config.productionRunRoot, bookId)
  if (bookRunRoot !== config.productionRunRoot && bookRunRoot.startsWith(`${config.productionRunRoot}/`)) {
    await rm(bookRunRoot, { recursive: true, force: true })
  }
  if (job.logFile) await rm(resolve(job.logFile), { force: true })
}

function resolveManagedContainerPath(path, containerRoot, hostRoot) {
  if (path === containerRoot) return hostRoot
  if (path.startsWith(`${containerRoot}/`)) return resolve(hostRoot, path.slice(containerRoot.length + 1))
  return resolve(path)
}

async function runJob(store, job) {
  if (job.stopRequested) {
    job.status = 'stopped'
    job.finishedAt = new Date().toISOString()
    await store.persistAndEmit(job)
    return
  }
  const recovering = Boolean(job.recoveryRequested)
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  job.attempts = Number(job.attempts || 0) + 1
  job.error = ''
  job.recoveryNote = recovering ? '服务重启后已自动恢复，当前生产进程正在运行。' : ''
  await store.appendEvent(job, recovering ? 'job.recovered' : 'job.started', 'info', recovering ? '任务已从 run.json 自动恢复并继续执行。' : '任务开始执行。')
  await store.persistAndEmit(job)

  try {
    const commands = await commandsForJobAttempt(job)
    for (let index = 0; index < commands.length; index += 1) {
      job.currentCommand = index
      await store.persistAndEmit(job)
      const result = await runCommand(store, job, commands[index])
      if (job.serviceShutdownRequested) {
        job.status = 'queued'
        job.pid = null
        job.finishedAt = ''
        job.recoveryRequested = true
        job.error = '服务关闭时任务被中断，下次启动将自动恢复。'
        await store.appendEvent(job, 'job.interrupted', 'warn', job.error, { exit_code: result.code })
        await store.persistAndEmit(job)
        return
      }
      if (job.stopRequested) {
        job.status = 'stopped'
        job.exitCode = result.code
        job.error = '任务已暂停，可继续生产。'
        job.finishedAt = new Date().toISOString()
        await syncProductionRunStatus(job, 'stopped', job.finishedAt)
        await store.appendEvent(job, 'job.stopped', 'warn', '任务已暂停，可从已完成成果继续。', { exit_code: result.code })
        await store.persistAndEmit(job)
        return
      }
      if (result.code !== 0) {
        if (await scheduleAutomaticRetry(store, job, `命令退出码 ${result.code}`, result.code)) return
        job.status = 'failed'
        job.exitCode = result.code
        job.error = `命令退出码 ${result.code}`
        job.finishedAt = new Date().toISOString()
        await store.appendEvent(job, 'job.failed', 'error', job.error, { exit_code: result.code })
        await store.persistAndEmit(job)
        return
      }
    }
    job.status = 'completed'
    job.exitCode = 0
    job.nextAttemptAt = ''
    job.finishedAt = new Date().toISOString()
    await store.appendEvent(job, 'job.completed', 'info', '任务执行完成。', { exit_code: 0 })
    await store.persistAndEmit(job)
  } catch (error) {
    if (job.serviceShutdownRequested) {
      job.status = 'queued'
      job.pid = null
      job.finishedAt = ''
      job.recoveryRequested = true
      job.error = '服务关闭时任务被中断，下次启动将自动恢复。'
      await store.appendEvent(job, 'job.interrupted', 'warn', job.error)
      await store.persistAndEmit(job)
      return
    }
    if (!job.stopRequested && await scheduleAutomaticRetry(store, job, error.message)) return
    job.status = job.stopRequested ? 'stopped' : 'failed'
    job.error = job.stopRequested ? '任务已暂停，可继续生产。' : error.message
    job.finishedAt = new Date().toISOString()
    if (job.stopRequested) await syncProductionRunStatus(job, 'stopped', job.finishedAt)
    await store.appendEvent(job, job.stopRequested ? 'job.stopped' : 'job.failed', job.stopRequested ? 'warn' : 'error', job.error)
    await store.persistAndEmit(job)
  } finally {
    job.pid = null
    job.stopRequested = false
    job.recoveryRequested = job.status === 'queued'
    job.serviceShutdownRequested = false
    await store.persistAndEmit(job)
  }
}

async function scheduleAutomaticRetry(store, job, errorMessage, exitCode = null) {
  if (!store.config.autoRetryFailures) return false
  const retryCount = Number(job.automaticRetryCount || 0)
  if (retryCount >= store.config.maxAutomaticRetries) return false
  const productionRun = await readProductionRunState(job).catch(() => null)
  if (!productionRun?.runJsonPath || !productionRun.runJson) return false
  const nextRetryCount = retryCount + 1
  const delayMs = Math.min(
    store.config.automaticRetryMaxDelayMs,
    store.config.automaticRetryBaseDelayMs * (2 ** (nextRetryCount - 1)),
  )
  job.status = 'queued'
  job.pid = null
  job.exitCode = exitCode
  job.finishedAt = ''
  job.recoveryRequested = true
  job.automaticRetryCount = nextRetryCount
  job.nextAttemptAt = new Date(Date.now() + delayMs).toISOString()
  job.error = `${errorMessage}；将在 ${Math.ceil(delayMs / 1000)} 秒后自动从 run.json 恢复（${nextRetryCount}/${store.config.maxAutomaticRetries}）。`
  await store.appendEvent(job, 'job.retry_scheduled', 'warn', job.error, {
    exit_code: exitCode,
    retry_delay_ms: delayMs,
    next_attempt_at: job.nextAttemptAt,
  })
  await store.persistAndEmit(job)
  return true
}

async function commandsForJobAttempt(job) {
  if (!job.recoveryRequested) return job.commands
  const productionRun = await readProductionRunState(job)
  if (!productionRun?.runJsonPath || !productionRun.runJson) return job.commands
  job.productionRunDir = productionRun.runDir
  return [{
    command: process.execPath,
    args: [productionPipelineScript, 'resume', '--run', productionRun.runJsonPath],
    display: `${process.execPath} ${productionPipelineScript} resume --run ${productionRun.runJsonPath}`,
    cwd: repoRoot,
  }]
}

function runCommand(store, job, commandSpec) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: { ...process.env, ...readRuntimeCredentials(store.config.credentialsFile) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
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
    button, input, textarea, select { font: inherit; }
    .shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100vh; }
    .app-nav { position: sticky; top: 0; align-self: start; height: 100vh; box-sizing: border-box; background: #101828; color: #fff; padding: 22px 14px; display: flex; flex-direction: column; gap: 6px; }
    .app-nav h1 { padding: 0 10px 18px; margin: 0; font-size: 18px; }
    .nav-button { width: 100%; border: 0; background: transparent; color: #cbd5e1; text-align: left; padding: 11px 12px; }
    .nav-button:hover, .nav-button.active { background: #243148; color: #fff; }
    .nav-spacer { flex: 1; }
    .workspace { min-width: 0; display: grid; grid-template-columns: 440px minmax(0, 1fr); min-height: 100vh; }
    .control-pane { background: #fff; border-right: 1px solid #d9dee8; padding: 22px; overflow: auto; max-height: 100vh; box-sizing: border-box; }
    .view-pane > h1 { margin-bottom: 6px; }
    .view-description { margin-bottom: 18px; color: #667085; font-size: 13px; line-height: 1.5; }
    main { padding: 24px; overflow: auto; }
    h1 { font-size: 20px; margin: 0 0 18px; }
    h2 { font-size: 15px; margin: 20px 0 10px; }
    label { display: grid; gap: 6px; margin: 10px 0; font-size: 13px; color: #4b5565; }
    [hidden] { display: none !important; }
    input, textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #cfd6e3; border-radius: 6px; background: #fff; color: #1d2433; padding: 9px 10px; }
    textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    button { border: 1px solid #1f5eff; background: #1f5eff; color: #fff; border-radius: 6px; padding: 9px 12px; cursor: pointer; }
    button.secondary { background: #fff; color: #1f5eff; }
    button.danger { background: #fff; color: #b42318; border-color: #e5a39c; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .jobs { display: grid; gap: 8px; margin-top: 12px; }
    .job { border: 1px solid #d9dee8; background: #fff; border-radius: 8px; padding: 10px; cursor: pointer; }
    .job.active { border-color: #1f5eff; box-shadow: 0 0 0 2px #dbe6ff; }
    .model-profiles { gap: 10px; }
    .model-profile { border: 1px solid #d9dee8; border-radius: 8px; background: #fff; padding: 12px; }
    .model-profile-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid #edf0f5; }
    .model-profile-title { min-width: 0; }
    .model-profile-title strong { display: block; color: #1d2433; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-profile-title span { display: block; color: #667085; font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-profile-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .model-profile button { padding: 6px 9px; }
    .model-profile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; padding-top: 10px; }
    .model-profile-field { display: grid; gap: 5px; margin: 0; min-width: 0; }
    .model-profile-field.wide { grid-column: 1 / -1; }
    .model-profile-field span { color: #667085; font-size: 12px; font-weight: 700; }
    .model-profile-field input { min-width: 0; padding: 8px 9px; font-size: 13px; }
    .fallback-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; border: 1px solid #d9dee8; border-radius: 6px; padding: 5px 8px; background: #f8fafc; color: #344054; font-size: 12px; font-weight: 700; margin: 0; }
    .fallback-toggle:has(input:checked) { border-color: #b8d8c8; background: #edf8f2; color: #11603c; }
    .toggle-field { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: #344054; font-size: 13px; }
    .toggle-field input { position: absolute; opacity: 0; pointer-events: none; }
    .toggle-switch { width: 34px; height: 20px; border-radius: 999px; background: #d9dee8; position: relative; transition: background .15s ease; }
    .toggle-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(16, 24, 40, .18); transition: transform .15s ease; }
    .toggle-field input:checked + .toggle-switch { background: #1f5eff; }
    .toggle-field input:checked + .toggle-switch::after { transform: translateX(14px); }
    .toggle-field input:focus-visible + .toggle-switch { outline: 2px solid #9db7ff; outline-offset: 2px; }
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
    .inline-feedback { border-radius: 7px; padding: 10px 12px; margin: 10px 0; font-size: 13px; line-height: 1.5; }
    .inline-feedback.info { background: #eef4ff; color: #1949a3; border: 1px solid #bfd1ff; }
    .inline-feedback.success { background: #e8f7ee; color: #17613b; border: 1px solid #a9dfbd; }
    .inline-feedback.error { background: #fff1ee; color: #9a3324; border: 1px solid #efb6aa; }
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
    .stage-options { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
    .stage-option { display: flex; align-items: flex-start; gap: 7px; padding: 7px; border: 1px solid #e3e7ef; border-radius: 6px; }
    .stage-option input { width: auto; margin-top: 2px; }
    .stage-option label { display: block; margin: 0; color: #1d2433; }
    .book-progress { border: 1px solid #d9dee8; border-radius: 7px; padding: 9px; margin: 8px 0 12px; background: #f8fafc; }
    .book-progress .progress-row { display: grid; grid-template-columns: 58px 1fr 48px; gap: 7px; align-items: center; margin: 5px 0; font-size: 12px; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 12px; }
    .summary-card { background: #fff; border: 1px solid #d9dee8; border-radius: 10px; padding: 16px; }
    .summary-card strong { display: block; font-size: 28px; margin-top: 8px; }
    .progress-track { height: 7px; border-radius: 99px; background: #e3e8f0; overflow: hidden; }
    .progress-fill { height: 100%; background: #1f5eff; }
    .overall-progress { margin: 14px 0; padding: 14px; background: #f8fafc; border: 1px solid #d9dee8; border-radius: 8px; }
    .overall-progress .progress-track { height: 10px; margin: 8px 0; }
    .dag-flow { overflow-x: auto; padding: 10px 0; }
    .dag-graph { display: flex; align-items: center; gap: 8px; min-width: max-content; }
    .dag-branches { display: grid; gap: 7px; padding: 7px; border: 1px dashed #d7deea; border-radius: 9px; background: #fbfcfe; }
    .dag-lane { display: flex; align-items: center; gap: 8px; min-height: 54px; }
    .dag-lane-group { display: grid; gap: 6px; }
    .dag-lane-label { width: 52px; color: #667085; font-size: 11px; text-align: right; }
    .dag-stream-dependency { display: inline-flex; align-items: center; gap: 5px; padding: 5px 7px; border: 1px dashed #d59b18; border-radius: 7px; background: #fff9e8; color: #735b00; font-size: 11px; white-space: nowrap; }
    .dag-stream-dependency strong { color: #8a5a00; }
    .dag-wave { min-width: 130px; display: grid; gap: 6px; align-content: center; }
    .dag-arrow { align-self: center; color: #98a2b3; font-size: 22px; }
    .dag-node { border: 1px solid #d0d8e5; border-radius: 7px; padding: 8px; background: #fff; font-size: 12px; }
    .dag-node.running { border-color: #e3b341; background: #fff8dc; }
    .dag-node-progress { margin-top: 7px; }
    .dag-node-progress-label { display: flex; justify-content: space-between; gap: 6px; color: #735b00; font-size: 11px; font-variant-numeric: tabular-nums; }
    .dag-node-progress .progress-track { height: 5px; margin-top: 4px; background: #eadfb4; }
    .dag-node-progress .progress-fill { background: #e3a008; transition: width .35s ease; }
    .dag-node.progress-updated { animation: dag-progress-pulse 1.1s ease-out; }
    @keyframes dag-progress-pulse { 0% { background: #fff8dc; box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } 25% { background: #ffe69a; box-shadow: 0 0 0 4px rgba(245, 158, 11, .28); } 100% { background: #fff8dc; box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } }
    @media (prefers-reduced-motion: reduce) { .dag-node.progress-updated { animation: none; } }
    .dag-node.completed { border-color: #74c69d; background: #eaf8f0; }
    .dag-node.failed { border-color: #e58b82; background: #fff0ee; }
    details.technical { margin-top: 14px; }
    details.technical summary { cursor: pointer; color: #475467; font-weight: 700; }
    .chip { border: 1px solid #ccd6e4; border-radius: 999px; padding: 4px 8px; font-size: 12px; background: #f8fafc; color: #344054; }
    #wizardSteps button.active { background: #1f5eff; color: #fff; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #101828; color: #e5e7eb; border-radius: 8px; padding: 14px; min-height: 280px; max-height: 480px; overflow: auto; }
    .empty { color: #667085; padding: 24px; text-align: center; }
    .workspace.overview-mode { grid-template-columns: minmax(0, 1fr); }
    .workspace.overview-mode .control-pane { display: none; }
    .overview-section { margin-top: 18px; }
    .overview-jobs { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .overview-job { border: 1px solid #d9dee8; border-radius: 10px; padding: 14px; background: #fff; cursor: pointer; }
    .queue-panel { border: 1px solid #d9dee8; border-radius: 8px; background: #f8fafc; padding: 10px; margin: 12px 0; }
    .queue-panel h2 { margin-top: 0; }
    .queue-list { display: grid; gap: 7px; }
    .queue-row { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; gap: 8px; align-items: center; border: 1px solid #e3e7ef; border-radius: 7px; background: #fff; padding: 8px; cursor: pointer; }
    .queue-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-rank { color: #667085; font-size: 12px; font-weight: 700; }
    @media (max-width: 1100px) { .shell { grid-template-columns: 180px minmax(0, 1fr); } .workspace { grid-template-columns: 380px minmax(0, 1fr); } }
    @media (max-width: 760px) { .shell { display: block; } .app-nav { position: sticky; top: 0; z-index: 5; height: auto; align-self: auto; flex-direction: row; overflow-x: auto; padding: 8px; } .app-nav h1, .nav-spacer { display: none; } .nav-button { width: auto; white-space: nowrap; } .workspace { display: block; } .control-pane { max-height: none; border-right: 0; border-bottom: 1px solid #d9dee8; } .model-profile-grid { grid-template-columns: 1fr; } .model-profile-head { align-items: flex-start; } .model-profile-actions { flex-direction: column; align-items: flex-end; } .queue-row { grid-template-columns: 48px minmax(0, 1fr); } .queue-row .status { grid-column: 1 / -1; justify-self: start; } .stages, .metrics, .concurrency { grid-template-columns: repeat(2, minmax(120px, 1fr)); } }
  </style>
</head>
<body>
  <div class="shell">
    <nav class="app-nav" aria-label="主导航">
      <h1>内容生产</h1>
      <button class="nav-button active" data-console-view="overview" type="button">总览</button>
      <button class="nav-button" data-console-view="tasks" type="button">任务</button>
      <button class="nav-button" data-console-view="new" type="button">新建生产</button>
      <button class="nav-button" data-console-view="templates" type="button">模板</button>
      <button class="nav-button" data-console-view="assets" type="button">素材与备份</button>
      <div class="nav-spacer"></div>
      <button class="nav-button" data-console-view="settings" type="button">设置</button>
    </nav>
    <div class="workspace">
    <aside class="control-pane">
      <section class="view-pane" data-view-pane="settings" hidden>
      <h1>设置</h1>
      <div class="view-description">管理当前浏览器的访问凭据。模型、并发和 Gateway 默认值将在后续迁入这里。</div>
      <label>Token <input id="token" type="password" autocomplete="off" placeholder="PRODUCTION_PIPELINE_CONSOLE_TOKEN" /></label>
      <div class="actions"><button class="secondary" id="saveToken" type="button">验证并保存</button><button class="secondary" id="clearToken" type="button">清除</button></div>
      <div id="tokenFeedback" class="meta" aria-live="polite"></div>
      <h2>生产环境</h2>
      <div id="settingsStatus" class="book-progress">加载中...</div>
      <h2>模型 API 凭据</h2>
      <div id="modelProfiles" class="jobs model-profiles"></div>
      <div class="actions"><button class="secondary" id="addModelProfile" type="button">创建新 LLM</button><button id="saveModelProfiles" type="button">保存模型配置</button></div>
      <div id="modelProfileFeedback" class="meta" aria-live="polite">可配置多组模型；最多一组可标记为兜底。</div>
      <label>LLM API Key <input id="settingsLlmApiKey" type="password" autocomplete="new-password" placeholder="留空则保留现有 LLM_API_KEY" /></label>
      <label>向量 API Key <input id="settingsEmbeddingApiKey" type="password" autocomplete="new-password" placeholder="留空则保留现有 EMBEDDING_API_KEY" /></label>
      <div class="actions"><button class="secondary save-runtime-credentials" data-source="settings" type="button">保存到生产环境</button></div>
      <div id="settingsCredentialFeedback" class="meta" aria-live="polite">使用密码框输入，服务端不会回传明文。</div>
      <h2>费用估算（元/章）</h2>
      <label>摘要 <input id="costSummary" type="number" min="0" step="0.001" value="0" /></label>
      <label>知识图谱 <input id="costKg" type="number" min="0" step="0.001" value="0" /></label>
      <label>有声书 <input id="costAudio" type="number" min="0" step="0.001" value="0" /></label>
      <div class="meta">按供应商实际账单填写；0表示暂不估算，不会编造价格。</div>
      <h2>通知</h2>
      <button class="secondary" id="enableNotifications" type="button">启用浏览器完成通知</button>
      <div id="notificationStatus" class="meta">仅在当前浏览器授权后通知任务完成或失败。</div>
      <h2>最近审计事件</h2>
      <div id="auditEvents" class="jobs">加载中...</div>
      </section>
      <section class="view-pane" data-view-pane="templates" hidden>
      <h1>模板</h1>
      <div class="view-description">从生产端模板启动任务，或导入当前电脑上的 JSON。</div>
      <label>生产端 JSON <select id="jobPath"><option value="">加载中...</option></select></label>
      <input id="localJobFile" type="file" accept=".json,application/json" hidden />
      <div class="actions">
        <button class="secondary" id="chooseJob" type="button">本机 JSON</button>
        <button id="startV2" type="button">启动所选</button>
        <button class="secondary" id="refresh" type="button">刷新</button>
      </div>
      <div id="jobPickerFeedback" class="meta" aria-live="polite">可选择生产端已有 JSON，或从当前电脑上传一份 JSON。</div>
      <div id="templates" class="meta">加载中...</div>
      </section>
      <section class="view-pane" data-view-pane="assets" hidden>
      <h2>源文件</h2>
      <label>上传 TXT/EPUB/PDF/MOBI/AZW <input id="sourceFile" type="file" accept=".txt,.epub,.pdf,.mobi,.azw,.azw3" /></label>
      <div class="actions"><button class="secondary" id="uploadSource" type="button">上传源文件</button></div>
      <div id="sources" class="meta">加载中...</div>
      <h2>主库备份</h2>
      <div class="actions"><button class="secondary" id="createBackup" type="button">创建一致性备份</button></div>
      <div id="backups" class="meta">加载中...</div>
      </section>
      <section class="view-pane" data-view-pane="new" hidden>
      <h1>新建生产</h1>
      <div class="view-description">配置内容来源、生产阶段和资源参数，校验后保存或启动。</div>
      <div class="chips" id="wizardSteps"><button class="secondary" data-wizard-step="1" type="button">1 内容</button><button class="secondary" data-wizard-step="2" type="button">2 目标</button><button class="secondary" data-wizard-step="3" type="button">3 资源</button><button class="secondary" data-wizard-step="4" type="button">4 确认</button></div>
      <div class="wizard-step" data-wizard-panel="1">
      <label>创建方式 <select id="builderTemplateMode"><option value="new">新建空模板</option><option value="copy">复制已有任务或模板</option></select></label>
      <label id="builderTemplateSourceRow" hidden>作为模板 <select id="builderTemplateSource"></select></label>
      <div id="builderTemplateSourceFeedback" class="meta" aria-live="polite"></div>
      <label>模板名称 <input id="templateName" placeholder="新书生产" /></label>
      <div id="templateNameHint" class="meta">保存为模板时需要填写；复制已有任务或模板启动时可留空。</div>
      <label>任务标题 <input id="builderTitle" placeholder="新书生产" /></label>
      <label>内容来源 <select id="builderMode"><option value="upload">上传源文件</option><option value="main-db">主库已有书籍</option></select></label>
      <label id="builderSourceRow">源文件 <select id="builderSource"></select></label>
      <label id="builderBookRow" hidden>主库书籍 <select id="builderBook"></select></label>
      <div id="bookProduction" class="book-progress" hidden></div>
      </div>
      <div class="wizard-step" data-wizard-panel="2" hidden>
      <h2>选择生产目标</h2>
      <div id="builderStages" class="stage-options"></div>
      <div class="meta">阶段依赖会自动补齐：摘要定位依赖摘要，验证依赖发布，发布依赖打包。</div>
      </div>
      <div class="wizard-step" data-wizard-panel="3" hidden>
      <h2>资源配置</h2>
      <div class="actions"><button class="secondary resource-preset" data-preset="stable" type="button">稳定</button><button class="resource-preset" data-preset="balanced" type="button">均衡（推荐）</button><button class="secondary resource-preset" data-preset="fast" type="button">极速</button></div>
      <label>LLM 配置 <select id="llmProfile"><option value="">手动配置</option></select></label>
      <label>LLM 地址 <input id="llmBaseUrl" /></label>
      <label>LLM 模型 <input id="llmModel" /></label>
      <label>LLM 总并发数 <input id="llmConcurrency" type="number" min="1" max="64" /></label>
      <label>LLM API Key <input id="builderLlmApiKey" type="password" autocomplete="new-password" placeholder="留空则使用已保存的 LLM_API_KEY" /></label>
      <label>向量服务地址 <input id="embeddingBaseUrl" /></label>
      <label>向量模型 <input id="embeddingModel" /></label>
      <label>向量并发数 <input id="embeddingConcurrency" type="number" min="1" max="128" /></label>
      <label>向量 API Key <input id="builderEmbeddingApiKey" type="password" autocomplete="new-password" placeholder="留空则使用已保存的 EMBEDDING_API_KEY" /></label>
      <div class="actions"><button class="secondary save-runtime-credentials" data-source="builder" type="button">保存 API Key 到生产环境</button></div>
      <div id="builderCredentialFeedback" class="meta" aria-live="polite"></div>
      <h2>有声书参数</h2>
      <label>TTS 配置文件 <input id="ttsConfig" /></label>
      <label>导演最大并发数（自动计算） <input id="directorConcurrency" type="number" readonly /></label>
      <div class="meta">导演并发由 LLM 总并发池动态分配；摘要、KG 同时运行时会自动降低，空闲后自动借用。</div>
      <label>同时编排章节 <input id="llmChapters" type="number" min="1" max="16" /></label>
      <label>TTS 请求并发数 <input id="ttsConcurrency" type="number" min="1" max="64" /></label>
      <label>同时合成章节 <input id="ttsChapters" type="number" min="1" max="16" /></label>
      <h2>Gateway 发布参数</h2>
      <label>主机 <input id="gatewayHost" /></label>
      <label>SSH 用户 <input id="gatewayUser" /></label>
      <label>部署目录 <input id="gatewayRoot" /></label>
      <label>验证 URL <input id="gatewayUrl" /></label>
      <label>访问 Token 环境变量 <input id="gatewayTokenEnv" /></label>
      <label>音频抽样数 <input id="audioSamples" type="number" min="1" max="20" value="3" /></label>
      </div>
      <div class="wizard-step" data-wizard-panel="4" hidden>
      <h2>检查并启动</h2>
      <label>模板 JSON <textarea id="templateJson" placeholder='{"title":"新书","source":{"type":"txt","file":"新书.txt"},"stages":["import","summary","kg","embedding","package"]}'></textarea></label>
      <div class="actions"><button class="secondary" id="generateTemplate" type="button">刷新配置</button><button class="secondary" id="saveTemplate" type="button">保存为模板</button><button id="saveAndStart" type="button">确认并启动</button></div>
      <div id="builderFeedback" class="inline-feedback info" hidden aria-live="polite"></div>
      </div>
      <div class="actions"><button class="secondary" id="wizardBack" type="button">上一步</button><button id="wizardNext" type="button">下一步</button></div>
      </section>
      <section class="view-pane" data-view-pane="tasks">
      <h1>任务</h1>
      <div class="view-description">查看运行中、等待中和历史生产任务。</div>
      <div id="schedulerQueue"></div>
      <label>搜索 <input id="jobSearch" placeholder="书名或模板" /></label>
      <label>状态 <select id="jobStatusFilter"><option value="">全部状态</option><option value="running">运行中</option><option value="queued">等待中</option><option value="failed">失败</option><option value="stopped">已暂停</option><option value="completed">已完成</option></select></label>
      <div id="jobs" class="jobs"></div>
      </section>
    </aside>
    <main>
      <div id="detail" class="empty">选择或启动一个任务。</div>
    </main>
    </div>
  </div>
  <script>
    const state = { selectedJobId: '', eventSource: null, builderBooks: [], builderTemplates: [], modelProfiles: [], jobs: [], jobStatuses: {}, scheduler: null, dagProgress: {}, currentView: localStorage.getItem('productionPipeline.currentView') || 'overview', wizardStep: 1, logFilter: 'key' };
    function showWizardStep(step) {
      state.wizardStep = Math.max(1, Math.min(4, Number(step) || 1));
      document.querySelectorAll('[data-wizard-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.wizardPanel) !== state.wizardStep; });
      document.querySelectorAll('[data-wizard-step]').forEach(button => button.classList.toggle('active', Number(button.dataset.wizardStep) === state.wizardStep));
      document.getElementById('wizardBack').disabled = state.wizardStep === 1;
      document.getElementById('wizardNext').hidden = state.wizardStep === 4;
      if (state.wizardStep === 4) { generateTemplate(); renderWizardPreview(); }
    }
    function renderWizardPreview() {
      const template = buildTemplateFromForm();
      const labels = { import: '导入正文', summary: '章节摘要', 'summary-locate': '摘要定位', kg: '知识图谱', embedding: '向量索引', audio: '有声书', package: '打包', publish: '发布', verify: '验证' };
      const stages = template.stages || [];
      const book = state.builderBooks.find(item => item.id === template.bookId);
      const scope = template.source?.type === 'main-db' ? ((book?.chapterCount || '未知') + ' 章') : '导入后按实际章节';
      const chapterCount = Number(book?.chapterCount) || 0;
      const perChapterCost = (stages.includes('summary') ? Number(template.costEstimation?.summaryPerChapter) || 0 : 0) + (stages.includes('kg') ? Number(template.costEstimation?.kgPerChapter) || 0 : 0) + (stages.includes('audio') ? Number(template.costEstimation?.audioPerChapter) || 0 : 0);
      const estimatedCost = chapterCount * perChapterCost;
      const costLabel = perChapterCost <= 0 ? '未配置章节单价' : (chapterCount > 0 ? '约 ¥' + estimatedCost.toFixed(2) : '导入并识别章节后计算');
      document.getElementById('detail').innerHTML = '<div class="panel"><h1>启动前检查</h1><div class="meta">书籍：' + escapeHtml(template.title || '未命名') + '</div><div class="meta">处理范围：' + escapeHtml(scope) + '</div><h2>生产 DAG</h2><div class="chips">' + stages.map((stage, index) => '<span class="chip">' + (index + 1) + ' ' + escapeHtml(labels[stage] || stage) + '</span>').join('') + '</div><h2>资源与风险</h2><div class="meta">LLM 总并发 ' + escapeHtml(template.llm?.concurrency || 0) + '；向量并发 ' + escapeHtml(template.embedding?.concurrency || 0) + '；TTS 并发 ' + escapeHtml(template.audio?.ttsConcurrency || 0) + '。</div><div class="meta">预计费用：' + escapeHtml(costLabel) + '</div><div class="inline-feedback info">摘要、知识图谱和有声书会调用外部模型并产生费用；发布阶段会写入 Gateway。</div></div>';
    }
    function setConsoleView(view) {
      state.currentView = view;
      localStorage.setItem('productionPipeline.currentView', view);
      document.querySelector('.workspace').classList.toggle('overview-mode', view === 'overview');
      const paneView = view;
      document.querySelectorAll('[data-view-pane]').forEach(pane => { pane.hidden = pane.dataset.viewPane !== paneView; });
      document.querySelectorAll('[data-console-view]').forEach(button => button.classList.toggle('active', button.dataset.consoleView === view));
      if (view === 'overview') renderOverview();
      else if (view === 'new') { document.getElementById('detail').innerHTML = '<div class="panel"><h1>新建生产</h1><p>按照内容来源、生产目标、资源配置和启动确认完成任务创建。</p><div id="wizardPreview" class="meta">进入第4步后，这里将显示最终 DAG 和生产影响范围。</div></div>'; showWizardStep(state.wizardStep); }
      else if (view === 'templates') document.getElementById('detail').innerHTML = '<div class="panel"><h1>模板管理</h1><p>选择生产端模板直接启动，或导入本机 JSON。模板不会自动执行。</p></div>';
      else if (view === 'assets') document.getElementById('detail').innerHTML = '<div class="panel"><h1>素材与备份</h1><p>集中管理生产源文件和主库一致性备份。</p></div>';
      else if (view === 'settings') document.getElementById('detail').innerHTML = '<div class="panel"><h1>设置</h1><p>Console Token 保存在当前浏览器；模型 API Key 以权限 600 保存到服务端运行环境文件，并注入后续生产进程。</p></div>';
    }
    function renderOverview() {
      const jobs = state.jobs || [];
      const active = jobs.filter(isActiveJob).length;
      const failed = jobs.filter(job => job.status === 'failed').length;
      const completed = jobs.filter(job => job.status === 'completed').length;
      document.getElementById('detail').className = '';
      const activeJobs = jobs.filter(isActiveJob);
      const attentionJobs = jobs.filter(job => job.status === 'failed' || job.status === 'stopped');
      const activeCards = activeJobs.map(job => '<div class="overview-job" data-overview-job="' + escapeHtml(job.id) + '"><div class="topline"><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(statusLabel(job.status)) + '</span></div><div class="meta">' + escapeHtml(job.progressSummary || '正在读取阶段进度') + '</div><div class="meta">启动于 ' + escapeHtml(formatLocalTime(job.startedAt || job.createdAt)) + '</div></div>').join('');
      const attentionCards = attentionJobs.slice(0, 6).map(job => '<div class="overview-job" data-overview-job="' + escapeHtml(job.id) + '"><div class="topline"><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(statusLabel(job.status)) + '</span></div><div class="meta">' + escapeHtml(job.error || '需要处理') + '</div></div>').join('');
      document.getElementById('detail').innerHTML = '<h1>生产总览</h1><p class="meta">只展示当前产能、正在生产和需要处理的事项；完整历史请进入“任务”。</p><div class="summary-grid"><div class="summary-card"><span class="meta">正在运行</span><strong>' + jobs.filter(job => job.status === 'running').length + '</strong></div><div class="summary-card"><span class="meta">等待资源</span><strong>' + jobs.filter(job => job.status === 'queued').length + '</strong></div><div class="summary-card"><span class="meta">需要处理</span><strong>' + attentionJobs.length + '</strong></div><div class="summary-card"><span class="meta">累计完成</span><strong>' + completed + '</strong></div></div><div class="overview-section"><h2>正在生产</h2><div class="overview-jobs">' + (activeCards || '<div class="panel"><p>当前没有运行或排队任务。</p></div>') + '</div></div>' + (attentionCards ? '<div class="overview-section"><h2>需要处理</h2><div class="overview-jobs">' + attentionCards + '</div></div>' : '');
      document.querySelectorAll('[data-overview-job]').forEach(card => card.addEventListener('click', () => { setConsoleView('tasks'); selectJob(card.dataset.overviewJob); }));
    }
    document.querySelectorAll('[data-console-view]').forEach(button => button.addEventListener('click', () => setConsoleView(button.dataset.consoleView)));
    const fields = ['jobPath','templateName','templateJson','builderTitle','llmBaseUrl','llmModel','llmConcurrency','embeddingBaseUrl','embeddingModel','embeddingConcurrency','ttsConfig','llmChapters','ttsConcurrency','ttsChapters','gatewayHost','gatewayUser','gatewayRoot','gatewayUrl','gatewayTokenEnv','audioSamples','costSummary','costKg','costAudio'];
    for (const id of fields) {
      const saved = localStorage.getItem('productionPipeline.' + id);
      const el = document.getElementById(id);
      if (saved !== null) el.value = saved;
      el.addEventListener('input', () => localStorage.setItem('productionPipeline.' + id, el.value));
    }
    document.getElementById('builderTemplateMode').value = localStorage.getItem('productionPipeline.builderTemplateMode') || 'new';
    document.getElementById('builderTemplateSourceRow').hidden = document.getElementById('builderTemplateMode').value !== 'copy';
    const savedToken = localStorage.getItem('productionPipeline.token') || '';
    document.getElementById('token').value = savedToken;
    if (savedToken) document.getElementById('tokenFeedback').textContent = '已读取当前浏览器保存的 Token。';
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
    async function saveConsoleToken() {
      const token = document.getElementById('token').value.trim();
      if (!token) throw new Error('请先输入 Token。');
      const feedback = document.getElementById('tokenFeedback');
      feedback.textContent = '正在验证…';
      const session = await api('/api/session');
      localStorage.setItem('productionPipeline.token', token);
      feedback.textContent = 'Token 已验证并保存在当前浏览器。权限：' + (session.role === 'admin' ? '管理员' : '只读查看');
      await Promise.all([loadJobs(), loadManagedAssets()]);
    }
    function clearConsoleToken() {
      localStorage.removeItem('productionPipeline.token');
      document.getElementById('token').value = '';
      document.getElementById('tokenFeedback').textContent = '当前浏览器保存的 Token 已清除。';
    }
    async function saveRuntimeCredentials(source, button) {
      const prefix = source === 'settings' ? 'settings' : 'builder';
      const llmInput = document.getElementById(prefix + 'LlmApiKey');
      const embeddingInput = document.getElementById(prefix + 'EmbeddingApiKey');
      const feedback = document.getElementById(prefix + 'CredentialFeedback');
      const body = { llmApiKey: llmInput.value.trim(), embeddingApiKey: embeddingInput.value.trim() };
      if (!body.llmApiKey && !body.embeddingApiKey) throw new Error('请至少输入一个 API Key。');
      button.disabled = true;
      feedback.textContent = '正在保存到生产环境…';
      try {
        const result = await api('/api/runtime-credentials', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        llmInput.value = '';
        embeddingInput.value = '';
        feedback.textContent = '已保存。LLM：' + (result.environmentStatus.llmCredential ? '已配置' : '未配置') + '；向量：' + (result.environmentStatus.embeddingCredential ? '已配置' : '未配置') + '。';
        await loadManagedAssets();
      } finally {
        button.disabled = false;
      }
    }
    function showError(title, error) {
      document.getElementById('detail').className = '';
      document.getElementById('detail').innerHTML = '<div class="error-panel"><strong>' + escapeHtml(title) + '</strong><div>' + escapeHtml(error.message || String(error)) + '</div></div>' + document.getElementById('detail').innerHTML;
    }
    function showBuilderFeedback(type, message) {
      const root = document.getElementById('builderFeedback');
      root.className = 'inline-feedback ' + type;
      root.textContent = message;
      root.hidden = false;
    }
    async function loadJobs() {
      const [body, health] = await Promise.all([api('/api/jobs?limit=50'), api('/health')]);
      for (const job of body.jobs) {
        const previous = state.jobStatuses[job.id];
        if (previous && previous !== job.status && (job.status === 'completed' || job.status === 'failed') && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('内容生产' + statusLabel(job.status), { body: job.title + ' · ' + statusLabel(job.status) });
        }
        state.jobStatuses[job.id] = job.status;
      }
      state.jobs = body.jobs;
      state.scheduler = health.scheduler || null;
      renderBuilderTemplateSourceOptions();
      renderSchedulerQueue();
      const root = document.getElementById('jobs');
      const visibleJobs = filterJobs(body.jobs);
      root.innerHTML = visibleJobs.map(job => '<div class="job ' + (job.id === state.selectedJobId ? 'active' : '') + '" data-id="' + job.id + '"><div class="topline"><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + job.status + '">' + escapeHtml(statusLabel(job.status)) + '</span></div>' + (job.runSummary ? '<div class="meta">阶段 ' + job.runSummary.completedStages + '/' + job.runSummary.totalStages + (job.runSummary.runningStages.length ? ' · 当前：' + escapeHtml(job.runSummary.runningStages.join('、')) : '') + '</div>' : '') + '<div class="meta">' + escapeHtml(formatLocalTime(job.createdAt)) + '</div><div class="meta">' + escapeHtml(job.productionJobPath || '') + '</div><div class="actions">' + (isActiveJob(job) ? '<button class="secondary stop-job" type="button" data-id="' + job.id + '">暂停生产</button>' : canRetryJob(job) ? '<button class="secondary retry-job" type="button" data-id="' + job.id + '">' + (job.status === 'failed' ? '重试失败项' : '继续生产') + '</button>' : '') + (canDeleteJob(job) ? '<button class="danger delete-job" type="button" data-id="' + job.id + '" data-title="' + escapeHtml(job.title) + '">删除</button>' : '') + '</div></div>').join('') || '<div class="meta">没有符合条件的任务</div>';
      root.querySelectorAll('.job').forEach(el => el.addEventListener('click', () => { if (state.currentView === 'overview') setConsoleView('tasks'); selectJob(el.dataset.id); }));
      root.querySelectorAll('.stop-job').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        stopJob(button.dataset.id).catch(error => showError('停止任务失败', error));
      }));
      root.querySelectorAll('.retry-job').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        retryJob(button.dataset.id).catch(error => showError('重新排队失败', error));
      }));
      root.querySelectorAll('.delete-job').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        deleteJob(button.dataset.id, button.dataset.title).catch(error => showError('删除任务失败', error));
      }));
      if (state.currentView === 'overview') renderOverview();
    }
    function renderSchedulerQueue() {
      const root = document.getElementById('schedulerQueue');
      if (!root) return;
      const scheduler = state.scheduler || {};
      const running = state.jobs.filter(job => job.status === 'running' || job.status === 'stopping').sort((a, b) => (a.startedAt || a.createdAt).localeCompare(b.startedAt || b.createdAt));
      const queued = state.jobs.filter(job => job.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const rows = [
        ...running.map(job => queueRow(job, '运行中')),
        ...queued.map((job, index) => queueRow(job, '第 ' + (index + 1) + ' 个')),
      ].join('');
      root.innerHTML = '<div class="queue-panel"><div class="topline"><h2>待执行队列</h2><span class="meta">并发 ' + escapeHtml(scheduler.running || 0) + '/' + escapeHtml(scheduler.maxConcurrentJobs || 1) + ' · 等待 ' + escapeHtml(scheduler.queued || 0) + '</span></div><div class="queue-list">' + (rows || '<div class="meta">当前没有运行或等待中的生产任务。</div>') + '</div></div>';
      root.querySelectorAll('.queue-row').forEach(row => row.addEventListener('click', () => selectJob(row.dataset.id)));
    }
    function queueRow(job, rank) {
      return '<div class="queue-row" data-id="' + escapeHtml(job.id) + '"><span class="queue-rank">' + escapeHtml(rank) + '</span><strong>' + escapeHtml(job.title) + '</strong><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(statusLabel(job.status)) + '</span></div>';
    }
    function filterJobs(jobs) {
      const query = document.getElementById('jobSearch').value.trim().toLowerCase();
      const status = document.getElementById('jobStatusFilter').value;
      return jobs.filter(job => (!status || job.status === status) && (!query || (job.title + ' ' + (job.productionJobPath || '')).toLowerCase().includes(query)));
    }
    function renderBuilderTemplateSourceOptions() {
      const select = document.getElementById('builderTemplateSource');
      if (!select) return;
      const selected = select.value || localStorage.getItem('productionPipeline.builderTemplateSource') || '';
      const templateOptions = (state.builderTemplates || []).map(file => ({
        key: file.name,
        value: 'template:' + encodeURIComponent(file.name),
        label: '模板 · ' + (file.title || file.name) + ' · ' + file.name,
      }));
      const seenJobTemplates = new Set();
      const jobOptions = (state.jobs || []).flatMap(job => {
        const path = job.productionJobPath || '';
        const prefix = '/app/jobs/';
        const name = path.startsWith(prefix) && path.endsWith('.json') && !path.slice(prefix.length).includes('/') ? path.slice(prefix.length) : '';
        if (!name || seenJobTemplates.has(name)) return [];
        seenJobTemplates.add(name);
        return [{
          key: name,
          value: 'template:' + encodeURIComponent(name),
          label: '任务 · ' + (job.title || name) + ' · ' + name,
        }];
      });
      const options = [...jobOptions, ...templateOptions.filter(item => !seenJobTemplates.has(item.key))];
      select.innerHTML = options.map(item => '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</option>').join('');
      if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
      document.getElementById('builderTemplateSourceFeedback').textContent = options.length ? '选择已有任务或模板后，会复制其生产参数；模板名称可留空，启动时会自动生成后台文件名。' : '暂无可复制的任务或模板。';
      updateTemplateNameHint();
    }
    function canAutonameTemplateForStart() {
      return document.getElementById('builderTemplateMode').value === 'copy' && Boolean(document.getElementById('builderTemplateSource').value);
    }
    function updateTemplateNameHint() {
      const hint = document.getElementById('templateNameHint');
      if (!hint) return;
      hint.textContent = canAutonameTemplateForStart() ? '已选择已有任务或模板：模板名称可留空，确认启动时会按任务标题自动生成后台文件名。' : '保存为模板或新建空模板启动时需要填写模板名称。';
    }
    function resetBuilderForNewTemplate() {
      document.getElementById('templateName').value = '';
      document.getElementById('builderTitle').value = '';
      document.getElementById('templateJson').value = '';
      document.getElementById('builderTemplateSourceFeedback').textContent = '已切换为新建空模板。';
      localStorage.removeItem('productionPipeline.templateName');
      localStorage.removeItem('productionPipeline.builderTitle');
      localStorage.removeItem('productionPipeline.templateJson');
    }
    async function applyBuilderTemplateSource() {
      const mode = document.getElementById('builderTemplateMode').value;
      const sourceRow = document.getElementById('builderTemplateSourceRow');
      sourceRow.hidden = mode !== 'copy';
      if (mode !== 'copy') {
        resetBuilderForNewTemplate();
        updateTemplateNameHint();
        return;
      }
      const value = document.getElementById('builderTemplateSource').value;
      if (!value) {
        document.getElementById('builderTemplateSourceFeedback').textContent = '暂无可复制的任务或模板。';
        updateTemplateNameHint();
        return;
      }
      const [, encodedName = ''] = value.split(':');
      await loadTemplateIntoBuilder(encodedName, true);
      document.getElementById('builderTemplateMode').value = 'copy';
      sourceRow.hidden = false;
      updateTemplateNameHint();
    }
    async function loadManagedAssets() {
      const [sourceBody, templateBody, backupBody, builderBody, auditBody, sessionBody] = await Promise.all([
        api('/api/sources'), api('/api/templates'), api('/api/backups'), api('/api/builder-metadata'), api('/api/audit?limit=20'), api('/api/session'),
      ]);
      state.builderTemplates = templateBody.templates || [];
      document.getElementById('tokenFeedback').textContent = '当前权限：' + (sessionBody.role === 'admin' ? '管理员' : '只读查看') + '。Token 保存在当前浏览器。';
      document.getElementById('auditEvents').innerHTML = auditBody.events.map(event => '<div class="job"><strong>' + escapeHtml(event['event.action'] || 'event') + '</strong><div class="meta">' + escapeHtml(event.message || '') + '</div><div class="meta">' + escapeHtml(formatLocalTime(event['@timestamp'])) + ' · ' + escapeHtml(event.job_id || '') + '</div></div>').join('') || '<div class="meta">暂无审计事件</div>';
      document.getElementById('sources').innerHTML = sourceBody.sources.map(file => '<div class="job"><strong>' + escapeHtml(file.name) + '</strong><div class="meta">' + formatBytes(file.sizeBytes) + ' · ' + escapeHtml(formatLocalTime(file.updatedAt)) + '</div><div class="actions"><button class="danger delete-source" data-name="' + encodeURIComponent(file.name) + '" type="button">删除</button></div></div>').join('') || '暂无源文件';
      document.getElementById('templates').innerHTML = templateBody.templates.map(file => '<div class="job"><strong>' + escapeHtml(file.title || file.name) + '</strong><div class="meta mono">' + escapeHtml(file.name) + '</div><div class="meta">' + escapeHtml((file.stages || []).join(' → ') || '空任务') + '</div><div class="actions"><button class="start-template" data-name="' + encodeURIComponent(file.name) + '" type="button">启动</button><button class="secondary edit-template" data-name="' + encodeURIComponent(file.name) + '" type="button">编辑</button><button class="secondary copy-template" data-name="' + encodeURIComponent(file.name) + '" type="button">复制</button><button class="danger delete-template" data-name="' + encodeURIComponent(file.name) + '" data-title="' + escapeHtml(file.title || file.name) + '" type="button">删除</button></div></div>').join('') || '暂无模板';
      const jobPath = document.getElementById('jobPath');
      const selectedJobPath = jobPath.value || localStorage.getItem('productionPipeline.jobPath') || '';
      jobPath.innerHTML = '<option value="">请选择生产端 JSON</option>' + templateBody.templates.map(file => '<option value="/app/jobs/' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + ' · ' + escapeHtml(file.title || '未命名') + '</option>').join('');
      if ([...jobPath.options].some(option => option.value === selectedJobPath)) jobPath.value = selectedJobPath;
      renderBuilderTemplateSourceOptions();
      document.querySelectorAll('.start-template').forEach(button => button.addEventListener('click', async () => {
        const body = await api('/api/templates/' + button.dataset.name + '/start', { method: 'POST' });
        await loadJobs();
        await selectJob(body.job.id);
      }));
      document.querySelectorAll('.edit-template').forEach(button => button.addEventListener('click', () => loadTemplateIntoBuilder(button.dataset.name, false).catch(error => showError('加载模板失败', error))));
      document.querySelectorAll('.copy-template').forEach(button => button.addEventListener('click', () => loadTemplateIntoBuilder(button.dataset.name, true).catch(error => showError('复制模板失败', error))));
      document.querySelectorAll('.delete-template').forEach(button => button.addEventListener('click', () => deleteTemplate(button.dataset.name, button.dataset.title).catch(error => showError('删除模板失败', error))));
      document.getElementById('backups').innerHTML = backupBody.backups.map(file => '<div class="job"><strong>' + escapeHtml(file.name) + '</strong><div class="meta">' + formatBytes(file.sizeBytes) + ' · ' + escapeHtml(formatLocalTime(file.updatedAt)) + '</div><div class="actions"><button class="secondary download-backup" data-name="' + encodeURIComponent(file.name) + '" type="button">下载</button><button class="danger delete-backup" data-name="' + encodeURIComponent(file.name) + '" type="button">删除</button></div></div>').join('') || '暂无备份';
      document.querySelectorAll('.download-backup').forEach(button => button.addEventListener('click', () => downloadBackup(button.dataset.name).catch(error => showError('下载备份失败', error))));
      document.querySelectorAll('.delete-source').forEach(button => button.addEventListener('click', () => deleteManagedAsset('sources', button.dataset.name, '源文件').catch(error => showError('删除源文件失败', error))));
      document.querySelectorAll('.delete-backup').forEach(button => button.addEventListener('click', () => deleteManagedAsset('backups', button.dataset.name, '备份').catch(error => showError('删除备份失败', error))));
      populateBuilder(builderBody);
    }
    async function deleteManagedAsset(kind, encodedName, label) {
      const name = decodeURIComponent(encodedName);
      if (!window.confirm('删除' + label + '“' + name + '”？\\n\\n此操作不会删除主库中的书籍。')) return;
      await api('/api/' + kind + '/' + encodedName, { method: 'DELETE' });
      await loadManagedAssets();
    }
    async function loadTemplateIntoBuilder(encodedName, copy) {
      const body = await api('/api/templates/' + encodedName);
      const template = body.template || {};
      const fileName = decodeURIComponent(encodedName);
      if (copy) {
        document.getElementById('builderTemplateMode').value = 'copy';
        document.getElementById('builderTemplateSourceRow').hidden = false;
        const sourceValue = 'template:' + encodedName;
        if ([...document.getElementById('builderTemplateSource').options].some(option => option.value === sourceValue)) {
          document.getElementById('builderTemplateSource').value = sourceValue;
          localStorage.setItem('productionPipeline.builderTemplateSource', sourceValue);
        }
        localStorage.setItem('productionPipeline.builderTemplateMode', 'copy');
      }
      document.getElementById('templateName').value = copy ? '' : fileName.replace(/\.json$/i, '');
      document.getElementById('builderTitle').value = template.title || '';
      document.getElementById('builderTemplateSourceFeedback').textContent = copy ? '已复制“' + fileName + '”，请按新任务修改标题、内容来源和资源参数；模板名称可留空。' : '已载入“' + fileName + '”，可直接编辑并保存。';
      const mainDb = template.source?.type === 'main-db';
      document.getElementById('builderMode').value = mainDb ? 'main-db' : 'upload';
      document.getElementById('builderSourceRow').hidden = mainDb;
      document.getElementById('builderBookRow').hidden = !mainDb;
      if (template.source?.file) document.getElementById('builderSource').value = template.source.file.split('/').pop();
      if (template.bookId) document.getElementById('builderBook').value = template.bookId;
      if (template.llm?.profileId) document.getElementById('llmProfile').value = template.llm.profileId;
      document.querySelectorAll('#builderStages input').forEach(input => { input.checked = (template.stages || []).includes(input.value); });
      for (const [id, value] of [['llmBaseUrl', template.llm?.baseUrl], ['llmModel', template.llm?.model], ['llmConcurrency', template.llm?.concurrency], ['embeddingBaseUrl', template.embedding?.baseUrl], ['embeddingModel', template.embedding?.model], ['embeddingConcurrency', template.embedding?.concurrency], ['ttsConfig', template.audio?.ttsConfig], ['llmChapters', template.audio?.llmChapters], ['ttsConcurrency', template.audio?.ttsConcurrency], ['ttsChapters', template.audio?.ttsChapters], ['gatewayHost', template.gateway?.host], ['gatewayUser', template.gateway?.user], ['gatewayRoot', template.gateway?.root], ['gatewayUrl', template.gateway?.url], ['gatewayTokenEnv', template.gateway?.tokenEnv], ['audioSamples', template.verify?.audioSamples], ['costSummary', template.costEstimation?.summaryPerChapter], ['costKg', template.costEstimation?.kgPerChapter], ['costAudio', template.costEstimation?.audioPerChapter]]) {
        if (value !== undefined) document.getElementById(id).value = value;
      }
      enforceStageDependencies();
      updateDirectorConcurrency();
      setConsoleView('new');
      showWizardStep(1);
      updateTemplateNameHint();
      showBuilderFeedback('info', copy ? '已加载模板副本，若只启动任务可不填写模板名称。' : '模板已载入编辑器。');
    }
    async function deleteTemplate(encodedName, title) {
      if (!window.confirm('删除模板“' + title + '”？\\n\\n不会删除历史任务和生产产物。')) return;
      await api('/api/templates/' + encodedName, { method: 'DELETE' });
      await loadManagedAssets();
    }
    function populateBuilder(body) {
      const environmentStatus = body.environmentStatus || {};
      state.modelProfiles = body.modelProfiles || [];
      renderModelProfiles();
      const statusLabels = { mainDatabase: '生产主库', ttsConfig: 'TTS配置', llmCredential: 'LLM凭据', embeddingCredential: '向量凭据', gatewayToken: 'Gateway访问凭据', gatewayAdminToken: 'Gateway管理凭据' };
      document.getElementById('settingsStatus').innerHTML = Object.entries(statusLabels).map(([key, label]) => '<div class="topline"><span>' + label + '</span><span class="status ' + (environmentStatus[key] ? 'completed' : 'failed') + '">' + (environmentStatus[key] ? '已配置' : '未配置') + '</span></div>').join('');
      const source = document.getElementById('builderSource');
      const selectedSource = source.value;
      source.innerHTML = body.sources.map(file => '<option value="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</option>').join('');
      if (selectedSource) source.value = selectedSource;
      const book = document.getElementById('builderBook');
      const selectedBook = book.value;
      state.builderBooks = body.books;
      const titleCounts = body.books.reduce((counts, item) => ({ ...counts, [item.title]: (counts[item.title] || 0) + 1 }), {});
      book.innerHTML = body.books.map(item => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title) + (titleCounts[item.title] > 1 ? ' · ' + escapeHtml(item.id.slice(-8)) : '') + ' (' + item.chapterCount + '章 · ' + compactProductionStatus(item) + ')</option>').join('');
      if (selectedBook) book.value = selectedBook;
      renderBookProduction();
      const stages = document.getElementById('builderStages');
      if (!stages.children.length) {
        stages.innerHTML = body.stages.map(stage => '<div class="stage-option"><input type="checkbox" id="stage-' + stage.id + '" value="' + stage.id + '"><label for="stage-' + stage.id + '"><strong>' + escapeHtml(stage.label) + '</strong><div class="meta">' + escapeHtml(stage.description) + '</div></label></div>').join('');
        stages.querySelectorAll('input').forEach(input => input.addEventListener('change', enforceStageDependencies));
      }
      enforceStageDependencies();
      const profileSelect = document.getElementById('llmProfile');
      const selectedProfile = profileSelect.value;
      profileSelect.innerHTML = '<option value="">手动配置</option>' + state.modelProfiles.map(profile => '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.label) + (profile.fallback ? '（兜底）' : '') + '</option>').join('');
      if (selectedProfile) profileSelect.value = selectedProfile;
      for (const [id, value] of [['llmBaseUrl', body.defaults.llm.baseUrl], ['llmModel', body.defaults.llm.model], ['llmConcurrency', body.defaults.llm.concurrency], ['embeddingBaseUrl', body.defaults.embedding.baseUrl], ['embeddingModel', body.defaults.embedding.model], ['embeddingConcurrency', body.defaults.embedding.concurrency]]) {
        if (!document.getElementById(id).value) document.getElementById(id).value = value;
      }
      for (const [id, value] of [['ttsConfig', body.defaults.audio.ttsConfig], ['llmChapters', body.defaults.audio.llmChapters], ['ttsConcurrency', body.defaults.audio.ttsConcurrency], ['ttsChapters', body.defaults.audio.ttsChapters], ['gatewayHost', body.defaults.gateway.host], ['gatewayUser', body.defaults.gateway.user], ['gatewayRoot', body.defaults.gateway.root], ['gatewayUrl', body.defaults.gateway.url], ['gatewayTokenEnv', body.defaults.gateway.tokenEnv]]) {
        if (!document.getElementById(id).value) document.getElementById(id).value = value;
      }
    }
    function renderModelProfiles() {
      const root = document.getElementById('modelProfiles');
      root.innerHTML = state.modelProfiles.map((profile, index) => {
        const labelValue = escapeHtml(profile.label || '');
        const modelValue = escapeHtml(profile.model || '');
        const baseUrlValue = escapeHtml(profile.baseUrl || '');
        const displayLabel = labelValue || '未命名模型';
        const displayModel = modelValue || '未填写模型名称';
        return '<section class="model-profile" data-profile-index="' + index + '">' +
          '<div class="model-profile-head"><div class="model-profile-title"><strong>' + displayLabel + '</strong><span>' + displayModel + '</span></div><div class="model-profile-actions"><label class="toggle-field fallback-toggle"><input data-profile-field="fallback" type="checkbox" ' + (profile.fallback ? 'checked' : '') + '><span class="toggle-switch" aria-hidden="true"></span><span>兜底</span></label><button class="danger remove-model-profile" type="button">删除</button></div></div>' +
          '<div class="model-profile-grid">' +
          '<label class="model-profile-field"><span>名称</span><input data-profile-field="label" value="' + labelValue + '"></label>' +
          '<label class="model-profile-field"><span>标识</span><input data-profile-field="id" value="' + escapeHtml(profile.id) + '" ' + (profile.persisted ? 'readonly' : '') + '></label>' +
          '<label class="model-profile-field wide"><span>Base URL</span><input data-profile-field="baseUrl" value="' + baseUrlValue + '"></label>' +
          '<label class="model-profile-field"><span>模型名称</span><input data-profile-field="model" value="' + modelValue + '"></label>' +
          '<label class="model-profile-field"><span>API Key</span><input data-profile-field="apiKey" type="password" autocomplete="new-password" placeholder="留空保留现有凭据"></label>' +
          '</div>' +
          '</section>';
      }).join('') || '<div class="meta">尚未创建命名模型配置。</div>';
      root.querySelectorAll('.remove-model-profile').forEach(button => button.addEventListener('click', () => { state.modelProfiles.splice(Number(button.closest('.model-profile').dataset.profileIndex), 1); renderModelProfiles(); }));
    }
    function collectModelProfiles() {
      return [...document.querySelectorAll('.model-profile')].map(card => ({
        id: card.querySelector('[data-profile-field="id"]').value.trim(), label: card.querySelector('[data-profile-field="label"]').value.trim(),
        baseUrl: card.querySelector('[data-profile-field="baseUrl"]').value.trim(), model: card.querySelector('[data-profile-field="model"]').value.trim(),
        apiKey: card.querySelector('[data-profile-field="apiKey"]').value, fallback: card.querySelector('[data-profile-field="fallback"]').checked,
      }));
    }
    async function saveModelProfiles() {
      const body = await api('/api/model-profiles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profiles: collectModelProfiles() }) });
      state.modelProfiles = (body.profiles || []).map(profile => ({ ...profile, persisted: true }));
      document.getElementById('modelProfileFeedback').textContent = '模型配置已保存，API Key 不会回传到页面。';
      renderModelProfiles();
      await loadManagedAssets();
    }
    function selectModelProfile() {
      const profile = state.modelProfiles.find(item => item.id === document.getElementById('llmProfile').value);
      if (!profile) return;
      document.getElementById('llmBaseUrl').value = profile.baseUrl;
      document.getElementById('llmModel').value = profile.model;
    }
    function enforceStageDependencies() {
      const checked = id => document.getElementById('stage-' + id)?.checked;
      const select = id => { const input = document.getElementById('stage-' + id); if (input) input.checked = true; };
      const importInput = document.getElementById('stage-import');
      const uploadMode = document.getElementById('builderMode').value === 'upload';
      if (importInput) { importInput.checked = uploadMode; importInput.disabled = true; }
      if (checked('summary-locate')) select('summary');
      if (checked('verify')) { select('publish'); select('package'); }
      if (checked('publish')) select('package');
    }
    function compactProductionStatus(book) {
      const p = book.production || {};
      return ['摘' + formatPercent(p.summary?.ratio), '图' + formatPercent(p.kg?.ratio), '向' + formatPercent(p.embedding?.ratio), '音' + formatPercent(p.audio?.ratio), p.packagePublished ? '已发布' : '未发布'].join(' · ');
    }
    function formatPercent(ratio) { return Math.round((Number(ratio) || 0) * 100) + '%'; }
    function renderBookProduction() {
      const root = document.getElementById('bookProduction');
      const mainDb = document.getElementById('builderMode').value === 'main-db';
      const book = state.builderBooks.find(item => item.id === document.getElementById('builderBook').value);
      root.hidden = !mainDb || !book;
      if (!book) return;
      const p = book.production || {};
      const rows = [['摘要', p.summary], ['知识图谱', p.kg], ['向量', p.embedding], ['音频', p.audio]];
      root.innerHTML = '<strong>' + escapeHtml(book.title) + '</strong><div class="meta mono">' + escapeHtml(book.id) + '</div><div class="meta">主库正文 ' + book.chapterCount + ' 章 · ' + Number(book.wordCount || 0).toLocaleString() + ' 字</div>' + rows.map(([label, value]) => '<div class="progress-row"><span>' + label + '</span><div class="progress-track"><div class="progress-fill" style="width:' + formatPercent(value?.ratio) + '"></div></div><span>' + (value?.completed || 0) + '/' + (value?.total || book.chapterCount) + '</span></div>').join('') + '<div class="meta">内容包：' + (p.packagePublished ? '已发布到 Gateway' : '尚未发布') + '</div>';
    }
    function buildTemplateFromForm() {
      const mode = document.getElementById('builderMode').value;
      const stages = [...document.querySelectorAll('#builderStages input:checked')].map(input => input.value);
      const file = document.getElementById('builderSource').value;
      const extension = (file.split('.').pop() || 'txt').toLowerCase();
      const template = {
        title: document.getElementById('builderTitle').value.trim() || document.getElementById('templateName').value.trim(),
        source: mode === 'upload' ? { type: extension, file } : { type: 'main-db' },
        stages,
      };
      if (mode === 'main-db') template.bookId = document.getElementById('builderBook').value;
      if (stages.some(stage => ['summary','summary-locate','kg','audio'].includes(stage))) {
        const selected = state.modelProfiles.find(item => item.id === document.getElementById('llmProfile').value);
        const fallback = state.modelProfiles.find(item => item.fallback && item.id !== selected?.id);
        template.llm = { provider: 'openai-compatible', baseUrl: document.getElementById('llmBaseUrl').value.trim(), model: document.getElementById('llmModel').value.trim(), concurrency: Number(document.getElementById('llmConcurrency').value) || 8, apiKeyEnv: selected?.apiKeyEnv || 'LLM_API_KEY', ...(selected ? { profileId: selected.id } : {}), ...(fallback ? { fallback: { profileId: fallback.id, baseUrl: fallback.baseUrl, model: fallback.model, apiKeyEnv: fallback.apiKeyEnv } } : {}), scheduler: { borrowIdle: true, weights: { summary: 4, kg: 2, audio: 4 } } };
      }
      if (stages.includes('embedding')) template.embedding = { provider: 'openai-compatible', baseUrl: document.getElementById('embeddingBaseUrl').value.trim(), model: document.getElementById('embeddingModel').value.trim(), concurrency: Number(document.getElementById('embeddingConcurrency').value) || 16, apiKeyEnv: 'EMBEDDING_API_KEY' };
      if (stages.includes('audio')) template.audio = { workflowDag: true, ttsConfig: document.getElementById('ttsConfig').value.trim(), llmChapters: Number(document.getElementById('llmChapters').value) || 1, ttsConcurrency: Number(document.getElementById('ttsConcurrency').value) || 16, ttsChapters: Number(document.getElementById('ttsChapters').value) || 1, resume: true, strict: true };
      if (stages.some(stage => ['publish','verify'].includes(stage))) template.gateway = { host: document.getElementById('gatewayHost').value.trim(), user: document.getElementById('gatewayUser').value.trim(), root: document.getElementById('gatewayRoot').value.trim(), url: document.getElementById('gatewayUrl').value.trim(), tokenEnv: document.getElementById('gatewayTokenEnv').value.trim() };
      if (stages.includes('publish')) template.publish = { dryRun: false };
      if (stages.includes('verify')) template.verify = { audioSamples: Number(document.getElementById('audioSamples').value) || 3 };
      template.costEstimation = { summaryPerChapter: Number(document.getElementById('costSummary').value) || 0, kgPerChapter: Number(document.getElementById('costKg').value) || 0, audioPerChapter: Number(document.getElementById('costAudio').value) || 0 };
      return template;
    }
    function generateTemplate() {
      const template = buildTemplateFromForm();
      document.getElementById('templateJson').value = JSON.stringify(template, null, 2);
      localStorage.setItem('productionPipeline.templateJson', document.getElementById('templateJson').value);
      showBuilderFeedback('success', 'JSON 已生成。检查后可“保存为模板”，或点击“确认并启动”完成校验并启动。');
      return template;
    }
    function generateAutomaticTemplateName(template) {
      const base = (template.title || '生产任务').split('/').join(' ').split(String.fromCharCode(92)).join(' ').trim().slice(0, 80) || '生产任务';
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      return base + '-' + stamp;
    }
    async function uploadSource() {
      const file = document.getElementById('sourceFile').files[0];
      if (!file) throw new Error('请先选择源文件');
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/sources', { method: 'POST', headers: authHeaders(), body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || response.statusText);
      await loadManagedAssets();
    }
    async function saveTemplate(options = {}) {
      const name = document.getElementById('templateName').value.trim() || options.name || '';
      if (!name) throw new Error('请填写模板名称。');
      showBuilderFeedback('info', '正在校验配置…');
      const template = generateTemplate();
      showBuilderFeedback('info', '配置已生成，正在执行服务端校验…');
      const validation = await api('/api/templates/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
      if (!validation.valid) throw new Error(validation.errors.join('；'));
      const saved = await api('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, template }) });
      showBuilderFeedback('success', (options.generatedName ? '已自动生成后台模板“' : '模板“') + name + '”已保存。' + (validation.warnings.length ? ' 提示：' + validation.warnings.join('；') : ' 配置校验通过。'));
      await loadManagedAssets();
      return { name: saved.template.name, template, validation };
    }
    async function createBackup() {
      await api('/api/backups', { method: 'POST' });
      await loadManagedAssets();
    }
    async function downloadBackup(encodedName) {
      const response = await fetch('/api/backups/' + encodedName + '/download', { headers: authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = decodeURIComponent(encodedName);
      link.click();
      URL.revokeObjectURL(url);
    }
    function formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
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
      const technicalDetailsOpen = document.querySelector('details.technical')?.open === true;
      const runtimeInputIds = ['runtimeKgConcurrency', 'runtimeDirectorConcurrency', 'runtimeLlmChapters', 'runtimeTtsConcurrency', 'runtimeTtsChapters'];
      const runtimeDraft = Object.fromEntries(runtimeInputIds.map(id => [id, document.getElementById(id)?.value]).filter(([, value]) => value !== undefined));
      const focusedRuntimeInput = runtimeInputIds.includes(document.activeElement?.id) ? document.activeElement.id : '';
      const productionRun = renderProductionRun(job.id, body.productionRun);
      const logItems = (job.logs || []).filter(item => state.logFilter === 'all' || (state.logFilter === 'errors' ? item.stream === 'stderr' || /fail|error|失败/i.test(item.line) : item.stream === 'system' || /start|completed|failed|停止|完成|失败/i.test(item.line)));
      const logs = logItems.map(item => '[' + formatLocalTime(item.at) + '] ' + item.stream + ': ' + localizeLogTimestamps(item.line)).join('\\n');
      document.getElementById('detail').className = '';
      const jobButton = '<div class="actions">' + (isActiveJob(job) ? '<button class="secondary" id="stopSelectedJob" type="button">暂停生产</button>' : canRetryJob(job) ? '<button class="secondary" id="retrySelectedJob" type="button">' + (job.status === 'failed' ? '重试失败项' : '继续生产') + '</button>' : '') + (canDeleteJob(job) ? '<button class="danger" id="deleteSelectedJob" type="button">删除任务</button>' : '') + '</div>';
      const activeError = job.error && !isActiveJob(job) ? '<div class="error-panel">' + escapeHtml(job.error) + '</div>' : '';
      const recoveryInfo = job.recoveryNote && isActiveJob(job) ? '<div class="inline-feedback info">' + escapeHtml(job.recoveryNote) + '</div>' : '';
      document.getElementById('detail').innerHTML = '<div class="panel"><div class="topline"><div><h1>' + escapeHtml(job.title) + '</h1><div class="meta">' + job.id + '</div></div><span class="status ' + job.status + '">' + escapeHtml(statusLabel(job.status)) + '</span></div><div class="meta">' + escapeHtml(job.productionJobPath || '') + '</div>' + activeError + recoveryInfo + jobButton + '</div>' + productionRun + '<div class="panel"><div class="topline"><h2>任务事件</h2><select id="jobLogFilter" style="width:auto"><option value="key">关键事件</option><option value="errors">仅错误</option><option value="all">全部</option></select></div><pre id="jobLog">' + escapeHtml(logs || '当前筛选下暂无日志') + '</pre></div>';
      if (technicalDetailsOpen && document.querySelector('details.technical')) document.querySelector('details.technical').open = true;
      for (const [id, value] of Object.entries(runtimeDraft)) if (document.getElementById(id)) document.getElementById(id).value = value;
      if (focusedRuntimeInput && document.getElementById(focusedRuntimeInput)) document.getElementById(focusedRuntimeInput).focus();
      document.getElementById('jobLogFilter').value = state.logFilter;
      document.getElementById('jobLogFilter').addEventListener('change', event => { state.logFilter = event.target.value; renderJob(body); });
      const stopSelectedJob = document.getElementById('stopSelectedJob');
      if (stopSelectedJob) stopSelectedJob.addEventListener('click', () => stopJob(job.id).catch(error => showError('停止任务失败', error)));
      const retrySelectedJob = document.getElementById('retrySelectedJob');
      if (retrySelectedJob) retrySelectedJob.addEventListener('click', () => retryJob(job.id).catch(error => showError('重新排队失败', error)));
      const deleteSelectedJob = document.getElementById('deleteSelectedJob');
      if (deleteSelectedJob) deleteSelectedJob.addEventListener('click', () => deleteJob(job.id, job.title).catch(error => showError('删除任务失败', error)));
      document.querySelectorAll('.runtime-concurrency-save').forEach(button => button.addEventListener('click', () => updateRuntimeConcurrencyFromConsole(button).catch(error => showError('调整并发失败', error))));
      const nextLog = document.getElementById('jobLog');
      if (nextLog && shouldStickToBottom) nextLog.scrollTop = nextLog.scrollHeight;
      await loadJobs();
    }
    function isActiveJob(job) {
      return job && !job.readOnly && (job.status === 'queued' || job.status === 'running' || job.status === 'stopping');
    }
    function canRetryJob(job) {
      return job && !job.readOnly && (job.status === 'failed' || job.status === 'stopped');
    }
    function canDeleteJob(job) {
      return job && !job.readOnly && !isActiveJob(job);
    }
    function statusLabel(status) {
      return ({ pending: '等待依赖', queued: '等待中', running: '运行中', stopping: '暂停中', stopped: '已暂停', completed: '已完成', failed: '失败' })[status] || status || '未知';
    }
    async function stopJob(jobId) {
      await api('/api/jobs/' + encodeURIComponent(jobId) + '/stop', { method: 'POST' });
      await selectJob(jobId);
    }
    async function deleteJob(jobId, title) {
      if (!window.confirm('彻底删除任务“' + title + '”？\\n\\n将删除任务记录、该书主库数据、全部运行目录，以及 Gateway 上已发布的内容和音频。此操作不可撤销。')) return;
      await api('/api/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
      if (state.selectedJobId === jobId) {
        state.selectedJobId = '';
        if (state.eventSource) state.eventSource.close();
        document.getElementById('detail').className = 'empty';
        document.getElementById('detail').textContent = '任务及对应生产产物已彻底删除。';
      }
      await loadJobs();
    }
    async function retryJob(jobId) {
      await api('/api/jobs/' + encodeURIComponent(jobId) + '/retry', { method: 'POST' });
      await selectJob(jobId);
    }
    async function updateRuntimeConcurrencyFromConsole(button) {
      const jobId = button.dataset.jobId;
      const kind = button.dataset.kind;
      const numberValue = id => Number(document.getElementById(id).value);
      const body = kind === 'kg'
        ? { kg: { concurrency: numberValue('runtimeKgConcurrency') } }
        : { audio: {
            directorConcurrency: numberValue('runtimeDirectorConcurrency'),
            llmChapters: numberValue('runtimeLlmChapters'),
            ttsConcurrency: numberValue('runtimeTtsConcurrency'),
            ttsChapters: numberValue('runtimeTtsChapters'),
          } };
      button.disabled = true;
      try {
        await api('/api/jobs/' + encodeURIComponent(jobId) + '/runtime-concurrency', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        await selectJob(jobId);
      } finally {
        button.disabled = false;
      }
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
      const overallProgress = renderOverallProgress(productionRun.metrics && productionRun.metrics.progress);
      const concurrency = renderRuntimeConcurrency(jobId, productionRun.metrics && productionRun.metrics.concurrency);
      const dag = renderProductionDag(jobId, run, productionRun.metrics);
      return '<div class="panel"><div class="topline"><div><h2>生产进度</h2></div><span class="status ' + escapeHtml(run.status || 'pending') + '">' + escapeHtml(statusLabel(run.status || 'pending')) + '</span></div>' + overallProgress + dag + concurrency + metrics + '<details class="technical"><summary>技术详情</summary><div class="meta mono">' + runJsonLink + '</div>' + (stageCards ? '<div class="stages">' + stageCards + '</div>' : '<div class="meta">等待任务启动。</div>') + '</details></div>';
    }
    function renderProductionDag(jobId, run, metrics) {
      const configured = run.job && Array.isArray(run.job.stages) ? run.job.stages : [];
      const audioDagStages = ['directorDraft', 'directorQc', 'ttsSegments', 'audioQc', 'audioAssemble'];
      const audioDag = audioDagStages.some(stage => Boolean(run.stages?.[stage]));
      const includes = stage => configured.includes(stage) || (stage === 'chunkEmbedding' || stage === 'summaryEmbedding') && configured.includes('embedding') || audioDag && ['directorDraft','directorQc','ttsSegments','audioQc','audioAssemble'].includes(stage);
      const labels = { import: '导入正文', summary: '章节摘要', 'summary-locate': '摘要定位', kg: '知识图谱', chunkEmbedding: '正文向量', summaryEmbedding: '摘要向量', directorDraft: '导演脚本生成', directorQc: '导演脚本质检', ttsSegments: 'TTS 片段合成', audioQc: '音频片段质检', audioAssemble: '章节拼接编码', audio: '音频目录聚合', package: '打包', publish: '发布', verify: '验证' };
      const renderNode = stage => {
        const recordedStatus = run.stages?.[stage]?.status || 'pending';
        const latest = metrics?.stages?.[stage]?.latest;
        const completed = Math.max(0, Number(latest?.completed ?? latest?.done) || 0);
        const total = Math.max(0, Number(latest?.total) || 0);
        const percent = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : 0;
        const pipelinedAudioStage = ['directorQc', 'ttsSegments', 'audioQc', 'audioAssemble'].includes(stage) && run.stages?.directorDraft?.status === 'running';
        const status = recordedStatus === 'pending' && pipelinedAudioStage && completed > 0 ? (total > 0 && completed >= total ? 'completed' : 'running') : recordedStatus;
        const progressKey = jobId + ':' + stage;
        const previous = state.dagProgress[progressKey];
        const changed = status === 'running' && previous !== undefined && completed > previous;
        state.dagProgress[progressKey] = completed;
        const progress = status === 'running' && total > 0 ? '<div class="dag-node-progress"><div class="dag-node-progress-label"><span>' + escapeHtml(String(completed)) + '/' + escapeHtml(String(total)) + '</span><span>' + escapeHtml(String(percent)) + '%</span></div><div class="progress-track"><div class="progress-fill" style="width:' + escapeHtml(String(percent)) + '%"></div></div></div>' : '';
        return '<div class="dag-node ' + escapeHtml(status) + (changed ? ' progress-updated' : '') + '"><strong>' + escapeHtml(labels[stage] || stage) + '</strong><div class="meta">' + escapeHtml(statusLabel(status)) + '</div>' + progress + '</div>';
      };
      const arrow = '<div class="dag-arrow">→</div>';
      const summaryTail = ['summary-locate', 'summaryEmbedding'].filter(includes);
      const lanes = [];
      if (includes('summary') || summaryTail.length) lanes.push('<div class="dag-lane"><span class="dag-lane-label">摘要分支</span>' + (includes('summary') ? renderNode('summary') : '') + (summaryTail.length ? arrow + '<div class="dag-lane-group">' + summaryTail.map(renderNode).join('') + '</div>' : '') + '</div>');
      if (includes('kg')) lanes.push('<div class="dag-lane"><span class="dag-lane-label">KG 分支</span>' + renderNode('kg') + '</div>');
      if (includes('chunkEmbedding')) lanes.push('<div class="dag-lane"><span class="dag-lane-label">向量分支</span>' + renderNode('chunkEmbedding') + '</div>');
      const audioStages = (audioDag ? ['directorDraft','directorQc','ttsSegments','audioQc','audioAssemble','audio'] : ['audio']).filter(includes);
      const kgLeadChapters = Math.max(1, Number(run.job?.audio?.kgWarmupChapters ?? run.job?.audio?.kg_warmup_chapters) || 2);
      const audioDependency = audioDag && includes('kg') ? '<span class="dag-stream-dependency"><strong>KG</strong><span>有序领先 ' + escapeHtml(String(kgLeadChapters)) + ' 章</span><span>→</span></span>' : '';
      if (audioStages.length) lanes.push('<div class="dag-lane"><span class="dag-lane-label">音频分支</span>' + audioDependency + audioStages.map((stage, index) => (index ? arrow : '') + renderNode(stage)).join('') + '</div>');
      const tail = ['package', 'publish', 'verify'].filter(includes);
      const graph = (includes('import') ? renderNode('import') + (lanes.length || tail.length ? arrow : '') : '')
        + (lanes.length ? '<div class="dag-branches">' + lanes.join('') + '</div>' : '')
        + (tail.length && lanes.length ? arrow : '')
        + tail.map((stage, index) => (index ? arrow : '') + renderNode(stage)).join('');
      if (!graph) return '';
      return '<h2>执行 DAG</h2><div class="dag-flow"><div class="dag-graph">' + graph + '</div></div>';
    }
    function renderOverallProgress(progress) {
      if (!progress) return '';
      const eta = Number.isFinite(Number(progress.etaMinutes)) ? formatMinutes(progress.etaMinutes) + ' 分钟' : '计算中';
      const cost = Number(progress.estimatedTotalCost) > 0 ? ' · 估算费用 ¥' + Number(progress.estimatedSpentCost || 0).toFixed(2) + '/¥' + Number(progress.estimatedTotalCost).toFixed(2) : '';
      return '<div class="overall-progress"><div class="topline"><strong>整体完成 ' + escapeHtml(String(progress.percent || 0)) + '%</strong><span class="meta">预计剩余 ' + escapeHtml(eta) + '</span></div><div class="progress-track"><div class="progress-fill" style="width:' + escapeHtml(String(progress.percent || 0)) + '%"></div></div><div class="meta">关键路径：' + escapeHtml(progress.criticalStage || '等待阶段数据') + ' · 已完成阶段 ' + escapeHtml(String(progress.completedStages || 0)) + '/' + escapeHtml(String(progress.totalStages || 0)) + escapeHtml(cost) + '</div></div>';
    }
    function renderRuntimeConcurrency(jobId, concurrency) {
      if (!concurrency || (!concurrency.llmPool && !concurrency.embedding && !concurrency.kg && !concurrency.audio)) return '';
      const cards = [];
      if (concurrency.llmPool) {
        const pool = concurrency.llmPool;
        const stageLabels = { summary: '摘要', 'summary-locate': '摘要定位', kg: 'KG', audio: '音频导演', directorDraft: '导演脚本' };
        const allocationChips = (pool.allocations || []).map(item => '<span class="chip">' + escapeHtml(stageLabels[item.stage] || item.stage) + ' ' + escapeHtml(formatConcurrencyValue(item.concurrency)) + '</span>').join('');
        cards.push('<div class="concurrency-card"><strong>LLM 共享并发池</strong><div class="chips"><span class="chip">总量 ' + escapeHtml(formatConcurrencyValue(pool.total)) + '</span><span class="chip">已分配 ' + escapeHtml(formatConcurrencyValue(pool.used)) + '</span><span class="chip">空闲 ' + escapeHtml(formatConcurrencyValue(pool.available)) + '</span></div><div class="meta">阶段分配</div><div class="chips">' + (allocationChips || '<span class="chip">暂无 LLM 阶段</span>') + '</div></div>');
      }
      if (concurrency.embedding) {
        const embedding = concurrency.embedding;
        const labels = { chunkEmbedding: '正文向量', summaryEmbedding: '摘要向量' };
        cards.push('<div class="concurrency-card"><strong>向量服务并发</strong><div class="chips"><span class="chip">请求并发 ' + escapeHtml(formatConcurrencyValue(embedding.concurrency)) + '</span>' + (embedding.stages || []).map(stage => '<span class="chip">' + escapeHtml(labels[stage] || stage) + '运行中</span>').join('') + '</div></div>');
      }
      if (concurrency.kg) {
        const kg = concurrency.kg;
        cards.push('<div class="concurrency-card"><strong>KG 当前并发</strong><div class="chips"><span class="chip">当前 ' + escapeHtml(formatConcurrencyValue(kg.concurrency)) + '</span><span class="chip">' + (kg.active ? '运行中' : '未运行') + '</span></div>' + (kg.active ? '<label>请求并发 <input id="runtimeKgConcurrency" type="number" min="1" max="64" value="' + escapeHtml(formatConcurrencyValue(kg.concurrency)) + '" /></label><button class="secondary runtime-concurrency-save" data-kind="kg" data-job-id="' + escapeHtml(jobId) + '" type="button">应用 KG 并发</button>' : '') + renderControlTime(kg.updatedAt, kg.active) + '</div>');
      }
      if (concurrency.audio) {
        const audio = concurrency.audio;
        const editor = audio.active ? '<div class="stage-options"><label>导演 LLM<input id="runtimeDirectorConcurrency" type="number" min="1" max="64" value="' + escapeHtml(formatConcurrencyValue(audio.directorConcurrency)) + '" /></label><label>LLM 章节<input id="runtimeLlmChapters" type="number" min="1" max="16" value="' + escapeHtml(formatConcurrencyValue(audio.llmChapters)) + '" /></label><label>TTS API<input id="runtimeTtsConcurrency" type="number" min="1" max="128" value="' + escapeHtml(formatConcurrencyValue(audio.ttsConcurrency)) + '" /></label><label>TTS 章节<input id="runtimeTtsChapters" type="number" min="1" max="16" value="' + escapeHtml(formatConcurrencyValue(audio.ttsChapters)) + '" /></label></div><button class="secondary runtime-concurrency-save" data-kind="audio" data-job-id="' + escapeHtml(jobId) + '" type="button">应用 Audio 并发</button><div class="meta">新数值会在运行器下一次轮询时生效，无需暂停任务。</div>' : '';
        cards.push('<div class="concurrency-card"><strong>Audio 当前并发</strong><div class="chips"><span class="chip">导演 LLM ' + escapeHtml(formatConcurrencyValue(audio.directorConcurrency)) + '</span><span class="chip">LLM 章节 ' + escapeHtml(formatConcurrencyValue(audio.llmChapters)) + '</span><span class="chip">TTS API ' + escapeHtml(formatConcurrencyValue(audio.ttsConcurrency)) + '</span><span class="chip">TTS 章节 ' + escapeHtml(formatConcurrencyValue(audio.ttsChapters)) + '</span><span class="chip">' + (audio.active ? '运行中' : '未运行') + '</span></div>' + editor + renderControlTime(audio.updatedAt, audio.active) + '</div>');
      }
      return '<h2>当前并发</h2><div class="concurrency">' + cards.join('') + '</div>';
    }
    function renderUpdatedAt(value) {
      return value ? '<div class="meta">更新于 ' + escapeHtml(formatLocalTime(value)) + '</div>' : '';
    }
    function renderControlTime(value, active) {
      return value ? '<div class="meta">' + (active ? '当前控制更新时间：' : '最后控制记录：') + escapeHtml(formatLocalTime(value)) + '</div>' : '';
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
      const stageLabels = { summary: '章节摘要', chunkEmbedding: '正文向量覆盖', kg: '知识图谱覆盖', 'summary-locate': '摘要定位覆盖', summaryEmbedding: '摘要向量覆盖', directorDraft: '导演脚本', directorQc: '导演脚本质检', ttsSegments: 'TTS 片段合成', audioQc: '音频片段质检', audioAssemble: '章节拼接编码', audio: '章节音频' };
      const bookChapterTotal = Math.max(0, ...Object.values(metrics.stages).map(metric => Number(metric?.latest?.total) || 0));
      const cards = Object.entries(metrics.stages).map(([name, metric]) => {
        const latest = metric.latest || {};
        const unit = metric.unit || '项';
        const total = Number(latest.total) > 0 ? '/' + latest.total : '';
        const percent = Number(latest.total) > 0 ? ' · ' + Math.min(100, Math.round((Number(latest.completed || 0) / Number(latest.total)) * 100)) + '%' : '';
        const rows = windows.map(windowInfo => {
          const rate = metric.rates && metric.rates[windowInfo.key];
          const value = rate ? formatRate(rate.perMinute) + ' ' + unit + '/分钟' : '暂无';
          const detail = rate ? '<div class="meta">' + escapeHtml(rate.produced + ' ' + unit + ' / ' + formatMinutes(rate.minutes) + ' 分钟') + '</div>' : '';
          return '<div class="metric-row"><span class="meta">' + escapeHtml(windowInfo.label) + '</span><span class="metric-value">' + escapeHtml(value) + '</span></div>' + detail;
        }).join('');
        return '<div class="metric"><strong>' + escapeHtml(stageLabels[name] || name) + '</strong><div class="meta">覆盖章节 ' + escapeHtml(String(latest.completed ?? latest.done ?? 0)) + escapeHtml(total) + escapeHtml(percent) + (latest.failed ? '，失败 ' + escapeHtml(String(latest.failed)) : '') + '</div>' + rows + '</div>';
      }).join('');
      return '<div class="topline"><h2>各工序章节覆盖</h2>' + (bookChapterTotal ? '<span class="chip">本书共 ' + escapeHtml(String(bookChapterTotal)) + ' 章</span>' : '') + '</div><div class="meta">卡片统一按主库章节统计；下方速度只表示最近处理速率。</div><div class="metrics">' + cards + '</div><div class="meta">统计时间：' + escapeHtml(formatLocalTime(metrics.generatedAt)) + '</div>';
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
    document.getElementById('jobSearch').addEventListener('input', loadJobs);
    document.getElementById('jobStatusFilter').addEventListener('change', loadJobs);
    document.getElementById('saveToken').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await saveConsoleToken(); } catch (error) { document.getElementById('tokenFeedback').textContent = '保存失败：' + (error.message || String(error)); } finally { button.disabled = false; }
    });
    document.getElementById('clearToken').addEventListener('click', clearConsoleToken);
    document.querySelectorAll('.save-runtime-credentials').forEach(button => button.addEventListener('click', () => saveRuntimeCredentials(button.dataset.source, button).catch(error => {
      document.getElementById((button.dataset.source === 'settings' ? 'settings' : 'builder') + 'CredentialFeedback').textContent = '保存失败：' + (error.message || String(error));
    })));
    document.getElementById('enableNotifications').addEventListener('click', async () => {
      const root = document.getElementById('notificationStatus');
      if (typeof Notification === 'undefined') { root.textContent = '当前浏览器不支持通知。'; return; }
      const permission = await Notification.requestPermission();
      root.textContent = permission === 'granted' ? '浏览器通知已启用。' : '未获得通知权限。';
    });
    document.getElementById('uploadSource').addEventListener('click', () => uploadSource().catch(error => showError('上传源文件失败', error)));
    document.getElementById('generateTemplate').addEventListener('click', () => {
      try { generateTemplate(); } catch (error) { showError('生成模板失败', error); }
    });
    document.getElementById('saveTemplate').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await saveTemplate(); } catch (error) { showBuilderFeedback('error', '保存失败：' + (error.message || String(error))); } finally { button.disabled = false; }
    });
    document.getElementById('builderMode').addEventListener('change', event => {
      const mainDb = event.target.value === 'main-db';
      document.getElementById('builderSourceRow').hidden = mainDb;
      document.getElementById('builderBookRow').hidden = !mainDb;
      enforceStageDependencies();
      renderBookProduction();
    });
    document.getElementById('builderTemplateMode').addEventListener('change', event => {
      localStorage.setItem('productionPipeline.builderTemplateMode', event.target.value);
      applyBuilderTemplateSource().catch(error => showBuilderFeedback('error', '加载模板来源失败：' + (error.message || String(error))));
    });
    document.getElementById('builderTemplateSource').addEventListener('change', event => {
      localStorage.setItem('productionPipeline.builderTemplateSource', event.target.value);
      applyBuilderTemplateSource().catch(error => showBuilderFeedback('error', '加载模板来源失败：' + (error.message || String(error))));
    });
    document.getElementById('builderBook').addEventListener('change', renderBookProduction);
    document.getElementById('llmProfile').addEventListener('change', selectModelProfile);
    document.getElementById('addModelProfile').addEventListener('click', () => {
      const next = state.modelProfiles.length + 1;
      state.modelProfiles.push({ id: 'llm' + next, label: 'LLM ' + next, baseUrl: '', model: '', apiKeyEnv: '', fallback: false });
      renderModelProfiles();
    });
    document.getElementById('saveModelProfiles').addEventListener('click', () => saveModelProfiles().catch(error => { document.getElementById('modelProfileFeedback').textContent = '保存失败：' + (error.message || String(error)); }));
    function updateDirectorConcurrency() {
      const total = Math.max(1, Number(document.getElementById('llmConcurrency').value) || 8);
      const chapters = Math.max(1, Number(document.getElementById('llmChapters').value) || 1);
      document.getElementById('directorConcurrency').value = Math.max(1, Math.ceil(total / chapters));
    }
    document.getElementById('llmConcurrency').addEventListener('input', updateDirectorConcurrency);
    document.getElementById('llmChapters').addEventListener('input', updateDirectorConcurrency);
    updateDirectorConcurrency();
    document.querySelectorAll('[data-wizard-step]').forEach(button => button.addEventListener('click', () => showWizardStep(button.dataset.wizardStep)));
    document.getElementById('wizardBack').addEventListener('click', () => showWizardStep(state.wizardStep - 1));
    document.getElementById('wizardNext').addEventListener('click', () => showWizardStep(state.wizardStep + 1));
    const resourcePresets = {
      stable: { llm: 4, embedding: 8, directorChapters: 1, tts: 8, ttsChapters: 1 },
      balanced: { llm: 8, embedding: 16, directorChapters: 1, tts: 16, ttsChapters: 1 },
      fast: { llm: 16, embedding: 32, directorChapters: 2, tts: 30, ttsChapters: 2 },
    };
    document.querySelectorAll('.resource-preset').forEach(button => button.addEventListener('click', () => {
      const preset = resourcePresets[button.dataset.preset];
      document.getElementById('llmConcurrency').value = preset.llm;
      document.getElementById('embeddingConcurrency').value = preset.embedding;
      document.getElementById('llmChapters').value = preset.directorChapters;
      document.getElementById('ttsConcurrency').value = preset.tts;
      document.getElementById('ttsChapters').value = preset.ttsChapters;
      updateDirectorConcurrency();
    }));
    document.getElementById('saveAndStart').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const template = generateTemplate();
        const validation = await api('/api/templates/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
        if (!validation.valid) throw new Error(validation.errors.join('；'));
        const stageNames = template.stages.join('、');
        if (!window.confirm('确认启动“' + template.title + '”？\\n\\n阶段：' + stageNames + '\\nLLM/TTS 阶段可能产生费用，发布阶段会写入 Gateway。')) return;
        const explicitName = document.getElementById('templateName').value.trim();
        const generatedName = !explicitName && canAutonameTemplateForStart();
        const result = await saveTemplate({ name: generatedName ? generateAutomaticTemplateName(template) : '', generatedName });
        const body = await api('/api/templates/' + encodeURIComponent(result.name) + '/start', { method: 'POST' });
        setConsoleView('tasks');
        await loadJobs();
        await selectJob(body.job.id);
      } catch (error) { showBuilderFeedback('error', '启动失败：' + (error.message || String(error))); } finally { button.disabled = false; }
    });
    document.getElementById('createBackup').addEventListener('click', () => createBackup().catch(error => showError('创建备份失败', error)));
    document.getElementById('chooseJob').addEventListener('click', () => document.getElementById('localJobFile').click());
    document.getElementById('localJobFile').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      const feedback = document.getElementById('jobPickerFeedback');
      feedback.textContent = '正在读取并校验本机 JSON…';
      try {
        const template = JSON.parse(await file.text());
        const validation = await api('/api/templates/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
        if (!validation.valid) throw new Error(validation.errors.join('；'));
        const name = file.name.replace(/\.json$/i, '') || 'uploaded-job';
        await api('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, template }) });
        document.getElementById('templateName').value = name;
        document.getElementById('templateJson').value = JSON.stringify(template, null, 2);
        await loadManagedAssets();
        const path = '/app/jobs/' + (name.endsWith('.json') ? name : name + '.json');
        document.getElementById('jobPath').value = path;
        localStorage.setItem('productionPipeline.jobPath', path);
        feedback.textContent = '本机 JSON 已上传并选中：' + file.name;
      } catch (error) {
        feedback.textContent = '本机 JSON 处理失败：' + (error.message || String(error));
      } finally {
        event.target.value = '';
      }
    });
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function formatLocalTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(date).replaceAll('/', '-') + ' UTC+8';
    }
    function localizeLogTimestamps(value) {
      return String(value || '').replace(/\\[([^\\]]+)\\]/g, (match, timestamp) => {
        const date = new Date(timestamp);
        return Number.isFinite(date.getTime()) ? '[' + formatLocalTime(timestamp) + ']' : match;
      });
    }
    setConsoleView(state.currentView);
    loadJobs().catch(error => { document.getElementById('jobs').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>'; });
    loadManagedAssets().catch(error => showError('加载生产资源失败', error));
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
      <div class="meta">${escapeHtmlText(path)} · 北京时间 UTC+8 · 每 5 秒自动刷新 · <span id="status">等待刷新</span></div>
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
        log.textContent = localizeLogTimestamps(text) || '暂无日志';
        status.textContent = '已刷新 ' + formatLocalTime(new Date());
        if (shouldStickToBottom) log.scrollTop = log.scrollHeight;
      } catch (error) {
        status.textContent = '刷新失败：' + error.message;
      }
    }
    function formatLocalTime(value) {
      const date = new Date(value);
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date) + ' UTC+8';
    }
    function localizeLogTimestamps(value) {
      return String(value || '').replace(/\\[([^\\]]+)\\]/g, (match, timestamp) => {
        const date = new Date(timestamp);
        if (!Number.isFinite(date.getTime())) return match;
        return '[' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date).replaceAll('/', '-') + ' UTC+8]';
      });
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

async function readJobRunSummary(job) {
  if (!job) return null
  let runJsonPath = ''
  if (job.productionRunDir) runJsonPath = resolve(job.productionRunDir, 'run.json')
  else if (job.productionBookId && job.productionRunRoot) {
    const bookRunRoot = resolve(job.productionRunRoot, job.productionBookId)
    try {
      const entries = await readdir(bookRunRoot, { withFileTypes: true })
      const latest = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1)
      if (latest) runJsonPath = resolve(bookRunRoot, latest, 'run.json')
    } catch { return null }
  }
  if (!runJsonPath) return null
  const runJson = await readJsonIfExists(runJsonPath).catch(() => null)
  if (!runJson) return null
  const configured = Array.isArray(runJson.job?.stages) ? runJson.job.stages : []
  const expected = expandExpectedProductionStages(configured, runJson.job)
  return {
    completedStages: expected.filter((stage) => runJson.stages?.[stage]?.status === 'completed').length,
    totalStages: expected.length,
    runningStages: expected.filter((stage) => runJson.stages?.[stage]?.status === 'running'),
  }
}

function expandExpectedProductionStages(configured, job = {}) {
  const workflowDag = Boolean(job.audio?.workflowDag || job.audio?.workflow_dag)
  return configured.flatMap((stage) => {
    if (stage === 'embedding') return ['chunkEmbedding', 'summaryEmbedding']
    if (stage === 'audio' && workflowDag) return ['directorDraft', 'directorQc', 'ttsSegments', 'audioQc', 'audioAssemble', 'audio']
    return [stage]
  })
}

async function syncProductionRunStatus(job, status, finishedAt = new Date().toISOString()) {
  const productionRun = await readProductionRunState(job)
  if (!productionRun?.runJsonPath || !productionRun.runJson) return
  const runJson = productionRun.runJson
  const stages = Object.fromEntries(Object.entries(runJson.stages || {}).map(([name, stage]) => [
    name,
    stage?.status === 'running' ? { ...stage, status, finishedAt } : stage,
  ]))
  await writeJsonAtomic(productionRun.runJsonPath, {
    ...runJson,
    status,
    updatedAt: finishedAt,
    finishedAt,
    stages,
  })
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
  const audioTotal = readProductionAudioTotal(runJson)
  const audioMetric = await readAudioMetricFromArtifacts(runDir, audioTotal).catch(() => null)
  if (audioMetric) stageMetrics.audio = {
    ...(stageMetrics.audio || {}),
    ...audioMetric,
  }
  if (runJson.job?.audio?.workflowDag || runJson.job?.audio?.workflow_dag) {
    Object.assign(stageMetrics, await readAudioWorkflowMetrics(runDir, audioTotal).catch(() => ({})))
    if (!stageMetrics.audio) stageMetrics.audio = {
      unit: '章',
      latest: { at: generatedAt, completed: 0, done: 0, failed: 0, total: audioTotal },
      rates: {},
    }
  }
  const coverage = readProductionChapterCoverage(runJson)
  for (const [stageName, value] of Object.entries(coverage)) {
    if (!stageMetrics[stageName]) stageMetrics[stageName] = { unit: '章', rates: {} }
    stageMetrics[stageName].unit = '章'
    stageMetrics[stageName].latest = {
      ...(stageMetrics[stageName].latest || {}),
      at: generatedAt,
      completed: value.completed,
      done: value.completed,
      failed: 0,
      total: value.total,
    }
  }
  return {
    generatedAt,
    windows: [
      { key: '5m', label: '近 5 分钟' },
      { key: '15m', label: '近 15 分钟' },
      { key: 'overall', label: '全程平均' },
    ],
    concurrency: await readRuntimeConcurrency(runDir, runJson),
    progress: buildProductionOverallProgress(runJson, stageMetrics),
    stages: stageMetrics,
  }
}

function buildProductionOverallProgress(runJson, stageMetrics) {
  const configured = Array.isArray(runJson?.job?.stages) ? runJson.job.stages : []
  const expected = expandExpectedProductionStages(configured, runJson.job)
  if (!expected.length) return null
  const chapterTotal = readProductionAudioTotal(runJson)
  const chapterStages = new Set(['summary', 'summary-locate', 'kg', 'chunkEmbedding', 'summaryEmbedding', 'directorDraft', 'directorQc', 'ttsSegments', 'audioQc', 'audioAssemble', 'audio'])
  let totalUnits = 0
  let completedUnits = 0
  let completedStages = 0
  let criticalStage = ''
  let etaMinutes = 0
  let estimatedSpentCost = 0
  let estimatedTotalCost = 0
  const costRates = { summary: Number(runJson.job?.costEstimation?.summaryPerChapter) || 0, kg: Number(runJson.job?.costEstimation?.kgPerChapter) || 0, audio: Number(runJson.job?.costEstimation?.audioPerChapter) || 0 }
  for (const stageName of expected) {
    const stage = runJson.stages?.[stageName]
    const metric = stageMetrics[stageName]
    const stageTotal = chapterStages.has(stageName) ? (Number(metric?.latest?.total) || chapterTotal || 1) : 1
    const stageCompleted = stage?.status === 'completed' ? stageTotal : Math.min(stageTotal, Number(metric?.latest?.completed) || 0)
    totalUnits += stageTotal
    completedUnits += stageCompleted
    if (costRates[stageName]) { estimatedSpentCost += stageCompleted * costRates[stageName]; estimatedTotalCost += stageTotal * costRates[stageName] }
    if (stage?.status === 'completed') completedStages += 1
    const rate = Number(metric?.rates?.['5m']?.perMinute || metric?.rates?.overall?.perMinute) || 0
    const remainingMinutes = rate > 0 ? Math.max(0, stageTotal - stageCompleted) / rate : 0
    if (remainingMinutes > etaMinutes) { etaMinutes = remainingMinutes; criticalStage = stageName }
  }
  return {
    percent: totalUnits > 0 ? Math.min(100, Math.round((completedUnits / totalUnits) * 100)) : 0,
    completedStages,
    totalStages: expected.length,
    etaMinutes: etaMinutes || null,
    criticalStage,
    estimatedSpentCost,
    estimatedTotalCost,
  }
}

async function readRuntimeConcurrency(runDir, runJson = {}) {
  const runtimeDir = resolve(runDir, 'artifacts', 'runtime')
  const [kgControl, audioControl] = await Promise.all([
    readJsonIfExists(resolve(runtimeDir, 'kg-control.json')).catch(() => null),
    readJsonIfExists(resolve(runtimeDir, 'audio-control.json')).catch(() => null),
  ])
  const stages = runJson.stages || {}
  const job = runJson.job || {}
  const llmTotal = readFiniteNumber(job.llm?.scheduler?.concurrency ?? job.llm?.concurrency)
  const llmStageNames = new Set(['summary', 'summary-locate', 'kg', 'audio', 'directorDraft'])
  const llmAllocations = Object.entries(stages)
    .filter(([name, stage]) => llmStageNames.has(name) && stage?.status === 'running')
    .map(([name, stage]) => {
      let concurrency = readFiniteNumber(stage.schedulerConcurrency)
      if (concurrency === null && name === 'summary-locate') concurrency = llmTotal
      return { stage: name, concurrency: concurrency || 0 }
    })
  const llmUsed = llmAllocations.reduce((sum, item) => sum + item.concurrency, 0)
  const embeddingStages = Object.entries(stages)
    .filter(([name, stage]) => ['chunkEmbedding', 'summaryEmbedding'].includes(name) && stage?.status === 'running')
    .map(([name]) => name)
  const audioActive = ['audio', 'directorDraft', 'directorQc', 'ttsSegments', 'audioQc', 'audioAssemble'].some(name => stages[name]?.status === 'running')
  return {
    llmPool: llmTotal ? { total: llmTotal, used: llmUsed, available: Math.max(0, llmTotal - llmUsed), allocations: llmAllocations } : null,
    embedding: embeddingStages.length ? { concurrency: readFiniteNumber(job.embedding?.concurrency), stages: embeddingStages } : null,
    kg: kgControl ? {
      active: stages.kg?.status === 'running',
      concurrency: stages.kg?.status === 'running' ? readFiniteNumber(kgControl.concurrency) : 0,
      updatedAt: readString(kgControl.updatedAt),
    } : null,
    audio: audioControl ? {
      active: audioActive,
      directorConcurrency: audioActive ? readFiniteNumber(audioControl.directorConcurrency ?? audioControl.director_concurrency) : 0,
      llmChapters: audioActive ? readFiniteNumber(audioControl.llmChapters ?? audioControl.llm_chapters) : 0,
      ttsConcurrency: audioActive ? readFiniteNumber(audioControl.ttsConcurrency ?? audioControl.tts_concurrency) : 0,
      ttsChapters: audioActive ? readFiniteNumber(audioControl.ttsChapters ?? audioControl.tts_chapters) : 0,
      updatedAt: readString(audioControl.updatedAt),
    } : null,
  }
}

async function updateRuntimeConcurrency(runDir, runJson, body) {
  const runtimeDir = resolve(runDir, 'artifacts', 'runtime')
  const updatedAt = new Date().toISOString()
  const result = { updatedAt }
  if (body.audio !== undefined) {
    if (!['audio', 'directorDraft', 'directorQc', 'ttsSegments', 'audioQc', 'audioAssemble'].some(stage => runJson.stages?.[stage]?.status === 'running')) throw httpError(409, 'audio_not_running', 'Audio 阶段当前未运行。')
    const path = resolve(runtimeDir, 'audio-control.json')
    const current = await readJsonIfExists(path)
    if (!current) throw httpError(404, 'audio_control_not_found', '未找到 Audio 运行时控制文件。')
    const audio = readObjectBody(body.audio)
    result.audio = {
      directorConcurrency: requiredRuntimeInteger(audio.directorConcurrency, '导演 LLM 并发', 1, 64),
      llmChapters: requiredRuntimeInteger(audio.llmChapters, 'LLM 章节并发', 1, 16),
      ttsConcurrency: requiredRuntimeInteger(audio.ttsConcurrency, 'TTS API 并发', 1, 128),
      ttsChapters: requiredRuntimeInteger(audio.ttsChapters, 'TTS 章节并发', 1, 16),
      updatedAt,
    }
    await writeJsonAtomic(path, { ...current, ...result.audio })
  }
  if (body.kg !== undefined) {
    if (!runJson.stages?.kg || runJson.stages.kg.status !== 'running') throw httpError(409, 'kg_not_running', 'KG 阶段当前未运行。')
    const path = resolve(runtimeDir, 'kg-control.json')
    const current = await readJsonIfExists(path)
    if (!current) throw httpError(404, 'kg_control_not_found', '未找到 KG 运行时控制文件。')
    const kg = readObjectBody(body.kg)
    result.kg = { concurrency: requiredRuntimeInteger(kg.concurrency, 'KG 并发', 1, 64), updatedAt }
    await writeJsonAtomic(path, { ...current, ...result.kg })
  }
  if (!result.audio && !result.kg) throw httpError(400, 'runtime_concurrency_required', '请提供 audio 或 kg 并发设置。')
  return result
}

function requiredRuntimeInteger(value, label, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw httpError(400, 'invalid_runtime_concurrency', `${label}必须是 ${min} 到 ${max} 的整数。`)
  return number
}

function formatRuntimeConcurrencyUpdate(updated) {
  const parts = []
  if (updated.audio) parts.push(`Audio director=${updated.audio.directorConcurrency}, llmChapters=${updated.audio.llmChapters}, tts=${updated.audio.ttsConcurrency}, ttsChapters=${updated.audio.ttsChapters}`)
  if (updated.kg) parts.push(`KG=${updated.kg.concurrency}`)
  return parts.join('; ')
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

async function readAudioMetricFromArtifacts(runDir, total = 0) {
  const files = await findFiles(runDir, (filePath) => /\/tts-source\/ch\d+-full\/audio\/chapter\.mp3$/.test(filePath))
  return buildChapterArtifactMetric(files, /\/tts-source\/ch(\d+)-full\/audio\/chapter\.mp3$/, total)
}

async function readAudioWorkflowMetrics(runDir, total = 0) {
  const root = resolve(runDir, 'artifacts', 'tts-source')
  const definitions = [
    ['directorDraft', /\/ch(\d+)-full\/director-script\.json$/],
    ['directorQc', /\/ch(\d+)-full\/director-script\.audit\.json$/],
    ['ttsSegments', /\/ch(\d+)-full\/audio\/tts-metrics\.json$/],
    ['audioQc', /\/ch(\d+)-full\/audio\/audio-qc\.json$/],
    ['audioAssemble', /\/ch(\d+)-full\/audio\/chapter\.mp3$/],
  ]
  const metrics = {}
  for (const [stageName, pattern] of definitions) {
    const files = await findFiles(root, (filePath) => pattern.test(filePath))
    metrics[stageName] = await buildChapterArtifactMetric(files, pattern, total) || {
      unit: '章',
      latest: { at: new Date().toISOString(), completed: 0, done: 0, failed: 0, total },
      rates: {},
    }
  }
  return metrics
}

async function buildChapterArtifactMetric(files, chapterPattern, total) {
  const chapters = new Map()
  for (const filePath of files) {
    const chapterMatch = chapterPattern.exec(filePath)
    if (!chapterMatch) continue
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat) continue
    const chapter = Number(chapterMatch[1]) || 0
    const previous = chapters.get(chapter)
    if (!previous || fileStat.mtimeMs < previous.atMs) chapters.set(chapter, { chapter, atMs: fileStat.mtimeMs, at: fileStat.mtime.toISOString() })
  }
  const ordered = [...chapters.values()].sort((a, b) => a.atMs - b.atMs || a.chapter - b.chapter)
  const samples = []
  for (const item of ordered) {
    samples.push({
      at: item.at,
      atMs: item.atMs,
      done: samples.length + 1,
      completed: samples.length + 1,
      failed: 0,
      total,
      chapter: item.chapter,
    })
  }
  return buildRateMetric({ unit: '章', samples })
}

function readProductionAudioTotal(runJson) {
  const job = runJson?.job || {}
  if (job.audio?.chapter) return 1
  const bookId = readString(job.bookId)
  const mainDbPath = readString(runJson?.mainDbPath || job.mainDbPath)
  if (!bookId || !mainDbPath) return 0
  let db
  try {
    db = new DatabaseSync(mainDbPath, { readOnly: true })
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?').get(bookId)?.count) || 0
    const limit = Number(job.audio?.limit) || 0
    return limit > 0 ? Math.min(count, limit) : count
  } catch {
    return 0
  } finally {
    db?.close()
  }
}

function readProductionChapterCoverage(runJson) {
  const job = runJson?.job || {}
  const bookId = readString(job.bookId)
  const mainDbPath = readString(runJson?.mainDbPath || job.mainDbPath)
  if (!bookId || !mainDbPath) return {}
  let db
  try {
    db = new DatabaseSync(mainDbPath, { readOnly: true })
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?').get(bookId)?.count) || 0
    if (!total) return {}
    const count = (table, sql) => sqliteTableExistsInService(db, table) ? Number(db.prepare(sql).get(bookId)?.count) || 0 : null
    const summaries = count('summaries', 'SELECT COUNT(DISTINCT c.id) AS count FROM summaries s JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ?')
    const kg = count('kg_chapter_extractions', "SELECT COUNT(DISTINCT chapter_id) AS count FROM kg_chapter_extractions WHERE book_id = ? AND status = 'completed'")
    const chunkEmbedding = count('chapter_chunk_embeddings', 'SELECT COUNT(DISTINCT chapter_id) AS count FROM chapter_chunk_embeddings WHERE book_id = ?')
    const summaryEmbedding = count('summary_embeddings', 'SELECT COUNT(DISTINCT chapter_id) AS count FROM summary_embeddings WHERE book_id = ?')
    const completedStageCoverage = stageName => runJson.stages?.[stageName]?.status === 'completed' ? total : 0
    return {
      ...(summaries === null ? {} : { summary: { completed: Math.min(total, summaries), total } }),
      ...(kg === null ? {} : { kg: { completed: Math.min(total, kg), total } }),
      ...(chunkEmbedding === null ? {} : { chunkEmbedding: { completed: Math.min(total, chunkEmbedding), total } }),
      ...(summaryEmbedding === null ? {} : { summaryEmbedding: { completed: Math.min(total, summaryEmbedding), total } }),
      'summary-locate': { completed: completedStageCoverage('summary-locate'), total },
    }
  } catch {
    return {}
  } finally {
    db?.close()
  }
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

function listMainBooks(mainDbPath, { query = '', limit = 50, gatewayRoot = '' } = {}) {
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

    const summaryStatement = sqliteTableExistsInService(db, 'summaries') ? db.prepare('SELECT COUNT(*) AS count FROM summaries s JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ?') : null
    const kgStatement = sqliteTableExistsInService(db, 'kg_chapter_extractions') ? db.prepare("SELECT COUNT(*) AS count FROM kg_chapter_extractions WHERE book_id = ? AND status = 'completed'") : null
    const summaryEmbeddingStatement = sqliteTableExistsInService(db, 'summary_embeddings') ? db.prepare('SELECT COUNT(DISTINCT chapter_id) AS count FROM summary_embeddings WHERE book_id = ?') : null
    const chunkEmbeddingStatement = sqliteTableExistsInService(db, 'chapter_chunk_embeddings') ? db.prepare('SELECT COUNT(DISTINCT chapter_id) AS count FROM chapter_chunk_embeddings WHERE book_id = ?') : null
    return rows.map((row) => {
      const id = String(row.id)
      const chapterCount = Number(row.chapter_count) || 0
      const summaryCount = Number(summaryStatement?.get(id)?.count) || 0
      const kgCount = Number(kgStatement?.get(id)?.count) || 0
      const summaryEmbeddingCount = Number(summaryEmbeddingStatement?.get(id)?.count) || 0
      const chunkEmbeddingCount = Number(chunkEmbeddingStatement?.get(id)?.count) || 0
      const audioCount = countPublishedAudioChapters(gatewayRoot, id)
      const published = Boolean(gatewayRoot && existsSync(resolve(gatewayRoot, 'data', 'books', id, 'package.json')))
      return {
        id,
        title: String(row.title),
        importedAt: String(row.imported_at || ''),
        updatedAt: String(row.updated_at || ''),
        chapterCount,
        wordCount: Number(row.word_count) || 0,
        production: {
          summary: productionCoverage(summaryCount, chapterCount),
          kg: productionCoverage(kgCount, chapterCount),
          embedding: productionCoverage(Math.min(summaryEmbeddingCount, chunkEmbeddingCount), chapterCount),
          audio: productionCoverage(audioCount, chapterCount),
          packagePublished: published,
        },
      }
    })
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' || error.code === 'ENOENT') {
      throw httpError(404, 'main_db_unavailable', `Cannot read main database: ${mainDbPath}. ${error.message}`)
    }
    throw error
  } finally {
    db?.close()
  }
}

function sqliteTableExistsInService(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName))
}

function productionCoverage(completed, total) {
  return { completed, total, ratio: total > 0 ? Math.min(1, completed / total) : 0 }
}

function countPublishedAudioChapters(gatewayRoot, bookId) {
  if (!gatewayRoot) return 0
  const bookAudioDir = resolve(gatewayRoot, 'audio', 'books', bookId)
  try {
    return readdirSync(bookAudioDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(bookAudioDir, entry.name, 'chapter.mp3'))).length
  } catch {
    return 0
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

async function listManagedFiles(dir, allowedExtensions) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && allowedExtensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => describeManagedFile(resolve(dir, entry.name))))
  return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function describeManagedFile(filePath) {
  const fileStat = await stat(filePath)
  return {
    name: basename(filePath),
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
  }
}

function safeManagedFileName(value, allowedExtensions) {
  const name = basename(readString(value)).normalize('NFC')
  if (!name || name === '.' || name === '..' || name.startsWith('.') || name.length > 180 || /[\0/\\]/.test(name)) {
    throw httpError(400, 'invalid_file_name', 'File name is invalid.')
  }
  if (!allowedExtensions.has(extname(name).toLowerCase())) {
    throw httpError(400, 'unsupported_file_type', `Unsupported file type: ${extname(name) || '(none)'}`)
  }
  return name
}

function resolveManagedFile(dir, fileName) {
  const resolved = resolve(dir, fileName)
  if (dirname(resolved) !== resolve(dir)) throw httpError(400, 'invalid_file_name', 'File path escapes the managed directory.')
  return resolved
}

async function listJobTemplates(dir) {
  const files = await listManagedFiles(dir, new Set(['.json']))
  return Promise.all(files.map(async (file) => describeJobTemplate(resolve(dir, file.name))))
}

async function describeJobTemplate(path) {
  const [file, template] = await Promise.all([describeManagedFile(path), readJsonIfExists(path)])
  return {
    ...file,
    title: readString(template?.title),
    bookId: readString(template?.bookId),
    stages: Array.isArray(template?.stages) ? template.stages.map(String) : [],
    sourceFile: readString(template?.source?.file ? basename(template.source.file) : ''),
  }
}

function normalizeServiceJobTemplate(template, config) {
  const normalized = JSON.parse(JSON.stringify(template))
  normalized.mainDbPath = config.mainDbPath
  if (normalized.source?.file) {
    const sourceName = safeManagedFileName(basename(readString(normalized.source.file)), supportedSourceExtensions)
    normalized.source = {
      ...normalized.source,
      file: resolveManagedFile(config.sourcesDir, sourceName),
    }
  }
  return normalized
}

function validateServiceJobTemplate(template, config) {
  const errors = []
  const warnings = []
  const stages = Array.isArray(template.stages) ? template.stages.map(String) : []
  const knownStages = new Set(productionStageMetadata.map((stage) => stage.id))
  for (const stage of stages) if (!knownStages.has(stage)) errors.push(`未知阶段：${stage}`)
  if (!readString(template.title)) errors.push('请填写任务标题。')
  if (stages.includes('import')) {
    const file = readString(template.source?.file)
    if (!file) errors.push('导入阶段需要选择源文件。')
    else {
      try { statSyncSafe(resolveManagedFile(config.sourcesDir, basename(file))) || errors.push(`源文件不存在：${basename(file)}`) } catch { errors.push('源文件路径无效。') }
    }
  } else if (!readString(template.bookId)) {
    errors.push('不执行导入时需要选择主库中的书籍。')
  }
  if (stages.some((stage) => ['summary', 'summary-locate', 'kg'].includes(stage))) {
    if (!readString(template.llm?.baseUrl)) errors.push('摘要或知识图谱阶段需要填写 LLM 地址。')
    if (!readString(template.llm?.model)) errors.push('摘要或知识图谱阶段需要填写 LLM 模型。')
  }
  if (template.llm?.concurrency !== undefined && (!Number.isInteger(Number(template.llm.concurrency)) || Number(template.llm.concurrency) < 1 || Number(template.llm.concurrency) > 64)) errors.push('LLM 总并发数必须是 1 到 64 的整数。')
  if (stages.includes('audio')) {
    const totalLlm = Number(template.llm?.concurrency) || 0
    const llmChapters = Number(template.audio?.llmChapters) || 1
    if (totalLlm && llmChapters > totalLlm) errors.push('同时编排章节数不能大于 LLM 总并发数。')
    const directorConcurrency = Number(template.audio?.directorConcurrency) || 0
    if (totalLlm && directorConcurrency && directorConcurrency * llmChapters > totalLlm) errors.push('导演并发数 × 同时编排章节数不能大于 LLM 总并发数。')
  }
  if (stages.includes('embedding')) {
    if (!readString(template.embedding?.baseUrl)) errors.push('向量阶段需要填写服务地址。')
    if (!readString(template.embedding?.model)) errors.push('向量阶段需要填写模型。')
  }
  if (stages.includes('audio') && !readString(template.audio?.ttsConfig) && !readString(template.audio?.sourceRoot)) errors.push('有声书阶段需要配置 audio.ttsConfig 或 audio.sourceRoot。')
  if (stages.includes('publish') && !readString(template.gateway?.host) && !readString(template.publish?.gatewayDataDir)) errors.push('发布阶段需要配置 Gateway 主机或本地数据目录。')
  if (stages.includes('verify')) {
    if (!readString(template.gateway?.url) && !readString(template.verify?.gatewayUrl)) errors.push('验证阶段需要配置 Gateway URL。')
    if (!readString(template.gateway?.token) && !readString(template.gateway?.tokenEnv) && !readString(template.verify?.gatewayToken) && !readString(template.verify?.gatewayTokenEnv)) errors.push('验证阶段需要配置 Gateway Token 环境变量。')
  }
  if (!stages.length) warnings.push('当前模板没有生产阶段，启动后只会完成一次空任务。')
  return { valid: errors.length === 0, errors, warnings, normalized: redactSecrets(template) }
}

function statSyncSafe(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:api.?key|token|password|secret)$/i.test(key) && typeof item === 'string' ? '[REDACTED]' : redactSecrets(item),
  ]))
}

function readRuntimeCredentials(path) {
  if (!path || !existsSync(path)) return {}
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).flatMap(line => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (!match || (!['LLM_API_KEY', 'EMBEDDING_API_KEY'].includes(match[1]) && !/^LLM_PROFILE_[A-Z0-9_]+_API_KEY$/.test(match[1]))) return []
      let value = match[2]
      try { value = JSON.parse(value) } catch {}
      return typeof value === 'string' && value ? [[match[1], value]] : []
    }))
  } catch {
    return {}
  }
}

async function writeRuntimeCredentials(path, credentials) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  const content = Object.keys(credentials)
    .filter(key => ['LLM_API_KEY', 'EMBEDDING_API_KEY'].includes(key) || /^LLM_PROFILE_[A-Z0-9_]+_API_KEY$/.test(key))
    .sort()
    .filter(key => readString(credentials[key]))
    .map(key => `${key}=${JSON.stringify(readString(credentials[key]))}`)
    .join('\n')
  await writeFile(tempPath, content ? `${content}\n` : '', { mode: 0o600 })
  await rename(tempPath, path)
  await chmod(path, 0o600)
}

function runtimeCredentialStatus(config, credentials = readRuntimeCredentials(config.credentialsFile)) {
  return {
    llmCredential: Boolean(process.env.LLM_API_KEY || credentials.LLM_API_KEY),
    embeddingCredential: Boolean(process.env.EMBEDDING_API_KEY || credentials.EMBEDDING_API_KEY),
  }
}

function readModelProfiles(path) {
  if (!existsSync(path)) return []
  try {
    return normalizeModelProfiles(JSON.parse(readFileSync(path, 'utf8')).profiles)
  } catch {
    return []
  }
}

function normalizeModelProfiles(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.map((item, index) => {
    const source = item && typeof item === 'object' ? item : {}
    const id = readString(source.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `llm${index + 1}`
    if (seen.has(id)) throw httpError(400, 'duplicate_model_profile', `模型配置名称重复：${id}`)
    seen.add(id)
    const baseUrl = readString(source.baseUrl)
    const model = readString(source.model)
    if (!baseUrl || !model) throw httpError(400, 'invalid_model_profile', `${id} 必须填写 Base URL 和模型名称。`)
    return {
      id,
      label: readString(source.label) || id,
      provider: 'openai-compatible',
      baseUrl,
      model,
      apiKeyEnv: `LLM_PROFILE_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
      fallback: source.fallback === true,
      ...(readString(source.apiKey) ? { apiKey: readString(source.apiKey) } : {}),
    }
  }).map((profile, _index, profiles) => ({
    ...profile,
    fallback: profile.fallback && profiles.findIndex(item => item.fallback) === profiles.indexOf(profile),
  }))
}

async function writeJsonAtomic(path, value) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
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

function readPositiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function readNonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
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
    const close = async (signal) => {
      app.log.info({ signal }, 'production pipeline service shutting down')
      await app.close()
    }
    process.once('SIGTERM', () => void close('SIGTERM'))
    process.once('SIGINT', () => void close('SIGINT'))
  } catch (error) {
    app.log.error(error, 'failed to start production pipeline console')
    process.exitCode = 1
  }
}
