import { useEffect, useMemo, useState } from 'react'
import { getCachedChapters, saveCachedChapters } from '../lib/chapterCache'
import { extractPdfDocument } from '../lib/pdfImport'

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
  keyPointSources?: SummaryKeyPointSource[]
  skippable: string
  generatedBy: 'local' | 'ollama' | 'openai'
}

export type SummaryKeyPointSource = {
  index: number
  text: string
  startOffset: number
  endOffset: number
  quote: string
  confidence: number
  locator: string
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
  concurrency: number
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
export type MissingSummaryBatchResult = {
  completedCount: number
  failedCount: number
  missingCount: number
}
export type SummaryGenerationSelectionOptions = {
  overwriteExisting?: boolean
}

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

export function chapterScrollPositionKey(bookId: string | null | undefined, chapterId: string) {
  return `${bookId || 'book'}:${chapterId}`
}

export function readChapterScrollPosition(
  positions: Record<string, number>,
  bookId: string | null | undefined,
  chapterId: string,
) {
  const scoped = positions[chapterScrollPositionKey(bookId, chapterId)]
  if (typeof scoped === 'number' && Number.isFinite(scoped)) return Math.max(0, scoped)

  const legacy = positions[chapterId]
  return typeof legacy === 'number' && Number.isFinite(legacy) ? Math.max(0, legacy) : 0
}

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
    concurrency: 3,
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
  const response = await fetch('/api/state?source=structured&content=metadata')

  if (!response.ok) {
    throw new Error('Local database API is not available.')
  }

  const payload = (await response.json()) as { state?: unknown }
  return payload.state ?? null
}

async function loadLibraryBookFromLocalDb(bookId: string, includeContent = false): Promise<LibraryBook> {
  const contentMode = includeContent ? 'full' : 'metadata'
  const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/library-state?content=${contentMode}`)

  if (!response.ok) {
    throw new Error('Local database API could not load the selected book.')
  }

  const payload = (await response.json()) as { libraryBook?: unknown }
  const libraryBook = payload.libraryBook as LibraryBook | undefined
  if (!libraryBook?.book) {
    throw new Error('Selected book payload is invalid.')
  }

  return libraryBook
}

async function loadChaptersFromLocalDb(bookId: string, params: { start?: number; end?: number; ids?: string[] }): Promise<Chapter[]> {
  const search = new URLSearchParams()
  if (params.ids?.length) {
    search.set('ids', params.ids.join(','))
  } else if (params.start && params.end) {
    search.set('start', String(params.start))
    search.set('end', String(params.end))
  }

  const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters?${search}`)

  if (!response.ok) {
    throw new Error('Local database API could not load chapters.')
  }

  const payload = (await response.json()) as { chapters?: Chapter[] }
  return Array.isArray(payload.chapters) ? payload.chapters : []
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([chapterId, summary]) => [chapterId, sanitizeSummary(summary)])
      .filter((entry): entry is [string, Summary] => Boolean(entry[1])),
  )
}

function sanitizeSummary(value: unknown): Summary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = value as Record<string, unknown>
  const keyPoints = Array.isArray(summary.keyPoints)
    ? summary.keyPoints.filter((point): point is string => typeof point === 'string' && Boolean(point.trim())).map((point) => point.trim())
    : []
  return {
    short: typeof summary.short === 'string' ? summary.short : '',
    detail: typeof summary.detail === 'string' ? summary.detail : '',
    keyPoints,
    keyPointSources: normalizeSummaryKeyPointSources(summary.keyPointSources, keyPoints),
    skippable: typeof summary.skippable === 'string' ? summary.skippable : '',
    generatedBy: summary.generatedBy === 'ollama' || summary.generatedBy === 'openai' ? summary.generatedBy : 'local',
  }
}

function normalizeSummaryKeyPointSources(value: unknown, keyPoints: string[] = []): SummaryKeyPointSource[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry, fallbackIndex): SummaryKeyPointSource | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const source = entry as Record<string, unknown>
      const index = Number.isInteger(source.index) && (source.index as number) >= 0 ? source.index as number : fallbackIndex
      const startOffset = Number.isInteger(source.startOffset) && (source.startOffset as number) >= 0 ? source.startOffset as number : null
      const endOffset = Number.isInteger(source.endOffset) && (source.endOffset as number) >= 0 ? source.endOffset as number : null
      const text = typeof source.text === 'string' && source.text.trim() ? source.text.trim() : keyPoints[index] ?? ''
      if (!text || startOffset === null || endOffset === null || endOffset <= startOffset) return null
      return {
        index,
        text,
        startOffset,
        endOffset,
        quote: typeof source.quote === 'string' ? source.quote : '',
        confidence: typeof source.confidence === 'number' && source.confidence >= 0 && source.confidence <= 1 ? source.confidence : 1,
        locator: typeof source.locator === 'string' && source.locator.trim() ? source.locator.trim() : 'quote',
      }
    })
    .filter((entry): entry is SummaryKeyPointSource => Boolean(entry))
}

function locateSummaryKeyPointSources(chapterContent: string, keyPoints: string[], hints: unknown): SummaryKeyPointSource[] {
  const hintList = Array.isArray(hints) ? hints.filter((hint) => hint && typeof hint === 'object' && !Array.isArray(hint)) as Record<string, unknown>[] : []
  return keyPoints
    .map((point, index): SummaryKeyPointSource | null => {
      const hint = hintList.find((candidate) => candidate.index === index || candidate.text === point)
      const quotes = [
        typeof hint?.quote === 'string' ? hint.quote : '',
        ...(Array.isArray(hint?.quotes) ? hint.quotes.filter((quote): quote is string => typeof quote === 'string') : []),
        point,
      ].map((quote) => quote.trim()).filter(Boolean)
      for (const quote of Array.from(new Set(quotes))) {
        const located = locateQuoteInText(chapterContent, quote)
        if (!located) continue
        return {
          index,
          text: point,
          startOffset: located.startOffset,
          endOffset: located.endOffset,
          quote: chapterContent.slice(located.startOffset, located.endOffset),
          confidence: located.confidence,
          locator: located.locator,
        }
      }
      return null
    })
    .filter((entry): entry is SummaryKeyPointSource => Boolean(entry))
}

