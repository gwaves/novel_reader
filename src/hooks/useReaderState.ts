import { useEffect, useMemo, useState } from 'react'

export type Chapter = {
  id: string
  index: number
  title: string
  content: string
  wordCount: number
}

export type Book = {
  id: string
  title: string
  chapters: Chapter[]
  importedAt: string
}

export type Summary = {
  short: string
  detail: string
  keyPoints: string[]
  skippable: string
  generatedBy: 'local' | 'ollama' | 'openai'
}

export type LibraryBook = {
  book: Book
  activeChapterId: string | null
  summaries: Record<string, Summary>
}

export type StoredState = {
  books: LibraryBook[]
  activeBookId: string | null
  book: Book | null
  activeChapterId: string | null
  summaries: Record<string, Summary>
  aiProvider: AIProvider
  ollamaModel: string
  ollamaTemperature: number
  ollamaConcurrency: number
  openaiConfigs: OpenAIConfig[]
  activeOpenAIConfigId: string
  thinkingEnabled: boolean
  readerFontSize: number
  readerLineHeight: number
  readerContentWidth: number
  readerParagraphSpacing: number
  readerTheme: ReaderTheme
  chapterScrollPositions: Record<string, number>
  embeddingConfig: EmbeddingConfig
}

export type AIProvider = 'ollama' | 'openai'
export type EmbeddingProvider = 'ollama' | 'openai'
export type ReaderTheme = 'paper' | 'night' | 'green'
export type AppView = 'home' | 'reader' | 'knowledge' | 'search'
export type OllamaModel = {
  name: string
}
export type OpenAIConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  thinkingEnabled: boolean
  temperature: number
  concurrency: number
}
export type EmbeddingConfig = {
  provider: EmbeddingProvider
  baseUrl: string
  model: string
  apiKey: string
  dimension: number | null
}
export type ModelConfigDraft = Pick<
  StoredState,
  | 'aiProvider'
  | 'ollamaModel'
  | 'ollamaTemperature'
  | 'ollamaConcurrency'
  | 'openaiConfigs'
  | 'activeOpenAIConfigId'
  | 'thinkingEnabled'
  | 'embeddingConfig'
>

type ImportedBookContent = {
  title: string
  chapters: Chapter[]
}

type ZipEntry = {
  name: string
  compressionMethod: number
  compressedData: Uint8Array
}

const STORAGE_KEY = 'novel-reader-mvp-state'
const LEGACY_DB_NAME = 'novel-reader-mvp'
const LEGACY_DB_STORE = 'state'
const LEGACY_DB_VERSION = 1
export const CHAPTERS_PER_PAGE = 100

const initialState: StoredState = {
  books: [],
  activeBookId: null,
  book: null,
  activeChapterId: null,
  summaries: {},
  aiProvider: 'ollama',
  ollamaModel: 'qwen2.5:7b',
  ollamaTemperature: 1,
  ollamaConcurrency: 1,
  openaiConfigs: [
    {
      id: 'default-openai',
      name: 'OpenAI 默认',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1-mini',
      thinkingEnabled: false,
      temperature: 1,
      concurrency: 3,
    },
  ],
  activeOpenAIConfigId: 'default-openai',
  thinkingEnabled: false,
  readerFontSize: 18,
  readerLineHeight: 2.05,
  readerContentWidth: 820,
  readerParagraphSpacing: 1,
  readerTheme: 'paper',
  chapterScrollPositions: {},
  embeddingConfig: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    apiKey: '',
    dimension: null,
  },
}

const OLLAMA_BASE_URL = 'http://localhost:11434'

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    } catch {
      // fall through
    }
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function openLegacyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(LEGACY_DB_STORE)) {
        db.createObjectStore(LEGACY_DB_STORE)
      }
    }
  })
}

function loadStateFromLegacyDb(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    openLegacyDatabase()
      .then((db) => {
        const transaction = db.transaction(LEGACY_DB_STORE, 'readonly')
        const store = transaction.objectStore(LEGACY_DB_STORE)
        const request = store.get(STORAGE_KEY)

        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
      .catch(reject)
  })
}

async function loadStateFromLocalDb(): Promise<unknown> {
  const response = await fetch('/api/state')

  if (!response.ok) {
    throw new Error('Local database API is not available.')
  }

  const payload = (await response.json()) as { state?: unknown }
  return payload.state ?? null
}

async function saveStateToLocalDb(state: StoredState): Promise<void> {
  const response = await fetch('/api/state', {
    body: JSON.stringify({ state }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PUT',
  })

  if (!response.ok) {
    throw new Error('Local database API rejected the state payload.')
  }
}

function isBook(value: unknown): value is Book {
  const book = value as Book

  return (
    Boolean(book) &&
    typeof book.id === 'string' &&
    typeof book.title === 'string' &&
    Array.isArray(book.chapters) &&
    typeof book.importedAt === 'string'
  )
}

function sanitizeSummaries(value: unknown): Record<string, Summary> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Summary>)
    : {}
}

function sanitizeRecordOfNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => typeof key === 'string' && typeof entry === 'number' && Number.isFinite(entry))
      .map(([key, entry]) => [key, Math.max(0, entry as number)]),
  )
}

function sanitizeLibraryBooks(storedState: Partial<StoredState> & Record<string, unknown>): LibraryBook[] {
  const fromBooks = Array.isArray(storedState.books)
    ? storedState.books
        .map((entry): LibraryBook | null => {
          const libraryBook = entry as Partial<LibraryBook>

          if (!isBook(libraryBook.book)) return null

          const activeChapterId =
            typeof libraryBook.activeChapterId === 'string'
              ? libraryBook.activeChapterId
              : libraryBook.book.chapters[0]?.id ?? null

          return {
            book: libraryBook.book,
            activeChapterId,
            summaries: sanitizeSummaries(libraryBook.summaries),
          }
        })
        .filter((entry): entry is LibraryBook => Boolean(entry))
    : []

  if (fromBooks.length) return fromBooks

  if (!isBook(storedState.book)) return []

  return [
    {
      book: storedState.book,
      activeChapterId:
        typeof storedState.activeChapterId === 'string'
          ? storedState.activeChapterId
          : storedState.book.chapters[0]?.id ?? null,
      summaries: sanitizeSummaries(storedState.summaries),
    },
  ]
}

