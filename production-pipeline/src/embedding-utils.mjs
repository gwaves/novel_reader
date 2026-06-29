import { createHash } from 'node:crypto'

export const CHUNK_TARGET_CHARS = 1200
export const CHUNK_OVERLAP_CHARS = 160
export const EMBEDDING_TRANSIENT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])
export const EMBEDDING_MAX_ATTEMPTS = 4
export const EMBEDDING_RETRY_BASE_DELAY_MS = 1000

export function normalizeChunkText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function splitChapterIntoChunks(chapter, options = {}) {
  const targetChars = positiveInteger(options.targetChars ?? options.target ?? CHUNK_TARGET_CHARS, CHUNK_TARGET_CHARS)
  const overlapChars = Math.min(
    positiveInteger(options.overlapChars ?? options.overlap ?? CHUNK_OVERLAP_CHARS, CHUNK_OVERLAP_CHARS),
    Math.max(0, targetChars - 1),
  )
  const stepChars = Math.max(1, targetChars - overlapChars)
  const content = normalizeChunkText(chapter?.content)
  if (!content) return []

  const chunks = []
  const paragraphs = content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
  let buffer = ''
  let bufferStart = 0
  let cursor = 0

  const pushChunk = (text, startOffset, endOffset) => {
    const normalized = normalizeChunkText(text)
    if (!normalized) return
    chunks.push({
      id: `${chapter.id}:chunk:${chunks.length}`,
      bookId: chapter.bookId,
      chapterId: chapter.id,
      chapterIndex: chapter.chapterIndex,
      chunkIndex: chunks.length,
      startOffset,
      endOffset,
      text: normalized,
    })
  }

  for (const paragraph of paragraphs) {
    const paragraphStart = content.indexOf(paragraph, cursor)
    const start = paragraphStart >= 0 ? paragraphStart : cursor
    const end = start + paragraph.length
    cursor = end

    if (paragraph.length > targetChars) {
      if (buffer) {
        pushChunk(buffer, bufferStart, start)
        buffer = buffer.slice(Math.max(0, buffer.length - overlapChars))
        bufferStart = Math.max(0, start - buffer.length)
      }
      for (let i = 0; i < paragraph.length; i += stepChars) {
        const piece = paragraph.slice(i, i + targetChars)
        pushChunk(piece, start + i, Math.min(end, start + i + piece.length))
      }
      buffer = ''
      bufferStart = end
      continue
    }

    const nextBuffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (nextBuffer.length > targetChars && buffer) {
      pushChunk(buffer, bufferStart, start)
      const overlap = buffer.slice(Math.max(0, buffer.length - overlapChars))
      buffer = overlap ? `${overlap}\n\n${paragraph}` : paragraph
      bufferStart = Math.max(0, start - overlap.length)
    } else {
      if (!buffer) bufferStart = start
      buffer = nextBuffer
    }
  }

  if (buffer) {
    pushChunk(buffer, bufferStart, content.length)
  }

  return chunks
}

export function buildChunkEmbeddingId(chunkId, model) {
  const modelHash = createHash('sha1').update(String(model ?? '')).digest('hex').slice(0, 12)
  return `${chunkId}:model:${modelHash}`
}

export function l2Normalize(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return vector
  const sum = vector.reduce((acc, value) => acc + value * value, 0)
  const norm = Math.sqrt(sum)
  if (norm === 0) return vector
  return vector.map((value) => value / norm)
}

export function buildSummaryText(summary) {
  const parts = []
  if (summary?.short) parts.push(String(summary.short).trim())
  if (summary?.detail) parts.push(String(summary.detail).trim())
  const keyPoints = safeJsonParse(summary?.keyPointsJson ?? summary?.key_points_json, [])
  if (Array.isArray(keyPoints) && keyPoints.length > 0) {
    parts.push(...keyPoints.map((point) => String(point).trim()).filter(Boolean))
  }
  return parts.filter(Boolean).join(' ').trim()
}

export async function retryEmbeddingRequest(request, options = {}) {
  const maxAttempts = positiveInteger(options.maxAttempts ?? EMBEDDING_MAX_ATTEMPTS, EMBEDDING_MAX_ATTEMPTS)
  const delay = options.delay ?? embeddingRetryDelay
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts || !isRetryableEmbeddingError(error)) {
        throw error
      }
      await sleep(delay(attempt, error))
    }
  }

  throw lastError
}

export function isRetryableEmbeddingError(error) {
  if (error?.name === 'AbortError') return true
  if (typeof error?.status === 'number') return EMBEDDING_TRANSIENT_RETRY_STATUSES.has(error.status)
  if (typeof error?.statusCode === 'number') return EMBEDDING_TRANSIENT_RETRY_STATUSES.has(error.statusCode)
  const message = error instanceof Error ? error.message : String(error || '')
  return /\b(408|429|500|502|503|504)\b|Bad Gateway|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|timeout/i.test(message)
}

export function embeddingRetryDelay(attempt) {
  const jitter = Math.floor(Math.random() * 300)
  return EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter
}

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback
  if (Array.isArray(value)) return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
