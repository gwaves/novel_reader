import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export type GatewayBookVisibility = 'default' | 'trusted' | 'admin' | 'hidden'

export type GatewayBookSummary = {
  id: string
  title: string
  author?: string
  chapterCount: number
  wordCount?: number
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  audioChapterCount?: number
  updatedAt: string
  visibility: GatewayBookVisibility
  labels: string[]
}

export type GatewayBookCatalog = {
  schemaVersion: 1
  books: GatewayBookSummary[]
}

export type GatewayBookPackage = {
  schemaVersion: 1
  book: GatewayBookSummary
  generatedAt?: string
  [key: string]: unknown
}

export type GatewayBookPackageFile = {
  stream: ReturnType<typeof createReadStream>
  sizeBytes: number
  fileName: string
}

export type GatewayBookPackageStatus = {
  bookId: string
  title: string
  author?: string
  chapterCount: number
  packageChapterCount: number
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  status: 'imported' | 'missing' | 'invalid'
  importStatus: 'imported' | 'missing' | 'invalid'
  sizeBytes: number
  updatedAt?: string
  importedAt?: string
  errorCode?: string
}

type GatewayBookPackageMetadata = {
  status: GatewayBookPackageStatus
  chapterIds: string[]
}

type CachedPackageMetadata = {
  signature: string
  value?: GatewayBookPackageMetadata
  promise?: Promise<GatewayBookPackageMetadata>
}

export type GatewayBookDeleteResult = {
  bookId: string
  title: string
  removed: true
  packageRemoved: boolean
  audioRemoved: boolean
}

const packageMetadataCache = new Map<string, CachedPackageMetadata>()

export async function readBookCatalog(config: GatewayConfig): Promise<GatewayBookCatalog> {
  await mkdir(config.dataDir, { recursive: true })

  let rawCatalog: string
  try {
    rawCatalog = await readFile(join(config.dataDir, 'books.json'), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        books: [],
      }
    }
    throw error
  }

  return normalizeCatalog(parseCatalog(rawCatalog))
}

export async function readBookSummary(config: GatewayConfig, bookId: string): Promise<GatewayBookSummary> {
  const catalog = await readBookCatalog(config)
  const book = catalog.books.find((candidate) => candidate.id === bookId)
  if (!book) {
    throw new GatewayHttpError(404, 'book_not_found', `Gateway book ${bookId} was not found.`)
  }
  return book
}

export async function readBookPackage(config: GatewayConfig, bookId: string): Promise<GatewayBookPackage> {
  await readBookSummary(config, bookId)

  let rawPackage: string
  try {
    rawPackage = await readFile(join(config.dataDir, 'books', bookId, 'package.json'), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new GatewayHttpError(404, 'book_package_not_found', `Gateway package for book ${bookId} was not found.`)
    }
    throw error
  }

  return normalizeBookPackage(parseBookPackage(rawPackage), bookId, {
    code: 'book_package_invalid',
    statusCode: 500,
  })
}

export async function openBookPackageFile(config: GatewayConfig, bookId: string): Promise<GatewayBookPackageFile> {
  await readBookSummary(config, bookId)

  const packagePath = join(config.dataDir, 'books', bookId, 'package.json')
  try {
    const packageStat = await stat(packagePath)
    return {
      stream: createReadStream(packagePath),
      sizeBytes: packageStat.size,
      fileName: `${bookId}-package-full.json`,
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new GatewayHttpError(404, 'book_package_not_found', `Gateway package for book ${bookId} was not found.`)
    }
    throw error
  }
}

export async function readBookPackageStatuses(config: GatewayConfig): Promise<GatewayBookPackageStatus[]> {
  const catalog = await readBookCatalog(config)
  return readBookPackageStatusesForBooks(config, catalog.books)
}

export async function readBookPackageStatusesForBooks(
  config: GatewayConfig,
  books: GatewayBookSummary[],
): Promise<GatewayBookPackageStatus[]> {
  return Promise.all(books.map((book) => readBookPackageStatus(config, book)))
}