export function normalizeStoredState(
  storedState: Partial<StoredState> & Record<string, unknown>,
): StoredState {
  const books = sanitizeLibraryBooks(storedState)
  const activeBookId =
    typeof storedState.activeBookId === 'string' &&
    books.some((entry) => entry.book.id === storedState.activeBookId)
      ? storedState.activeBookId
      : books[0]?.book.id ?? null
  const activeLibraryBook = books.find((entry) => entry.book.id === activeBookId) ?? null
  const fallbackThinking =
    typeof storedState.thinkingEnabled === 'boolean' ? storedState.thinkingEnabled : false
  const fallbackOllamaModel =
    typeof storedState.ollamaModel === 'string' ? storedState.ollamaModel : initialState.ollamaModel
  const fallbackOllamaTemperature =
    typeof storedState.ollamaTemperature === 'number'
      ? storedState.ollamaTemperature
      : initialState.ollamaTemperature
  const fallbackOllamaConcurrency =
    typeof storedState.ollamaConcurrency === 'number'
      ? storedState.ollamaConcurrency
      : initialState.ollamaConcurrency

  const fallbackOpenAIConfigs = Array.isArray(storedState.openaiConfigs)
    ? sanitizeOpenAIConfigs(storedState.openaiConfigs as unknown[])
    : initialState.openaiConfigs

  const fallbackActiveOpenAIConfigId =
    typeof storedState.activeOpenAIConfigId === 'string' &&
    fallbackOpenAIConfigs.some((config) => config.id === storedState.activeOpenAIConfigId)
      ? storedState.activeOpenAIConfigId
      : fallbackOpenAIConfigs[0].id

  return {
    books,
    activeBookId,
    book: activeLibraryBook?.book ?? null,
    activeChapterId: activeLibraryBook?.activeChapterId ?? null,
    summaries: activeLibraryBook?.summaries ?? {},
    aiProvider: storedState.aiProvider === 'openai' ? 'openai' : 'ollama',
    ollamaModel: fallbackOllamaModel,
    ollamaTemperature: fallbackOllamaTemperature,
    ollamaConcurrency: fallbackOllamaConcurrency,
    openaiConfigs: fallbackOpenAIConfigs,
    activeOpenAIConfigId: fallbackActiveOpenAIConfigId,
    thinkingEnabled: fallbackThinking,
    readerFontSize:
      typeof storedState.readerFontSize === 'number'
        ? Math.max(14, Math.min(28, storedState.readerFontSize))
        : initialState.readerFontSize,
    readerLineHeight:
      typeof storedState.readerLineHeight === 'number'
        ? Math.max(1.5, Math.min(2.6, storedState.readerLineHeight))
        : initialState.readerLineHeight,
    readerContentWidth:
      typeof storedState.readerContentWidth === 'number'
        ? Math.max(640, Math.min(1040, storedState.readerContentWidth))
        : initialState.readerContentWidth,
    readerParagraphSpacing:
      typeof storedState.readerParagraphSpacing === 'number'
        ? Math.max(0.5, Math.min(1.8, storedState.readerParagraphSpacing))
        : initialState.readerParagraphSpacing,
    readerTheme:
      storedState.readerTheme === 'night' || storedState.readerTheme === 'green'
        ? storedState.readerTheme
        : initialState.readerTheme,
    chapterScrollPositions: sanitizeRecordOfNumbers(storedState.chapterScrollPositions),
    embeddingConfig: sanitizeEmbeddingConfig(storedState.embeddingConfig),
  }
}

export function sanitizeEmbeddingConfig(value: unknown): EmbeddingConfig {
  const fallback = initialState.embeddingConfig

  if (!value || typeof value !== 'object') {
    return fallback
  }

  const config = value as EmbeddingConfig
  const provider = config.provider === 'openai' ? 'openai' : 'ollama'
  const baseUrl =
    typeof config.baseUrl === 'string' && config.baseUrl.trim()
      ? config.baseUrl.trim()
      : fallback.baseUrl
  const model =
    typeof config.model === 'string' && config.model.trim()
      ? config.model.trim()
      : fallback.model
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : fallback.apiKey
  const dimension =
    typeof config.dimension === 'number' && Number.isFinite(config.dimension)
      ? config.dimension
      : fallback.dimension

  return { provider, baseUrl, model, apiKey, dimension }
}

export function sanitizeOpenAIConfigs(
  configs: unknown[],
): OpenAIConfig[] {
  const fallbackConfigs = initialState.openaiConfigs

  if (!configs.length) return fallbackConfigs

  return configs.map((config) => ({
    id: typeof (config as OpenAIConfig).id === 'string' ? (config as OpenAIConfig).id : generateId(),
    name:
      typeof (config as OpenAIConfig).name === 'string'
        ? (config as OpenAIConfig).name
        : fallbackConfigs[0].name,
    baseUrl:
      typeof (config as OpenAIConfig).baseUrl === 'string'
        ? (config as OpenAIConfig).baseUrl
        : fallbackConfigs[0].baseUrl,
    apiKey:
      typeof (config as OpenAIConfig).apiKey === 'string'
        ? (config as OpenAIConfig).apiKey
        : fallbackConfigs[0].apiKey,
    model:
      typeof (config as OpenAIConfig).model === 'string'
        ? (config as OpenAIConfig).model
        : fallbackConfigs[0].model,
    thinkingEnabled: Boolean((config as OpenAIConfig).thinkingEnabled),
    temperature:
      typeof (config as OpenAIConfig).temperature === 'number'
        ? (config as OpenAIConfig).temperature
        : fallbackConfigs[0].temperature,
    concurrency:
      typeof (config as OpenAIConfig).concurrency === 'number'
        ? (config as OpenAIConfig).concurrency
        : fallbackConfigs[0].concurrency,
  }))
}

export function normalizeConcurrency(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)

  return Math.max(1, Math.min(10, Math.floor(Number.isFinite(parsed) ? parsed : fallback)))
}

