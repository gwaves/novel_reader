import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { buildContentPipelineService, loadServiceConfig } from '../scripts/service.mjs'

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

async function buildTestApp(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-pipeline-service-test-'))
  tempDirs.push(dataDir)
  const app = await buildContentPipelineService(loadServiceConfig({
    CONTENT_PIPELINE_SERVICE_DATA_DIR: dataDir,
    CONTENT_PIPELINE_LOG_LEVEL: 'silent',
    ...overrides,
  }))
  apps.push(app)
  return app
}

describe('content pipeline service', () => {
  it('returns health status', async () => {
    const app = await buildTestApp()
    const response = await app.inject({ method: 'GET', url: '/health' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().service, 'novel-reader-content-pipeline')
  })

  it('requires bearer token when configured', async () => {
    const app = await buildTestApp({ CONTENT_PIPELINE_SERVICE_TOKEN: 'secret' })
    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs',
    })

    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error.code, 'missing_authorization')
  })

  it('starts a dry-run init job and exposes manifest state', async () => {
    const app = await buildTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        action: 'produce',
        bookId: 'test-book',
        title: '测试书',
        steps: 'import',
        dryRun: true,
      },
    })

    assert.equal(response.statusCode, 202)
    const jobId = response.json().job.id

    let body
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const poll = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })
      body = poll.json()
      if (body.job.status === 'completed' || body.job.status === 'failed') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }

    assert.equal(body.job.status, 'completed')
    assert.equal(body.manifest.book.id, 'test-book')
    assert.equal(body.manifest.stages.offlineImport.status, 'skipped')
  })

  it('starts a production pipeline v2 job and exposes run state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'content-pipeline-production-v2-test-'))
    tempDirs.push(dataDir)
    const txtPath = join(dataDir, 'sample.txt')
    const dbPath = join(dataDir, 'main.sqlite')
    const runRoot = join(dataDir, 'production-runs')
    const jobPath = join(dataDir, 'job.json')
    await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
    await writeFile(
      jobPath,
      JSON.stringify({
        bookId: 'v2-book',
        title: 'V2 测试书',
        mainDbPath: dbPath,
        source: { type: 'txt', file: txtPath },
        stages: ['import'],
        import: { replace: true },
      }),
      'utf8',
    )

    const app = await buildTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        action: 'production-v2',
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
  })

  it('defaults audio jobs without chapters to the full book range', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'content-pipeline-audio-range-test-'))
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
      'audio-book',
      '音频书',
      '2026-06-28T00:00:00.000Z',
      2,
    )
    db.close()

    const app = await buildTestApp({ CONTENT_PIPELINE_MAIN_DB: mainDbPath })
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        action: 'produce',
        bookId: 'audio-book',
        title: '音频书',
        steps: 'audio',
        dryRun: true,
        mainDb: mainDbPath,
      },
    })

    assert.equal(response.statusCode, 202)
    const jobId = response.json().job.id

    let body
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const poll = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })
      body = poll.json()
      if (body.job.status === 'completed' || body.job.status === 'failed') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }

    assert.equal(body.job.status, 'completed')
    assert.equal(body.manifest.artifacts.audioChapters, '1-2')
    assert.equal(body.manifest.stages.audio.status, 'skipped')
  })

  it('lists and searches books from the configured main database', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'content-pipeline-books-test-'))
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
      'book-a',
      '测试书 A',
      '2026-06-28T00:00:00.000Z',
      2,
    )
    db.prepare('INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count) VALUES (?, ?, ?, ?, ?, ?)').run(
      'book-a:ch1',
      'book-a',
      1,
      '第一章',
      'content',
      12,
    )
    db.prepare('INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count) VALUES (?, ?, ?, ?, ?, ?)').run(
      'book-a:ch2',
      'book-a',
      2,
      '第二章',
      'content',
      18,
    )
    db.close()

    const app = await buildTestApp({ CONTENT_PIPELINE_MAIN_DB: mainDbPath })
    const response = await app.inject({ method: 'GET', url: '/api/books?query=A' })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().books[0], {
      id: 'book-a',
      title: '测试书 A',
      importedAt: '2026-06-28T00:00:00.000Z',
      updatedAt: response.json().books[0].updatedAt,
      chapterCount: 2,
      wordCount: 30,
    })
  })
})