function locateQuoteInText(text: string, quote: string): { startOffset: number; endOffset: number; confidence: number; locator: string } | null {
  const needle = quote.trim()
  if (!text || !needle) return null
  const exact = text.indexOf(needle)
  if (exact >= 0) return { startOffset: exact, endOffset: exact + needle.length, confidence: 1, locator: 'exact' }
  const normalizedText = normalizeTextWithMap(text)
  const normalizedNeedle = normalizeTextForLocation(needle)
  const normalizedIndex = normalizedText.normalized.indexOf(normalizedNeedle)
  if (normalizedIndex < 0) return null
  const startOffset = normalizedText.map[normalizedIndex]
  const endSource = normalizedText.map[normalizedIndex + normalizedNeedle.length - 1]
  if (startOffset === undefined || endSource === undefined) return null
  return { startOffset, endOffset: endSource + 1, confidence: 0.86, locator: 'normalized' }
}

function normalizeTextWithMap(value: string) {
  const map: number[] = []
  let normalized = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = normalizeLocationChar(value[index])
    if (!char) continue
    normalized += char
    map.push(index)
  }
  return { normalized, map }
}

function normalizeTextForLocation(value: string) {
  return Array.from(value).map(normalizeLocationChar).join('')
}

function normalizeLocationChar(value: string) {
  return /\s/u.test(value) ? '' : value.normalize('NFKC').toLowerCase()
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
  const concurrency =
    typeof config.concurrency === 'number' && Number.isFinite(config.concurrency)
      ? normalizeConcurrency(config.concurrency, fallback.concurrency)
      : fallback.concurrency
  const dimension =
    typeof config.dimension === 'number' && Number.isFinite(config.dimension)
      ? config.dimension
      : fallback.dimension

  return { provider, baseUrl, model, apiKey, concurrency, dimension }
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
  /^\s*(?:(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回][^\n]*|(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回][^\n]*|Chapter\s*\d+[^\n]*|\d+[.、]\s*[^\n]+)\s*$/gim

function normalizeChapterTitle(title: string): string {
  return title.replace(/^正文\s+/, '').trim()
}

function splitHeadingLine(line: string): { title: string; contentPrefix: string } {
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

type ChapterTitleAnomaly = {
  chapterIndex: number
  headingLine: string
  suspectedTitle: string
  suspectedContentPrefix: string
  reason: string
}

type ChapterTitleRepairSuggestion = {
  chapterIndex: number
  isAnomaly: boolean
  fixedTitle: string
  contentPrefix: string
  confidence: number
  reason: string
}

export function detectChapterTitleAnomalies(rawText: string): ChapterTitleAnomaly[] {
  const matches = Array.from(rawText.matchAll(CHAPTER_PATTERN))

  return matches
    .map((match, index) => {
      const headingLine = normalizeChapterTitle(String(match[0] ?? '').trim())
      const split = splitHeadingLine(headingLine)
      const hasQuotedDialogue = /["“”][^"“”]{2,80}["“”]/.test(headingLine)
      const isVeryLong = headingLine.length > 80
      const hasInlineProse = Boolean(split.contentPrefix)

      if (!hasInlineProse && !isVeryLong && !hasQuotedDialogue) return null

      return {
        chapterIndex: index + 1,
        headingLine,
        suspectedTitle: split.title,
        suspectedContentPrefix: split.contentPrefix,
        reason: hasInlineProse
          ? '章节标题行疑似粘连正文起手句。'
          : '章节标题行过长或包含对白，疑似把正文误并入标题。',
      }
    })
    .filter((item): item is ChapterTitleAnomaly => Boolean(item))
}

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
    const heading = splitHeadingLine(lines[0].trim())
    const contentLines = heading.contentPrefix ? [heading.contentPrefix, ...lines.slice(1)] : lines.slice(1)
    const content = contentLines.join('\n').trim()

    return {
      id: `${idx + 1}-${heading.title.slice(0, 32)}`,
      index: idx + 1,
      title: heading.title,
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

  const fallbackPattern = /^((?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[集卷部]\s+第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回]|(?:正文\s*)?第\s*[0-9零一二三四五六七八九十百千万亿〇○]+\s*[章卷节回]|Chapter\s*\d+|\d+[.、])/

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

      currentTitle = normalizeChapterTitle(line)
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

function cleanFormattingTags(text: string): string {
  return text.replace(/\[\/?(?:color|b|i|u|size)(?:=[^\]]*)?\]/gi, '')
}

function stripPublicDomainBoilerplate(text: string): string {
  let output = text
  const startMarker =
    /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[\s\r\n]*/i
  const endMarker =
    /[\s\r\n]*\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[\s\S]*$/i

  const startMatch = output.match(startMarker)
  if (startMatch?.index != null) {
    output = output.slice(startMatch.index + startMatch[0].length)
  }

  output = output.replace(endMarker, '')
  return output.trim()
}

function isBadSplit(chapters: Chapter[], rawText: string): boolean {
  if (chapters.length < 2) return true

  const totalChars = rawText.replace(/\s/g, '').length
  const avgLength = totalChars / chapters.length

  return avgLength > 30000 || (totalChars > 100000 && chapters.length < 3)
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    if (start === -1) throw new Error('模型没有返回 JSON 对象。')

    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i += 1) {
      const char = text[i]
      if (escape) {
        escape = false
        continue
      }
      if (char === '\\') {
        escape = true
        continue
      }
      if (char === '"' && !inString) {
        inString = true
        continue
      }
      if (char === '"' && inString) {
        inString = false
        continue
      }
      if (inString) continue
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }

    throw new Error('模型没有返回 JSON 对象。')
  }
}

function convertChineseNumber(input: string): number | null {
  const normalized = input.trim()
  if (!normalized) return null

  const asInt = Number(normalized)
  if (Number.isFinite(asInt)) return asInt

  const s = normalized
    .replace(/廿/g, '二十')
    .replace(/卅/g, '三十')
    .replace(/〇/g, '零')
    .replace(/○/g, '零')

  const digitMap: Record<string, number> = {
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
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
    亿: 100000000,
  }

  let total = 0
  let temp = 0

  for (const char of s) {
    if (char in digitMap) {
      temp = temp * 10 + digitMap[char]
    } else if (char in unitMap) {
      const unit = unitMap[char]
      total += (temp === 0 ? 1 : temp) * unit
      temp = 0
    }
  }

  total += temp
  return total === 0 && s !== '零' ? null : total
}

type HeadingInfo = {
  index: number
  raw: string
  vol: number
  ch: number
  title: string
  displayTitle?: string
}

type LocalPattern = {
  name: string
  regex: RegExp
  extract: (match: RegExpMatchArray) => { vol: number; ch: number; title: string } | null
}

const CN_NUM = '[一二三四五六七八九十百千万亿〇○零廿卅\\d]+'

const LOCAL_CHAPTER_PATTERNS: LocalPattern[] = [
  {
    name: 'bracket-volume-colon-chapter',
    regex: new RegExp(`^【第(${CN_NUM})卷[：:](.+?)】第(${CN_NUM})折[：:\\s\\u3000]+(.+)$`, 'im'),
    extract: (m) => {
      const vol = convertChineseNumber(m[1])
      const ch = convertChineseNumber(m[3])
      if (vol == null || ch == null) return null
      return { vol, ch, title: m[4].trim() }
    },
  },
  {
    name: 'plain-volume-bracket-chapter',
    regex: new RegExp(`^卷(${CN_NUM})\\s+(.+?)\\s+【第(${CN_NUM})折[\\s\\u3000]+(.+?)】$`, 'im'),
    extract: (m) => {
      const vol = convertChineseNumber(m[1])
      const ch = convertChineseNumber(m[3])
      if (vol == null || ch == null) return null
      return { vol, ch, title: m[4].trim() }
    },
  },
  {
    name: 'plain-volume-space-chapter',
    regex: new RegExp(`^卷(${CN_NUM})\\s+(.+?)\\s+第(${CN_NUM})折[\\s\\u3000]+(.+)$`, 'im'),
    extract: (m) => {
      const vol = convertChineseNumber(m[1])
      const ch = convertChineseNumber(m[3])
      if (vol == null || ch == null) return null
      return { vol, ch, title: m[4].trim() }
    },
  },
  {
    name: 'plain-volume-tight-chapter',
    regex: new RegExp(`^卷(${CN_NUM})\\s*(.+?)第(${CN_NUM})折[\\s\\u3000]*(.+)$`, 'im'),
    extract: (m) => {
      const vol = convertChineseNumber(m[1])
      const ch = convertChineseNumber(m[3])
      if (vol == null || ch == null) return null
      return { vol, ch, title: m[4].trim() }
    },
  },
  {
    name: 'plain-chapter-only',
    regex: new RegExp(`^第(${CN_NUM})折[：:\\s\\u3000]+(.+)$`, 'im'),
    extract: (m) => {
      const ch = convertChineseNumber(m[1])
      if (ch == null) return null
      return { vol: 1, ch, title: m[2].trim() }
    },
  },
  {
    name: 'plain-hui-chapter',
    regex: new RegExp(`^(?:正文\\s*)?第(${CN_NUM})回[：:、\\s\\u3000]*(.+)$`, 'im'),
    extract: (m) => {
      const ch = convertChineseNumber(m[1])
      if (ch == null) return null
      return { vol: 1, ch, title: m[2].trim() }
    },
  },
  {
    name: 'plain-zhang-chapter',
    regex: new RegExp(`^(?:正文\\s*)?第(${CN_NUM})章[：:、\\s\\u3000]*(.+)$`, 'im'),
    extract: (m) => {
      const ch = convertChineseNumber(m[1])
      if (ch == null) return null
      return { vol: 1, ch, title: m[2].trim() }
    },
  },
]

const DEFAULT_NON_CHAPTER_MARKERS = [
  '完',
  '后记',
  '待续',
  '感恩',
  '展望',
  '序章',
  '楔子',
  '尾声',
  '番外',
  '前言',
  '引言',
  '目录',
]

function isNonChapterMarker(line: string, extraMarkers: string[]): boolean {
  const allMarkers = [...DEFAULT_NON_CHAPTER_MARKERS, ...extraMarkers]
  return allMarkers.some((marker) => line.includes(marker))
}

function extractChapterHeadings(rawText: string, extraMarkers: string[] = []): HeadingInfo[] {
  const lines = rawText.split(/\r?\n/)
  const headings: HeadingInfo[] = []

  let globalIndex = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      globalIndex += line.length + 1
      continue
    }

    if (isNonChapterMarker(trimmed, extraMarkers)) {
      globalIndex += line.length + 1
      continue
    }

    for (const pattern of LOCAL_CHAPTER_PATTERNS) {
      const match = trimmed.match(pattern.regex)
      if (!match) continue

      const info = pattern.extract(match)
      if (!info) continue

      headings.push({
        index: globalIndex,
        raw: trimmed,
        vol: info.vol,
        ch: info.ch,
        title: info.title,
      })
      break
    }

    globalIndex += line.length + 1
  }

  return headings
}

