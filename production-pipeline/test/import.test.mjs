import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
          { id: 'sample-book:ch00001', chapterIndex: 1, title: '第一章 开始' },
          { id: 'sample-book:ch00002', chapterIndex: 2, title: '第二章 继续' },
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
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')

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
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')

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

  it('uses book-scoped chapter ids to avoid collisions with existing books', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-import-collision-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')

      const db = new DatabaseSync(dbPath)
      try {
        db.exec(`
          PRAGMA foreign_keys = ON;
          CREATE TABLE books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            chapter_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE chapters (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            chapter_index INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            word_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `)
        db.prepare('INSERT INTO books (id, title, imported_at, chapter_count) VALUES (?, ?, ?, ?)').run(
          'legacy-book',
          '旧书',
          '2026-06-28T00:00:00.000Z',
          1,
        )
        db.prepare('INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count) VALUES (?, ?, ?, ?, ?, ?)').run(
          '1-第一章 开始',
          'legacy-book',
          1,
          '第一章 开始',
          '旧章节内容。',
          6,
        )
      } finally {
        db.close()
      }

      await execFileAsync(process.execPath, [
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
      ])

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = verifyDb.prepare('SELECT id, book_id AS bookId FROM chapters ORDER BY book_id, chapter_index')
          .all()
          .map(plainRow)
        assert.deepEqual(rows, [
          { id: '1-第一章 开始', bookId: 'legacy-book' },
          { id: 'sample-book:ch00001', bookId: 'sample-book' },
        ])
      } finally {
        verifyDb.close()
      }
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
      seedSummaries(dbPath)
      seedEmbeddings(dbPath)
      seedKnowledgeGraph(dbPath)

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
      assert.equal(bookPackage.book.summaryCoverage, 1)
      assert.equal(bookPackage.book.embeddingCoverage, 1)
      assert.equal(bookPackage.chapters[0].id, 'sample-book:ch00001')
      assert.equal(bookPackage.chapters[0].content, '这是第一章内容。')
      assert.deepEqual(
        bookPackage.summaries.map((summary) => [summary.chapterId, summary.keyPoints]),
        [
          ['sample-book:ch00001', ['要点一']],
          ['sample-book:ch00002', ['要点二']],
        ],
      )
      assert.deepEqual(bookPackage.embeddings.coverage.summary, {
        embeddedSummaries: 2,
        embeddedChapters: 2,
        totalSummaries: 2,
        totalChapters: 2,
        coverage: 1,
        availableSummaryCoverage: 1,
        models: [{ model: 'fake-embedding', dimension: 3, count: 2 }],
      })
      assert.equal(bookPackage.embeddings.coverage.chunks.embeddedChunks, 2)
      assert.equal(bookPackage.embeddings.coverage.chunks.embeddedChapters, 2)
      assert.deepEqual(
        bookPackage.embeddings.summaries.map((embedding) => [embedding.chapterId, embedding.model, embedding.dimension, embedding.embedding]),
        [
          ['sample-book:ch00001', 'fake-embedding', 3, [1, 2, 3]],
          ['sample-book:ch00002', 'fake-embedding', 3, [1, 2, 3]],
        ],
      )
      assert.deepEqual(
        bookPackage.embeddings.chunks.map((embedding) => [embedding.chapterId, embedding.chapterIndex, embedding.chunkIndex, embedding.text, embedding.embedding]),
        [
          ['sample-book:ch00001', 1, 0, '这是第一章内容。', [1, 2, 3]],
          ['sample-book:ch00002', 2, 0, '这是第二章内容。', [1, 2, 3]],
        ],
      )
      assert.equal(bookPackage.knowledgeGraph.entities.length, 2)
      assert.equal(bookPackage.knowledgeGraph.entityMentions.length, 2)
      assert.equal(bookPackage.knowledgeGraph.relations.length, 1)
      assert.equal(bookPackage.knowledgeGraph.relationMentions.length, 1)
      assert.deepEqual(
        bookPackage.knowledgeGraph.entities.find((entity) => entity.name === '阿甲')?.aliases,
        ['阿甲'],
      )

      const runId = stdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(runId)
      const runJson = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.package.status, 'completed')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('reports book-level embedding coverage against all chapters', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-package-coverage-test-'))
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
      seedEmbeddings(dbPath)
      pruneSecondChapterGeneratedData(dbPath)

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

      const packagePath = stdout.match(/package: (.+)/)?.[1]?.trim()
      assert.ok(packagePath)
      const bookPackage = JSON.parse(await readFile(packagePath, 'utf8'))
      assert.equal(bookPackage.book.summaryCoverage, 0.5)
      assert.equal(bookPackage.book.embeddingCoverage, 0.5)
      assert.equal(bookPackage.embeddings.coverage.summary.coverage, 0.5)
      assert.equal(bookPackage.embeddings.coverage.summary.availableSummaryCoverage, 1)
      assert.equal(bookPackage.embeddings.coverage.chunks.coverage, 0.5)
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
        JSON.stringify({
          schemaVersion: 1,
          books: [
            { id: 'old-book', title: '旧书', chapterCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
            { id: 'sample-book', title: '旧样书', chapterCount: 99, updatedAt: '2026-01-02T00:00:00.000Z' },
          ],
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
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          stages: ['package', 'publish'],
          publish: {
            gatewayDataDir,
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
      assert.deepEqual(mergedCatalog.books.map((book) => book.id).sort(), ['old-book', 'sample-book'])
      assert.equal(mergedCatalog.books.find((book) => book.id === 'old-book')?.title, '旧书')
      assert.equal(mergedCatalog.books.filter((book) => book.id === 'sample-book').length, 1)
      assert.equal(mergedCatalog.books.find((book) => book.id === 'sample-book')?.title, '样书')

      const publishedCatalog = JSON.parse(await readFile(join(gatewayDataDir, 'books.json'), 'utf8'))
      assert.deepEqual(publishedCatalog.books.map((book) => book.id).sort(), ['old-book', 'sample-book'])
      assert.equal(publishedCatalog.books.find((book) => book.id === 'old-book')?.title, '旧书')
      assert.equal(publishedCatalog.books.filter((book) => book.id === 'sample-book').length, 1)
      assert.equal(publishedCatalog.books.find((book) => book.id === 'sample-book')?.title, '样书')
      assert.equal(await fileExists(join(gatewayDataDir, 'books', 'sample-book', 'package.json')), true)

      const { stdout: resumeStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'resume',
        '--run',
        runJsonPath,
      ])

      assert.match(resumeStdout, /skip: package already completed/)
      assert.match(resumeStdout, /skip: publish already completed/)
      assert.match(resumeStdout, /status: completed/)

      const { stdout: statusStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'status',
        '--run',
        runJsonPath,
        '--log-lines',
        '3',
      ])

      assert.match(statusStdout, /run: /)
      assert.match(statusStdout, /status: completed/)
      assert.match(statusStdout, /- package: completed/)
      assert.match(statusStdout, /child:/)
      assert.match(statusStdout, /runJson:/)
      assert.match(statusStdout, /gatewayDataDir:/)
      assert.match(statusStdout, /- publish: completed/)
      assert.match(statusStdout, /logTail:/)

      const { stdout: statusJsonStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'status',
        '--run',
        runJsonPath,
        '--json',
      ])
      assert.equal(JSON.parse(statusJsonStdout).status, 'completed')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('resumes a failed job by skipping completed stages and retrying the failed stage', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-resume-failed-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const gatewayDataDir = join(tempDir, 'gateway-data')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await writeFile(gatewayDataDir, 'not a directory', 'utf8')
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
          },
        }),
        'utf8',
      )

      let failedRun
      try {
        await execFileAsync(process.execPath, [
          cliPath,
          'run',
          '--job',
          jobPath,
          '--run-root',
          runRoot,
        ])
      } catch (error) {
        failedRun = error
      }
      assert.ok(failedRun)
      assert.match(failedRun.message, /Command failed:/)
      assert.match(failedRun.stdout, /completed: package/)
      const parentRunDir = await findRunDir(runRoot, 'sample-book', (runJson) =>
        runJson.status === 'failed' &&
        runJson.stages?.package?.status === 'completed' &&
        runJson.stages?.publish?.status === 'failed'
      )
      const runJsonPath = join(parentRunDir, 'run.json')
      const failedRunJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(failedRunJson.status, 'failed')
      assert.equal(failedRunJson.stages.package.status, 'completed')
      assert.equal(failedRunJson.stages.publish.status, 'failed')
      const packageChildRunJson = failedRunJson.stages.package.childRunJson
      assert.ok(packageChildRunJson)

      await rm(gatewayDataDir, { force: true })
      await mkdir(gatewayDataDir, { recursive: true })
      await writeFile(join(gatewayDataDir, 'books.json'), JSON.stringify({ schemaVersion: 1, books: [] }), 'utf8')

      const { stdout: resumeStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'resume',
        '--run',
        runJsonPath,
      ])

      assert.match(resumeStdout, /skip: package already completed/)
      assert.doesNotMatch(resumeStdout, /completed: package/)
      assert.match(resumeStdout, /completed: publish/)
      assert.match(resumeStdout, /status: completed/)

      const resumedRunJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(resumedRunJson.status, 'completed')
      assert.equal(resumedRunJson.stages.package.status, 'completed')
      assert.equal(resumedRunJson.stages.package.childRunJson, packageChildRunJson)
      assert.equal(resumedRunJson.stages.publish.status, 'completed')
      assert.equal(await fileExists(join(gatewayDataDir, 'books', 'sample-book', 'package.json')), true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('ignores configured bookId for import jobs and persists the imported file book id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-derived-book-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      const sourceText = '第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。'
      await writeFile(txtPath, sourceText, 'utf8')
      const expectedBookId = `file-${createHash('sha256').update(Buffer.from(sourceText)).digest('hex').slice(0, 24)}`
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'stale-config-book-id',
          title: '样书',
          mainDbPath: dbPath,
          source: { type: 'txt', file: txtPath },
          stages: ['import', 'package'],
          import: { replace: true },
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

      assert.match(stdout, /completed: import/)
      assert.match(stdout, /completed: package/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      assert.equal(parentRunDir, join(runRoot, expectedBookId, basename(parentRunDir)))
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(runJson.job.bookId, expectedBookId)
      assert.equal(runJson.stages.import.status, 'completed')
      assert.equal(runJson.stages.package.status, 'completed')
      const persistedJob = JSON.parse(await readFile(jobPath, 'utf8'))
      assert.equal(persistedJob.bookId, expectedBookId)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const book = db.prepare('SELECT id, title, chapter_count FROM books WHERE id = ?').get(expectedBookId)
        assert.equal(book.id, expectedBookId)
        assert.equal(book.title, '样书')
        assert.equal(book.chapter_count, 2)
      } finally {
        db.close()
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('expands embedding stage into chunk and summary embedding stages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-run-embedding-split-test-'))
    let embeddingServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      const sourceText = `第一章 开始\n这是第一章内容。`
      const expectedBookId = `file-${createHash('sha256').update(Buffer.from(sourceText)).digest('hex').slice(0, 24)}`
      await writeFile(txtPath, sourceText, 'utf8')
      embeddingServer = await startFakeEmbeddingServer()
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'embedding', 'package'],
          embedding: {
            provider: 'openai',
            baseUrl: embeddingServer.url,
            model: 'fake-embedding',
            concurrency: 2,
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

      assert.match(stdout, /completed: chunkEmbedding/)
      assert.match(stdout, /completed: summaryEmbedding/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(runJson.job.bookId, expectedBookId)
      assert.equal(runJson.stages.chunkEmbedding.status, 'completed')
      assert.equal(runJson.stages.summaryEmbedding.status, 'completed')
      assert.equal(runJson.stages.package.status, 'completed')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ?').get(expectedBookId).count, 1)
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ?').get(expectedBookId).count, 0)
      } finally {
        db.close()
      }
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('applies llm concurrency to summary and kg stages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-llm-concurrency-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      chatServer = await startFakeChatServer()
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary', 'kg'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 2,
          },
          summary: { limit: 1 },
          kg: { limit: 1 },
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      const summaryReport = JSON.parse(await readFile(join(dirname(runJson.stages.summary.childRunJson), 'artifacts', 'summary-report.json'), 'utf8'))
      const kgReport = JSON.parse(await readFile(join(dirname(runJson.stages.kg.childRunJson), 'artifacts', 'kg-report.json'), 'utf8'))
      assert.equal(summaryReport.concurrency, 2)
      assert.equal(kgReport.concurrency, 2)
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('allocates shared llm concurrency by scheduler weights', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-llm-scheduler-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      chatServer = await startFakeChatServer()
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary', 'kg'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 3,
            scheduler: {
              weights: {
                summary: 3,
                kg: 1,
              },
            },
          },
          summary: { limit: 1 },
          kg: { limit: 1 },
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      const summaryReport = JSON.parse(await readFile(join(dirname(runJson.stages.summary.childRunJson), 'artifacts', 'summary-report.json'), 'utf8'))
      const kgReport = JSON.parse(await readFile(join(dirname(runJson.stages.kg.childRunJson), 'artifacts', 'kg-report.json'), 'utf8'))
      assert.equal(summaryReport.concurrency, 2)
      assert.equal(kgReport.concurrency, 1)
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('queues llm stages when scheduler concurrency is smaller than active stages', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-llm-scheduler-queue-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      chatServer = await startFakeChatServer({ delayMs: 100 })
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary', 'kg'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 1,
            scheduler: {
              weights: {
                summary: 1,
                kg: 1,
              },
            },
          },
          summary: { limit: 1 },
          kg: { limit: 1 },
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.ok(
        new Date(runJson.stages.kg.startedAt).getTime() >= new Date(runJson.stages.summary.finishedAt).getTime(),
        'kg should wait until summary releases the only llm scheduler slot',
      )
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('can reserve idle llm scheduler shares when borrowIdle is disabled', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-llm-scheduler-reserve-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      chatServer = await startFakeChatServer()
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 4,
            scheduler: {
              borrowIdle: false,
              weights: {
                summary: 1,
                kg: 3,
              },
            },
          },
          summary: { limit: 1 },
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      const summaryReport = JSON.parse(await readFile(join(dirname(runJson.stages.summary.childRunJson), 'artifacts', 'summary-report.json'), 'utf8'))
      assert.equal(summaryReport.concurrency, 1)
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs audio with initial parallel stages even when it follows embedding in the job', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-audio-after-embedding-test-'))
    let chatServer
    let embeddingServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const ttsOutRoot = join(tempDir, 'generated-tts')
      const fakeDirectorPath = join(tempDir, 'fake-tts-director.mjs')
      const fakeConfigPath = join(tempDir, 'fake-tts-config.json')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      await writeFile(fakeConfigPath, JSON.stringify({ ok: true, fakeDelayMs: 500 }), 'utf8')
      await writeFile(fakeDirectorPath, fakeTtsDirectorSource(), 'utf8')
      chatServer = await startFakeChatServer()
      embeddingServer = await startFakeEmbeddingServer()
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary', 'kg', 'embedding', 'audio'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 10,
            scheduler: {
              weights: {
                summary: 3,
                kg: 3,
                audio: 4,
              },
            },
          },
          summary: { limit: 1 },
          kg: { limit: 1 },
          embedding: {
            provider: 'openai-compatible',
            baseUrl: embeddingServer.url,
            model: 'fake-embedding',
            concurrency: 2,
          },
          audio: {
            ttsConfig: fakeConfigPath,
            ttsDirectorScript: fakeDirectorPath,
            ttsOutRoot,
            chapters: '1',
            llmChapters: 2,
            resume: true,
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.audio.status, 'completed')
      assert.equal(runJson.stages.summaryEmbedding.status, 'completed')
      assert.ok(
        new Date(runJson.stages.audio.startedAt).getTime() <= new Date(runJson.stages.summaryEmbedding.startedAt).getTime(),
        'audio should start before summaryEmbedding even when audio is listed after embedding',
      )
      const summaryReport = JSON.parse(await readFile(join(dirname(runJson.stages.summary.childRunJson), 'artifacts', 'summary-report.json'), 'utf8'))
      const kgReport = JSON.parse(await readFile(join(dirname(runJson.stages.kg.childRunJson), 'artifacts', 'kg-report.json'), 'utf8'))
      const audioRunJson = JSON.parse(await readFile(runJson.stages.audio.childRunJson, 'utf8'))
      const ttsArgs = JSON.parse(await readFile(join(audioRunJson.stages.audio.artifacts.ttsSourceRoot, 'args.json'), 'utf8'))
      const ttsConfig = JSON.parse(await readFile(join(audioRunJson.stages.audio.artifacts.ttsSourceRoot, 'config.json'), 'utf8'))
      const finalAudioControl = JSON.parse(await readFile(join(audioRunJson.stages.audio.artifacts.ttsSourceRoot, 'control-final.json'), 'utf8'))
      assert.equal(summaryReport.concurrency, 3)
      assert.equal(kgReport.concurrency, 3)
      assert.equal(ttsConfig.llm.baseUrl, chatServer.url)
      assert.equal(ttsConfig.llm.model_name, 'fake-chat')
      assert.equal(ttsConfig.llm.apiKeyEnv, 'LLM_API_KEY')
      assert.equal(ttsConfig.llm.apiKey, undefined)
      assert.equal(ttsArgs['director-concurrency'], '2')
      assert.equal(ttsArgs['llm-chapters'], '2')
      assert.ok(ttsArgs['control-file'])
      assert.equal(finalAudioControl.directorConcurrency, 5)
      assert.equal(finalAudioControl.llmChapters, 2)
    } finally {
      if (chatServer) await chatServer.close()
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs scheduled audio production after sharing the llm pool', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-audio-parallel-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const ttsOutRoot = join(tempDir, 'generated-tts')
      const fakeDirectorPath = join(tempDir, 'fake-tts-director.mjs')
      const fakeConfigPath = join(tempDir, 'fake-tts-config.json')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      await writeFile(fakeConfigPath, JSON.stringify({ ok: true }), 'utf8')
      await writeFile(fakeDirectorPath, fakeTtsDirectorSource(), 'utf8')
      chatServer = await startFakeChatServer({ delayMs: 1500 })
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          source: { file: txtPath },
          stages: ['import', 'summary', 'audio'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 1,
            scheduler: {
              weights: {
                summary: 4,
                audio: 1,
              },
            },
          },
          summary: { limit: 1 },
          audio: {
            ttsConfig: fakeConfigPath,
            ttsDirectorScript: fakeDirectorPath,
            ttsOutRoot,
            chapters: '1',
            resume: true,
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

      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.summary.status, 'completed')
      assert.equal(runJson.stages.audio.status, 'completed')
      assert.ok(runJson.stages.summary.childRunJson)
      assert.ok(runJson.stages.audio.childRunJson)
      assert.match(await readFile(join(parentRunDir, runJson.stages.audio.logFile), 'utf8'), /fake director start/)
      assert.ok(
        new Date(runJson.stages.audio.startedAt).getTime() >= new Date(runJson.stages.summary.finishedAt).getTime(),
        'audio should wait for summary when both stages share a single llm scheduler slot',
      )
    } finally {
      if (chatServer) await chatServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs summary as an independent job stage and records child artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-summary-stage-test-'))
    let chatServer
    try {
      chatServer = await startFakeChatServer()
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
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
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          stages: ['summary'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 2,
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

      assert.match(stdout, /completed: summary/)
      assert.match(stdout, /status: completed/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const parentRunJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(parentRunJson.status, 'completed')
      assert.deepEqual(Object.keys(parentRunJson.stages), ['summary'])
      assert.equal(parentRunJson.stages.summary.status, 'completed')
      assert.ok(parentRunJson.stages.summary.childRunJson)
      assert.ok(parentRunJson.stages.summary.logFile)

      const childRunJson = JSON.parse(await readFile(parentRunJson.stages.summary.childRunJson, 'utf8'))
      assert.equal(childRunJson.command, 'summary')
      assert.equal(childRunJson.status, 'completed')
      assert.equal(childRunJson.stages.summary.status, 'completed')
      const summaryReport = JSON.parse(await readFile(join(dirname(parentRunJson.stages.summary.childRunJson), 'artifacts', 'summary-report.json'), 'utf8'))
      assert.equal(summaryReport.targetChapters, 2)
      assert.equal(summaryReport.completed, 2)
      assert.equal(summaryReport.failed, 0)
      assert.equal(summaryReport.concurrency, 2)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = db.prepare('SELECT chapter_id AS chapterId, short FROM summaries ORDER BY chapter_id').all().map(plainRow)
        assert.deepEqual(rows, [
          { chapterId: 'sample-book:ch00001', short: '本章概要' },
          { chapterId: 'sample-book:ch00002', short: '本章概要' },
        ])
      } finally {
        db.close()
      }
    } finally {
      await chatServer?.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs kg as an independent job stage and records child artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-kg-stage-test-'))
    let chatServer
    try {
      chatServer = await startFakeChatServer()
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n阿甲在长安帮助乙门。\n\n第二章 继续\n阿甲再次来到长安。`, 'utf8')
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
          stages: ['kg'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 2,
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

      assert.match(stdout, /completed: kg/)
      assert.match(stdout, /status: completed/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const parentRunJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(parentRunJson.status, 'completed')
      assert.deepEqual(Object.keys(parentRunJson.stages), ['kg'])
      assert.equal(parentRunJson.stages.kg.status, 'completed')
      assert.ok(parentRunJson.stages.kg.childRunJson)
      assert.ok(parentRunJson.stages.kg.logFile)

      const childRunJson = JSON.parse(await readFile(parentRunJson.stages.kg.childRunJson, 'utf8'))
      assert.equal(childRunJson.command, 'kg')
      assert.equal(childRunJson.status, 'completed')
      assert.equal(childRunJson.stages.kg.status, 'completed')
      const kgReport = JSON.parse(await readFile(join(dirname(parentRunJson.stages.kg.childRunJson), 'artifacts', 'kg-report.json'), 'utf8'))
      assert.equal(kgReport.targetChapters, 2)
      assert.equal(kgReport.completed, 2)
      assert.equal(kgReport.failed, 0)
      assert.equal(kgReport.entityMentions, 4)
      assert.equal(kgReport.relationMentions, 2)
      assert.equal(kgReport.concurrency, 2)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const extractionCount = db.prepare('SELECT COUNT(*) AS count FROM kg_chapter_extractions WHERE book_id = ? AND status = ?')
          .get('sample-book', 'completed').count
        const entityCount = db.prepare('SELECT COUNT(*) AS count FROM kg_entities WHERE book_id = ?').get('sample-book').count
        const relationCount = db.prepare('SELECT COUNT(*) AS count FROM kg_relations WHERE book_id = ?').get('sample-book').count
        assert.equal(extractionCount, 2)
        assert.equal(entityCount, 2)
        assert.equal(relationCount, 1)
      } finally {
        db.close()
      }
    } finally {
      await chatServer?.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs embedding as independent job stages and records child artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-embedding-stage-test-'))
    let embeddingServer
    try {
      embeddingServer = await startFakeEmbeddingServer()
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
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
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          stages: ['embedding'],
          embedding: {
            provider: 'openai',
            baseUrl: embeddingServer.url,
            model: 'fake-embedding',
            concurrency: 2,
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

      assert.match(stdout, /completed: chunkEmbedding/)
      assert.match(stdout, /completed: summaryEmbedding/)
      assert.match(stdout, /status: completed/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const parentRunJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(parentRunJson.status, 'completed')
      assert.deepEqual(Object.keys(parentRunJson.stages), ['chunkEmbedding', 'summaryEmbedding'])
      assert.equal(parentRunJson.stages.chunkEmbedding.status, 'completed')
      assert.equal(parentRunJson.stages.summaryEmbedding.status, 'completed')
      assert.ok(parentRunJson.stages.chunkEmbedding.childRunJson)
      assert.ok(parentRunJson.stages.summaryEmbedding.childRunJson)

      const chunkChildRunJson = JSON.parse(await readFile(parentRunJson.stages.chunkEmbedding.childRunJson, 'utf8'))
      const summaryChildRunJson = JSON.parse(await readFile(parentRunJson.stages.summaryEmbedding.childRunJson, 'utf8'))
      assert.equal(chunkChildRunJson.command, 'embedding')
      assert.equal(summaryChildRunJson.command, 'embedding')
      assert.equal(chunkChildRunJson.status, 'completed')
      assert.equal(summaryChildRunJson.status, 'completed')
      const chunkReport = JSON.parse(await readFile(join(dirname(parentRunJson.stages.chunkEmbedding.childRunJson), 'artifacts', 'embedding-report.json'), 'utf8'))
      const summaryReport = JSON.parse(await readFile(join(dirname(parentRunJson.stages.summaryEmbedding.childRunJson), 'artifacts', 'embedding-report.json'), 'utf8'))
      assert.equal(chunkReport.mode, 'chunks')
      assert.equal(chunkReport.targetChapters, 2)
      assert.equal(chunkReport.completed, 2)
      assert.equal(chunkReport.chunkCompleted, 2)
      assert.equal(summaryReport.mode, 'summaries')
      assert.equal(summaryReport.targetChapters, 2)
      assert.equal(summaryReport.completed, 2)
      assert.equal(summaryReport.chunkCompleted, 0)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const summaryCount = db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ? AND model = ?')
          .get('sample-book', 'fake-embedding').count
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ? AND model = ?')
          .get('sample-book', 'fake-embedding').count
        assert.equal(summaryCount, 2)
        assert.equal(chunkCount, 2)
      } finally {
        db.close()
      }
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs audio as an independent job stage and records child artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-audio-stage-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const ttsOutRoot = join(tempDir, 'generated-tts')
      const fakeDirectorPath = join(tempDir, 'fake-tts-director.mjs')
      const fakeConfigPath = join(tempDir, 'fake-tts-config.json')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await writeFile(fakeConfigPath, JSON.stringify({ ok: true }), 'utf8')
      await writeFile(fakeDirectorPath, fakeTtsDirectorSource(), 'utf8')
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
          stages: ['audio'],
          audio: {
            ttsConfig: fakeConfigPath,
            ttsDirectorScript: fakeDirectorPath,
            ttsOutRoot,
            chapters: '1-2',
            resume: true,
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

      assert.match(stdout, /completed: audio/)
      assert.match(stdout, /status: completed/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      assert.ok(parentRunDir)
      const parentRunJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      assert.equal(parentRunJson.status, 'completed')
      assert.deepEqual(Object.keys(parentRunJson.stages), ['audio'])
      assert.equal(parentRunJson.stages.audio.status, 'completed')
      assert.ok(parentRunJson.stages.audio.childRunJson)
      assert.ok(parentRunJson.stages.audio.logFile)

      const childRunDir = dirname(parentRunJson.stages.audio.childRunJson)
      const childRunJson = JSON.parse(await readFile(parentRunJson.stages.audio.childRunJson, 'utf8'))
      assert.equal(childRunJson.command, 'audio')
      assert.equal(childRunJson.status, 'completed')
      assert.equal(childRunJson.stages.audio.status, 'completed')
      const audioCatalogPath = join(childRunDir, childRunJson.stages.audio.artifacts.audioCatalog)
      const audioCatalog = JSON.parse(await readFile(audioCatalogPath, 'utf8'))
      assert.deepEqual(audioCatalog.chapters.map((chapter) => chapter.chapterId), [
        'sample-book:ch00001',
        'sample-book:ch00002',
      ])
      assert.equal(audioCatalog.chapters[0].timelineVersion, 2)
      assert.equal(audioCatalog.chapters[0].durationMs, 1000)
      assert.equal(audioCatalog.chapters[1].durationMs, 2000)
      assert.equal(await fileExists(join(dirname(audioCatalogPath), audioCatalog.chapters[0].fileName)), true)
      assert.equal(await fileExists(join(ttsOutRoot, 'ch001-full', 'audio', 'chapter.mp3')), true)
      assert.match(await readFile(join(childRunDir, 'artifacts', 'tts-director.log'), 'utf8'), /fake director start/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('records child log metadata while a child stage is still running', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-running-child-test-'))
    let chatServer
    let child
    try {
      chatServer = await startFakeChatServer({ delayMs: 1500 })
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
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
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: dbPath,
          stages: ['summary'],
          summary: {
            baseUrl: chatServer.url,
            model: 'fake-chat',
            concurrency: 1,
            limit: 1,
            timeoutMs: 5000,
          },
        }),
        'utf8',
      )

      const output = { stdout: '', stderr: '' }
      child = spawn(process.execPath, [cliPath, 'run', '--job', jobPath, '--run-root', runRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (chunk) => {
        output.stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        output.stderr += chunk.toString()
      })

      const runJsonPath = await waitFor(async () => {
        const bookRunRoot = join(runRoot, 'sample-book')
        const runIds = await readdir(bookRunRoot).catch(() => [])
        for (const runId of runIds.sort().reverse()) {
          const candidate = join(bookRunRoot, runId, 'run.json')
          const runJson = await readJsonIfExists(candidate)
          if (runJson?.stages?.summary?.status === 'running' && runJson.stages.summary.logFile) {
            return candidate
          }
        }
        return null
      }, { timeoutMs: 3000 })

      const parentRunDir = dirname(runJsonPath)
      const runningRunJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(runningRunJson.status, 'running')
      assert.equal(runningRunJson.stages.summary.status, 'running')
      assert.ok(runningRunJson.stages.summary.logFile)
      assert.equal(await fileExists(join(parentRunDir, runningRunJson.stages.summary.logFile)), true)

      const { stdout: statusStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'status',
        '--run',
        runJsonPath,
      ])
      assert.match(statusStdout, /- summary: running/)
      assert.match(statusStdout, /log: /)

      const exit = await waitForProcess(child)
      child = null
      assert.equal(exit.code, 0, `${output.stdout}\n${output.stderr}`)
      const completedRunJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(completedRunJson.status, 'completed')
      assert.equal(completedRunJson.stages.summary.status, 'completed')
    } finally {
      if (child && !child.killed) child.kill()
      await chatServer?.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps child log metadata when a child stage fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-failed-child-test-'))
    try {
      const runRoot = join(tempDir, 'runs')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'missing-book',
          title: '缺失书',
          mainDbPath: join(tempDir, 'missing.sqlite'),
          stages: ['package'],
        }),
        'utf8',
      )

      await assert.rejects(
        () => execFileAsync(process.execPath, [
          cliPath,
          'run',
          '--job',
          jobPath,
          '--run-root',
          runRoot,
        ]),
        /Command failed:/,
      )

      const bookRunRoot = join(runRoot, 'missing-book')
      const runId = (await readdir(bookRunRoot)).sort().at(-1)
      const runJsonPath = join(bookRunRoot, runId, 'run.json')
      const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
      assert.equal(runJson.status, 'failed')
      assert.equal(runJson.stages.package.status, 'failed')
      assert.ok(runJson.stages.package.logFile)
      const logText = await readFile(join(dirname(runJsonPath), runJson.stages.package.logFile), 'utf8')
      assert.match(logText, /Book not found|no such table|SQLITE_ERROR|unable to open database file/)

      const { stdout: statusStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'status',
        '--run',
        runJsonPath,
        '--log-lines',
        '5',
      ])
      assert.match(statusStdout, /- package: failed/)
      assert.match(statusStdout, /logTail:/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preflights a job config before a long run', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-doctor-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const jobPath = join(tempDir, 'job.json')
      const badJobPath = join(tempDir, 'bad-job.json')
      const ttsConfigPath = join(tempDir, 'tts-config.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await writeFile(ttsConfigPath, JSON.stringify({ ok: true }), 'utf8')
      await writeFile(
        jobPath,
        JSON.stringify({
          bookId: 'sample-book',
          title: '样书',
          mainDbPath: join(tempDir, 'main.sqlite'),
          source: { type: 'txt', file: txtPath },
          stages: ['import', 'summary', 'kg', 'embedding', 'audio', 'package', 'publish', 'verify'],
          llm: {
            provider: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:30000/v1',
            model: 'fake-chat',
          },
          embedding: {
            provider: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:30001/v1',
            model: 'fake-embedding',
          },
          audio: {
            ttsConfig: ttsConfigPath,
          },
          gateway: {
            host: '127.0.0.1',
            user: 'gwaves',
            url: 'https://127.0.0.1:8888',
            token: 'dev-token',
          },
        }),
        'utf8',
      )

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'doctor',
        '--job',
        jobPath,
      ])
      assert.match(stdout, /checks: \d+\/\d+/)
      assert.match(stdout, /ok: import.sourceFile.exists/)
      assert.match(stdout, /ok: audio.ttsConfig.exists/)
      assert.match(stdout, /ok: verify.gatewayToken/)

      const { stdout: jsonStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'doctor',
        '--job',
        jobPath,
        '--json',
      ])
      assert.equal(JSON.parse(jsonStdout).ok, true)

      await writeFile(
        badJobPath,
        JSON.stringify({
          bookId: 'bad-book',
          source: { type: 'txt', file: join(tempDir, 'missing.txt') },
          stages: ['import', 'verify'],
          gateway: { url: 'https://127.0.0.1:8888' },
        }),
        'utf8',
      )
      await assert.rejects(
        () => execFileAsync(process.execPath, [cliPath, 'doctor', '--job', badJobPath]),
        /Doctor failed: \d+ check\(s\) failed\./,
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('reports missing job fields and stage configuration in one doctor pass', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-doctor-missing-test-'))
    try {
      const missingStagesJobPath = join(tempDir, 'missing-stages-job.json')
      const incompleteJobPath = join(tempDir, 'incomplete-job.json')
      await writeFile(
        missingStagesJobPath,
        JSON.stringify({
          title: '缺阶段',
          mainDbPath: join(tempDir, 'missing-main.sqlite'),
        }),
        'utf8',
      )
      await writeFile(
        incompleteJobPath,
        JSON.stringify({
          title: '缺配置',
          mainDbPath: join(tempDir, 'missing-main.sqlite'),
          stages: ['summary', 'publish', 'verify'],
          gateway: {
            url: 'https://127.0.0.1:8888',
          },
        }),
        'utf8',
      )

      const missingStagesError = await captureRejectedExec(process.execPath, [cliPath, 'doctor', '--job', missingStagesJobPath])
      assert.match(missingStagesError.message, /Doctor failed: \d+ check\(s\) failed\./)
      const missingStagesStdout = missingStagesError.stdout
      assert.match(missingStagesStdout, /fail: job\.bookId - missing/)
      assert.match(missingStagesStdout, /fail: job\.stages - missing/)

      const incompleteError = await captureRejectedExec(process.execPath, [cliPath, 'doctor', '--job', incompleteJobPath])
      assert.match(incompleteError.message, /Doctor failed: \d+ check\(s\) failed\./)
      const stdout = incompleteError.stdout
      assert.match(stdout, /fail: job\.bookId - missing/)
      assert.match(stdout, /fail: mainDb\.exists/)
      assert.match(stdout, /fail: stage\.summary\.config - summary stage requires job\.llm\.baseUrl or job\.summary\.baseUrl/)
      assert.match(stdout, /fail: publish\.target - missing/)
      assert.match(stdout, /ok: verify\.gatewayUrl - https:\/\/127\.0\.0\.1:8888/)
      assert.match(stdout, /fail: verify\.gatewayToken - missing/)

      const error = await captureRejectedExec(process.execPath, [cliPath, 'doctor', '--job', incompleteJobPath, '--json'])
      assert.match(error.message, /Doctor failed: \d+ check\(s\) failed\./)
      const report = JSON.parse(error.stdout)
      assert.equal(report.ok, false)
      const failedCheckNames = report.checks.filter((check) => !check.ok).map((check) => check.name)
      assert.ok(failedCheckNames.includes('job.bookId'))
      assert.ok(failedCheckNames.includes('stage.summary.config'))
      assert.ok(failedCheckNames.includes('publish.target'))
      assert.ok(failedCheckNames.includes('verify.gatewayToken'))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preflights Ollama embedding model names before running', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-doctor-ollama-test-'))
    let embeddingServer
    try {
      embeddingServer = await startFakeOllamaEmbeddingServer({ models: ['qwen3-embedding:8b'] })
      const dbPath = join(tempDir, 'main.sqlite')
      const jobPath = join(tempDir, 'job.json')
      const badJobPath = join(tempDir, 'bad-job.json')
      await writeFile(dbPath, '')
      const baseJob = {
        bookId: 'sample-book',
        title: '样书',
        mainDbPath: dbPath,
        stages: ['embedding'],
        embedding: {
          provider: 'ollama',
          baseUrl: embeddingServer.url,
          model: 'qwen3-embedding:8b',
        },
      }
      await writeFile(jobPath, JSON.stringify(baseJob), 'utf8')
      await writeFile(
        badJobPath,
        JSON.stringify({
          ...baseJob,
          embedding: { ...baseJob.embedding, model: 'qwen3-embedding-8:b' },
        }),
        'utf8',
      )

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'doctor',
        '--job',
        jobPath,
      ])
      assert.match(stdout, /ok: embedding\.ollama\.model - qwen3-embedding:8b/)

      await assert.rejects(
        () => execFileAsync(process.execPath, [cliPath, 'doctor', '--job', badJobPath]),
        /Doctor failed: 1 check\(s\) failed\./,
      )
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('merges gateway defaults with publish and verify overrides', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-gateway-merge-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const gatewayDataDir = join(tempDir, 'gateway-data')
      const jobPath = join(tempDir, 'job.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。`, 'utf8')
      await mkdir(gatewayDataDir, { recursive: true })
      await writeFile(join(gatewayDataDir, 'books.json'), JSON.stringify({ schemaVersion: 1, books: [] }), 'utf8')
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
          gateway: {
            gatewayDataDir,
            url: 'https://127.0.0.1:8888',
            token: 'dev-token',
          },
          publish: {
            dryRun: true,
          },
        }),
        'utf8',
      )

      const { stdout: doctorStdout } = await execFileAsync(process.execPath, [
        cliPath,
        'doctor',
        '--job',
        jobPath,
      ])
      assert.match(doctorStdout, /ok: publish.target/)

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'run',
        '--job',
        jobPath,
        '--run-root',
        runRoot,
      ])
      assert.match(stdout, /completed: publish/)
      const parentRunDir = stdout.match(/runDir: (.+)/)?.[1]?.trim()
      const runJson = JSON.parse(await readFile(join(parentRunDir, 'run.json'), 'utf8'))
      const publishLog = await readFile(join(parentRunDir, runJson.stages.publish.childRuns[0].logFile), 'utf8')
      assert.match(publishLog, new RegExp(escapeRegExp(gatewayDataDir)))
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
        ['sample-book:ch00001', 'sample-book:ch00002'],
      )
      assert.equal(catalog.chapters[0].timelineVersion, 2)
      assert.equal(catalog.chapters[0].durationMs, 1250)
      assert.equal(catalog.chapters[1].timelineVersion, 3)
      assert.equal(catalog.chapters[1].durationMs, 2500)
      assert.match(catalog.chapters[0].fileName, /^ch001-sample-book-ch00001\//)
      assert.equal(await fileExists(join(dirname(catalogPath), catalog.chapters[0].fileName)), true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('generates TTS source audio before packaging Gateway audio artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-audio-tts-test-'))
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      const ttsOutRoot = join(tempDir, 'generated-tts')
      const fakeDirectorPath = join(tempDir, 'fake-tts-director.mjs')
      const fakeConfigPath = join(tempDir, 'fake-tts-config.json')
      const controlPath = join(tempDir, 'audio-control.json')
      await writeFile(txtPath, `第一章 开始\n这是第一章内容。\n\n第二章 继续\n这是第二章内容。`, 'utf8')
      await writeFile(fakeConfigPath, JSON.stringify({ ok: true }), 'utf8')
      await writeFile(controlPath, JSON.stringify({ ttsChapters: 4 }), 'utf8')
      await writeFile(fakeDirectorPath, fakeTtsDirectorSource(), 'utf8')
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
        '--tts-config',
        fakeConfigPath,
        '--tts-director-script',
        fakeDirectorPath,
        '--tts-out-root',
        ttsOutRoot,
        '--chapters',
        '1-2',
        '--control-file',
        controlPath,
        '--resume',
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
        ['sample-book:ch00001', 'sample-book:ch00002'],
      )
      assert.equal(await fileExists(join(ttsOutRoot, 'ch001-full', 'audio', 'chapter.mp3')), true)
      assert.equal(await fileExists(join(dirname(catalogPath), catalog.chapters[0].fileName)), true)
      const runId = stdout.match(/run: (.+)/)?.[1]?.trim()
      assert.ok(runId)
      const runJson = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.audio.artifacts.ttsSourceRoot, ttsOutRoot)
      assert.equal(runJson.stages.audio.status, 'completed')
      assert.match(await readFile(join(runRoot, 'sample-book', runId, 'artifacts', 'tts-director.log'), 'utf8'), /fake director start/)
      const directorArgs = JSON.parse(await readFile(join(ttsOutRoot, 'args.json'), 'utf8'))
      assert.equal(directorArgs['control-file'], controlPath)
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
      const audioCatalog = {
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'sample-book:ch00001',
            title: '第一章 开始',
            fileName: 'ch001-1/chapter.mp3',
            manifestFileName: 'ch001-1/manifest.json',
            timelineVersion: 2,
            durationMs: 1000,
            sizeBytes: 13,
          },
        ],
      }
      await mkdir(join(runRoot, 'sample-book', runId, 'artifacts', 'gateway-audio', 'books', 'sample-book'), { recursive: true })
      await writeFile(
        join(runRoot, 'sample-book', runId, 'artifacts', 'gateway-audio', 'books', 'sample-book', 'audio.json'),
        JSON.stringify(audioCatalog),
        'utf8',
      )
      gateway = await startFakeGateway({
        token: 'dev-token',
        adminToken: 'admin-token',
        bookPackage,
        audioCatalog,
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
        '--gateway-admin-token',
        'admin-token',
      ])

      assert.match(stdout, /checks: 29\/29/)
      const runJson = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'run.json'), 'utf8'))
      assert.equal(runJson.stages.verify.status, 'completed')
      const report = JSON.parse(await readFile(join(runRoot, 'sample-book', runId, 'artifacts', 'verify-report.json'), 'utf8'))
      assert.equal(report.ok, true)
      const checksByName = new Map(report.checks.map((check) => [check.name, check]))
      assert.equal(checksByName.get('audio.durationMs.sample-book:ch00001')?.ok, true)
      assert.equal(checksByName.get('audio.sizeBytes.sample-book:ch00001')?.ok, true)
      assert.equal(checksByName.get('audio.manifestTimelineVersion.sample-book:ch00001')?.ok, true)
      assert.equal(checksByName.get('audio.download.sample-book:ch00001')?.ok, true)
      assert.equal(checksByName.get('audio.downloadSize.sample-book:ch00001')?.ok, true)
      assert.equal(checksByName.get('adminBooks.bookListed')?.ok, true)
      assert.equal(checksByName.get('mobileSession.allowedVisibilities')?.ok, true)
      assert.equal(checksByName.get('library.visibilityConsistent')?.ok, true)
      assert.equal(checksByName.get('adminAudio.refresh.bookId')?.ok, true)
      assert.equal(checksByName.get('adminAudio.refresh.audioChapterCount')?.ok, true)
      assert.equal(checksByName.get('adminAudio.refresh.missingChapterCount')?.ok, true)
      assert.equal(checksByName.get('adminAudio.refresh.totalSizeBytes')?.ok, true)
      assert.equal(checksByName.get('adminAudio.list.bookListed')?.ok, true)
      assert.equal(checksByName.get('adminAudio.list.audioChapterCount')?.ok, true)
      assert.deepEqual(gateway.requests.filter((request) => request.url.startsWith('/mobile/books') && request.url.includes('/audio/')).map((request) => request.url).sort(), [
        '/mobile/books/sample-book/audio/sample-book%3Ach00001/download',
        '/mobile/books/sample-book/audio/sample-book%3Ach00001/manifest',
      ].sort())
      assert.deepEqual(gateway.requests.filter((request) => request.url.startsWith('/admin')).map((request) => `${request.method} ${request.url}`), [
        'GET /admin/books',
        'POST /admin/books/sample-book/audio/refresh',
        'GET /admin/audio',
      ])
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

      assert.match(stdout, /embedding start: 0\/2 completed=0 failed=0 chunkCompleted=0 chunkFailed=0/)
      assert.match(stdout, /embedding finish: 2\/2 completed=2 failed=0 chunkCompleted=2 chunkFailed=0/)
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

  it('generates chunk embeddings without waiting for summaries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-chunk-embedding-test-'))
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
      embeddingServer = await startFakeEmbeddingServer()

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'embedding',
        '--mode',
        'chunks',
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

      assert.match(stdout, /mode: chunks/)
      assert.match(stdout, /embedding targets: 2/)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const summaryCount = db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ?').get('sample-book').count
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ?').get('sample-book').count
        assert.equal(summaryCount, 0)
        assert.equal(chunkCount, 2)
      } finally {
        db.close()
      }
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('generates embeddings through the Ollama embedding API shape', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-ollama-embedding-test-'))
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
      embeddingServer = await startFakeOllamaEmbeddingServer()

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'embedding',
        '--book-id',
        'sample-book',
        '--provider',
        'ollama',
        '--base-url',
        embeddingServer.url,
        '--model',
        'qwen3-embedding:8b',
        '--limit',
        '1',
        '--main-db',
        dbPath,
        '--run-root',
        runRoot,
      ])

      assert.match(stdout, /embedding targets: 1/)
      assert.match(stdout, /embedding finish: 1\/1 completed=1 failed=0 chunkCompleted=1 chunkFailed=0/)
      assert.equal(embeddingServer.requests.length, 2)
      assert.deepEqual(
        [...new Set(embeddingServer.requests.map((request) => request.model))],
        ['qwen3-embedding:8b'],
      )
      assert.ok(embeddingServer.requests.every((request) => request.prompt && !('input' in request)))
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const summaryCount = db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ? AND model = ?')
          .get('sample-book', 'qwen3-embedding:8b').count
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ? AND model = ?')
          .get('sample-book', 'qwen3-embedding:8b').count
        assert.equal(summaryCount, 1)
        assert.equal(chunkCount, 1)
      } finally {
        db.close()
      }
    } finally {
      if (embeddingServer) await embeddingServer.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('generates knowledge graph rows directly into the main DB without a local API service', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'production-pipeline-kg-test-'))
    let chatServer
    try {
      const txtPath = join(tempDir, 'sample.txt')
      const dbPath = join(tempDir, 'main.sqlite')
      const runRoot = join(tempDir, 'runs')
      await writeFile(txtPath, `第一章 开始\n阿甲在长安帮助乙门。\n\n第二章 继续\n阿甲再次来到长安。`, 'utf8')
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
        'kg',
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

      assert.match(stdout, /kg start: 0\/2 completed=0 failed=0 entityMentions=0 relationMentions=0/)
      assert.match(stdout, /kg finish: 2\/2 completed=2 failed=0 entityMentions=4 relationMentions=2/)
      assert.match(stdout, /kg targets: 2/)
      assert.match(stdout, /completed: 2/)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const extractionCount = db.prepare('SELECT COUNT(*) AS count FROM kg_chapter_extractions WHERE book_id = ? AND status = ?')
          .get('sample-book', 'completed').count
        const entityCount = db.prepare('SELECT COUNT(*) AS count FROM kg_entities WHERE book_id = ?').get('sample-book').count
        const relationCount = db.prepare('SELECT COUNT(*) AS count FROM kg_relations WHERE book_id = ?').get('sample-book').count
        assert.equal(extractionCount, 2)
        assert.equal(entityCount, 2)
        assert.equal(relationCount, 1)
      } finally {
        db.close()
      }
    } finally {
      if (chatServer) await chatServer.close()
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

      assert.match(stdout, /summary start: 0\/2 completed=0 failed=0/)
      assert.match(stdout, /summary finish: 2\/2 completed=2 failed=0/)
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    insert.run('sample-book:ch00001', '短摘要一', '详细摘要一', JSON.stringify(['要点一']))
    insert.run('sample-book:ch00002', '短摘要二', '详细摘要二', JSON.stringify(['要点二']))
  } finally {
    db.close()
  }
}

