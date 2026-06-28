import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const cliPath = new URL('../src/cli.mjs', import.meta.url).pathname

describe('production-pipeline import', () => {
  it('imports a TXT file into the main DB and records run artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-import-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(
        txtPath,
        `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`,
        'utf8',
      )

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /book: sample-book 样书/)
      assert.match(stdout, /chapters: 2/)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const book = plainRow(
          db.prepare('SELECT id, title, chapter_count AS chapterCount FROM books WHERE id = ?').get('sample-book'),
        )
        assert.deepEqual(book, { id: 'sample-book', title: '样书', chapterCount: 2 })
        const chapters = db.prepare('SELECT id, chapter_index AS chapterIndex, title FROM chapters ORDER BY chapter_index')
          .all()
          .map(plainRow)
        assert.deepEqual(chapters, [
          { id: '1-第一章 开始', chapterIndex: 1, title: '第一章 开始' },
          { id: '2-第二章 继续', chapterIndex: 2, title: '第二章 继续' },
        ])
      } finally {
        db.close()
      }

      const runId = stdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(runId)
      const runJson = JSON.parse(await readFile(join(runRoot, runId, 'run.json'), 'utf8'))
      assert.equal(runJson.status, 'completed')
      const report = JSON.parse(await readFile(join(runRoot, runId, 'artifacts', 'import-report.json'), 'utf8'))
      assert.equal(report.book.chapterCount, 2)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('dry-runs without writing the main DB', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-import-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--main-db',
        dbPath,
        '--run-root',
        join(tempDir, 'runs'),
        '--dry-run',
      ])

      assert.match(stdout, /dry-run: main database was not modified/)
      assert.equal(await fileExists(dbPath), false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('requires --replace before overwriting an existing book', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-import-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')

      const args = [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ]
      await execFileAsync(process.execPath, args)

      await assert.rejects(
        () => execFileAsync(process.execPath, args),
        /Book already exists: sample-book\. Use --replace to overwrite\./,
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('packages a main DB book into Gateway package artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-package-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'package',
        '--book-id',
        'sample-book',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /book: sample-book 样书/)
      assert.match(stdout, /chapters: 2/)
      const packagePath = stdout.match(/package: (.+)/)?.[1]?.trim()
      assert.ok(packagePath)
      const bookPackage = JSON.parse(await readFile(packagePath, 'utf8'))
      assert.equal(bookPackage.schemaVersion, 1)
      assert.equal(bookPackage.book.id, 'sample-book')
      assert.equal(bookPackage.book.chapterCount, 2)
      assert.equal(bookPackage.chapters[0].id, '1-第一章 开始')
      assert.equal(bookPackage.chapters[0].content, '这是第一章内容。')

      const runId = stdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(runId)
      const runJson = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.package.status, 'completed')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('prepares a dry-run publish plan and merged Gateway catalog', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-publish-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const gatewayDataDir = join(tempDir, 'gateway-data')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await mkdir(gatewayDataDir, { recursive: true })
      await writeFile(
        join(gatewayDataDir, 'books.json'),
        JSON.stringify({
          schemaVersion: 1,
          books: [{ id: 'old-book', title: '旧书', chapterCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' }],
        }),
        'utf8',
      )
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      const { stdout: packageStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'package',
        '--book-id',
        'sample-book',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      const runId = packageStdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(runId)

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'publish',
        '--run',
        join(runRoot, 'sample-book', runId, 'run.json'),
        '--gateway-data-dir',
        gatewayDataDir,
        '--dry-run',
      ])

      assert.match(stdout, /dry-run: rsync -a/)
      const catalog = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'artifacts', 'gateway-data', 'books.json'), 'utf8'))
      assert.deepEqual(
        catalog.books.map((book) => book.id).sort(),
        ['old-book', 'sample-book'],
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs a job config and resumes by skipping completed stages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-run-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const gatewayDataDir = join(tempDir, 'gateway-data')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await mkdir(gatewayDataDir, { recursive: true })
      await writeFile(
        join(gatewayDataDir, 'books.json'),
        JSON.stringify({ schemaVersion: 1, books: [] }),
        'utf8',
      )
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          stages: ['package', 'publish'],
          publish: {
            gatewayDataDir,
            dryRun: true,
          },
        }),
        'utf8',
      )

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'run',
        '--job',
        jobPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /completed: package/)
      assert.match(stdout, /completed: publish/)
      assert.match(stdout, /status: completed/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJsonPath = join(parentRunDir, 'run.json')
      const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(runJson.status, 'completed')
      assert.equal(runJson.stages.package.status, 'completed')
      assert.equal(runJson.stages.publish.status, 'completed')
      assert.ok(runJson.stages.package.childRunJson)
      assert.ok(runJson.stages.publish.childRuns[0].logFile)

      const packageRun = JSON.parse(await readFile(runJson.stages.package.childRunJson, 'utf8'))
      const mergedCatalog = JSON.parse(await readFile(
        join(dirname(runJson.stages.package.childRunJson), packageRun.stages.package.artifacts.gatewayDataDir, 'books.json'),
        'utf8',
      ))
      assert.deepEqual(mergedCatalog.books.map((book) => book.id), ['sample-book'])

      const { stdout: resumeStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'resume',
        '--run',
        runJsonPath,
      ])

      assert.match(resumeStdout, /skip: package already completed/)
      assert.match(resumeStdout, /skip: publish already completed/)
      assert.match(resumeStdout, /status: completed/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('maps audio files to canonical main DB chapter ids', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-audio-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const sourceRoot = join(tempDir, 'tts')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await mkdir(join(sourceRoot, 'ch001-full', 'audio'), { recursive: true })
      await mkdir(join(sourceRoot, 'ch002-full', 'audio'), { recursive: true })
      await writeFile(join(sourceRoot, 'ch001-full', 'audio', 'chapter.mp3'), 'fake-mp3-1')
      await writeFile(join(sourceRoot, 'ch001-full', 'audio', 'manifest.json'), JSON.stringify({ version: 2, duration: 1.25 }))
      await writeFile(join(sourceRoot, 'ch002-full', 'audio', 'chapter.mp3'), 'fake-mp3-2')
      await writeFile(join(sourceRoot, 'ch002-full', 'audio', 'manifest.json'), JSON.stringify({ timelineVersion: 3, durationMs: 2500 }))
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'audio',
        '--book-id',
        'sample-book',
        '--source-root',
        sourceRoot,
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /audio chapters: 2/)
      const catalogPath = stdout.match(/audio: (.+)/)?.[1]?.trim()
      assert.ok(catalogPath)
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
      assert.deepEqual(
        catalog.chapters.map((chapter) => chapter.chapterId),
        ['1-第一章 开始', '2-第二章 继续'],
      )
      assert.equal(catalog.chapters[0].timelineVersion, 2)
      assert.equal(catalog.chapters[0].durationMs, 1250)
      assert.equal(catalog.chapters[1].timelineVersion, 3)
      assert.equal(catalog.chapters[1].durationMs, 2500)
      assert.match(catalog.chapters[0].fileName, /^ch001-1\//)
      assert.equal(await fileExists(join(dirname(catalogPath), catalog.chapters[0].fileName)), true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('verifies Gateway package output against a published Gateway API', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-verify-test-'))
    let gateway
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      const { stdout: packageStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'package',
        '--book-id',
        'sample-book',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      const packagePath = packageStdout.match(/package: (.+)/)?.[1]?.trim()
      const runId = packageStdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(packagePath)
      assert.ok(runId)
      const bookPackage = JSON.parse(await readFile(packagePath, 'utf8'))
      gateway = await startFakeGateway({
        token: 'dev-token',
        bookPackage,
        audioCatalog: { schemaVersion: 1, chapters: [] },
      })

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'verify',
        '--run',
        join(runRoot, 'sample-book', runId, 'run.json'),
        '--gateway-url',
        gateway.url,
        '--gateway-token',
        'dev-token',
      ])

      assert.match(stdout, /checks: 5\/5/)
      const runJson = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.verify.status, 'completed')
      const report = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'artifacts', 'verify-report.json'), 'utf8'))
      assert.equal(report.ok, true)
    } finally {
      if (gateway) await gateway.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('generates embeddings directly into the main DB without a local API service', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-embedding-test-'))
    let embeddingServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      seedSummaries(dbPath)
      embeddingServer = await startFakeEmbeddingServer()

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'embedding',
        '--book-id',
        'sample-book',
        '--provider',
        'openai',
        '--base-url',
        embeddingServer.url,
        '--model',
        'fake-embedding',
        '--concurrency',
        '2',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /embedding targets: 2/)
      assert.match(stdout, /completed: 2/)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const summaryCount = db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ?').get('sample-book').count
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ?').get('sample-book').count
        assert.equal(summaryCount, 2)
        assert.equal(chunkCount, 2)
        const dimension = db.prepare('SELECT dimension FROM summary_embeddings LIMIT 1').get().dimension
        assert.equal(dimension, 3)
      } finally {
        db.close()
      }
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('generates summaries directly into the main DB without a local API service', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-summary-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await execFileAsync(process.execPath, [
        cliPath,
        'import',
        '--file',
        txtPath,
        '--book-id',
        'sample-book',
        '--title',
        '样书',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])
      chatServer = await startFakeChatServer()

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'summary',
        '--book-id',
        'sample-book',
        '--provider',
        'openai-compatible',
        '--base-url',
        chatServer.url,
        '--model',
        'fake-chat',
        '--concurrency',
        '2',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /summary targets: 2/)
      assert.match(stdout, /completed: 2/)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = db.prepare('SELECT chapter_id AS chapterId, short, detail, key_points_json AS keyPointsJson FROM summaries ORDER BY chapter_id')
          .all()
          .map(plainRow)
        assert.equal(rows.length, 2)
        assert.equal(rows[0].short, '本章概要')
        assert.deepEqual(JSON.parse(rows[0].keyPointsJson), ['要点一', '要点二'])
      } finally {
        db.close()
      }
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

})