function standardizeHeading(vol: number, ch: number, title: string): string {
  return `第${vol}卷第${ch}章：${title}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectFormatExamples(analysis: FormatAnalysis | null): string[] {
  const examples = analysis?.formats.flatMap((format) => format.examples) ?? []
  const seen = new Set<string>()

  return examples
    .map((example) => example.replace(/\s+/g, ' ').trim())
    .filter((example) => {
      if (!example || seen.has(example)) return false
      seen.add(example)
      return true
    })
}

function buildExamplePattern(example: string): LocalPattern | null {
  const match = new RegExp(`^(.*?)第\\s*(${CN_NUM})\\s*([章卷节回折])([：:、\\s\\u3000]*)(.+)$`, 'i').exec(
    example,
  )
  if (!match) return null

  const prefix = match[1].trim()
  const unit = match[3]
  const prefixPattern = prefix ? `${escapeRegExp(prefix)}\\s*` : ''

  return {
    name: `llm-example-${example.slice(0, 24)}`,
    regex: new RegExp(`^${prefixPattern}第\\s*(${CN_NUM})\\s*${escapeRegExp(unit)}[：:、\\s\\u3000]*(.+)$`, 'im'),
    extract: (m) => {
      const ch = convertChineseNumber(m[1])
      if (ch == null) return null
      return { vol: 1, ch, title: m[2].trim() }
    },
  }
}

function extractChapterHeadingsWithPatterns(
  rawText: string,
  patterns: LocalPattern[],
  extraMarkers: string[] = [],
): HeadingInfo[] {
  const lines = rawText.split(/\r?\n/)
  const headings: HeadingInfo[] = []

  let globalIndex = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      globalIndex += line.length + 1
      continue
    }

    if (isNonChapterMarker(trimmed, extraMarkers)) {
      globalIndex += line.length + 1
      continue
    }

    for (const pattern of patterns) {
      const match = trimmed.match(pattern.regex)
      if (!match) continue

      const info = pattern.extract(match)
      if (!info) continue

      headings.push({
        index: globalIndex,
        raw: trimmed,
        vol: info.vol,
        ch: info.ch,
        title: info.title,
        displayTitle: normalizeChapterTitle(trimmed),
      })
      break
    }

    globalIndex += line.length + 1
  }

  return headings
}

function extractChapterHeadingsFromExamples(
  rawText: string,
  analysis: FormatAnalysis | null,
  extraMarkers: string[] = [],
): HeadingInfo[] {
  const patterns = collectFormatExamples(analysis)
    .map(buildExamplePattern)
    .filter((pattern): pattern is LocalPattern => Boolean(pattern))

  if (!patterns.length) return []

  return extractChapterHeadingsWithPatterns(rawText, patterns, extraMarkers)
}

function isPlausibleHeadingSet(headings: HeadingInfo[], rawText: string): boolean {
  if (headings.length < 2) return false

  const nonEmptyLines = rawText.split(/\r?\n/).filter((line) => line.trim()).length
  if (nonEmptyLines > 0 && headings.length > nonEmptyLines * 0.05) return false

  const uniqueIndexes = new Set(headings.map((heading) => heading.index))
  return uniqueIndexes.size === headings.length
}

function splitWithHeadings(rawText: string, headings: HeadingInfo[]): Chapter[] {
  if (headings.length < 2) return []

  return headings.map((heading, idx) => {
    const start = heading.index
    const end = idx < headings.length - 1 ? headings[idx + 1].index : rawText.length
    const block = rawText.slice(start, end).trim()
    const lines = block.split(/\r?\n/)
    const title = heading.displayTitle ?? standardizeHeading(heading.vol, heading.ch, heading.title)
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

function buildFormatAnalysisPrompt(sample: string): string {
  return `你是一名文本处理助手。请分析下面这部中文小说的三个片段，它们分别来自小说的开头、中间和结尾。找出其中章节标题的规律。

说明：
- 文本中可能包含 [color=...]、[b]、[/b]、[/color] 等格式标签，这些标签会在后续处理中被移除。请忽略这些标签。
- 不同位置的章节标题格式可能不同。

要求：
1. 只返回一个 JSON 对象，不要输出任何其他解释。
2. JSON 格式必须是：
   {"formats": [{"description": "格式描述", "examples": ["示例1", "示例2"]}], "nonChapterMarkers": ["完", "后记"]}
3. description 用自然语言描述一种章节标题格式。
4. examples 必须列出完整的真实章节标题行（从片段中原样截取），不要只返回章节号或摘要。
5. nonChapterMarkers 列出看起来像章节标题但不是正文章节的标记（如"第一卷完"、"后记"、"待续"等）。

文本片段：
${sample}`
}

type FormatAnalysis = {
  formats: Array<{
    description: string
    examples: string[]
  }>
  nonChapterMarkers: string[]
}

function parseFormatAnalysis(raw: string): FormatAnalysis | null {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    const parsed = parseJsonObject(jsonText) as Record<string, unknown>
    const formats = Array.isArray(parsed.formats)
      ? parsed.formats
          .map((item) => {
            const format = item as Record<string, unknown>
            const description = typeof format.description === 'string' ? format.description : ''
            const examples = Array.isArray(format.examples)
              ? format.examples.filter((e): e is string => typeof e === 'string')
              : []
            return description ? { description, examples } : null
          })
          .filter((item): item is FormatAnalysis['formats'][number] => Boolean(item))
      : []
    const nonChapterMarkers = Array.isArray(parsed.nonChapterMarkers)
      ? parsed.nonChapterMarkers.filter((m): m is string => typeof m === 'string')
      : []

    return { formats, nonChapterMarkers }
  } catch {
    return null
  }
}

function parseChapterTitleRepairSuggestions(raw: string): ChapterTitleRepairSuggestion[] {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    const parsed = parseJsonObject(jsonText) as Record<string, unknown>
    const repairs = Array.isArray(parsed.repairs) ? parsed.repairs : []

    return repairs
      .map((item) => {
        const repair = item as Record<string, unknown>
        const chapterIndex = Number(repair.chapterIndex)
        const fixedTitle = typeof repair.fixedTitle === 'string' ? repair.fixedTitle.trim() : ''
        const contentPrefix = typeof repair.contentPrefix === 'string' ? repair.contentPrefix.trim() : ''
        const confidence = Number(repair.confidence)

        if (!Number.isInteger(chapterIndex) || chapterIndex < 1 || !fixedTitle || !Number.isFinite(confidence)) {
          return null
        }

        return {
          chapterIndex,
          isAnomaly: repair.isAnomaly === true,
          fixedTitle,
          contentPrefix,
          confidence,
          reason: typeof repair.reason === 'string' ? repair.reason : '',
        }
      })
      .filter((item): item is ChapterTitleRepairSuggestion => Boolean(item))
  } catch {
    return []
  }
}

function buildChapterTitleRepairPrompt(anomalies: ChapterTitleAnomaly[], chapters: Chapter[]): string {
  const candidates = anomalies
    .slice(0, 8)
    .map((anomaly) => {
      const chapter = chapters[anomaly.chapterIndex - 1]
      const previousTitle = chapters[anomaly.chapterIndex - 2]?.title ?? ''
      const nextTitle = chapters[anomaly.chapterIndex]?.title ?? ''

      return {
        chapterIndex: anomaly.chapterIndex,
        previousTitle,
        headingLine: anomaly.headingLine,
        currentParsedTitle: chapter?.title ?? '',
        currentContentStart: chapter?.content.slice(0, 500) ?? '',
        nextTitle,
        localGuess: {
          fixedTitle: anomaly.suspectedTitle,
          contentPrefix: anomaly.suspectedContentPrefix,
          reason: anomaly.reason,
        },
      }
    })

  return `你是一名中文小说章节切分审校助手。下面是程序检测出的可疑章节标题行，可能存在“章节标题和正文粘在同一行”的情况。

请判断每个候选是否异常，并给出修正建议。只返回 JSON 对象，不要输出解释或 Markdown。

返回格式：
{
  "repairs": [
    {
      "chapterIndex": 25,
      "isAnomaly": true,
      "fixedTitle": "第二十五回\u3000镇元仙赶捉取经僧\u3000孙行者大闹五庄观",
      "contentPrefix": "却说他兄弟三众，到了殿上",
      "confidence": 0.95,
      "reason": "从“却说”开始进入章回小说正文叙述"
    }
  ]
}

要求：
- fixedTitle 必须是候选 headingLine 开头的真实章节标题，不要改写用字。
- contentPrefix 必须是 headingLine 中紧跟标题后的正文开头；如果没有正文粘连，返回空字符串。
- 只有确实异常时 isAnomaly 才为 true。
- confidence 用 0 到 1 的数字。

候选：
${JSON.stringify(candidates, null, 2)}`
}

async function generateJsonTextWithModel(
  prompt: string,
  modelConfig: ModelConfigDraft,
  systemPrompt: string,
): Promise<string | null> {
  if (modelConfig.aiProvider === 'ollama') {
    const model = modelConfig.ollamaModel.trim()
    if (!model) return null

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
      }),
    })

    if (!response.ok) return null

    const data = (await response.json()) as { response?: string }
    return data.response ?? '{}'
  }

  const activeConfig = getActiveOpenAIConfig(modelConfig)
  if (!activeConfig) return null

  const normalizedBaseUrl = activeConfig.baseUrl.trim().replace(/\/+$/, '')
  const model = activeConfig.model.trim()
  if (!normalizedBaseUrl || !model) return null

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (activeConfig.apiKey.trim()) {
    headers.Authorization = `Bearer ${activeConfig.apiKey.trim()}`
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }

  if (!modelConfig.thinkingEnabled) {
    requestBody.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) return null

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? '{}'
}

async function analyzeChapterFormats(
  rawText: string,
  modelConfig: ModelConfigDraft,
): Promise<FormatAnalysis | null> {
  const chunkSize = 7000
  const start = rawText.slice(0, chunkSize)
  const middleStart = Math.max(0, Math.floor(rawText.length / 2) - chunkSize / 2)
  const middle = rawText.slice(middleStart, middleStart + chunkSize)
  const end = rawText.slice(Math.max(0, rawText.length - chunkSize))
  const sample = `【开头片段】\n${start}\n\n【中间片段】\n${middle}\n\n【结尾片段】\n${end}`
  const prompt = buildFormatAnalysisPrompt(sample)

  try {
    const responseText = await generateJsonTextWithModel(
      prompt,
      modelConfig,
      '你是文本处理助手。你必须只输出符合要求的 JSON。',
    )
    if (!responseText) return null

    return parseFormatAnalysis(responseText)
  } catch {
    return null
  }
}

function normalizeForBoundaryCheck(value: string): string {
  return value.replace(/\s/g, '')
}

export function applyChapterTitleRepairSuggestions(
  chapters: Chapter[],
  suggestions: ChapterTitleRepairSuggestion[],
): Chapter[] {
  if (!suggestions.length) return chapters

  const suggestionByIndex = new Map(
    suggestions
      .filter((suggestion) => suggestion.isAnomaly && suggestion.confidence >= 0.65)
      .map((suggestion) => [suggestion.chapterIndex, suggestion]),
  )

  if (!suggestionByIndex.size) return chapters

  return chapters.map((chapter) => {
    const suggestion = suggestionByIndex.get(chapter.index)
    if (!suggestion) return chapter

    const fixedTitle = normalizeChapterTitle(suggestion.fixedTitle)
    if (!fixedTitle || fixedTitle.length >= chapter.title.length) return chapter

    const currentTitle = normalizeChapterTitle(chapter.title)
    if (!currentTitle.startsWith(fixedTitle)) return chapter

    const titleTail = currentTitle.slice(fixedTitle.length).trim()
    const contentPrefix = suggestion.contentPrefix.trim()
    if (contentPrefix && titleTail && !normalizeForBoundaryCheck(titleTail).startsWith(normalizeForBoundaryCheck(contentPrefix))) {
      return chapter
    }

    const content = [titleTail, chapter.content].filter(Boolean).join('\n').trim()
    if (!content) return chapter

    return {
      ...chapter,
      id: `${chapter.index}-${fixedTitle.slice(0, 32)}`,
      title: fixedTitle,
      content,
      wordCount: countWords(content),
    }
  })
}

async function repairChapterTitleAnomaliesWithLlm(
  rawText: string,
  chapters: Chapter[],
  modelConfig: ModelConfigDraft,
): Promise<Chapter[]> {
  const anomalies = detectChapterTitleAnomalies(rawText)
  if (!anomalies.length) return chapters

  try {
    const prompt = buildChapterTitleRepairPrompt(anomalies, chapters)
    const responseText = await generateJsonTextWithModel(
      prompt,
      modelConfig,
      '你是中文小说章节切分审校助手。你必须只输出符合要求的 JSON。',
    )
    if (!responseText) return chapters

    return applyChapterTitleRepairSuggestions(chapters, parseChapterTitleRepairSuggestions(responseText))
  } catch {
    return chapters
  }
}

function tryExtractChaptersHybrid(
  rawText: string,
  analysis: FormatAnalysis | null,
): Chapter[] | null {
  const extraMarkers = analysis?.nonChapterMarkers ?? []
  const headings = extractChapterHeadings(rawText, extraMarkers)

  if (isPlausibleHeadingSet(headings, rawText)) {
    return splitWithHeadings(rawText, headings)
  }

  const exampleHeadings = extractChapterHeadingsFromExamples(rawText, analysis, extraMarkers)
  if (isPlausibleHeadingSet(exampleHeadings, rawText)) {
    return splitWithHeadings(rawText, exampleHeadings)
  }

  return null
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
    〇: 0,
    '○': 0,
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
  const match = /第\s*([0-9零一二三四五六七八九十百千万亿〇○]+)\s*[章卷节回]/.exec(title)

  return match ? parseChineseNumber(match[1]) : null
}

function decodeTextFile(file: File): Promise<string> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then(decodeTextBuffer)
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      resolve(decodeTextBuffer(reader.result as ArrayBuffer))
    }

    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  // UTF-16 BOM
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buffer)
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buffer)
    }
  }

  // Try UTF-8 first; only fall back to GB18030 if the bytes are not valid UTF-8.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
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

function isReadableEpubText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  if (countWords(normalized) < 80 && /^(?:cover|table of contents|目录)(?:\b|$)/i.test(normalized)) {
    return false
  }
  return true
}

function selectEpubChapters(spineChapters: Chapter[]): Chapter[] {
  const fullText = spineChapters.map((chapter) => chapter.content).join('\n')
  const textChapters = splitChapters(fullText)
  const spineWordCount = spineChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  const textWordCount = textChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  const preservesMostContent = spineWordCount === 0 || textWordCount / spineWordCount > 0.85

  if (textChapters.length >= spineChapters.length * 2 && preservesMostContent) {
    return textChapters
  }

  return spineChapters
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
    if (!text || !isReadableEpubText(text)) continue

    chapters.push(makeChapterFromText(chapters.length + 1, heading || stripExtension(item.href), text))
  }

  if (!chapters.length) {
    throw new Error('EPUB 中没有识别到可阅读章节。')
  }

  return { title: metadataTitle, chapters: selectEpubChapters(chapters) }
}

export async function parseImportedBook(
  file: File,
  modelConfig?: ModelConfigDraft,
): Promise<ImportedBookContent> {
  if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') {
    return parseEpubFile(file)
  }

  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
  const pdf = isPdf ? await extractPdfDocument(await file.arrayBuffer()) : null
  const text = pdf?.text ?? await decodeTextFile(file)
  const cleanedText = stripPublicDomainBoilerplate(cleanFormattingTags(text))
  let chapters = pdf?.sections.length
    ? pdf.sections.map((section, index) => ({
        id: `${index + 1}-${section.title.slice(0, 32)}`,
        index: index + 1,
        title: section.title,
        content: section.content,
        wordCount: countWords(section.content),
      }))
    : splitChapters(cleanedText)

  if (isBadSplit(chapters, cleanedText) && modelConfig) {
    const analysis = await analyzeChapterFormats(cleanedText, modelConfig)
    const hybridChapters = tryExtractChaptersHybrid(cleanedText, analysis)
    if (hybridChapters && hybridChapters.length > chapters.length && !isBadSplit(hybridChapters, cleanedText)) {
      chapters = hybridChapters
    }
  }

  if (modelConfig) {
    chapters = await repairChapterTitleAnomaliesWithLlm(cleanedText, chapters, modelConfig)
  }

  return {
    title: pdf?.title || inferTitle(file.name),
    chapters,
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
- keyPointSources: 数组，必须与 keyPoints 按 index 对齐。每项包含 index、text、quote；quote 必须是本章正文中能支撑该要点的一小段连续原文，尽量 15-80 字，不要编造，不要给 offset。
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
    keyPointSources: locateSummaryKeyPointSources(chapter.content, Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [], parsed.keyPointSources),
    skippable: parsed.skippable || '暂无跳读建议。',
    generatedBy: 'ollama',
  }
}

export async function generateWithOpenAICompatible(
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
    keyPointSources: locateSummaryKeyPointSources(chapter.content, Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [], parsed.keyPointSources),
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

    let response: Response
    try {
      response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
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
    } catch (error) {
      throw new Error(`[LLM] 无法连接 Ollama：${errorMessage(error)}`, { cause: error })
    }

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

  let response: Response
  try {
    response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(validateBody),
    })
  } catch (error) {
    throw new Error(`[LLM] 无法连接 OpenAI-compatible Base URL：${errorMessage(error)}`, { cause: error })
  }

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

  const requestInit: RequestInit = {
    body: JSON.stringify({
      provider: embeddingConfig.provider,
      model,
      baseUrl,
      apiKey: embeddingConfig.apiKey,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }

  let response: Response
  try {
    response = await fetch('/api/rag/embeddings/validate', requestInit)
  } catch {
    try {
      response = await fetch('http://127.0.0.1:5174/api/rag/embeddings/validate', requestInit)
    } catch (error) {
      throw new Error(`[Embedding] 无法连接 embedding 验证服务：${errorMessage(error)}`, { cause: error })
    }
  }

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string }
    throw new Error(`[Embedding] 验证失败：${payload.error ?? response.statusText}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error || '请求失败')
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