export async function readBookPackageChapterIds(config: GatewayConfig, bookId: string): Promise<string[]> {
  const book = await readBookSummary(config, bookId)
  try {
    return (await readBookPackageMetadata(config, book)).chapterIds
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    if (error instanceof GatewayHttpError) return []
    throw error
  }
}

export async function upsertBookPackage(
  config: GatewayConfig,
  bookId: string,
  rawPackage: unknown,
): Promise<GatewayBookSummary> {
  const bookPackage = normalizeBookPackage(rawPackage, bookId, {
    code: 'invalid_book_package',
    statusCode: 400,
  })
  const book = normalizeBook(
    bookPackage.book,
    0,
    {
      code: 'invalid_book_package',
      statusCode: 400,
    },
    readOptionalIsoDate(bookPackage, 'generatedAt') ?? readOptionalIsoDate(bookPackage.book, 'importedAt'),
  )
  const bookDir = join(config.dataDir, 'books', bookId)

  await mkdir(bookDir, { recursive: true })
  await writeJsonFile(join(bookDir, 'package.json'), bookPackage)
  return upsertBookSummary(config, book, {
    hasExplicitVisibility: isRecord(bookPackage.book) && isBookVisibility(bookPackage.book.visibility),
    hasExplicitLabels: isRecord(bookPackage.book) && Array.isArray(bookPackage.book.labels),
  })
}

export async function deleteBook(config: GatewayConfig, bookId: string): Promise<GatewayBookDeleteResult> {
  const catalog = await readBookCatalog(config)
  const book = catalog.books.find((candidate) => candidate.id === bookId)
  if (!book) {
    throw new GatewayHttpError(404, 'book_not_found', `Gateway book ${bookId} was not found.`)
  }

  const packageRemoved = await removeBookDirectory(config.dataDir, bookId)
  const audioRemoved = await removeBookDirectory(config.audioDir, bookId)
  await writeBookCatalog(
    config,
    catalog.books.filter((candidate) => candidate.id !== bookId),
  )

  return {
    bookId,
    title: book.title,
    removed: true,
    packageRemoved,
    audioRemoved,
  }
}

async function readBookPackageStatus(config: GatewayConfig, book: GatewayBookSummary): Promise<GatewayBookPackageStatus> {
  try {
    return (await readBookPackageMetadata(config, book)).status
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return missingBookPackageStatus(book)
    }
    if (error instanceof GatewayHttpError) {
      return invalidBookPackageStatus(book, error.code)
    }
    throw error
  }
}

async function readBookPackageMetadata(config: GatewayConfig, book: GatewayBookSummary): Promise<GatewayBookPackageMetadata> {
  const packagePath = join(config.dataDir, 'books', book.id, 'package.json')
  const packageStat = await stat(packagePath)
  const signature = `${packageStat.size}:${packageStat.mtimeMs}`
  const cached = packageMetadataCache.get(packagePath)
  if (cached?.signature === signature) {
    if (cached.value) return cached.value
    if (cached.promise) return cached.promise
  }

  const promise = readBookPackageMetadataUncached(book, packagePath, packageStat.size, packageStat.mtime.toISOString())
  packageMetadataCache.set(packagePath, { signature, promise })
  try {
    const value = await promise
    packageMetadataCache.set(packagePath, { signature, value })
    return value
  } catch (error) {
    packageMetadataCache.delete(packagePath)
    throw error
  }
}

