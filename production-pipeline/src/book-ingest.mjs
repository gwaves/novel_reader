import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, extname, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inflateRawSync } from 'node:zlib'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPdfDocument } from './pdf-text.mjs'

const chapterPattern =
  /^\s*(?:(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回][^\n]*|(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回][^\n]*|Chapter\s*\d+[^\n]*|\d+[.、]\s*[^\n]+)\s*$/gim

export async function ingestBookFile(filePath, options = {}) {
  const fileBuffer = await readFile(filePath)
  const sha256 = hashBuffer(fileBuffer)
  const parsed = await parseBookFile(filePath, fileBuffer)
  const bookId = options.bookId || `file-${sha256.slice(0, 24)}`
  const importedAt = new Date().toISOString()
  const title = options.title || parsed.title
  const chapters = parsed.chapters.map((chapter, index) => {
    const normalizedTitle = chapter.title.trim() || `第 ${index + 1} 章`
    const content = chapter.content.trim()
    return {
      id: `${bookId}:ch${String(index + 1).padStart(5, '0')}`,
      index: index + 1,
      title: normalizedTitle,
      content,
      wordCount: countWords(content),
    }
  })

  if (!chapters.length) {
    throw new Error('没有识别到可导入章节。')
  }

  const dbPath = options.dbPath || process.env.NOVEL_READER_MAIN_DB || join(homedir(), '.novel_reader', 'novel_reader.sqlite')
  writeBookToMainDb(dbPath, { id: bookId, title, importedAt, chapters })

  return {
    book: {
      id: bookId,
      title,
      importedAt,
      chapterCount: chapters.length,
      wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    },
    source: {
      type: inferSourceType(filePath),
      fileName: basename(filePath),
      path: filePath,
      sha256,
      sizeBytes: fileBuffer.byteLength,
    },
  }
}

export async function parseBookFile(filePath, fileBuffer = null) {
  const buffer = fileBuffer || await readFile(filePath)
  const type = inferSourceType(filePath)

  if (type === 'epub') {
    return parseEpub(filePath, buffer)
  }
  if (type === 'mobi') {
    return parseMobi(filePath)
  }
  if (type === 'pdf') {
    const pdf = await extractPdfDocument(buffer)
    const text = stripPublicDomainBoilerplate(cleanFormattingTags(pdf.text))
    return {
      title: pdf.title || inferTitle(filePath),
      chapters: pdf.sections.length ? pdf.sections : splitChapters(text),
    }
  }

  const text = stripPublicDomainBoilerplate(cleanFormattingTags(decodeText(buffer)))
  return {
    title: inferTitle(filePath),
    chapters: splitChapters(text),
  }
}

export function inferSourceType(filePath) {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.txt') return 'txt'
  if (extension === '.epub') return 'epub'
  if (['.mobi', '.azw', '.azw3'].includes(extension)) return 'mobi'
  if (extension === '.pdf') return 'pdf'
  return 'file'
}

