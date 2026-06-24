import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireGatewayAuth } from './auth.js'
import { buildCapabilities } from './capabilities.js'
import { type GatewayConfig, loadConfig } from './config.js'
import { GatewayHttpError, isGatewayHttpError } from './errors.js'

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

  app.get('/auth/session', async (request) => ({
    authenticated: true,
    auth: requireGatewayAuth(config, request),
  }))

  app.get('/mobile/books', async (request) => {
    requireGatewayAuth(config, request)
    throw new GatewayHttpError(501, 'not_implemented', 'Book data API is planned for Phase 3.')
  })

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
