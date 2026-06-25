import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export type GatewayAudioChapter = {
  chapterId: string
  title?: string
  fileName: string
  manifestFileName?: string
  timelineVersion?: number
  durationMs?: number
  sizeBytes?: number
  updatedAt?: string
}

export type GatewayAudioCatalog = {
  schemaVersion: 1
  chapters: GatewayAudioChapter[]
}

export async function readAudioCatalog(config: GatewayConfig, bookId: string): Promise<GatewayAudioCatalog> {
  let rawCatalog: string
  try {
    rawCatalog = await readFile(join(config.audioDir, 'books', bookId, 'audio.json'), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        chapters: [],
      }
    }
    throw error
  }

  return normalizeAudioCatalog(parseAudioCatalog(rawCatalog))
}

export async function openAudioFile(config: GatewayConfig, bookId: string, chapterId: string) {
  const catalog = await readAudioCatalog(config, bookId)
  const chapter = catalog.chapters.find((candidate) => candidate.chapterId === chapterId)
  if (!chapter) {
    throw new GatewayHttpError(404, 'audio_chapter_not_found', `Audio chapter ${chapterId} was not found.`)
  }

  const filePath = resolveSafeAudioPath(config, bookId, chapter.fileName)
  const fileStat = await statAudioFile(filePath)
  return {
    chapter,
    filePath,
    sizeBytes: fileStat.size,
    stream: createReadStream(filePath),
  }
}

export async function readAudioManifest(config: GatewayConfig, bookId: string, chapterId: string): Promise<unknown> {
  const catalog = await readAudioCatalog(config, bookId)
  const chapter = catalog.chapters.find((candidate) => candidate.chapterId === chapterId)
  if (!chapter?.manifestFileName) {
    throw new GatewayHttpError(404, 'audio_manifest_not_found', `Audio manifest for chapter ${chapterId} was not found.`)
  }

  const manifestPath = resolveSafeAudioPath(config, bookId, chapter.manifestFileName)
  let rawManifest: string
  try {
    rawManifest = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new GatewayHttpError(404, 'audio_manifest_not_found', 'Gateway audio manifest was not found.')
    }
    throw error
  }

  try {
    return JSON.parse(rawManifest) as unknown
  } catch {
    throw new GatewayHttpError(500, 'audio_manifest_invalid', 'Gateway audio manifest is not valid JSON.')
  }
}

function parseAudioCatalog(rawCatalog: string) {
  try {
    return JSON.parse(rawCatalog) as unknown
  } catch {
    throw new GatewayHttpError(500, 'audio_catalog_invalid', 'Gateway audio catalog is not valid JSON.')
  }
}

function normalizeAudioCatalog(catalog: unknown): GatewayAudioCatalog {
  if (!isRecord(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.chapters)) {
    throw new GatewayHttpError(500, 'audio_catalog_invalid', 'Gateway audio catalog schema is invalid.')
  }

  return {
    schemaVersion: 1,
    chapters: catalog.chapters.map((chapter, index) => normalizeAudioChapter(chapter, index)),
  }
}

function normalizeAudioChapter(chapter: unknown, index: number): GatewayAudioChapter {
  if (!isRecord(chapter)) {
    throw invalidChapter(index)
  }

  const chapterId = readRequiredString(chapter, 'chapterId')
  const fileName = readRequiredString(chapter, 'fileName')
  const manifestFileName = readOptionalString(chapter, 'manifestFileName')
  if (
    !chapterId ||
    !fileName ||
    !isSafeRelativePath(fileName) ||
    (manifestFileName && !isSafeRelativePath(manifestFileName))
  ) {
    throw invalidChapter(index)
  }

  return {
    chapterId,
    title: readOptionalString(chapter, 'title'),
    fileName,
    manifestFileName,
    timelineVersion: readOptionalNonNegativeInteger(chapter, 'timelineVersion'),
    durationMs: readOptionalNonNegativeInteger(chapter, 'durationMs'),
    sizeBytes: readOptionalNonNegativeInteger(chapter, 'sizeBytes'),
    updatedAt: readOptionalString(chapter, 'updatedAt'),
  }
}

function isSafeRelativePath(fileName: string) {
  return !fileName.includes('..') && !fileName.startsWith('/')
}

function resolveSafeAudioPath(config: GatewayConfig, bookId: string, fileName: string) {
  const bookAudioDir = resolve(config.audioDir, 'books', bookId)
  const filePath = resolve(bookAudioDir, fileName)
  if (!filePath.startsWith(`${bookAudioDir}/`)) {
    throw new GatewayHttpError(500, 'audio_catalog_invalid', 'Gateway audio file path is invalid.')
  }
  return filePath
}

async function statAudioFile(filePath: string) {
  try {
    return await stat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new GatewayHttpError(404, 'audio_file_not_found', 'Gateway audio file was not found.')
    }
    throw error
  }
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readOptionalNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function invalidChapter(index: number) {
  return new GatewayHttpError(500, 'audio_catalog_invalid', `Gateway audio catalog entry at index ${index} is invalid.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
