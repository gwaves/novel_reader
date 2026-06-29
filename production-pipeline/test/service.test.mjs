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
    assert.match(html, /id="startV2"/)
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
    db.close()

    const app = await buildTestApp({ PRODUCTION_PIPELINE_MAIN_DB: mainDbPath })
    const response = await app.inject({ method: 'GET', url: '/api/books?query=%E6%B5%8B%E8%AF%95' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().books.length, 1)
    assert.equal(response.json().books[0].id, 'book-one')
    assert.equal(response.json().books[0].wordCount, 2)
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
        bookId: 'v2-book',
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
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await mkdir(join(runDir, 'artifacts', 'runtime'), { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId,
        status: 'running',
        stages: {
          kg: {
            status: 'running',
            logFile: 'logs/kg.log',
          },
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
  })
})