async function parseMobi(filePath) {
  const tempDir = await mkdtemp(join(tmpdir(), 'novel-reader-mobi-'))
  const epubPath = join(tempDir, `${basename(filePath).replace(/\.[^.]+$/, '') || 'book'}.epub`)
  try {
    await runEbookConvert(filePath, epubPath)
    return parseEpub(epubPath, await readFile(epubPath))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('MOBI/AZW 导入需要安装 Calibre，并确保 ebook-convert 在 PATH 中。macOS 可安装 Calibre 后重启终端或服务。')
    }
    const stderr = String(error.stderr || '').trim()
    throw new Error(`MOBI/AZW 转 EPUB 失败：${stderr || error.message}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function runEbookConvert(sourcePath, epubPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ebook-convert', [sourcePath, epubPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        rejectPromise(new Error('MOBI/AZW 导入需要安装 Calibre，并确保 ebook-convert 在 PATH 中。macOS 可安装 Calibre 后重启终端或服务。'))
        return
      }
      rejectPromise(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`ebook-convert 退出码 ${code}`))
    })
  })
}

function writeBookToMainDb(dbPath, book) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA busy_timeout = 60000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_book_index ON chapters(book_id, chapter_index);
    CREATE INDEX IF NOT EXISTS idx_chapters_title ON chapters(title);

    CREATE TABLE IF NOT EXISTS summaries (
      chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
      short TEXT NOT NULL,
      detail TEXT NOT NULL,
      key_points_json TEXT NOT NULL,
      skippable TEXT NOT NULL,
      generated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kg_chapter_extractions (
      chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      extraction_json TEXT,
      error TEXT,
      model TEXT,
      scanned_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      review_status TEXT,
      UNIQUE(book_id, type, normalized_name)
    );

    CREATE TABLE IF NOT EXISTS kg_entity_mentions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      evidence TEXT NOT NULL,
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      review_status TEXT,
      UNIQUE(book_id, source_entity_id, target_entity_id, type)
    );

    CREATE TABLE IF NOT EXISTS kg_relation_mentions (
      id TEXT PRIMARY KEY,
      relation_id TEXT NOT NULL REFERENCES kg_relations(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      evidence TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const upsertBook = db.prepare(`
    INSERT INTO books (id, title, imported_at, chapter_count, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      imported_at = excluded.imported_at,
      chapter_count = excluded.chapter_count,
      updated_at = excluded.updated_at
  `)
  const deleteChapters = db.prepare('DELETE FROM chapters WHERE book_id = ?')
  const insertChapter = db.prepare(`
    INSERT INTO chapters (id, book_id, chapter_index, title, content, word_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `)

  db.exec('BEGIN')
  try {
    upsertBook.run(book.id, book.title, book.importedAt, book.chapters.length)
    deleteChapters.run(book.id)
    for (const chapter of book.chapters) {
      insertChapter.run(chapter.id, book.id, chapter.index, chapter.title, chapter.content, chapter.wordCount)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function inferTitle(filePath) {
  return basename(filePath).replace(/\.[^.]+$/, '') || '未命名小说'
}

function decodeText(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer)
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer)
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
}

function cleanFormattingTags(text) {
  return text.replace(/\[\/?(?:color|b|i|u|size)(?:=[^\]]*)?\]/gi, '')
}

function stripPublicDomainBoilerplate(text) {
  let output = text
  const startMarker = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[\s\r\n]*/i
  const endMarker = /[\s\r\n]*\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[\s\S]*$/i
  const startMatch = output.match(startMarker)
  if (startMatch?.index != null) output = output.slice(startMatch.index + startMatch[0].length)
  return output.replace(endMarker, '').trim()
}

function splitChapters(rawText) {
  const matches = Array.from(rawText.matchAll(chapterPattern))
  if (matches.length < 2) return chunkFallback(rawText)

  const chapters = matches.map((match, index) => {
    const start = match.index ?? 0
    const end = index < matches.length - 1 ? (matches[index + 1].index ?? rawText.length) : rawText.length
    const block = rawText.slice(start, end).trim()
    const lines = block.split(/\r?\n/)
    const heading = splitHeadingLine(lines[0].trim())
    const contentLines = heading.contentPrefix ? [heading.contentPrefix, ...lines.slice(1)] : lines.slice(1)
    return {
      title: heading.title,
      content: contentLines.join('\n').trim(),
    }
  }).filter((chapter) => chapter.content)
  return dropLeadingTocFragments(chapters)
}

function dropLeadingTocFragments(chapters) {
  if (chapters.length < 2) return chapters
  const firstNumber = parseChapterNumber(chapters[0].title)
  if (!firstNumber || firstNumber <= 1) return chapters
  const firstRealIndex = chapters.findIndex((chapter, index) => index > 0 && parseChapterNumber(chapter.title) === 1)
  return firstRealIndex > 0 ? chapters.slice(firstRealIndex) : chapters
}

function parseChapterNumber(title) {
  const match = String(title || '').match(/第\s*([0-9零一二三四五六七八九十百千万亿〇○]+)\s*[章卷节回]/)
  if (!match) return 0
  if (/^\d+$/.test(match[1])) return Number(match[1])
  return parseChineseNumber(match[1])
}

function parseChineseNumber(value) {
  const digits = new Map([
    ['零', 0], ['〇', 0], ['○', 0],
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9],
  ])
  const units = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000], ['亿', 100000000]])
  let total = 0
  let section = 0
  let number = 0
  for (const char of String(value || '')) {
    if (digits.has(char)) {
      number = digits.get(char)
      continue
    }
    const unit = units.get(char)
    if (!unit) continue
    if (unit >= 10000) {
      section = (section + number) * unit
      total += section
      section = 0
    } else {
      section += (number || 1) * unit
    }
    number = 0
  }
  return total + section + number
}

function chunkFallback(text) {
  const lines = text.split(/\r?\n/)
  const chunks = []
  let currentTitle = '正文开始'
  let currentLines = []
  const fallbackPattern = /^((?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回]|(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回]|Chapter\s*\d+|\d+[.、])/

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (fallbackPattern.test(line)) {
      if (currentLines.length) {
        chunks.push({ title: currentTitle, content: currentLines.join('\n').trim() })
      }
      currentTitle = normalizeChapterTitle(line)
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length || chunks.length === 0) {
    chunks.push({ title: currentTitle, content: currentLines.join('\n').trim() })
  }
  return chunks.filter((chapter) => chapter.content)
}

function normalizeChapterTitle(title) {
  return title.replace(/^正文\s+/, '').trim()
}

function splitHeadingLine(line) {
  const normalizedLine = normalizeChapterTitle(line)
  const headingMatch = normalizedLine.match(
    /^((?:第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[集卷部]\s+)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回])([\s\S]*)$/,
  )

  if (!headingMatch) {
    return { title: normalizedLine, contentPrefix: '' }
  }

  const headingPrefix = headingMatch[1]
  const headingText = headingMatch[2] ?? ''
  const proseMarkers = ['却说', '话说', '且说', '诗曰', '原来', '当下', '却表', '却才']
  const markerIndex = proseMarkers
    .map((marker) => headingText.indexOf(marker))
    .filter((index) => index >= 4)
    .sort((a, b) => a - b)[0]

  if (markerIndex == null) {
    return { title: normalizedLine, contentPrefix: '' }
  }

  return {
    title: `${headingPrefix}${headingText.slice(0, markerIndex)}`.trim(),
    contentPrefix: headingText.slice(markerIndex).trim(),
  }
}

function countWords(text) {
  return text.replace(/\s/g, '').length
}

function parseEpub(filePath, buffer) {
  const entries = readZipEntries(buffer)
  const containerXml = readZipText(entries, 'META-INF/container.xml')
  const rootfile = getXmlElements(containerXml, 'rootfile')[0]?.attrs['full-path']
  if (!rootfile) throw new Error('EPUB 缺少 OPF rootfile。')

  const opfText = readZipText(entries, rootfile)
  const opfBasePath = dirname(rootfile).replace(/^\.$/, '')
  const metadataTitle = getXmlElements(opfText, 'title')[0]?.text || inferTitle(filePath)
  const manifest = new Map(
    getXmlElements(opfText, 'item')
      .map((item) => {
        const id = item.attrs.id
        const href = item.attrs.href
        const mediaType = item.attrs['media-type'] ?? ''
        return id && href ? [id, { href: joinZipPath(opfBasePath, href), mediaType }] : null
      })
      .filter(Boolean),
  )
  const spineIds = getXmlElements(opfText, 'itemref')
    .map((item) => item.attrs.idref)
    .filter(Boolean)
  const chapters = []

  for (const idref of spineIds) {
    const item = manifest.get(idref)
    if (!item || !/xhtml|html/i.test(item.mediaType)) continue

    const html = readZipText(entries, item.href)
    const { heading, text } = extractHtmlText(html)
    if (text && isReadableEpubText(text)) {
      chapters.push({ title: heading || stripExtension(item.href), content: text })
    }
  }

  if (!chapters.length) throw new Error('EPUB 中没有识别到可阅读章节。')
  return { title: metadataTitle, chapters: selectEpubChapters(chapters) }
}

function selectEpubChapters(spineChapters) {
  const fullText = spineChapters.map((chapter) => chapter.content).join('\n')
  const textChapters = splitChapters(fullText)
  const spineWordCount = spineChapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
  const textWordCount = textChapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
  const preservesMostContent = spineWordCount === 0 || textWordCount / spineWordCount > 0.85

  if (textChapters.length >= spineChapters.length * 2 && preservesMostContent) {
    return textChapters
  }

  return spineChapters
}

function isReadableEpubText(text) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  if (countWords(normalized) < 80 && /^(?:cover|table of contents|目录)(?:\b|$)/i.test(normalized)) {
    return false
  }
  return true
}

function readZipEntries(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const endOffset = findZipEndOfCentralDirectory(view)
  const entryCount = view.getUint16(endOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)
  const entries = new Map()
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('EPUB 中央目录损坏。')

    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const nameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength)
    const name = decodeZipName(nameBytes, Boolean(flags & 0x0800)).replace(/\\/g, '/')

    if (!name.endsWith('/')) {
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error(`EPUB 条目损坏：${name}`)
      const localNameLength = view.getUint16(localHeaderOffset + 26, true)
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
      entries.set(name, {
        compressionMethod,
        compressedData: bytes.slice(dataOffset, dataOffset + compressedSize),
      })
    }

    offset += 46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

function findZipEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22)
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error('不是有效的 EPUB/ZIP 文件。')
}

function decodeZipName(bytes, useUtf8) {
  return new TextDecoder(useUtf8 ? 'utf-8' : 'latin1').decode(bytes)
}

function readZipText(entries, path) {
  const entry = entries.get(path)
  if (!entry) throw new Error(`EPUB 缺少文件：${path}`)

  let data
  if (entry.compressionMethod === 0) {
    data = Buffer.from(entry.compressedData)
  } else if (entry.compressionMethod === 8) {
    data = inflateRawSync(Buffer.from(entry.compressedData))
  } else {
    throw new Error(`暂不支持 EPUB 压缩方式：${entry.compressionMethod}`)
  }

  return new TextDecoder('utf-8').decode(data)
}

function getXmlElements(xml, localName) {
  const results = []
  const tagName = `(?:[\\w.-]+:)?${escapeRegExp(localName)}`
  const pairedPattern = new RegExp(`<(${tagName})([^>]*)>([\\s\\S]*?)<\\/\\1>`, 'g')
  const selfClosingPattern = new RegExp(`<(${tagName})([^>]*)\\/\\s*>`, 'g')
  let match

  while ((match = pairedPattern.exec(xml))) {
    const attrText = match[2] || ''
    const text = decodeXmlEntities(stripXmlTags(match[3]).replace(/\s+/g, ' ').trim())
    results.push({ attrs: parseAttrs(attrText), text })
  }

  while ((match = selfClosingPattern.exec(xml))) {
    results.push({ attrs: parseAttrs(match[2] || ''), text: '' })
  }

  return results
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseAttrs(attrText) {
  const attrs = {}
  const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = attrPattern.exec(attrText))) {
    attrs[match[1].split(':').pop()] = decodeXmlEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

function stripXmlTags(text) {
  return text.replace(/<[^>]+>/g, ' ')
}

function extractHtmlText(html) {
  const withoutNoise = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const heading = firstMatchText(withoutNoise, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
  const blockPattern = /<(h[1-6]|p|li|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi
  const blocks = []
  let match
  while ((match = blockPattern.exec(withoutNoise))) {
    const text = htmlToText(match[2])
    if (text) blocks.push(text)
  }
  const text = blocks.length ? blocks.join('\n') : htmlToText(withoutNoise)
  return { heading, text }
}

function firstMatchText(text, pattern) {
  const match = pattern.exec(text)
  return match ? htmlToText(match[1]) : ''
}

function htmlToText(html) {
  return decodeXmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim(),
  )
}

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function joinZipPath(basePath, relativePath) {
  if (!basePath) return normalizeZipPath(relativePath)
  return normalizeZipPath(`${basePath}/${relativePath}`)
}

function normalizeZipPath(path) {
  const output = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return output.join('/')
}

function stripExtension(path) {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '') || '章节'
}