export function selectSummaryGenerationChapters(
  chapters: Chapter[],
  summaries: Record<string, Summary>,
  options: SummaryGenerationSelectionOptions = {},
): Chapter[] {
  if (options.overwriteExisting) return chapters
  return chapters.filter((chapter) => !summaries[chapter.id])
}

export function applyChapterSummary(
  state: StoredState,
  bookId: string,
  chapterId: string,
  summary: Summary,
): StoredState {
  return syncLibraryBook(state, bookId, {
    summaries: {
      ...getLibraryBookSummaries(state, bookId),
      [chapterId]: summary,
    },
  })
}

export function buildMissingSummaryBatchConfirmation(
  totalChapters: number,
  missingCount: number,
): string | null {
  if (missingCount <= 50) return null
  return (
    `全书共 ${totalChapters} 章，其中 ${missingCount} 章缺少概要。\n` +
    `批量生成将调用 AI 接口 ${missingCount} 次，可能耗时较长并消耗较多 token。\n` +
    '确定要继续吗？'
  )
}

export async function runMissingSummaryBatch({
  pendingChapters,
  totalChapters,
  concurrency,
  generateSummary,
  onSummary,
  onFailure,
  onProgress,
}: {
  pendingChapters: Chapter[]
  totalChapters: number
  concurrency: number
  generateSummary: (chapter: Chapter) => Promise<Summary>
  onSummary: (chapter: Chapter, summary: Summary) => void
  onFailure?: (chapter: Chapter) => void
  onProgress?: (message: string) => void
}): Promise<MissingSummaryBatchResult> {
  const missingCount = pendingChapters.length
  const baselineProcessedCount = totalChapters - missingCount
  let nextIndex = 0
  let completedCount = 0
  let failedCount = 0

  async function worker() {
    while (nextIndex < pendingChapters.length) {
      const chapter = pendingChapters[nextIndex]
      nextIndex += 1

      onProgress?.(
        `并发 ${concurrency}，正在生成 ${completedCount + failedCount + 1}/${missingCount}（全书 ${baselineProcessedCount + completedCount + failedCount + 1}/${totalChapters}）：第 ${chapter.index} 章`,
      )

      try {
        const summary = await generateSummary(chapter)
        completedCount += 1
        onSummary(chapter, summary)
      } catch {
        failedCount += 1
        onFailure?.(chapter)
      }

      onProgress?.(
        `并发 ${concurrency}，已完成 ${completedCount}/${missingCount}（全书 ${baselineProcessedCount + completedCount}/${totalChapters}），失败 ${failedCount} 章`,
      )
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, missingCount) }, () => worker()),
  )

  return { completedCount, failedCount, missingCount }
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
  generatingChapterId: string | null
  generatingPageSummaries: boolean
  pageSummaryProgress: string
  pageSummaryFailures: string[]
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
  generateMissingSummariesForCurrentPage: () => Promise<void>
  generateSummaryForChapter: (chapterId: string) => Promise<void>
  selectBook: (bookId: string) => Promise<void>
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
  const isActive = current.activeBookId === bookId
  return {
    ...current,
    ...(isActive && updates.summaries ? { summaries: updates.summaries } : {}),
    ...(isActive && updates.activeChapterId ? { activeChapterId: updates.activeChapterId } : {}),
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

function mergeChapters(libraryBook: LibraryBook, chapters: Chapter[]): LibraryBook {
  if (!chapters.length) return libraryBook

  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  return {
    ...libraryBook,
    book: {
      ...libraryBook.book,
      chapters: libraryBook.book.chapters.map((chapter) => chapterById.get(chapter.id) ?? chapter),
    },
  }
}

function getPriorityChapterWindow(libraryBook: LibraryBook): { chapters: Chapter[]; start: number; end: number } {
  const chapters = libraryBook.book.chapters
  const activeChapter =
    chapters.find((chapter) => chapter.id === libraryBook.activeChapterId) ?? chapters[0] ?? null

  if (!activeChapter) {
    return { chapters: [], start: 1, end: 0 }
  }

  const hasProgress = Boolean(libraryBook.activeChapterId)
  const start = hasProgress ? Math.max(1, activeChapter.index - 3) : 1
  const end = hasProgress
    ? Math.min(chapters.length, activeChapter.index + 5)
    : Math.min(chapters.length, 8)

  return {
    chapters: chapters.filter((chapter) => chapter.index >= start && chapter.index <= end),
    start,
    end,
  }
}

async function hydratePriorityChapters(libraryBook: LibraryBook): Promise<LibraryBook> {
  const { chapters: priorityChapters, start, end } = getPriorityChapterWindow(libraryBook)
  if (!priorityChapters.length) return libraryBook

  const bookId = libraryBook.book.id
  const priorityIds = priorityChapters.map((chapter) => chapter.id)
  const cached = await getCachedChapters(bookId, priorityIds)
  const missingIds = priorityIds.filter((chapterId) => !cached[chapterId])
  let nextLibraryBook = mergeChapters(libraryBook, Object.values(cached))

  if (missingIds.length) {
    const fetched = await loadChaptersFromLocalDb(bookId, { start, end })
    await saveCachedChapters(bookId, fetched)
    nextLibraryBook = mergeChapters(nextLibraryBook, fetched)
  }

  return nextLibraryBook
}

async function prefetchBookChapters(libraryBook: LibraryBook): Promise<void> {
  const bookId = libraryBook.book.id
  const batchSize = 80
  const total = libraryBook.book.chapters.length

  for (let start = 1; start <= total; start += batchSize) {
    const end = Math.min(total, start + batchSize - 1)
    const chapters = await loadChaptersFromLocalDb(bookId, { start, end })
    await saveCachedChapters(bookId, chapters)
  }
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
  const [generatingChapterId, setGeneratingChapterId] = useState<string | null>(null)
  const [generatingPageSummaries, setGeneratingPageSummaries] = useState(false)
  const [pageSummaryProgress, setPageSummaryProgress] = useState('')
  const [pageSummaryFailures, setPageSummaryFailures] = useState<string[]>([])
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
      .then(async (storedState) => {
        if (storedState) {
          const nextState = normalizeStoredState(storedState as Partial<StoredState> & Record<string, unknown>)
          const activeLibraryBook = nextState.books.find((entry) => entry.book.id === nextState.activeBookId)
          const hydratedLibraryBook = activeLibraryBook ? await hydratePriorityChapters(activeLibraryBook) : null
          const hydratedState = hydratedLibraryBook
            ? {
                ...nextState,
                books: nextState.books.map((entry) =>
                  entry.book.id === hydratedLibraryBook.book.id ? hydratedLibraryBook : entry,
                ),
                book: hydratedLibraryBook.book,
                activeChapterId: hydratedLibraryBook.activeChapterId,
                summaries: hydratedLibraryBook.summaries,
              }
            : nextState

          setState(hydratedState)
          setChapterPage(getChapterPageForState(hydratedState))
          if (hydratedLibraryBook) {
            void prefetchBookChapters(hydratedLibraryBook)
          }
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
    if (!isHydrated || !state.activeBookId || !state.activeChapterId) return

    const activeLibraryBook = state.books.find((entry) => entry.book.id === state.activeBookId)
    const activeChapter = activeLibraryBook?.book.chapters.find((chapter) => chapter.id === state.activeChapterId)
    if (!activeLibraryBook || activeChapter?.content) return

    let isCancelled = false

    hydratePriorityChapters(activeLibraryBook)
      .then((hydratedLibraryBook) => {
        if (isCancelled) return

        setState((current) => ({
          ...current,
          books: current.books.map((entry) =>
            entry.book.id === hydratedLibraryBook.book.id ? hydratedLibraryBook : entry,
          ),
          ...(current.activeBookId === hydratedLibraryBook.book.id
            ? {
                book: hydratedLibraryBook.book,
                activeChapterId: hydratedLibraryBook.activeChapterId,
                summaries: hydratedLibraryBook.summaries,
              }
            : {}),
        }))
      })
      .catch(() => {
        if (!isCancelled) setError('读取章节内容失败，请确认本地数据库服务仍在运行。')
      })

    return () => {
      isCancelled = true
    }
  }, [isHydrated, state.activeBookId, state.activeChapterId, state.books])

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
      const imported = await parseImportedBook(file, getModelConfigDraft(state))
      const { chapters } = imported

      if (!chapters.length) {
        setError('没有识别到正文内容，请换一个 txt、epub 或带文本层的 pdf 文件试试。')
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

    const pendingChapters = selectSummaryGenerationChapters(
      libraryBook.book.chapters,
      libraryBook.summaries,
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

    const confirmation = buildMissingSummaryBatchConfirmation(totalChapters, missingCount)
    if (confirmation && !window.confirm(confirmation)) {
      return
    }

    const concurrency = getActiveConcurrency()

    setGeneratingBookId(bookId)
    setGeneratingBookProgress(`并发 ${concurrency}，准备生成 ${missingCount} 章概要`)
    setError('')

    try {
      const { completedCount, failedCount } = await runMissingSummaryBatch({
        pendingChapters,
        totalChapters,
        concurrency,
        generateSummary: generateChapterSummary,
        onProgress: setGeneratingBookProgress,
        onSummary: (chapter, summary) => {
          setState((current) => applyChapterSummary(current, bookId, chapter.id, summary))
        },
      })

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

  async function generateMissingSummariesForCurrentPage() {
    const bookId = state.activeBookId
    if (!bookId || !state.book) return

    const pendingChapters = selectSummaryGenerationChapters(pagedChapters, state.summaries)
    const missingCount = pendingChapters.length

    setPageSummaryFailures([])

    if (!missingCount) {
      setPageSummaryProgress('当前页概要已经全部生成。')
      return
    }

    const concurrency = getActiveConcurrency()

    setGeneratingPageSummaries(true)
    setPageSummaryProgress(`并发 ${concurrency}，准备生成当前页 ${missingCount} 章概要`)
    setError('')

    try {
      const failedTitles: string[] = []
      const { completedCount, failedCount } = await runMissingSummaryBatch({
        pendingChapters,
        totalChapters: pendingChapters.length,
        concurrency,
        generateSummary: generateChapterSummary,
        onProgress: setPageSummaryProgress,
        onFailure: (chapter) => {
          failedTitles.push(chapter.title)
          setPageSummaryFailures([...failedTitles])
        },
        onSummary: (chapter, summary) => {
          setState((current) => applyChapterSummary(current, bookId, chapter.id, summary))
        },
      })

      if (failedCount > 0) {
        setPageSummaryProgress(`当前页生成结束，成功 ${completedCount} 章，失败 ${failedCount} 章。`)
      } else {
        setPageSummaryProgress(`当前页 ${missingCount} 章缺失概要已生成。`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '当前页生成概要失败。')
    } finally {
      setGeneratingPageSummaries(false)
    }
  }

  async function generateSummaryForChapter(chapterId: string) {
    const bookId = state.activeBookId
    const chapter = state.book?.chapters.find((item) => item.id === chapterId)
    if (!bookId || !chapter) return

    setGeneratingChapterId(chapterId)
    setError('')

    try {
      const summary = await generateChapterSummary(chapter)
      setState((current) => applyChapterSummary(current, bookId, chapter.id, summary))
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成本章概要失败。')
    } finally {
      setGeneratingChapterId((current) => (current === chapterId ? null : current))
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

  async function selectBook(bookId: string) {
    let nextBook = state.books.find((entry) => entry.book.id === bookId)
    if (!nextBook) return

    try {
      if (nextBook.book.chapters.some((chapter) => !chapter.content)) {
        nextBook = await loadLibraryBookFromLocalDb(bookId)
      }
      nextBook = await hydratePriorityChapters(nextBook)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取书籍内容失败。')
      return
    }

    setState((current) => ({
      ...current,
      books: current.books.map((entry) => (entry.book.id === bookId ? nextBook : entry)),
      activeBookId: nextBook!.book.id,
      book: nextBook!.book,
      activeChapterId: nextBook!.activeChapterId ?? nextBook!.book.chapters[0]?.id ?? null,
      summaries: nextBook!.summaries,
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
    void prefetchBookChapters(nextBook)
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
    generatingChapterId,
    generatingPageSummaries,
    pageSummaryProgress,
    pageSummaryFailures,
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
    generateMissingSummariesForCurrentPage,
    generateSummaryForChapter,
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