function plainRow(row) {
  return Object.assign({}, row)
}

function seedSummaries(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
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
    const insert = db.prepare(`
      INSERT INTO summaries (chapter_id, short, detail, key_points_json, skippable, generated_by, updated_at)
      VALUES (?, ?, ?, ?, 'false', 'test', CURRENT_TIMESTAMP)
    `)
    insert.run('1-第一章 开始', '短摘要一', '详细摘要一', JSON.stringify(['要点一']))
    insert.run('2-第二章 继续', '短摘要二', '详细摘要二', JSON.stringify(['要点二']))
  } finally {
    db.close()
  }
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function startFakeEmbeddingServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/embeddings') {
      sendJson(response, { error: { code: 'not_found' } }, 404)
      return
    }
    const body = await readRequestJson(request)
    const input = String(body.input || '')
    const base = Math.max(1, input.length % 10)
    sendJson(response, {
      data: [{ embedding: [base, base + 1, base + 2] }],
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function startFakeChatServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/chat/completions') {
      sendJson(response, { error: { code: 'not_found' } }, 404)
      return
    }
    await readRequestJson(request)
    sendJson(response, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              short: '本章概要',
              detail: '本章详细概要，包含起因、经过和结果。',
              keyPoints: ['要点一', '要点二'],
              skippable: '不可跳读：主线推进。',
            }),
          },
        },
      ],
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function readRequestJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function startFakeGateway({ token, bookPackage, audioCatalog }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJson(response, { status: 'ok' })
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, { error: { code: 'invalid_token' } }, 401)
      return
    }
    if (url.pathname === '/mobile/books') {
      sendJson(response, {
        schemaVersion: 1,
        books: [{ ...bookPackage.book, audioChapterCount: audioCatalog.chapters.length }],
      })
      return
    }
    if (url.pathname === `/mobile/books/${bookPackage.book.id}/package`) {
      sendJson(response, { package: bookPackage })
      return
    }
    if (url.pathname === `/mobile/books/${bookPackage.book.id}/audio`) {
      sendJson(response, audioCatalog)
      return
    }
    sendJson(response, { error: { code: 'not_found' } }, 404)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function sendJson(response, value, statusCode = 200) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