export function getActiveOpenAIConfig(
  config: Pick<StoredState, 'openaiConfigs' | 'activeOpenAIConfigId'>,
): OpenAIConfig | undefined {
  return (
    config.openaiConfigs.find((item) => item.id === config.activeOpenAIConfigId) ??
    config.openaiConfigs[0]
  )
}

const CHAPTER_PATTERN =
  /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[章卷节回][^\n]*|第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[章卷节回][^\n]*|Chapter\s*\d+[^\n]*|\d+[.、]\s*[^\n]+)\s*$/gim

export function splitChapters(rawText: string): Chapter[] {
  const matches = Array.from(rawText.matchAll(CHAPTER_PATTERN))

  if (matches.length < 2) {
    return chunkFallback(rawText)
  }

  return matches.map((match, idx) => {
    const start = match.index ?? 0
    const end = idx < matches.length - 1 ? (matches[idx + 1].index ?? rawText.length) : rawText.length
    const block = rawText.slice(start, end).trim()
    const lines = block.split(/\r?\n/)
    const title = lines[0].trim()
    const content = lines.slice(1).join('\n').trim()

    return {
      id: `${idx + 1}-${title.slice(0, 32)}`,
      index: idx + 1,
      title,
      content,
      wordCount: countWords(content),
    }
  })
}

function chunkFallback(text: string): Chapter[] {
  const lines = text.split(/\r?\n/)
  const chunks: Chapter[] = []
  let currentTitle = '正文开始'
  let currentLines: string[] = []

  const fallbackPattern = /^(第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[章卷节回]|第\s*[0-9零一二三四五六七八九十百千万亿]+\s*[章卷节回]|Chapter\s*\d+|\d+[.、])/

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()

    if (!line) continue

    if (fallbackPattern.test(line)) {
      if (currentLines.length) {
        const content = currentLines.join('\n').trim()

        chunks.push({
          id: `${chunks.length + 1}-${currentTitle.slice(0, 32)}`,
          index: chunks.length + 1,
          title: currentTitle,
          content,
          wordCount: countWords(content),
        })
      }

      currentTitle = line
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length || chunks.length === 0) {
    const content = currentLines.join('\n').trim()

    chunks.push({
      id: `${chunks.length + 1}-${currentTitle.slice(0, 32)}`,
      index: chunks.length + 1,
      title: currentTitle,
      content,
      wordCount: countWords(content),
    })
  }

  return chunks
}

export function countWords(text: string) {
  return text.replace(/\s/g, '').length
}

export function countBookWords(book: Pick<Book, 'chapters'>) {
  return book.chapters.reduce((total, chapter) => total + chapter.wordCount, 0)
}

export function formatWordCount(count: number) {
  if (count >= 10000) {
    return `${(count / 10000).toFixed(count >= 100000 ? 1 : 2)} 万字`
  }

  return `${count} 字`
}

export function inferTitle(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '') || '未命名小说'
}

function parseChineseNumber(input: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  const units: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
    亿: 100000000,
  }

  const clean = input.replace(/\s/g, '')
  if (/^\d+$/.test(clean)) {
    return Number(clean)
  }

  let total = 0
  let section = 0
  let number = 0

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]

    if (char in digits) {
      number = digits[char]
    } else if (char in units) {
      const unit = units[char]

      if (unit >= 10000) {
        section += (number || 1) * unit
        total += section
        section = 0
        number = 0
      } else {
        section += (number || 1) * unit
        number = 0
      }
    }
  }

  return total + section + number || null
}

function getChapterTitleNumber(title: string) {
  const match = /第\s*([0-9零一二三四五六七八九十百千万亿]+)\s*[章卷节回]/.exec(title)

  return match ? parseChineseNumber(match[1]) : null
}

function decodeTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer
      const bytes = new Uint8Array(buffer)

      // UTF-16 BOM
      if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          resolve(new TextDecoder('utf-16le').decode(buffer))
          return
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          resolve(new TextDecoder('utf-16be').decode(buffer))
          return
        }
      }

      // Try UTF-8 first; only fall back to GB18030 if the bytes are not valid UTF-8.
      try {
        const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        resolve(utf8)
        return
      } catch {
        resolve(new TextDecoder('gb18030').decode(buffer))
      }
    }

    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function decodeZipName(bytes: Uint8Array, useUtf8: boolean) {
  const decoder = new TextDecoder(useUtf8 ? 'utf-8' : 'latin1')
  return decoder.decode(bytes)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function findZipEndOfCentralDirectory(view: DataView) {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22)

  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }

  throw new Error('不是有效的 EPUB/ZIP 文件。')
}

function readZipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const endOffset = findZipEndOfCentralDirectory(view)
  const entryCount = view.getUint16(endOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)
  const entries = new Map<string, ZipEntry>()
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('EPUB 中央目录损坏。')
    }

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
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`EPUB 条目损坏：${name}`)
      }

      const localNameLength = view.getUint16(localHeaderOffset + 26, true)
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
      entries.set(name, {
        name,
        compressionMethod,
        compressedData: bytes.slice(dataOffset, dataOffset + compressedSize),
      })
    }

    offset += 46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

async function readZipText(entries: Map<string, ZipEntry>, path: string) {
  const entry = entries.get(path)
  if (!entry) throw new Error(`EPUB 缺少文件：${path}`)

  let data: ArrayBuffer

  if (entry.compressionMethod === 0) {
    data = toArrayBuffer(entry.compressedData)
  } else if (entry.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压 EPUB，请升级浏览器后重试。')
    }

    data = await new Response(
      new Blob([toArrayBuffer(entry.compressedData)]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
    ).arrayBuffer()
  } else {
    throw new Error(`暂不支持 EPUB 压缩方式：${entry.compressionMethod}`)
  }

  return new TextDecoder('utf-8').decode(data)
}

function getXmlElements(document: Document, localName: string) {
  return Array.from(document.getElementsByTagName('*')).filter((element) => element.localName === localName)
}

function joinPath(basePath: string, relativePath: string) {
  if (/^[a-z]+:/i.test(relativePath)) return relativePath

  const parts = `${basePath}/${relativePath}`.split('/')
  const output: string[] = []

  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      output.pop()
    } else {
      try {
        output.push(decodeURIComponent(part))
      } catch {
        output.push(part)
      }
    }
  }

  return output.join('/')
}

