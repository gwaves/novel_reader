import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
})

function plainRow(row) {
  return Object.assign({}, row)
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