function seedEmbeddings(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_embeddings (
        chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
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
    `)
    const insertSummary = db.prepare(`
      INSERT INTO summary_embeddings (chapter_id, book_id, model, dimension, embedding_json, generated_at)
      VALUES (?, 'sample-book', 'fake-embedding', 3, '[1,2,3]', CURRENT_TIMESTAMP)
    `)
    insertSummary.run('sample-book:ch00001')
    insertSummary.run('sample-book:ch00002')
    const insertChunk = db.prepare(`
      INSERT INTO chapter_chunk_embeddings (
        id, book_id, chapter_id, chapter_index, chunk_index, start_offset, end_offset, text, model, dimension, embedding_json, generated_at
      )
      VALUES (?, 'sample-book', ?, ?, 0, 0, 8, ?, 'fake-embedding', 3, '[1,2,3]', CURRENT_TIMESTAMP)
    `)
    insertChunk.run('sample-book:ch00001:0:fake-embedding', 'sample-book:ch00001', 1, '这是第一章内容。')
    insertChunk.run('sample-book:ch00002:0:fake-embedding', 'sample-book:ch00002', 2, '这是第二章内容。')
  } finally {
    db.close()
  }
}

function pruneSecondChapterGeneratedData(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('DELETE FROM summaries WHERE chapter_id = ?').run('sample-book:ch00002')
    db.prepare('DELETE FROM summary_embeddings WHERE chapter_id = ?').run('sample-book:ch00002')
    db.prepare('DELETE FROM chapter_chunk_embeddings WHERE chapter_id = ?').run('sample-book:ch00002')
  } finally {
    db.close()
  }
}

function seedKnowledgeGraph(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
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
    `)
    db.prepare(`
      INSERT INTO kg_entities (
        id, book_id, type, name, normalized_name, aliases_json, description, confidence,
        first_chapter_index, last_chapter_index, updated_at
      )
      VALUES (?, 'sample-book', ?, ?, ?, ?, ?, 0.9, 1, 2, CURRENT_TIMESTAMP)
    `).run('entity-a', 'person', '阿甲', '阿甲', JSON.stringify(['阿甲']), '主角')
    db.prepare(`
      INSERT INTO kg_entities (
        id, book_id, type, name, normalized_name, aliases_json, description, confidence,
        first_chapter_index, last_chapter_index, updated_at
      )
      VALUES (?, 'sample-book', ?, ?, ?, ?, ?, 0.8, 1, 1, CURRENT_TIMESTAMP)
    `).run('entity-b', 'organization', '乙门', '乙门', JSON.stringify(['乙门']), '门派')
    db.prepare(`
      INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence)
      VALUES (?, ?, 'sample-book', ?, ?, ?, 0.9)
    `).run('mention-a', 'entity-a', 'sample-book:ch00001', 1, '阿甲出现')
    db.prepare(`
      INSERT INTO kg_entity_mentions (id, entity_id, book_id, chapter_id, chapter_index, evidence, confidence)
      VALUES (?, ?, 'sample-book', ?, ?, ?, 0.8)
    `).run('mention-b', 'entity-b', 'sample-book:ch00001', 1, '乙门出现')
    db.prepare(`
      INSERT INTO kg_relations (
        id, book_id, source_entity_id, target_entity_id, type, description, confidence,
        first_chapter_index, last_chapter_index, updated_at
      )
      VALUES ('relation-a-b', 'sample-book', 'entity-a', 'entity-b', 'helps', '阿甲帮助乙门', 0.85, 1, 1, CURRENT_TIMESTAMP)
    `).run()
    db.prepare(`
      INSERT INTO kg_relation_mentions (id, relation_id, book_id, chapter_id, chapter_index, evidence, confidence)
      VALUES ('relation-mention-a-b', 'relation-a-b', 'sample-book', 'sample-book:ch00001', 1, '阿甲在长安帮助乙门', 0.85)
    `).run()
  } finally {
    db.close()
  }
}

