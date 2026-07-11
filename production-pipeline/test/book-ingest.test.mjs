import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inferSourceType, parseBookFile } from '../src/book-ingest.mjs'

describe('book ingest', () => {
  it('recognizes MOBI-family source types', () => {
    assert.equal(inferSourceType('/books/example.mobi'), 'mobi')
    assert.equal(inferSourceType('/books/example.azw'), 'mobi')
    assert.equal(inferSourceType('/books/example.azw3'), 'mobi')
  })

  it('imports text-layer PDF chapters', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'book-ingest-test-'))
    try {
      const pdfPath = join(tempDir, 'sample-novel.pdf')
      await writeFile(pdfPath, makeTextPdf([
        'Chapter 1 Beginning',
        'The first clue appears.',
        'Chapter 2 Return',
        'The story continues.',
      ]))

      const parsed = await parseBookFile(pdfPath)

      assert.equal(parsed.title, 'sample-novel')
      assert.equal(parsed.chapters.length, 2)
      assert.equal(parsed.chapters[0].title, 'Chapter 1 Beginning')
      assert.equal(parsed.chapters[0].content, 'The first clue appears.')
      assert.equal(parsed.chapters[1].title, 'Chapter 2 Return')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
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

  it('drops a leading table-of-contents fragment before the real first chapter', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'book-ingest-test-'))
    try {
      const txtPath = join(tempDir, '金麟外传.txt')
      await writeFile(
        txtPath,
        `
金鳞岂是池中物
第一章·龙回故乡
第二章·走马上任
第二百三十章·扩展结局

ÁÁÁÁÁÁÁÁÁÁ：example.com 1，2，3

第一章·龙回故乡
二十三岁的主角坐在飞机上，故事由此开始。

第二章·走马上任
新的职务带来新的局面。
`,
        'utf8',
      )

      const parsed = await parseBookFile(txtPath)

      assert.equal(parsed.chapters.length, 2)
      assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), [
        '第一章·龙回故乡',
        '第二章·走马上任',
      ])
      assert.doesNotMatch(parsed.chapters[0].content, /example\.com/)
      assert.match(parsed.chapters[0].content, /^二十三岁/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('splits Calibre EPUB spine chunks by embedded chapter headings', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'book-ingest-test-'))
    try {
      const epubPath = join(tempDir, '大唐双龙传.epub')
      await writeFile(
        epubPath,
        makeStoredZip({
          mimetype: 'application/epub+zip',
          'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
          'content.opf': `<?xml version="1.0" encoding="utf-8"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <metadata><dc:title>大唐双龙传</dc:title></metadata>
  <manifest>
    <item id="a" href="index_split_000.html" media-type="application/xhtml+xml"/>
    <item id="b" href="index_split_001.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="a"/><itemref idref="b"/></spine>
</package>`,
          'index_split_000.html': `<?xml version="1.0" encoding="utf-8"?>
<html><body>
  <p>黄易-大唐双龙传</p>
  <p>第一章 相依为命</p>
  <p>${'宇文化及卓立战舰指挥台之上。'.repeat(80)}</p>
  <p>第二章 大祸临头</p>
  <p>${'寇仲和徐子陵奔走扬州城中。'.repeat(80)}</p>
</body></html>`,
          'index_split_001.html': `<?xml version="1.0" encoding="utf-8"?>
<html><body>
  <p>黄易《大唐双龙传》02</p>
  <p>第一章 老奸巨猾</p>
  <p>${'徐子陵心中一动，暗觉形势有异。'.repeat(80)}</p>
  <p>第二章 尔虞我诈</p>
  <p>${'众人各怀心事，局势愈发微妙。'.repeat(80)}</p>
</body></html>`,
        }),
      )

      const parsed = await parseBookFile(epubPath)

      assert.equal(parsed.title, '大唐双龙传')
      assert.equal(parsed.chapters.length, 4)
      assert.deepEqual(
        parsed.chapters.map((chapter) => chapter.title),
        ['第一章 相依为命', '第二章 大祸临头', '第一章 老奸巨猾', '第二章 尔虞我诈'],
      )
      assert.match(parsed.chapters[0].content, /^宇文化及/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

function makeTextPdf(lines) {
  const escapePdfText = (value) => value.replace(/([\\()])/g, '\\$1')
  const commands = lines
    .map((line, index) => `${index === 0 ? '72 720 Td' : '0 -24 Td'} (${escapePdfText(line)}) Tj`)
    .join('\n')
  const stream = `BT\n/F1 12 Tf\n${commands}\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

function makeStoredZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name)
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localParts.push(localHeader, nameBuffer, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuffer)

    offset += localHeader.length + nameBuffer.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, centralDirectory, end])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
