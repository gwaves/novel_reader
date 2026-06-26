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
import { readBookCatalog, readBookPackage, readBookSummary, upsertBookPackage } from './data-store.js'
import { readDeviceRegistry, touchGatewayDevice } from './device-store.js'
import { isGatewayHttpError } from './errors.js'
import { forwardChatCompletion, forwardEmbeddings } from './openai-client.js'

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
      books: catalog.books,
    }
  })

  app.get<{ Params: { bookId: string } }>('/mobile/books/:bookId', async (request) => {
    requireGatewayAuth(config, request)
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      book: await readBookSummary(config, request.params.bookId),
    }
  })

  app.get<{ Params: { bookId: string } }>('/mobile/books/:bookId/package', async (request) => {
    requireGatewayAuth(config, request)
    return {
      generatedAt: new Date().toISOString(),
      package: await readBookPackage(config, request.params.bookId),
    }
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