async function readBookPackageMetadataUncached(
  book: GatewayBookSummary,
  packagePath: string,
  sizeBytes: number,
  updatedAt: string,
): Promise<GatewayBookPackageMetadata> {
  const rawPackage = await readFile(packagePath, 'utf8')
  const bookPackage = normalizeBookPackage(parseBookPackage(rawPackage), book.id, {
    code: 'book_package_invalid',
    statusCode: 500,
  })
  const chapters = Array.isArray(bookPackage.chapters) ? bookPackage.chapters : []
  const importedAt = readOptionalIsoDate(bookPackage, 'generatedAt') ?? readOptionalIsoDate(bookPackage.book, 'updatedAt')
  return {
    status: {
      bookId: book.id,
      title: book.title,
      author: book.author,
      chapterCount: book.chapterCount,
      packageChapterCount: chapters.length,
      summaryCoverage: bookPackage.book.summaryCoverage ?? deriveSummaryCoverage(bookPackage, book.chapterCount),
      kgCoverage: bookPackage.book.kgCoverage ?? deriveKgCoverage(bookPackage, book.chapterCount),
      embeddingCoverage: bookPackage.book.embeddingCoverage ?? deriveEmbeddingCoverage(bookPackage, book.chapterCount),
      status: 'imported',
      importStatus: 'imported',
      sizeBytes,
      updatedAt,
      importedAt,
    },
    chapterIds: chapters
      .filter(isRecord)
      .map((chapter) => readOptionalString(chapter, 'id') ?? readOptionalString(chapter, 'chapterId'))
      .filter((chapterId): chapterId is string => Boolean(chapterId)),
  }
}

function missingBookPackageStatus(book: GatewayBookSummary): GatewayBookPackageStatus {
  return {
    bookId: book.id,
    title: book.title,
    author: book.author,
    chapterCount: book.chapterCount,
    packageChapterCount: 0,
    status: 'missing',
    importStatus: 'missing',
    sizeBytes: 0,
  }
}

function invalidBookPackageStatus(book: GatewayBookSummary, errorCode: string): GatewayBookPackageStatus {
  return {
    bookId: book.id,
    title: book.title,
    author: book.author,
    chapterCount: book.chapterCount,
    packageChapterCount: 0,
    status: 'invalid',
    importStatus: 'invalid',
    sizeBytes: 0,
    errorCode,
  }
}

export async function updateBookVisibility(
  config: GatewayConfig,
  bookId: string,
  visibility: unknown,
): Promise<GatewayBookSummary> {
  if (!isBookVisibility(visibility)) {
    throw new GatewayHttpError(400, 'invalid_book_visibility', 'Book visibility is invalid.')
  }

  const catalog = await readBookCatalog(config)
  const book = catalog.books.find((candidate) => candidate.id === bookId)
  if (!book) {
    throw new GatewayHttpError(404, 'book_not_found', `Gateway book ${bookId} was not found.`)
  }
  book.visibility = visibility
  await writeBookCatalog(config, catalog.books)
  return book
}

export async function updateBookLabels(config: GatewayConfig, bookId: string, labels: unknown): Promise<GatewayBookSummary> {
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    throw new GatewayHttpError(400, 'invalid_book_labels', 'Book labels must be an array of strings.')
  }

  const catalog = await readBookCatalog(config)
  const book = catalog.books.find((candidate) => candidate.id === bookId)
  if (!book) {
    throw new GatewayHttpError(404, 'book_not_found', `Gateway book ${bookId} was not found.`)
  }
  book.labels = normalizeLabels(labels)
  await writeBookCatalog(config, catalog.books)
  return book
}

async function upsertBookSummary(
  config: GatewayConfig,
  book: GatewayBookSummary,
  options: { hasExplicitVisibility?: boolean; hasExplicitLabels?: boolean } = {},
) {
  const catalog = await readBookCatalog(config)
  const existing = catalog.books.find((candidate) => candidate.id === book.id)
  const books = catalog.books.filter((candidate) => candidate.id !== book.id)
  const savedBook = {
    ...book,
    visibility: options.hasExplicitVisibility ? book.visibility : existing?.visibility ?? book.visibility,
    labels: options.hasExplicitLabels ? book.labels : existing?.labels ?? book.labels,
  }
  books.push(savedBook)
  await writeBookCatalog(config, books)
  return savedBook
}

