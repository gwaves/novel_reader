import { afterEach, describe, expect, it } from 'vitest'
import { buildGatewayApp } from './app.js'
import { loadConfig } from './config.js'

const apps: ReturnType<typeof buildGatewayApp>[] = []

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    GATEWAY_ENV: 'test',
    GATEWAY_LOG_LEVEL: 'silent',
    ...overrides,
  })
}

function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const app = buildGatewayApp(testConfig(overrides))
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('gateway app', () => {
  it('returns health status', async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'novel-reader-gateway',
    })
  })

  it('reports unavailable optional capabilities when upstreams are not configured', async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/capabilities',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      auth: {
        requiredByDefault: true,
        mode: 'not-configured',
      },
      features: {
        aiSearch: {
          available: false,
        },
        embeddings: {
          available: false,
        },
        audio: {
          available: false,
        },
      },
    })
  })

  it('reports configured AI, embedding, and audio capabilities', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_AI_BASE_URL: 'https://ai.example.test/v1',
      GATEWAY_AI_API_KEY: 'secret',
      GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'secret',
      GATEWAY_OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
      GATEWAY_OBJECT_STORAGE_BUCKET: 'novel-audio',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/capabilities',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      auth: {
        mode: 'development-static-token',
      },
      features: {
        aiSearch: {
          available: true,
        },
        embeddings: {
          available: true,
        },
        audio: {
          available: true,
        },
      },
    })
  })

  it('returns unified errors for unknown routes', async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/missing',
    })
    const body = response.json()

    expect(response.statusCode).toBe(404)
    expect(body.error).toMatchObject({
      code: 'not_found',
      statusCode: 404,
    })
    expect(body.error.requestId).toBeTruthy()
  })

  it('rejects protected routes when auth is not configured', async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error).toMatchObject({
      code: 'auth_not_configured',
      statusCode: 503,
    })
  })

  it('rejects protected routes without a bearer token', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/auth/session',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toMatchObject({
      code: 'missing_authorization',
      statusCode: 401,
    })
  })

  it('rejects protected routes with an invalid bearer token', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: {
        authorization: 'Bearer wrong-token',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toMatchObject({
      code: 'invalid_token',
      statusCode: 401,
    })
  })

  it('accepts protected routes with the configured development token', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      authenticated: true,
      auth: {
        mode: 'development-static-token',
      },
    })
  })

  it('protects planned mobile data routes before returning implementation placeholders', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
    })
    const unauthorizedResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books',
    })
    const authorizedResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(authorizedResponse.statusCode).toBe(501)
    expect(authorizedResponse.json().error).toMatchObject({
      code: 'not_implemented',
      statusCode: 501,
    })
  })
})