function fakeTtsDirectorSource() {
  return `
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function parseChapters(value) {
  const result = []
  for (const part of String(value || '').split(',')) {
    const range = part.match(/^(\\d+)-(\\d+)$/)
    if (range) {
      for (let chapter = Number(range[1]); chapter <= Number(range[2]); chapter += 1) result.push(chapter)
    } else if (part.trim()) {
      result.push(Number(part))
    }
  }
  return result
}

const args = parseArgs(process.argv.slice(2))
if (args._[0] !== 'batch-pipeline') throw new Error('fake director only supports batch-pipeline')
await mkdir(args['out-root'], { recursive: true })
await writeFile(join(args['out-root'], 'args.json'), JSON.stringify(args))
const config = args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {}
await writeFile(join(args['out-root'], 'config.json'), JSON.stringify(config))
console.log('fake director start')
if (config.fakeDelayMs) {
  await new Promise(resolve => setTimeout(resolve, Number(config.fakeDelayMs)))
}
if (args['control-file']) {
  await writeFile(join(args['out-root'], 'control-final.json'), await readFile(args['control-file'], 'utf8'))
}
const chapters = parseChapters(args.chapters)
for (const chapter of chapters) {
  console.log('fake director chapter ' + chapter)
  const audioDir = join(args['out-root'], 'ch' + String(chapter).padStart(3, '0') + '-full', 'audio')
  await mkdir(audioDir, { recursive: true })
  await writeFile(join(audioDir, 'chapter.mp3'), 'fake mp3 ' + chapter)
  await writeFile(join(audioDir, 'manifest.json'), JSON.stringify({ version: 2, durationMs: chapter * 1000 }))
}
const summaryPath = join(args['out-root'], 'batch-pipeline-' + chapters[0] + '-' + chapters.at(-1) + '.summary.json')
await writeFile(summaryPath, JSON.stringify({ chapters }))
console.log('汇总文件：' + summaryPath)
`
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function findRunDir(runRoot, bookId, predicate) {
  const bookRunRoot = join(runRoot, bookId)
  const entries = await readdir(bookRunRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = join(bookRunRoot, entry.name)
    const runJson = await readJsonIfExists(join(runDir, 'run.json'))
    if (runJson && predicate(runJson)) return runDir
  }
  assert.fail(`No matching run.json found in ${bookRunRoot}`)
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function waitFor(probe, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  if (lastError) throw lastError
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function startFakeOllamaEmbeddingServer({ models = ['qwen3-embedding:8b'] } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(response, {
        models: models.map((model) => ({ name: model, model })),
      })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/api/embeddings') {
      sendJson(response, { error: { code: 'not_found' } }, 404)
      return
    }
    const body = await readRequestJson(request)
    requests.push(body)
    const prompt = String(body.prompt || '')
    const base = Math.max(1, prompt.length % 10)
    sendJson(response, {
      embedding: [base, base + 1, base + 2],
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function startFakeChatServer({ delayMs = 0 } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/chat/completions') {
      sendJson(response, { error: { code: 'not_found' } }, 404)
      return
    }
    const body = await readRequestJson(request)
    if (delayMs) await sleep(delayMs)
    const prompt = body.messages?.map((message) => message.content).join('\n') || ''
    if (prompt.includes('知识图谱')) {
      sendJson(response, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                entities: [
                  {
                    name: '阿甲',
                    type: 'person',
                    aliases: ['甲兄'],
                    description: '在本章行动的人物。',
                    evidence: '阿甲在长安帮助乙门',
                    confidence: 0.9,
                  },
                  {
                    name: '乙门',
                    type: 'organization',
                    aliases: [],
                    description: '被帮助的门派。',
                    evidence: '阿甲在长安帮助乙门',
                    confidence: 0.85,
                  },
                ],
                relations: [
                  {
                    source: '阿甲',
                    sourceType: 'person',
                    target: '乙门',
                    targetType: 'organization',
                    type: 'helps',
                    description: '阿甲帮助乙门。',
                    evidence: '阿甲在长安帮助乙门',
                    confidence: 0.86,
                  },
                ],
              }),
            },
          },
        ],
      })
      return
    }
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