async function writeBookCatalog(config: GatewayConfig, books: GatewayBookSummary[]) {
  books.sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return updatedDiff || left.title.localeCompare(right.title)
  })

  await writeJsonFile(join(config.dataDir, 'books.json'), {
    schemaVersion: 1,
    books,
  })
}

async function writeJsonFile(path: string, value: unknown) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmpPath, path)
}

async function removeBookDirectory(rootDir: string, bookId: string) {
  const root = resolve(rootDir, 'books')
  const path = resolve(root, bookId)
  const pathFromRoot = relative(root, path)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(pathFromRoot) === pathFromRoot) {
    throw new GatewayHttpError(500, 'book_catalog_invalid', 'Gateway book id resolves outside the storage directory.')
  }

  try {
    await rm(path, { recursive: true, force: false })
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function parseCatalog(rawCatalog: string) {
  try {
    return JSON.parse(rawCatalog) as unknown
  } catch {
    throw new GatewayHttpError(500, 'book_catalog_invalid', 'Gateway book catalog is not valid JSON.')
  }
}

function parseBookPackage(rawPackage: string) {
  try {
    return JSON.parse(rawPackage) as unknown
  } catch {
    throw new GatewayHttpError(500, 'book_package_invalid', 'Gateway book package is not valid JSON.')
  }
}

function normalizeBookPackage(
  bookPackage: unknown,
  bookId: string,
  error: { code: string; statusCode: number },
): GatewayBookPackage {
  if (!isRecord(bookPackage) || bookPackage.schemaVersion !== 1 || !isRecord(bookPackage.book)) {
    throw new GatewayHttpError(error.statusCode, error.code, 'Gateway book package schema is invalid.')
  }

  const packageBookId = readRequiredId(bookPackage.book, 'id')
  if (packageBookId !== bookId) {
    throw new GatewayHttpError(error.statusCode, error.code, 'Gateway book package does not match the requested book.')
  }

  return {
    ...bookPackage,
    book: {
      ...bookPackage.book,
      id: packageBookId,
    },
  } as GatewayBookPackage
}

function normalizeCatalog(catalog: unknown): GatewayBookCatalog {
  if (!isRecord(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.books)) {
    throw new GatewayHttpError(500, 'book_catalog_invalid', 'Gateway book catalog schema is invalid.')
  }

  const books = catalog.books.map((book, index) =>
    normalizeBook(book, index, {
      code: 'book_catalog_invalid',
      statusCode: 500,
    }),
  )
  books.sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return updatedDiff || left.title.localeCompare(right.title)
  })

  return {
    schemaVersion: 1,
    books,
  }
}

function normalizeBook(
  book: unknown,
  index: number,
  error: { code: string; statusCode: number } = { code: 'book_catalog_invalid', statusCode: 500 },
  fallbackUpdatedAt?: string,
): GatewayBookSummary {
  if (!isRecord(book)) {
    throw invalidBook(index, error)
  }

  const id = readRequiredId(book, 'id')
  const title = readRequiredString(book, 'title')
  const updatedAt = readOptionalIsoDate(book, 'updatedAt') ?? fallbackUpdatedAt
  const chapterCount = readNonNegativeInteger(book, 'chapterCount')

  if (!id || !title || !updatedAt || chapterCount === undefined || Number.isNaN(Date.parse(updatedAt))) {
    throw invalidBook(index, error)
  }

  return {
    id,
    title,
    author: readOptionalString(book, 'author'),
    chapterCount,
    wordCount: readOptionalNonNegativeInteger(book, 'wordCount'),
    summaryCoverage: readOptionalRatio(book, 'summaryCoverage'),
    kgCoverage: readOptionalRatio(book, 'kgCoverage'),
    embeddingCoverage: readOptionalRatio(book, 'embeddingCoverage'),
    audioChapterCount: readOptionalNonNegativeInteger(book, 'audioChapterCount'),
    updatedAt,
    visibility: normalizeVisibility(book.visibility),
    labels: normalizeLabels(book.labels),
  }
}

