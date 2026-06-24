import { describe, expect, it } from 'vitest'
import { buildGatewayApp } from './app.js'
import { loadConfig } from './config.js'

function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    GATEWAY_ENV: 'test',
    GATEWAY_LOG_LEVEL: 'silent',
    ...overrides,
  })
}

describe('gateway app', () => {
  it('returns health status', async () => {
    const app = buildGatewayApp(testConfig())
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
    const app = buildGatewayApp(testConfig())
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
    const app = buildGatewayApp(
      testConfig({
        GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
        GATEWAY_AI_BASE_URL: 'https://ai.example.test/v1',
        GATEWAY_AI_API_KEY: 'secret',
        GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
        GATEWAY_EMBEDDING_API_KEY: 'secret',
        GATEWAY_OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
        GATEWAY_OBJECT_STORAGE_BUCKET: 'novel-audio',
      }),
    )
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
    const app = buildGatewayApp(testConfig())
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
})
