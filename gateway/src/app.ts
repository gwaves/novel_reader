import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError } from 'fastify'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { requireGatewayAuth } from './auth.js'
import { openAudioFile, readAudioCatalog, readAudioManifest } from './audio-store.js'
import { buildCapabilities } from './capabilities.js'
import { type GatewayConfig, loadConfig } from './config.js'
import {
  type GatewayBookSummary,
  openBookPackageFile,
  readBookCatalog,
  readBookPackage,
  readBookSummary,
  upsertBookPackage,
} from './data-store.js'
import { readDeviceRegistry, touchGatewayDevice } from './device-store.js'
import { GatewayHttpError, isGatewayHttpError } from './errors.js'
import { createEmbedding, forwardChatCompletion, forwardEmbeddings } from './openai-client.js'

export function buildGatewayApp(config: GatewayConfig = loadConfig()) {
  const app = Fastify({
    logger:
      config.environment === 'test'
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie'],
              censor: '[redacted]',
            },
        },
    bodyLimit: config.maxBodyBytes,
    genReqId: (request) => {
      const existingRequestId = request.headers['x-request-id']
      const requestId = Array.isArray(existingRequestId) ? existingRequestId[0] : existingRequestId
      return requestId || randomUUID()
    },
  })

  app.register(helmet)
  app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  })

  if (config.cors.origins.length > 0) {
    app.register(cors, {
      origin: config.cors.origins,
    })
  }

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error as FastifyError | Error)
    request.log.error(
      {
        err: error,
        statusCode: normalized.statusCode,
        code: normalized.code,
      },
      'gateway request failed',
    )

    reply.status(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        statusCode: normalized.statusCode,
        requestId: request.id,
      },
    })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${request.url}`,
        statusCode: 404,
        requestId: request.id,
      },
    })
  })

  app.get('/health', async () => ({
    status: 'ok',
    service: 'novel-reader-gateway',
    time: new Date().toISOString(),
  }))

  app.get('/version', async () => ({
    service: 'novel-reader-gateway',
    version: '0.1.0',
    environment: config.environment,
  }))

  app.get('/capabilities', async () => buildCapabilities(config))

  app.get('/auth/session', async (request) => {
    const auth = requireGatewayAuth(config, request)
    await touchGatewayDevice(config, auth)
    return {
      authenticated: true,
      auth,
    }
  })

  app.get('/auth/devices', async (request) => {
    const auth = requireGatewayAuth(config, request)
    await touchGatewayDevice(config, auth)
    return {
      generatedAt: new Date().toISOString(),
      ...(await readDeviceRegistry(config)),
    }
  })

  app.get('/mobile/books', async (request) => {
    requireGatewayAuth(config, request)
    const catalog = await readBookCatalog(config)
    return {
      schemaVersion: catalog.schemaVersion,
      generatedAt: new Date().toISOString(),
      books: await withAudioChapterCounts(config, catalog.books),
    }
  })

  app.get<{ Params: { bookId: string } }>('/mobile/books/:bookId', async (request) => {
    requireGatewayAuth(config, request)
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      book: await withAudioChapterCount(config, await readBookSummary(config, request.params.bookId)),
    }
  })

  app.get<{ Params: { bookId: string }; Querystring: { include?: string } }>('/mobile/books/:bookId/package', async (request) => {
    requireGatewayAuth(config, request)
    const bookPackage = await readBookPackage(config, request.params.bookId)
    const includeFullPackage = request.query.include === 'all' || request.query.include === 'full'
    return {
      generatedAt: new Date().toISOString(),
      package: includeFullPackage ? bookPackage : buildReaderPackage(bookPackage),
    }
  })

  app.get<{ Params: { bookId: string } }>('/mobile/books/:bookId/package/download', async (request, reply) => {
    requireGatewayAuth(config, request)
    const packageFile = await openBookPackageFile(config, request.params.bookId)
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-length', packageFile.sizeBytes)
      .header('content-disposition', `attachment; filename="${basename(packageFile.fileName)}"`)
      .send(packageFile.stream)
  })

  app.put<{ Body: unknown; Params: { bookId: string } }>('/admin/books/:bookId/package', async (request) => {
    requireGatewayAuth(config, request)
    return {
      schemaVersion: 1,
      importedAt: new Date().toISOString(),
      book: await upsertBookPackage(config, request.params.bookId, request.body),
    }
  })

  app.post<{ Body: unknown }>('/ai/chat', async (request) => {
    requireGatewayAuth(config, request)
    return forwardChatCompletion(config, request.body)
  })

  app.post<{ Body: unknown }>('/ai/embeddings', async (request) => {
    requireGatewayAuth(config, request)
    return forwardEmbeddings(config, request.body)
  })

  app.post<{ Body: unknown }>('/ai/search', async (request) => {
    requireGatewayAuth(config, request)
    if (!isRecord(request.body)) {
      throw new GatewayHttpError(400, 'invalid_search_request', 'Search request body must be an object.')
    }
    const bookId = readNonEmptyString(request.body.bookId)
    const query = readNonEmptyString(request.body.query)
    const limit = readSearchLimit(request.body.limit)
    if (!bookId || !query) {
      throw new GatewayHttpError(400, 'invalid_search_request', 'Search request must include bookId and query.')
    }

    const [bookPackage, queryEmbedding] = await Promise.all([
      readBookPackage(config, bookId),
      createEmbedding(config, query),
    ])

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      bookId,
      query,
      results: searchPackageWithEmbedding(bookPackage, query, queryEmbedding, limit),
    }
  })

  app.post<{ Body: unknown }>('/ai/rag-answer', async (request) => {
    requireGatewayAuth(config, request)
    if (!isRecord(request.body)) {
      throw new GatewayHttpError(400, 'invalid_rag_answer_request', 'RAG answer request body must be an object.')
    }
    const bookId = readNonEmptyString(request.body.bookId)
    const query = readNonEmptyString(request.body.query)
    const limit = readSearchLimit(request.body.limit)
    if (!bookId || !query) {
      throw new GatewayHttpError(400, 'invalid_rag_answer_request', 'RAG answer request must include bookId and query.')
    }

    const [bookPackage, queryEmbedding] = await Promise.all([
      readBookPackage(config, bookId),
      createEmbedding(config, query),
    ])
    const results = searchPackageWithEmbedding(bookPackage, query, queryEmbedding, limit)
    const answer = await generateRagAnswer(config, query, results)

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      bookId,
      query,
      answer,
      results,
    }
  })

  app.get<{ Params: { bookId: string } }>('/mobile/books/:bookId/audio', async (request) => {
    requireGatewayAuth(config, request)
    const catalog = await readAudioCatalog(config, request.params.bookId)
    return {
      schemaVersion: catalog.schemaVersion,
      generatedAt: new Date().toISOString(),
      chapters: catalog.chapters,
    }
  })

  app.get<{ Params: { bookId: string; chapterId: string } }>(
    '/mobile/books/:bookId/audio/:chapterId/download',
    async (request, reply) => {
      requireGatewayAuth(config, request)
      const audio = await openAudioFile(config, request.params.bookId, request.params.chapterId)
      return reply
        .header('content-type', 'audio/mpeg')
        .header('content-length', audio.sizeBytes)
        .header('content-disposition', `inline; filename="${basename(audio.chapter.fileName)}"`)
        .send(audio.stream)
    },
  )

  app.get<{ Params: { bookId: string; chapterId: string } }>(
    '/mobile/books/:bookId/audio/:chapterId/manifest',
    async (request) => {
      requireGatewayAuth(config, request)
      return readAudioManifest(config, request.params.bookId, request.params.chapterId)
    },
  )

  return app
}

async function withAudioChapterCounts(config: GatewayConfig, books: GatewayBookSummary[]) {
  return Promise.all(books.map((book) => withAudioChapterCount(config, book)))
}

async function withAudioChapterCount(config: GatewayConfig, book: GatewayBookSummary) {
  const audioCatalog = await readAudioCatalog(config, book.id)
  return {
    ...book,
    audioChapterCount: audioCatalog.chapters.length,
  }
}

function buildReaderPackage(bookPackage: Awaited<ReturnType<typeof readBookPackage>>) {
  const {
    knowledgeGraph,
    integrity,
    ...readerPackage
  } = bookPackage
  delete (readerPackage as { embeddings?: unknown }).embeddings

  return {
    ...readerPackage,
    knowledgeGraph: summarizeKnowledgeGraph(knowledgeGraph),
    integrity: summarizeIntegrity(integrity),
  }
}

function summarizeKnowledgeGraph(value: unknown) {
  if (!isRecord(value)) return value

  return value
}

function summarizeIntegrity(value: unknown) {
  if (!isRecord(value)) return value

  return {
    ...value,
    embeddings: summarizeCount(value.embeddings),
  }
}

function summarizeCount(value: unknown) {
  return Array.isArray(value) ? { count: value.length } : value
}

function searchPackageWithEmbedding(
  bookPackage: Awaited<ReturnType<typeof readBookPackage>>,
  query: string,
  queryEmbedding: number[],
  limit: number,
) {
  const chapters = Array.isArray(bookPackage.chapters) ? bookPackage.chapters : []
  const chapterById = new Map<string, { index: number; id: string; title: string; chapterIndex: number }>()
  chapters.filter(isRecord).forEach((chapter, index) => {
    const id = readNonEmptyString(chapter.id)
    if (!id) return
    chapterById.set(id, {
      index,
      id,
      title: readNonEmptyString(chapter.title) || `第 ${index + 1} 章`,
      chapterIndex: readOptionalNumber(chapter.index) ?? readOptionalNumber(chapter.chapterIndex) ?? index + 1,
    })
  })
  const chunks = isRecord(bookPackage.embeddings) && Array.isArray(bookPackage.embeddings.chunks)
    ? bookPackage.embeddings.chunks.filter(isRecord)
    : []

  const results: Array<{
    chapterId: string
    chapterIndex: number
    chapterTitle: string
    snippet: string
    source: 'chunk'
    score: number
  }> = []

  for (const chunk of chunks) {
      const chapterId = readNonEmptyString(chunk.chapterId)
      const embedding = readNumberArray(chunk.embedding)
      if (!chapterId || embedding.length !== queryEmbedding.length) continue
      const chapter = chapterById.get(chapterId)
      if (!chapter) continue
      const score = cosineSimilarity(queryEmbedding, embedding)
      if (score <= 0) continue
      const text = readNonEmptyString(chunk.text)
      results.push({
        chapterId,
        chapterIndex: readOptionalNumber(chunk.chapterIndex) ?? chapter.chapterIndex,
        chapterTitle: chapter.title,
        snippet: findSearchSnippet(text, query),
        source: 'chunk',
        score: score * 100,
      })
  }

  return results
    .sort((left, right) => readOptionalNumber(right.score)! - readOptionalNumber(left.score)! || readOptionalNumber(left.chapterIndex)! - readOptionalNumber(right.chapterIndex)!)
    .slice(0, limit)
}

async function generateRagAnswer(
  config: GatewayConfig,
  query: string,
  results: Array<{
    chapterIndex: number
    chapterTitle: string
    snippet: string
    score: number
  }>,
) {
  if (!results.length) {
    return '没有检索到足够相关的章节内容，暂时无法基于原文回答这个问题。'
  }

  const prompt = buildRagAnswerPrompt(query, results)
  const response = await forwardChatCompletion(config, {
    messages: [
      { role: 'system', content: '你是长篇网络小说陪读助手。请严格依据提供的章节上下文回答问题，不要编造未提供的信息。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
  })
  const answer = readChatAnswer(response)
  if (!answer) {
    throw new GatewayHttpError(502, 'ai_upstream_invalid_response', 'OpenAI-compatible chat upstream returned no answer.')
  }
  return answer
}

function buildRagAnswerPrompt(
  query: string,
  results: Array<{
    chapterIndex: number
    chapterTitle: string
    snippet: string
    score: number
  }>,
) {
  const context = [...results]
    .sort((left, right) => left.chapterIndex - right.chapterIndex)
    .map((result) => {
      const lines = [`[第 ${result.chapterIndex} 章] ${result.chapterTitle}，相关度 ${result.score.toFixed(1)}`]
      if (result.snippet) lines.push(`原文片段：${result.snippet}`)
      return lines.join('\n')
    })
    .join('\n\n')

  return `请根据以下按章节顺序排列的相关内容回答问题。回答要简洁准确，并尽量引用章节号。如果信息不足，请明确说明。