function normalizeVisibility(value: unknown): GatewayBookVisibility {
  return isBookVisibility(value) ? value : 'default'
}

function isBookVisibility(value: unknown): value is GatewayBookVisibility {
  return value === 'default' || value === 'trusted' || value === 'admin' || value === 'hidden'
}

function normalizeLabels(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right))
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readRequiredId(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value)
  return undefined
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readOptionalIsoDate(record: Record<string, unknown>, key: string) {
  const value = readOptionalString(record, key)
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readOptionalNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return readNonNegativeInteger(record, key)
}

function readOptionalRatio(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined
}

function deriveSummaryCoverage(bookPackage: GatewayBookPackage, chapterCount: number): number | undefined {
  if (chapterCount <= 0) return undefined
  const summaries = bookPackage.summaries
  if (!Array.isArray(summaries)) return undefined
  return clampRatio(summaries.length / chapterCount)
}

function deriveKgCoverage(bookPackage: GatewayBookPackage, chapterCount: number): number | undefined {
  if (chapterCount <= 0) return undefined
  const knowledgeGraph = bookPackage.knowledgeGraph
  if (!isRecord(knowledgeGraph)) return undefined

  const chapterIds = new Set<string>()
  const hasEntityMentions = Array.isArray(knowledgeGraph.entityMentions)
  const hasRelationMentions = Array.isArray(knowledgeGraph.relationMentions)
  collectMentionChapterIds(knowledgeGraph.entityMentions, chapterIds)
  collectMentionChapterIds(knowledgeGraph.relationMentions, chapterIds)

  if (chapterIds.size === 0 && !hasEntityMentions && !hasRelationMentions) return undefined
  return clampRatio(chapterIds.size / chapterCount)
}

function deriveEmbeddingCoverage(bookPackage: GatewayBookPackage, chapterCount: number): number | undefined {
  const embeddings = bookPackage.embeddings
  if (!isRecord(embeddings)) return undefined
  const coverage = embeddings.coverage
  if (isRecord(coverage)) {
    const chunksCoverage = readNestedRatio(coverage, 'chunks', 'coverage')
    if (chunksCoverage !== undefined) return chunksCoverage
    const summaryCoverage = readNestedRatio(coverage, 'summary', 'coverage')
    if (summaryCoverage !== undefined) return summaryCoverage
  }

  if (chapterCount <= 0) return undefined
  const chunkChapterCoverage = deriveEmbeddingChapterCoverage(embeddings.chunks, chapterCount)
  if (chunkChapterCoverage !== undefined) return chunkChapterCoverage
  return deriveEmbeddingChapterCoverage(embeddings.summaries, chapterCount)
}

function collectMentionChapterIds(value: unknown, chapterIds: Set<string>) {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!isRecord(item)) continue
    const chapterId = item.chapterId
    if (typeof chapterId === 'string' && chapterId.trim()) chapterIds.add(chapterId.trim())
    if (typeof chapterId === 'number' && Number.isInteger(chapterId)) chapterIds.add(String(chapterId))
  }
}

function deriveEmbeddingChapterCoverage(value: unknown, chapterCount: number): number | undefined {
  if (!Array.isArray(value)) return undefined
  const chapterIds = new Set<string>()
  collectMentionChapterIds(value, chapterIds)
  return clampRatio(chapterIds.size / chapterCount)
}

function readNestedRatio(record: Record<string, unknown>, key: string, nestedKey: string): number | undefined {
  const nested = record[key]
  if (!isRecord(nested)) return undefined
  return readOptionalRatio(nested, nestedKey)
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function invalidBook(index: number, error: { code: string; statusCode: number }) {
  return new GatewayHttpError(error.statusCode, error.code, `Gateway book entry at index ${index} is invalid.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
