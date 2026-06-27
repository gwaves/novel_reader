import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

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
  await upsertBookSummary(config, book)

  return book
}

async function upsertBookSummary(config: GatewayConfig, book: GatewayBookSummary) {
  const catalog = await readBookCatalog(config)
  const books = catalog.books.filter((candidate) => candidate.id !== book.id)
  books.push(book)
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
  }
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

function invalidBook(index: number, error: { code: string; statusCode: number }) {
  return new GatewayHttpError(error.statusCode, error.code, `Gateway book entry at index ${index} is invalid.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