问题：${query}

相关内容：
${context}

请给出回答：`
}

function readChatAnswer(response: unknown) {
  if (!isRecord(response) || !Array.isArray(response.choices)) return ''
  const choice = response.choices.find(isRecord)
  if (!choice || !isRecord(choice.message)) return ''
  return readNonEmptyString(choice.message.content)
}

function findSearchSnippet(text: string, query: string) {
  const normalizedText = text.replace(/\s+/g, ' ')
  if (!normalizedText) return ''
  const lowerText = normalizedText.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index < 0) return normalizedText.slice(0, 160)
  const start = Math.max(0, index - 48)
  const end = Math.min(normalizedText.length, index + query.length + 112)
  return `${start > 0 ? '...' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '...' : ''}`
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function readNumberArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)) : []
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readOptionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readSearchLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20
  return Math.max(1, Math.min(50, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeError(error: FastifyError | Error) {
  if (isGatewayHttpError(error)) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    }
  }

  const fastifyError = error as FastifyError
  const statusCode = fastifyError.statusCode && fastifyError.statusCode >= 400 ? fastifyError.statusCode : 500

  return {
    code: statusCode >= 500 ? 'internal_error' : 'request_error',
    message: statusCode >= 500 ? 'Internal server error' : error.message,
    statusCode,
  }
}
