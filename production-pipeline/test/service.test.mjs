import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { buildProductionPipelineService, loadServiceConfig } from '../src/service.mjs'

const apps = []
const tempDirs = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(tempDirs.splice(0).map(removeTempDir))
})

async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function buildTestApp(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-console-test-'))
  tempDirs.push(dataDir)
  const app = await buildProductionPipelineService(loadServiceConfig({
    PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir,
    PRODUCTION_PIPELINE_CONSOLE_LOG_LEVEL: 'silent',
    PRODUCTION_PIPELINE_JOBS_DIR: join(dataDir, 'jobs'),
    PRODUCTION_PIPELINE_SOURCES_DIR: join(dataDir, 'sources'),
    PRODUCTION_PIPELINE_BACKUPS_DIR: join(dataDir, 'backups'),
    ...overrides,
  }))
  apps.push(app)
  return app
}

describe('production pipeline console service', () => {
  it('returns health status', async () => {
    const app = await buildTestApp()
    const response = await app.inject({ method: 'GET', url: '/health' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().service, 'novel-reader-production-pipeline')
  })

  it('renders a production v2 console', async () => {
    const app = await buildTestApp()
    const response = await app.inject({ method: 'GET', url: '/' })
    const html = response.body

    assert.equal(response.statusCode, 200)
    assert.match(html, /Production Pipeline/)
    assert.match(html, /id="jobPath"/)
    assert.match(html, /id="chooseJob"/)
    assert.match(html, /id="localJobFile"/)
    assert.match(html, /生产端 JSON/)
    assert.match(html, /本机 JSON/)
    assert.match(html, /id="startV2"/)
    assert.match(html, /id="builderStages"/)
    assert.match(html, /id="generateTemplate"/)
    assert.match(html, /id="ttsConfig"/)
    assert.match(html, /id="llmConcurrency"/)
    assert.match(html, /id="builderFeedback"/)
    assert.match(html, /job && !job\.readOnly/)
    assert.match(html, /LLM 共享并发池/)
    assert.match(html, /向量服务并发/)
    assert.match(html, /id="saveToken"/)
    assert.match(html, /Token 已验证并保存在当前浏览器/)
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(inlineScript)
    assert.doesNotThrow(() => new Function(inlineScript))
    assert.match(html, /Asia\/Shanghai/)
    assert.match(html, /localizeLogTimestamps/)
    assert.match(html, /data-console-view="overview"/)
    assert.match(html, /data-wizard-panel="4"/)
    assert.match(html, /id="saveAndStart"/)
    assert.match(html, /id="jobStatusFilter"/)
    assert.match(html, /id="gatewayTokenEnv"/)
    assert.match(html, /\[hidden\] \{ display: none !important; \}/)
    assert.match(html, /production-log-viewer/)
    assert.doesNotMatch(html, /Legacy/)
  })

  it('requires bearer token when configured', async () => {
    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_TOKEN: 'secret' })
    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs',
    })

    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error.code, 'missing_authorization')
  })

  it('allows a viewer token to read but rejects write operations', async () => {
    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_TOKEN: 'admin-secret', PRODUCTION_PIPELINE_CONSOLE_VIEWER_TOKEN: 'viewer-secret' })
    const headers = { authorization: 'Bearer viewer-secret' }
    const session = await app.inject({ method: 'GET', url: '/api/session', headers })
    assert.equal(session.statusCode, 200)
    assert.equal(session.json().role, 'viewer')
    const backup = await app.inject({ method: 'POST', url: '/api/backups', headers })
    assert.equal(backup.statusCode, 403)
    assert.equal(backup.json().error.code, 'read_only')
  })

  it('lists books from the main database', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-books-test-'))
    tempDirs.push(dataDir)
    const mainDbPath = join(dataDir, 'novel_reader.sqlite')
    const db = new DatabaseSync(mainDbPath)
    db.exec(`
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE chapters (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE summaries (chapter_id TEXT PRIMARY KEY);
      CREATE TABLE kg_chapter_extractions (chapter_id TEXT, book_id TEXT, status TEXT);
      CREATE TABLE summary_embeddings (chapter_id TEXT, book_id TEXT);
      CREATE TABLE chapter_chunk_embeddings (chapter_id TEXT, book_id TEXT);
    `)
    db.prepare('INSERT INTO books (id, title, imported_at, chapter_count) VALUES (?, ?, ?, ?)').run(
      'book-one',
      '测试书',
      '2026-06-28T00:00:00.000Z',
      1,
    )
    db.prepare('INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count) VALUES (?, ?, ?, ?, ?, ?)').run(
      'chapter-one',
      'book-one',
      1,
      '第一章',
      '正文',
      2,
    )
    db.exec(`
      INSERT INTO summaries VALUES ('chapter-one');
      INSERT INTO kg_chapter_extractions VALUES ('chapter-one', 'book-one', 'completed');
      INSERT INTO summary_embeddings VALUES ('chapter-one', 'book-one');
      INSERT INTO chapter_chunk_embeddings VALUES ('chapter-one', 'book-one');
    `)
    db.close()
    const gatewayRoot = join(dataDir, 'gateway')
    await mkdir(join(gatewayRoot, 'data', 'books', 'book-one'), { recursive: true })
    await mkdir(join(gatewayRoot, 'audio', 'books', 'book-one', 'chapter-one'), { recursive: true })
    await writeFile(join(gatewayRoot, 'data', 'books', 'book-one', 'package.json'), '{}')
    await writeFile(join(gatewayRoot, 'audio', 'books', 'book-one', 'chapter-one', 'chapter.mp3'), 'audio')

    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: mainDbPath, PRODUCTION_PIPELINE_GATEWAY_ROOT: gatewayRoot })
    const response = await app.inject({ method: 'GET', url: '/api/books?query=%E6%B5%8B%E8%AF%95' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().books.length, 1)
    assert.equal(response.json().books[0].id, 'book-one')
    assert.equal(response.json().books[0].wordCount, 2)
    assert.equal(response.json().books[0].production.summary.ratio, 1)
    assert.equal(response.json().books[0].production.kg.ratio, 1)
    assert.equal(response.json().books[0].production.embedding.ratio, 1)
    assert.equal(response.json().books[0].production.audio.ratio, 1)
    assert.equal(response.json().books[0].production.packagePublished, true)
  })

  it('starts a production pipeline v2 job and exposes package run state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-v2-console-test-'))
    tempDirs.push(dataDir)
    const txtPath = join(dataDir, 'sample.txt')
    const dbPath = join(dataDir, 'main.sqlite')
    const runRoot = join(dataDir, 'production-runs')
    const jobPath = join(dataDir, 'job.json')
    await writeFile(txtPath, '第一章 开始\n这是第一章内容。', 'utf8')
    await writeFile(
      jobPath,
      JSON.stringify({
        title: 'V2 测试书',
        mainDbPath: dbPath,
        source: { type: 'txt', file: txtPath },
        stages: ['import', 'package'],
        import: { replace: true },
      }),
      'utf8',
    )

    const app = await buildTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        jobPath,
        runRoot,
      },
    })

    assert.equal(response.statusCode, 202)
    assert.equal(response.json().job.action, 'production-v2')
    const jobId = response.json().job.id

    let body
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const poll = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })
      body = poll.json()
      if (body.job.status === 'completed' || body.job.status === 'failed') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }

    assert.equal(body.job.status, 'completed')
    assert.equal(body.productionRun.runJson.status, 'completed')
    assert.equal(body.productionRun.runJson.stages.import.status, 'completed')
    assert.ok(body.productionRun.runJson.stages.import.logFile)
    assert.equal(body.productionRun.runJson.stages.package.status, 'completed')
    assert.equal(body.productionRun.metrics.progress.percent, 100)
    assert.equal(body.productionRun.metrics.progress.completedStages, body.productionRun.metrics.progress.totalStages)
    assert.ok(body.productionRun.runJson.stages.package.childRunJson)
    assert.ok(body.productionRun.runJson.stages.package.logFile)

    const packageRun = JSON.parse(
      await readFile(body.productionRun.runJson.stages.package.childRunJson, 'utf8'),
    )
    const artifacts = packageRun.stages.package.artifacts
    assert.ok(artifacts.gatewayDataDir)
    assert.ok(artifacts.packageFile)
    assert.equal(
      await fileExists(join(dirname(body.productionRun.runJson.stages.package.childRunJson), artifacts.packageFile)),
      true,
    )

    const childRunResponse = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/production-file?path=${encodeURIComponent(body.productionRun.runJson.stages.package.childRunJson)}`,
    })
    assert.equal(childRunResponse.statusCode, 200)
    assert.equal(childRunResponse.json().command, 'package')

    const logViewerResponse = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/production-log-viewer?path=${encodeURIComponent(body.productionRun.runJson.stages.package.logFile)}`,
    })
    assert.equal(logViewerResponse.statusCode, 200)
    assert.match(logViewerResponse.body, /setInterval\(refreshLog, intervalMs\)/)
    assert.match(logViewerResponse.body, /const intervalMs = 5000/)
    assert.match(logViewerResponse.body, /production-file/)
    assert.match(logViewerResponse.body, /北京时间 UTC\+8/)
    const viewerScript = logViewerResponse.body.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(viewerScript)
    assert.doesNotThrow(() => new Function(viewerScript))

    const outsideResponse = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/production-file?path=${encodeURIComponent(jobPath)}`,
    })
    assert.equal(outsideResponse.statusCode, 403)
  })

  it('exposes production stage throughput metrics', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-metrics-test-'))
    tempDirs.push(dataDir)
    const runRoot = join(dataDir, 'runs')
    const bookId = 'metric-book'
    const runId = '2026-06-29T12-00-00-000Z-test'
    const runDir = join(runRoot, bookId, runId)
    const mainDbPath = join(dataDir, 'main.sqlite')
    const db = new DatabaseSync(mainDbPath)
    db.exec('CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT);')
    db.prepare('INSERT INTO chapters VALUES (?, ?)').run('ch1', bookId)
    db.prepare('INSERT INTO chapters VALUES (?, ?)').run('ch2', bookId)
    db.prepare('INSERT INTO chapters VALUES (?, ?)').run('ch3', bookId)
    db.close()
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await mkdir(join(runDir, 'artifacts', 'runtime'), { recursive: true })
    await mkdir(join(runDir, 'stage-runs', 'audio', 'one', 'tts-source', 'ch001-full', 'audio'), { recursive: true })
    await mkdir(join(runDir, 'stage-runs', 'audio', 'one', 'tts-source', 'ch002-full', 'audio'), { recursive: true })
    await writeFile(join(runDir, 'stage-runs', 'audio', 'one', 'tts-source', 'ch001-full', 'audio', 'chapter.mp3'), 'one')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    await writeFile(join(runDir, 'stage-runs', 'audio', 'one', 'tts-source', 'ch002-full', 'audio', 'chapter.mp3'), 'two')
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId,
        status: 'running',
        mainDbPath,
        job: { bookId },
        stages: {
          kg: {
            status: 'running',
            logFile: 'logs/kg.log',
          },
          audio: { status: 'running' },
        },
      }),
      'utf8',
    )
    await writeFile(
      join(runDir, 'logs', 'kg.log'),
      [
        '[2026-06-29T12:00:00.000Z] kg start: 0/10 completed=0 failed=0 entityMentions=0 relationMentions=0',
        '[2026-06-29T12:05:00.000Z] kg progress: 5/10 completed=5 failed=0 entityMentions=50 relationMentions=50',
        '[2026-06-29T12:10:00.000Z] kg progress: 10/10 completed=10 failed=0 entityMentions=100 relationMentions=100',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(runDir, 'artifacts', 'runtime', 'kg-control.json'),
      JSON.stringify({ concurrency: 7, updatedAt: '2026-06-29T12:10:00.000Z' }),
      'utf8',
    )
    await writeFile(
      join(runDir, 'artifacts', 'runtime', 'audio-control.json'),
      JSON.stringify({
        directorConcurrency: 4,
        llmChapters: 1,
        ttsConcurrency: 16,
        ttsChapters: 2,
        updatedAt: '2026-06-29T12:10:00.000Z',
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'jobs.json'),
      JSON.stringify([{
        id: 'metric-job',
        action: 'production-v2',
        title: 'Metric Job',
        status: 'running',
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:10:00.000Z',
        productionRunRoot: runRoot,
        productionBookId: bookId,
        productionJobPath: join(dataDir, 'job.json'),
        logFile: join(dataDir, 'metric-job.log'),
        commands: [],
        currentCommand: 0,
        exitCode: null,
        pid: null,
        error: '',
        logs: [],
      }], null, 2),
      'utf8',
    )

    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir })
    const response = await app.inject({ method: 'GET', url: '/api/jobs/metric-job' })
    const body = response.json()

    assert.equal(response.statusCode, 200)
    assert.equal(body.productionRun.metrics.stages.kg.latest.completed, 10)
    assert.equal(body.productionRun.metrics.stages.kg.rates['5m'].produced, 5)
    assert.equal(body.productionRun.metrics.stages.kg.rates['5m'].perMinute, 1)
    assert.equal(body.productionRun.metrics.stages.kg.rates.overall.produced, 10)
    assert.equal(body.productionRun.metrics.stages.kg.rates.overall.perMinute, 1)
    assert.equal(body.productionRun.metrics.concurrency.kg.concurrency, 7)
    assert.equal(body.productionRun.metrics.concurrency.audio.directorConcurrency, 4)
    assert.equal(body.productionRun.metrics.concurrency.audio.ttsConcurrency, 16)
    assert.equal(body.productionRun.metrics.stages.audio.latest.completed, 2)
    assert.equal(body.productionRun.metrics.stages.audio.latest.total, 3)
  })

  it('persists queued jobs and enforces the global concurrency limit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-queue-test-'))
    tempDirs.push(dataDir)
    const markerOne = join(dataDir, 'one.done')
    const markerTwo = join(dataDir, 'two.done')
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([
      queuedTestJob('queue-one', dataDir, markerOne, 250),
      queuedTestJob('queue-two', dataDir, markerTwo, 250),
    ], null, 2))

    const app = await buildTestApp({
      PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir,
      PRODUCTION_PIPELINE_MAX_CONCURRENT_JOBS: '1',
    })

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
    const during = (await app.inject({ method: 'GET', url: '/api/jobs' })).json()
    const queueJobs = during.jobs.filter((job) => job.id === 'queue-one' || job.id === 'queue-two')
    assert.equal(queueJobs.filter((job) => job.status === 'running').length, 1)
    assert.equal(queueJobs.filter((job) => job.status === 'queued').length, 1)
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().scheduler.maxConcurrentJobs, 1)

    await waitForFile(markerOne)
    await waitForFile(markerTwo)
    const after = (await app.inject({ method: 'GET', url: '/api/jobs' })).json()
    assert.equal(after.jobs.filter((job) => (job.id === 'queue-one' || job.id === 'queue-two') && job.status === 'completed').length, 2)
  })

  it('automatically resumes an interrupted persisted job after service restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-recovery-test-'))
    tempDirs.push(dataDir)
    const marker = join(dataDir, 'recovered.done')
    const job = queuedTestJob('recovery-job', dataDir, marker, 10)
    job.status = 'running'
    job.pid = 999999
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([job], null, 2))

    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir })
    await waitForFile(marker)
    const response = await waitForJobStatus(app, 'recovery-job', 'completed')

    assert.equal(response.json().job.status, 'completed')
    assert.equal(response.json().job.attempts, 1)
    const events = await readFile(join(dataDir, 'events.jsonl'), 'utf8')
    assert.match(events, /"event.action":"job.recovered"/)
    assert.match(events, /"event.action":"job.completed"/)
  })

  it('retries a failed job through the service API', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-retry-test-'))
    tempDirs.push(dataDir)
    const marker = join(dataDir, 'retried.done')
    const job = queuedTestJob('retry-job', dataDir, marker, 10)
    job.status = 'failed'
    job.error = 'previous failure'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([job], null, 2))

    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir })
    const retry = await app.inject({ method: 'POST', url: '/api/jobs/retry-job/retry' })
    assert.equal(retry.statusCode, 202)
    await waitForFile(marker)
    const response = await waitForJobStatus(app, 'retry-job', 'completed')
    assert.equal(response.json().job.status, 'completed')
  })

  it('deletes a terminal job from the list while retaining a persistent tombstone', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-delete-test-'))
    tempDirs.push(dataDir)
    const job = queuedTestJob('delete-job', dataDir, join(dataDir, 'unused.done'), 10)
    job.status = 'failed'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([job], null, 2))
    const app = await buildTestApp({ PRODUCTION_PIPELINE_CONSOLE_DATA_DIR: dataDir })

    const deleted = await app.inject({ method: 'DELETE', url: '/api/jobs/delete-job' })
    assert.equal(deleted.statusCode, 204)
    const list = await app.inject({ method: 'GET', url: '/api/jobs' })
    assert.equal(list.json().jobs.some((item) => item.id === 'delete-job'), false)
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    assert.equal(persisted.find((item) => item.id === 'delete-job').hidden, true)
  })

  it('uploads and lists managed production source files', async () => {
    const app = await buildTestApp()
    const boundary = '----production-pipeline-test-boundary'
    const payload = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="测试小说.txt"',
      'Content-Type: text/plain',
      '',
      '第一章\n测试内容',
      `--${boundary}--`,
      '',
    ].join('\r\n'))

    const upload = await app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(upload.statusCode, 201)
    assert.equal(upload.json().source.name, '测试小说.txt')

    const list = await app.inject({ method: 'GET', url: '/api/sources' })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().sources[0].name, '测试小说.txt')
    assert.ok(list.json().sources[0].sizeBytes > 0)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/sources/${encodeURIComponent('测试小说.txt')}` })).statusCode, 204)
  })

  it('creates and lists service job templates with managed paths', async () => {
    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: '/tmp/service-main.sqlite' })
    const response = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        name: '测试生产任务',
        template: {
          title: '测试生产任务',
          source: { type: 'txt', file: '测试小说.txt' },
          stages: ['import'],
        },
      },
    })

    assert.equal(response.statusCode, 201)
    assert.equal(response.json().template.name, '测试生产任务.json')
    const list = await app.inject({ method: 'GET', url: '/api/templates' })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().templates[0].title, '测试生产任务')
    assert.equal(list.json().templates[0].sourceFile, '测试小说.txt')
    const deleted = await app.inject({ method: 'DELETE', url: `/api/templates/${encodeURIComponent('测试生产任务.json')}` })
    assert.equal(deleted.statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates' })).json().templates.length, 0)
  })

  it('serves visual builder metadata and validates templates without exposing secrets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-builder-test-'))
    tempDirs.push(dataDir)
    const mainDbPath = join(dataDir, 'main.sqlite')
    const db = new DatabaseSync(mainDbPath)
    db.exec(`
      CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, imported_at TEXT, chapter_count INTEGER, updated_at TEXT);
      CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, word_count INTEGER);
      INSERT INTO books VALUES ('book-1', '测试书籍', '', 1, '');
    `)
    db.close()
    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: mainDbPath })

    const metadata = await app.inject({ method: 'GET', url: '/api/builder-metadata' })
    assert.equal(metadata.statusCode, 200)
    assert.ok(metadata.json().stages.some((stage) => stage.id === 'embedding'))
    assert.equal(metadata.json().books[0].title, '测试书籍')
    assert.doesNotMatch(metadata.body, /apiKey":"/)

    const valid = await app.inject({
      method: 'POST',
      url: '/api/templates/validate',
      payload: { template: { title: '已有书生产', bookId: 'book-1', source: { type: 'main-db' }, stages: ['summary'], llm: { baseUrl: 'http://llm/v1', model: 'model' } } },
    })
    assert.equal(valid.json().valid, true)

    const invalid = await app.inject({ method: 'POST', url: '/api/templates/validate', payload: { template: { title: '', stages: ['summary'] } } })
    assert.equal(invalid.json().valid, false)
    assert.ok(invalid.json().errors.length >= 3)

    const uploadWithoutImport = await app.inject({ method: 'POST', url: '/api/templates/validate', payload: { template: { title: '空任务', source: { type: 'txt', file: 'missing.txt' }, stages: [] } } })
    assert.equal(uploadWithoutImport.json().valid, false)
    assert.match(uploadWithoutImport.body, /主库中的书籍/)

    const fullProduction = await app.inject({
      method: 'POST', url: '/api/templates/validate',
      payload: { template: {
        title: '完整生产', bookId: 'book-1', source: { type: 'main-db' },
        stages: ['audio', 'package', 'publish', 'verify'],
        llm: { baseUrl: 'http://llm/v1', model: 'model' },
        audio: { ttsConfig: '/home/node/.novel_reader/tts-director.config.json' },
        gateway: { host: '192.168.88.100', user: 'gwaves', root: '/gateway', url: 'http://gateway', tokenEnv: 'GATEWAY_TOKEN' },
      } },
    })
    assert.equal(fullProduction.json().valid, true)

    const overAllocatedDirector = await app.inject({
      method: 'POST', url: '/api/templates/validate',
      payload: { template: { title: '超额导演并发', bookId: 'book-1', source: { type: 'main-db' }, stages: ['audio'], llm: { concurrency: 4 }, audio: { ttsConfig: '/tts.json', directorConcurrency: 3, llmChapters: 2 } } },
    })
    assert.equal(overAllocatedDirector.json().valid, false)
    assert.match(overAllocatedDirector.body, /导演并发数/)
  })

  it('returns template detail with embedded secrets redacted', async () => {
    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: '/tmp/service-main.sqlite' })
    await app.inject({
      method: 'POST', url: '/api/templates',
      payload: { name: 'secret-template', template: { title: '安全模板', stages: [], llm: { apiKey: 'do-not-return' } } },
    })
    const response = await app.inject({ method: 'GET', url: '/api/templates/secret-template.json' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().template.llm.apiKey, '[REDACTED]')
    assert.doesNotMatch(response.body, /do-not-return/)
  })

  it('creates, lists, and downloads a consistent production database backup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'production-pipeline-backup-test-'))
    tempDirs.push(dataDir)
    const mainDbPath = join(dataDir, 'main.sqlite')
    const db = new DatabaseSync(mainDbPath)
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample (value) VALUES (\'ok\');')
    db.close()
    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: mainDbPath })

    const created = await app.inject({ method: 'POST', url: '/api/backups' })
    assert.equal(created.statusCode, 201)
    assert.match(created.json().backup.name, /^novel-reader-.*\.sqlite$/)

    const list = await app.inject({ method: 'GET', url: '/api/backups' })
    assert.equal(list.json().backups.length, 1)
    const download = await app.inject({
      method: 'GET',
      url: `/api/backups/${encodeURIComponent(created.json().backup.name)}/download`,
    })
    assert.equal(download.statusCode, 200)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/backups/${encodeURIComponent(created.json().backup.name)}` })).statusCode, 204)
    assert.equal(download.statusCode, 200)
    assert.ok(download.rawPayload.length > 0)
  })
})

function queuedTestJob(id, dataDir, markerPath, delayMs) {
  const now = new Date().toISOString()
  return {
    id,
    action: 'production-v2',
    title: id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: '',
    finishedAt: '',
    productionRunRoot: join(dataDir, 'runs'),
    productionBookId: id,
    productionJobPath: join(dataDir, `${id}.json`),
    logFile: join(dataDir, 'logs', `${id}.log`),
    commands: [{
      command: process.execPath,
      args: ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ok'), ${delayMs})`],
      display: 'test command',
      cwd: dataDir,
    }],
    currentCommand: 0,
    exitCode: null,
    pid: null,
    error: '',
    logs: [],
    attempts: 0,
    recoveryRequested: false,
  }
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fileExists(path)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  assert.fail(`Timed out waiting for file: ${path}`)
}

async function waitForJobStatus(app, jobId, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })
    if (response.json().job.status === expectedStatus) return response
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  assert.fail(`Timed out waiting for job ${jobId} to reach ${expectedStatus}`)
}