function stripExtension(path: string) {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '') || '章节'
}

function extractHtmlText(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, style, nav, noscript').forEach((node) => node.remove())
  const body = document.body
  const heading = body.querySelector('h1,h2,h3,title')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const blocks = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote'))
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
  const text = blocks.length
    ? blocks.join('\n')
    : body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

  return { heading, text }
}

function makeChapterFromText(index: number, title: string, text: string): Chapter {
  return {
    id: `${index}-${title.slice(0, 32)}`,
    index,
    title,
    content: text,
    wordCount: countWords(text),
  }
}

async function parseEpubFile(file: File): Promise<ImportedBookContent> {
  const entries = readZipEntries(await file.arrayBuffer())
  const containerXml = await readZipText(entries, 'META-INF/container.xml')
  const container = new DOMParser().parseFromString(containerXml, 'application/xml')
  const rootfile = getXmlElements(container, 'rootfile')[0]?.getAttribute('full-path')

  if (!rootfile) {
    throw new Error('EPUB 缺少 OPF rootfile。')
  }

  const opfText = await readZipText(entries, rootfile)
  const opf = new DOMParser().parseFromString(opfText, 'application/xml')
  const opfBasePath = rootfile.split('/').slice(0, -1).join('/')
  const metadataTitle =
    getXmlElements(opf, 'title')[0]?.textContent?.replace(/\s+/g, ' ').trim() || inferTitle(file.name)
  const manifest = new Map(
    getXmlElements(opf, 'item')
      .map((item) => {
        const id = item.getAttribute('id')
        const href = item.getAttribute('href')
        const mediaType = item.getAttribute('media-type') ?? ''
        return id && href ? [id, { href: joinPath(opfBasePath, href), mediaType }] : null
      })
      .filter((entry): entry is [string, { href: string; mediaType: string }] => Boolean(entry)),
  )
  const spineIds = getXmlElements(opf, 'itemref')
    .map((itemref) => itemref.getAttribute('idref'))
    .filter((idref): idref is string => Boolean(idref))

  const chapters: Chapter[] = []

  for (const idref of spineIds) {
    const item = manifest.get(idref)
    if (!item || !/xhtml|html/i.test(item.mediaType)) continue

    const html = await readZipText(entries, item.href)
    const { heading, text } = extractHtmlText(html)
    if (!text) continue

    chapters.push(makeChapterFromText(chapters.length + 1, heading || stripExtension(item.href), text))
  }

  if (!chapters.length) {
    throw new Error('EPUB 中没有识别到可阅读章节。')
  }

  return { title: metadataTitle, chapters }
}

async function parseImportedBook(file: File): Promise<ImportedBookContent> {
  if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') {
    return parseEpubFile(file)
  }

  const text = await decodeTextFile(file)
  return {
    title: inferTitle(file.name),
    chapters: splitChapters(text),
  }
}

function buildSummaryPrompt(chapter: Chapter, thinkingEnabled: boolean): string {
  const thinkingInstruction = thinkingEnabled
    ? '请先用 /think 进行推理，但最终输出必须是 JSON，不要输出任何其他内容。'
    : '请直接输出 JSON，不要输出任何推理过程。'

  return `${thinkingInstruction}

你是资深网络小说阅读助手。请严格根据下面这一章的内容生成一份概要 JSON，JSON 字段如下：
- short: 一句话概括本章核心情节（不超过 60 字）。
- detail: 详细概要，包含起因、经过、结果（150-300 字）。
- keyPoints: 字符串数组，列出本章 3-6 个必须记住的关键信息点。
- skippable: 判断本章是否可跳读。如果是过渡章、纯回忆、重复描写，返回"可跳读：简要说明原因"；否则返回"不可跳读：简要说明原因"。

只返回 JSON，不要加 markdown 代码块，不要解释。

章节标题：${chapter.title}
章节字数：${chapter.wordCount}

正文：
${chapter.content.slice(0, 12000)}`
}

async function generateWithOllama(
  chapter: Chapter,
  model: string,
  temperature: number,
  thinkingEnabled: boolean,
): Promise<Summary> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.trim(),
      prompt: buildSummaryPrompt(chapter, thinkingEnabled),
      stream: false,
      format: 'json',
      options: {
        temperature,
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Ollama 返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as { response?: string }
  const parsed = parseOllamaSummary(data.response ?? '{}')

  return {
    short: parsed.short || 'Ollama 没有返回一句话概要。',
    detail: parsed.detail || 'Ollama 没有返回详细概要。',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
    skippable: parsed.skippable || '暂无跳读建议。',
    generatedBy: 'ollama',
  }
}

async function generateWithOpenAICompatible(
  chapter: Chapter,
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  thinkingEnabled: boolean,
): Promise<Summary> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')

  if (!normalizedBaseUrl) {
    throw new Error('请先填写 OpenAI-compatible Base URL。')
  }

  if (!model.trim()) {
    throw new Error('请先填写 OpenAI-compatible Model Name。')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const requestBody: Record<string, unknown> = {
    model: model.trim(),
    messages: [
      {
        role: 'system',
        content: '你是长篇网络小说陪读助手。你必须只输出符合要求的 JSON。',
      },
      {
        role: 'user',
        content: buildSummaryPrompt(chapter, thinkingEnabled),
      },
    ],
    temperature,
    response_format: { type: 'json_object' },
  }

  if (!thinkingEnabled) {
    requestBody.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI-compatible 接口返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseOllamaSummary(content)

  return {
    short: parsed.short || '模型没有返回一句话概要。',
    detail: parsed.detail || '模型没有返回详细概要。',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
    skippable: parsed.skippable || '暂无跳读建议。',
    generatedBy: 'openai',
  }
}

function parseOllamaSummary(raw: string): Partial<Summary> {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    return JSON.parse(jsonText) as Partial<Summary>
  } catch {
    return {
      short: 'Ollama 已返回内容，但不是标准 JSON。',
      detail: raw.slice(0, 600),
      keyPoints: [],
      skippable: '请重试，或换一个更擅长中文指令的模型。',
    }
  }
}