async function startFakeGateway({ token, adminToken = token, bookPackage, audioCatalog }) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, url: url.pathname, headers: request.headers })
    if (url.pathname === '/health') {
      sendJson(response, { status: 'ok' })
      return
    }
    const isAdminRoute = url.pathname.startsWith('/admin/') || url.pathname === '/admin/audio'
    const expectedToken = isAdminRoute ? adminToken : token
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
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
    if (url.pathname === '/auth/session') {
      sendJson(response, {
        authenticated: true,
        auth: {
          mode: 'development-static-token',
          deviceId: 'verify-device',
          deviceName: 'Verify Device',
          role: 'default',
          allowedVisibilities: ['default'],
        },
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/admin/books') {
      sendJson(response, {
        schemaVersion: 1,
        books: [{ ...bookPackage.book, visibility: bookPackage.book.visibility ?? 'default', audioChapterCount: audioCatalog.chapters.length }],
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
    if (request.method === 'POST' && url.pathname === `/admin/books/${bookPackage.book.id}/audio/refresh`) {
      sendJson(response, {
        schemaVersion: 1,
        refreshedAt: new Date().toISOString(),
        audio: fakeAdminAudioSummary(bookPackage, audioCatalog),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/admin/audio') {
      sendJson(response, {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        audio: [fakeAdminAudioSummary(bookPackage, audioCatalog)],
      })
      return
    }
    const audioDownloadMatch = url.pathname.match(new RegExp(`^/mobile/books/${bookPackage.book.id}/audio/([^/]+)/download$`))
    if (audioDownloadMatch) {
      const chapterId = decodeURIComponent(audioDownloadMatch[1])
      if (!audioCatalog.chapters.some((chapter) => chapter.chapterId === chapterId)) {
        sendJson(response, { error: { code: 'not_found' } }, 404)
        return
      }
      const chapter = audioCatalog.chapters.find((candidate) => candidate.chapterId === chapterId)
      const bytes = Buffer.alloc(chapter.sizeBytes ?? 13, 1)
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(bytes.byteLength) })
      response.end(bytes)
      return
    }
    const audioManifestMatch = url.pathname.match(new RegExp(`^/mobile/books/${bookPackage.book.id}/audio/([^/]+)/manifest$`))
    if (audioManifestMatch) {
      const chapterId = decodeURIComponent(audioManifestMatch[1])
      const chapter = audioCatalog.chapters.find((candidate) => candidate.chapterId === chapterId)
      if (!chapter?.manifestFileName) {
        sendJson(response, { error: { code: 'not_found' } }, 404)
        return
      }
      sendJson(response, {
        kind: 'novel-reader-tts-audio-manifest',
        version: chapter.timelineVersion,
        durationMs: chapter.durationMs,
        timeline: [],
      })
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
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function fakeAdminAudioSummary(bookPackage, audioCatalog) {
  const packageChapterIds = Array.isArray(bookPackage.chapters) ? bookPackage.chapters.map((chapter) => chapter.id) : []
  const audioChapterIds = new Set(audioCatalog.chapters.map((chapter) => chapter.chapterId))
  const missingChapterIds = packageChapterIds.filter((chapterId) => !audioChapterIds.has(chapterId))
  const totalSizeBytes = audioCatalog.chapters.reduce((sum, chapter) => sum + (Number(chapter.sizeBytes) || 0), 0)
  return {
    bookId: bookPackage.book.id,
    title: bookPackage.book.title,
    chapterCount: packageChapterIds.length,
    audioChapterCount: audioCatalog.chapters.length,
    missingChapterCount: missingChapterIds.length,
    missingChapterIds,
    coverage: packageChapterIds.length > 0 ? audioCatalog.chapters.length / packageChapterIds.length : 0,
    totalSizeBytes,
    updatedAt: new Date().toISOString(),
  }
}

function sendJson(response, value, statusCode = 200) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function captureRejectedExec(command, args) {
  try {
    await execFileAsync(command, args)
  } catch (error) {
    return error
  }
  assert.fail(`Expected command to fail: ${command} ${args.join(' ')}`)
}
