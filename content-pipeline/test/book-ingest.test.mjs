import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inferSourceType, parseBookFile } from '../lib/book-ingest.mjs'

describe('book ingest', () => {
  it('recognizes MOBI-family source types', () => {
    assert.equal(inferSourceType('/books/example.mobi'), 'mobi')
    assert.equal(inferSourceType('/books/example.azw'), 'mobi')
    assert.equal(inferSourceType('/books/example.azw3'), 'mobi')
  })

  it('reports a clear setup error when MOBI conversion is unavailable', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'book-ingest-test-'))
    const originalPath = process.env.PATH
    try {
      const mobiPath = join(tempDir, 'sample.mobi')
      await writeFile(mobiPath, 'not a real mobi', 'utf8')
      process.env.PATH = '/nonexistent'
      await assert.rejects(
        () => parseBookFile(mobiPath),
        /MOBI\/AZW 导入需要安装 Calibre/,
      )
    } finally {
      process.env.PATH = originalPath
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps prose out of a long classic chapter heading line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'book-ingest-test-'))
    try {
      const txtPath = join(tempDir, '西游记.txt')
      await writeFile(
        txtPath,
        `
第二十五回　镇元仙赶捉取经僧　孙行者大闹五庄观却说他兄弟三众，到了殿上，对师父道："饭将熟了，叫我们怎的？"
三藏道："徒弟，不是问饭。"

第二十六回　孙悟空三岛求方　观世音甘泉活树
诗曰：处世须存心上刃。
`,
        'utf8',
      )

      const parsed = await parseBookFile(txtPath)

      assert.equal(parsed.chapters.length, 2)
      assert.equal(parsed.chapters[0].title, '第二十五回　镇元仙赶捉取经僧　孙行者大闹五庄观')
      assert.match(parsed.chapters[0].content, /^却说他兄弟三众，到了殿上/)
      assert.doesNotMatch(parsed.chapters[0].content, /第二十五回/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