async function fetchOllamaModels(): Promise<OllamaModel[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`)

  if (!response.ok) {
    throw new Error(`无法连接 Ollama：${response.status}`)
  }

  const data = (await response.json()) as { models?: OllamaModel[] }
  return data.models ?? []
}

export async function validateModelConfig(config: ModelConfigDraft): Promise<void> {
  await validateLlmConfig(config)
  await validateEmbeddingConfig(config.embeddingConfig)
}

async function validateLlmConfig(config: ModelConfigDraft): Promise<void> {
  if (config.aiProvider === 'ollama') {
    if (!config.ollamaModel.trim()) {
      throw new Error('[LLM] 请先选择或填写 Ollama 模型。')
    }

    if (!Number.isFinite(config.ollamaTemperature)) {
      throw new Error('[LLM] Ollama Temperature 必须是数字。')
    }

    if (normalizeConcurrency(config.ollamaConcurrency, 1) !== config.ollamaConcurrency) {
      throw new Error('[LLM] Ollama 并发度必须是 1 到 10 的整数。')
    }

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel.trim(),
        prompt: '/no_think\n只输出 JSON：{"ok":true}',
        stream: false,
        format: 'json',
        options: {
          temperature: config.ollamaTemperature,
        },
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`[LLM] Ollama 验证失败 ${response.status}：${body || '请求失败'}`)
    }

    return
  }

  const activeConfig = getActiveOpenAIConfig(config)

  if (!activeConfig) {
    throw new Error('[LLM] 请先新增一个外部模型配置。')
  }

  const normalizedBaseUrl = activeConfig.baseUrl.trim().replace(/\/+$/, '')

  if (!normalizedBaseUrl) {
    throw new Error('[LLM] 请填写 Base URL。')
  }

  if (!activeConfig.model.trim()) {
    throw new Error('[LLM] 请填写 Model Name。')
  }

  if (!Number.isFinite(activeConfig.temperature)) {
    throw new Error('[LLM] 当前外部模型的 Temperature 必须是数字。')
  }

  if (normalizeConcurrency(activeConfig.concurrency, 3) !== activeConfig.concurrency) {
    throw new Error('[LLM] 当前外部模型的并发度必须是 1 到 10 的整数。')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (activeConfig.apiKey.trim()) {
    headers.Authorization = `Bearer ${activeConfig.apiKey.trim()}`
  }

  const validateBody: Record<string, unknown> = {
    model: activeConfig.model.trim(),
    messages: [
      {
        role: 'user',
        content: '/no_think\n只输出 JSON：{"ok":true}',
      },
    ],
    temperature: activeConfig.temperature,
    response_format: { type: 'json_object' },
  }

  if (!activeConfig.thinkingEnabled) {
    validateBody.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(validateBody),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`[LLM] OpenAI-compatible 验证失败 ${response.status}：${body || '请求失败'}`)
  }
}

async function validateEmbeddingConfig(embeddingConfig: EmbeddingConfig): Promise<void> {
  const baseUrl = embeddingConfig.baseUrl.trim().replace(/\/+$/, '')
  const model = embeddingConfig.model.trim()

  if (!baseUrl) {
    throw new Error('[Embedding] 请填写 Base URL。')
  }

  if (!model) {
    throw new Error('[Embedding] 请填写模型名。')
  }

  const response = await fetch('/api/rag/embeddings/validate', {
    body: JSON.stringify({
      provider: embeddingConfig.provider,
      model,
      baseUrl,
      apiKey: embeddingConfig.apiKey,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string }
    throw new Error(`[Embedding] 验证失败：${payload.error ?? response.statusText}`)
  }
}

export function getModelConfigDraft(state: StoredState): ModelConfigDraft {
  return {
    aiProvider: state.aiProvider,
    ollamaModel: state.ollamaModel,
    ollamaTemperature: state.ollamaTemperature,
    ollamaConcurrency: state.ollamaConcurrency,
    openaiConfigs: state.openaiConfigs,
    activeOpenAIConfigId: state.activeOpenAIConfigId,
    thinkingEnabled: state.thinkingEnabled,
    embeddingConfig: sanitizeEmbeddingConfig(state.embeddingConfig),
  }
}

export type MobileTab = 'bookshelf' | 'chapters' | 'reader' | 'summary' | 'search'

export interface UseReaderStateReturn {
  state: StoredState
  setState: React.Dispatch<React.SetStateAction<StoredState>>
  view: AppView
  setView: React.Dispatch<React.SetStateAction<AppView>>
  mobileTab: MobileTab
  setMobileTab: React.Dispatch<React.SetStateAction<MobileTab>>
  chapterPage: number
  setChapterPage: React.Dispatch<React.SetStateAction<number>>
  chapterSearch: string
  setChapterSearch: React.Dispatch<React.SetStateAction<string>>
  isHydrated: boolean
  generatingBookId: string | null
  generatingBookProgress: string
  isConfigOpen: boolean
  modelConfigDraft: ModelConfigDraft
  setModelConfigDraft: React.Dispatch<React.SetStateAction<ModelConfigDraft>>
  isTestingConfig: boolean
  configError: string
  ollamaModels: OllamaModel[]
  isCheckingOllama: boolean
  error: string
  setError: React.Dispatch<React.SetStateAction<string>>
  activeChapter: Chapter | null
  activeSummary: Summary | null
  previousChapter: Chapter | null
  nextChapter: Chapter | null
  chapterPageCount: number
  pagedChapters: Chapter[]
  normalizedChapterSearch: string
  searchedChapters: Chapter[]
  visibleChapters: Chapter[]
  processedCount: number
  pageSummaryCount: number
  currentProgressLabel: string
  activeProviderLabel: string
  activeOpenAIConfig: OpenAIConfig | undefined
  activeModelName: string | undefined
  activeThinkingEnabled: boolean
  activeTemperature: number
  activeConcurrency: number
  draftActiveOpenAIConfig: OpenAIConfig | undefined
  importedDate: string
  handleImport: (file: File) => Promise<void>
  generateMissingSummariesForBook: (bookId: string) => Promise<void>
  selectBook: (bookId: string) => void
  deleteBook: (bookId: string) => void
  updateActiveChapter: (id: string) => void
  navigateToPreviousChapter: () => void
  navigateToNextChapter: () => void
  resetBook: () => void
  openModelConfig: () => void
  closeModelConfig: () => void
  updateActiveOpenAIConfig: (updates: Partial<OpenAIConfig>) => void
  addOpenAIConfig: () => void
  removeActiveOpenAIConfig: () => void
  saveModelConfig: () => Promise<void>
  getActiveConcurrency: () => number
}

function syncActiveLibraryBook(
  current: StoredState,
  updates: Partial<Pick<LibraryBook, 'activeChapterId' | 'summaries'>>,
): StoredState {
  if (!current.activeBookId) return { ...current, ...updates }

  return {
    ...current,
    ...updates,
    books: current.books.map((entry) =>
      entry.book.id === current.activeBookId ? { ...entry, ...updates } : entry,
    ),
  }
}

function getLibraryBookSummaries(current: StoredState, bookId: string): Record<string, Summary> {
  return current.books.find((entry) => entry.book.id === bookId)?.summaries ?? {}
}

function syncLibraryBook(
  current: StoredState,
  bookId: string,
  updates: Partial<Pick<LibraryBook, 'activeChapterId' | 'summaries'>>,
): StoredState {
  return {
    ...current,
    books: current.books.map((entry) =>
      entry.book.id === bookId ? { ...entry, ...updates } : entry,
    ),
  }
}

function getChapterPageForState(state: StoredState): number {
  if (!state.book || !state.activeChapterId) return 1

  const chapter = state.book.chapters.find((item) => item.id === state.activeChapterId)
  return chapter ? Math.ceil(chapter.index / CHAPTERS_PER_PAGE) : 1
}

export function useReaderState(): UseReaderStateReturn {
  const [state, setState] = useState<StoredState>(initialState)
  const [view, setView] = useState<AppView>('home')
  const [mobileTab, setMobileTab] = useState<MobileTab>('bookshelf')
  const [chapterPage, setChapterPage] = useState(1)
  const [chapterSearch, setChapterSearch] = useState('')
  const [isHydrated, setIsHydrated] = useState(false)
  const [generatingBookId, setGeneratingBookId] = useState<string | null>(null)
  const [generatingBookProgress, setGeneratingBookProgress] = useState('')
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>(() =>
    getModelConfigDraft(initialState),
  )
  const [isTestingConfig, setIsTestingConfig] = useState(false)
  const [configError, setConfigError] = useState('')
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)
  const [error, setError] = useState('')

  const activeChapter = useMemo(() => {
    if (!state.book || !state.activeChapterId) return null
    return state.book.chapters.find((chapter) => chapter.id === state.activeChapterId) ?? null
  }, [state.book, state.activeChapterId])

  const activeSummary = activeChapter ? state.summaries[activeChapter.id] : null
  const previousChapter =
    state.book && activeChapter && activeChapter.index > 1
      ? state.book.chapters[activeChapter.index - 2]
      : null
  const nextChapter =
    state.book && activeChapter && activeChapter.index < state.book.chapters.length
      ? state.book.chapters[activeChapter.index]
      : null
  const chapterPageCount = state.book
    ? Math.max(1, Math.ceil(state.book.chapters.length / CHAPTERS_PER_PAGE))
    : 1
  const pagedChapters = state.book
    ? state.book.chapters.slice(
        (chapterPage - 1) * CHAPTERS_PER_PAGE,
        chapterPage * CHAPTERS_PER_PAGE,
      )
    : []
  const normalizedChapterSearch = chapterSearch.trim().toLowerCase()
  const searchedChapters =
    state.book && normalizedChapterSearch
      ? state.book.chapters.filter((chapter) => {
          const titleNumber = getChapterTitleNumber(chapter.title)

          return (
            chapter.title.toLowerCase().includes(normalizedChapterSearch) ||
            String(chapter.index).includes(normalizedChapterSearch) ||
            (titleNumber !== null && String(titleNumber).includes(normalizedChapterSearch))
          )
        })
      : []
  const visibleChapters = normalizedChapterSearch ? searchedChapters : pagedChapters

  useEffect(() => {
    localStorage.removeItem(STORAGE_KEY)

    loadStateFromLocalDb()
      .then((storedState) => {
        if (storedState) {
          const nextState = normalizeStoredState(storedState as Partial<StoredState> & Record<string, unknown>)
          setState(nextState)
          setChapterPage(getChapterPageForState(nextState))
          return
        }

        return loadStateFromLegacyDb().then((legacyState) => {
          if (!legacyState) return

          const migratedState = normalizeStoredState(
            legacyState as Partial<StoredState> & Record<string, unknown>,
          )
          setState(migratedState)
          setChapterPage(getChapterPageForState(migratedState))
          return saveStateToLocalDb(migratedState)
        })
      })
      .catch(() => {
        setError('读取本地 SQLite 书库失败，请确认本地数据库服务已启动。')
      })
      .finally(() => setIsHydrated(true))
  }, [])

  useEffect(() => {
    if (!isHydrated) return

    saveStateToLocalDb(state).catch(() => {
      setError('保存到本地 SQLite 失败，请确认本地数据库服务仍在运行。')
    })
  }, [isHydrated, state])

  useEffect(() => {
    if (!isHydrated) return

    let isCancelled = false

    async function checkOllamaModels() {
      setIsCheckingOllama(true)

      try {
        const models = await fetchOllamaModels()
        if (isCancelled) return

        setOllamaModels(models)

        if (models.length && !models.some((model) => model.name === state.ollamaModel)) {
          setState((current) => ({ ...current, ollamaModel: models[0].name }))
        }
      } catch {
        if (isCancelled) return
        setOllamaModels([])
      } finally {
        if (!isCancelled) {
          setIsCheckingOllama(false)
        }
      }
    }

    void checkOllamaModels()

    return () => {
      isCancelled = true
    }
  }, [isHydrated, state.ollamaModel])

  async function handleImport(file: File) {
    setError('')

    try {
      const imported = await parseImportedBook(file)
      const { chapters } = imported

      if (!chapters.length) {
        setError('没有识别到正文内容，请换一个 txt 或 epub 文件试试。')
        return
      }

      const book: Book = {
        id: generateId(),
        title: imported.title,
        chapters,
        importedAt: new Date().toISOString(),
      }
      const libraryBook: LibraryBook = {
        book,
        activeChapterId: chapters[0].id,
        summaries: {},
      }

      setState((current) => ({
        ...current,
        books: [...current.books, libraryBook],
        activeBookId: book.id,
        book,
        activeChapterId: chapters[0].id,
        summaries: {},
      }))
      setChapterPage(1)
      setView('reader')
      setMobileTab('reader')
    } catch (err) {
      setError(err instanceof Error ? `导入失败：${err.message}` : '导入失败，请重试。')
    }
  }

  async function generateMissingSummariesForBook(bookId: string) {
    const libraryBook = state.books.find((entry) => entry.book.id === bookId)

    if (!libraryBook) return

    const pendingChapters = libraryBook.book.chapters.filter(
      (chapter) => !libraryBook.summaries[chapter.id],
    )
    const totalChapters = libraryBook.book.chapters.length
    const missingCount = pendingChapters.length

    if (!missingCount) {
      setGeneratingBookId(bookId)
      setGeneratingBookProgress('概要已经全部生成。')
      setTimeout(() => {
        setGeneratingBookId((current) => (current === bookId ? null : current))
      }, 2000)
      return
    }

    if (
      missingCount > 50 &&
      !window.confirm(
        `全书共 ${totalChapters} 章，其中 ${missingCount} 章缺少概要。\n` +
          `批量生成将调用 AI 接口 ${missingCount} 次，可能耗时较长并消耗较多 token。\n` +
          '确定要继续吗？',
      )
    ) {
      return
    }

    const concurrency = getActiveConcurrency()
    const baselineProcessedCount = totalChapters - missingCount

    setGeneratingBookId(bookId)
    setGeneratingBookProgress(`并发 ${concurrency}，准备生成 ${missingCount} 章概要`)
    setError('')

    try {
      let nextIndex = 0
      let completedCount = 0
      let failedCount = 0

      async function worker() {
        while (nextIndex < pendingChapters.length) {
          const chapter = pendingChapters[nextIndex]
          nextIndex += 1

          setGeneratingBookProgress(
            `并发 ${concurrency}，正在生成 ${completedCount + failedCount + 1}/${missingCount}（全书 ${baselineProcessedCount + completedCount + failedCount + 1}/${totalChapters}）：第 ${chapter.index} 章`,
          )

          try {
            const summary = await generateChapterSummary(chapter)
            completedCount += 1

            setState((current) =>
              syncLibraryBook(current, bookId, {
                summaries: {
                  ...getLibraryBookSummaries(current, bookId),
                  [chapter.id]: summary,
                },
              }),
            )
          } catch {
            failedCount += 1
          }

          setGeneratingBookProgress(
            `并发 ${concurrency}，已完成 ${completedCount}/${missingCount}（全书 ${baselineProcessedCount + completedCount}/${totalChapters}），失败 ${failedCount} 章`,
          )
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, missingCount) }, () => worker()),
      )

      if (failedCount > 0) {
        setGeneratingBookProgress(
          `批量生成结束，成功 ${completedCount} 章，失败 ${failedCount} 章。`,
        )
      } else {
        setGeneratingBookProgress(`全书 ${missingCount} 章缺失概要已生成。`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量生成概要失败。')
    } finally {
      setTimeout(() => {
        setGeneratingBookId((current) => (current === bookId ? null : current))
      }, 2000)
    }
  }

  async function generateChapterSummary(chapter: Chapter): Promise<Summary> {
    if (state.aiProvider === 'openai') {
      const activeConfig = getActiveOpenAIConfig(state)

      if (!activeConfig) {
        throw new Error('请先配置外部模型。')
      }

      return generateWithOpenAICompatible(
        chapter,
        activeConfig.baseUrl,
        activeConfig.apiKey,
        activeConfig.model,
        activeConfig.temperature,
        activeConfig.thinkingEnabled,
      )
    }

    if (!state.ollamaModel.trim()) {
      throw new Error('请先配置 Ollama 模型。')
    }

    return generateWithOllama(
      chapter,
      state.ollamaModel,
      state.ollamaTemperature,
      state.thinkingEnabled,
    )
  }

  function getActiveConcurrency() {
    if (state.aiProvider === 'openai') {
      return normalizeConcurrency(getActiveOpenAIConfig(state)?.concurrency, 3)
    }

    return normalizeConcurrency(state.ollamaConcurrency, 1)
  }

  function updateActiveChapter(id: string) {
    const chapter = state.book?.chapters.find((item) => item.id === id)
    if (chapter) {
      setChapterPage(Math.ceil(chapter.index / CHAPTERS_PER_PAGE))
    }
    setState((current) => syncActiveLibraryBook(current, { activeChapterId: id }))
  }

  function navigateToPreviousChapter() {
    if (!previousChapter) return

    updateActiveChapter(previousChapter.id)
  }

  function navigateToNextChapter() {
    if (!nextChapter) return

    updateActiveChapter(nextChapter.id)
  }

  function selectBook(bookId: string) {
    const nextBook = state.books.find((entry) => entry.book.id === bookId)
    if (!nextBook) return

    setState((current) => ({
      ...current,
      activeBookId: nextBook.book.id,
      book: nextBook.book,
      activeChapterId: nextBook.activeChapterId ?? nextBook.book.chapters[0]?.id ?? null,
      summaries: nextBook.summaries,
    }))
    setChapterPage(getChapterPageForState({
      ...state,
      activeBookId: nextBook.book.id,
      book: nextBook.book,
      activeChapterId: nextBook.activeChapterId ?? nextBook.book.chapters[0]?.id ?? null,
      summaries: nextBook.summaries,
    }))
    setChapterSearch('')
    setView('reader')
    setMobileTab('reader')
  }

  function deleteBook(bookId: string) {
    setState((current) => {
      const nextBooks = current.books.filter((entry) => entry.book.id !== bookId)
      const nextActive =
        current.activeBookId === bookId
          ? nextBooks[0] ?? null
          : nextBooks.find((entry) => entry.book.id === current.activeBookId) ?? null

      return {
        ...current,
        books: nextBooks,
        activeBookId: nextActive?.book.id ?? null,
        book: nextActive?.book ?? null,
        activeChapterId: nextActive?.activeChapterId ?? nextActive?.book.chapters[0]?.id ?? null,
        summaries: nextActive?.summaries ?? {},
      }
    })
    setView('home')
    setMobileTab('bookshelf')
    setChapterSearch('')
  }

  function resetBook() {
    if (!state.activeBookId) return
    deleteBook(state.activeBookId)
  }

  function openModelConfig() {
    setModelConfigDraft(getModelConfigDraft(state))
    setConfigError('')
    setIsConfigOpen(true)
  }

  function closeModelConfig() {
    if (isTestingConfig) return

    setConfigError('')
    setModelConfigDraft(getModelConfigDraft(state))
    setIsConfigOpen(false)
  }

  function updateActiveOpenAIConfig(updates: Partial<OpenAIConfig>) {
    setModelConfigDraft((current) => ({
      ...current,
      openaiConfigs: current.openaiConfigs.map((config) =>
        config.id === current.activeOpenAIConfigId ? { ...config, ...updates } : config,
      ),
    }))
  }

  function addOpenAIConfig() {
    const id = generateId()

    setModelConfigDraft((current) => ({
      ...current,
      aiProvider: 'openai',
      activeOpenAIConfigId: id,
      openaiConfigs: [
        ...current.openaiConfigs,
        {
          id,
          name: `外部模型 ${current.openaiConfigs.length + 1}`,
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4.1-mini',
          thinkingEnabled: false,
          temperature: 1,
          concurrency: 3,
        },
      ],
    }))
  }

  function removeActiveOpenAIConfig() {
    setModelConfigDraft((current) => {
      if (current.openaiConfigs.length <= 1) return current

      const nextConfigs = current.openaiConfigs.filter(
        (config) => config.id !== current.activeOpenAIConfigId,
      )

      return {
        ...current,
        activeOpenAIConfigId: nextConfigs[0].id,
        openaiConfigs: nextConfigs,
      }
    })
  }

  async function saveModelConfig() {
    setIsTestingConfig(true)
    setConfigError('')

    try {
      await validateModelConfig(modelConfigDraft)
      const openaiConfigs = sanitizeOpenAIConfigs(modelConfigDraft.openaiConfigs).map((config) => ({
        ...config,
        baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: config.apiKey.trim(),
        model: config.model.trim(),
        temperature: Number.isFinite(config.temperature) ? config.temperature : 1,
        concurrency: normalizeConcurrency(config.concurrency, 3),
        name: config.name.trim() || config.model.trim() || '外部模型',
      }))
      const activeOpenAIConfigId = openaiConfigs.some(
        (config) => config.id === modelConfigDraft.activeOpenAIConfigId,
      )
        ? modelConfigDraft.activeOpenAIConfigId
        : openaiConfigs[0].id

      setState((current) => ({
        ...current,
        ...modelConfigDraft,
        openaiConfigs,
        activeOpenAIConfigId,
        ollamaTemperature: Number.isFinite(modelConfigDraft.ollamaTemperature)
          ? modelConfigDraft.ollamaTemperature
          : 1,
        ollamaConcurrency: normalizeConcurrency(modelConfigDraft.ollamaConcurrency, 1),
        ollamaModel: modelConfigDraft.ollamaModel.trim(),
      }))
      setIsConfigOpen(false)
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : '模型配置验证失败。')
    } finally {
      setIsTestingConfig(false)
    }
  }

  const processedCount = Object.keys(state.summaries).length
  const pageSummaryCount = pagedChapters.filter((chapter) => state.summaries[chapter.id]).length
  const currentProgressLabel = activeChapter
    ? `${activeChapter.title}（位置 ${activeChapter.index}/${state.book?.chapters.length ?? 0}）`
    : '未开始'
  const activeProviderLabel = state.aiProvider === 'openai' ? '外部模型' : 'Ollama'
  const activeOpenAIConfig = getActiveOpenAIConfig(state)
  const activeModelName =
    state.aiProvider === 'openai' ? activeOpenAIConfig?.name || activeOpenAIConfig?.model : state.ollamaModel
  const activeThinkingEnabled =
    state.aiProvider === 'openai'
      ? Boolean(activeOpenAIConfig?.thinkingEnabled)
      : state.thinkingEnabled
  const activeTemperature =
    state.aiProvider === 'openai' ? activeOpenAIConfig?.temperature ?? 1 : state.ollamaTemperature
  const activeConcurrency = getActiveConcurrency()
  const draftActiveOpenAIConfig = getActiveOpenAIConfig(modelConfigDraft)
  const importedDate = state.book
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(state.book.importedAt))
    : ''

  return {
    state,
    setState,
    view,
    setView,
    mobileTab,
    setMobileTab,
    chapterPage,
    setChapterPage,
    chapterSearch,
    setChapterSearch,
    isHydrated,
    generatingBookId,
    generatingBookProgress,
    isConfigOpen,
    modelConfigDraft,
    setModelConfigDraft,
    isTestingConfig,
    configError,
    ollamaModels,
    isCheckingOllama,
    error,
    setError,
    activeChapter,
    activeSummary,
    previousChapter,
    nextChapter,
    chapterPageCount,
    pagedChapters,
    normalizedChapterSearch,
    searchedChapters,
    visibleChapters,
    processedCount,
    pageSummaryCount,
    currentProgressLabel,
    activeProviderLabel,
    activeOpenAIConfig,
    activeModelName,
    activeThinkingEnabled,
    activeTemperature,
    activeConcurrency,
    draftActiveOpenAIConfig,
    importedDate,
    handleImport,
    generateMissingSummariesForBook,
    selectBook,
    deleteBook,
    updateActiveChapter,
    navigateToPreviousChapter,
    navigateToNextChapter,
    resetBook,
    openModelConfig,
    closeModelConfig,
    updateActiveOpenAIConfig,
    addOpenAIConfig,
    removeActiveOpenAIConfig,
    saveModelConfig,
    getActiveConcurrency,
  }
}
