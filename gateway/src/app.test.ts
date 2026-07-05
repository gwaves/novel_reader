import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGatewayApp } from './app.js'
import { loadConfig } from './config.js'

const apps: ReturnType<typeof buildGatewayApp>[] = []
const dataDirs: string[] = []

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
  await Promise.all(dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })))
  vi.unstubAllGlobals()
})

async function makeDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), 'novel-reader-gateway-test-'))
  dataDirs.push(dataDir)
  return dataDir
}

function createTestAudioStreamToken(
  secret: string,
  payload: { bookId: string; chapterId: string; deviceId: string; exp: number },
) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signaturePart = createHmac('sha256', secret).update(payloadPart).digest('base64url')
  return `${payloadPart}.${signaturePart}`
}

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
  }, 15000)

  it('serves published Android APK downloads', async () => {
    const downloadsDir = await makeDataDir()
    await writeFile(join(downloadsDir, 'ai_novel_reader.apk'), 'apk bytes')
    const app = buildTestApp({
      GATEWAY_DOWNLOADS_DIR: downloadsDir,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/downloads/ai_novel_reader.apk',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/vnd.android.package-archive')
    expect(response.headers['content-disposition']).toBe('attachment; filename="ai_novel_reader.apk"')
    expect(response.body).toBe('apk bytes')
  })

  it('does not allow downloads path traversal', async () => {
    const dataDir = await makeDataDir()
    const downloadsDir = join(dataDir, 'downloads')
    await mkdir(downloadsDir, { recursive: true })
    await writeFile(join(dataDir, 'books.json'), 'outside secret')
    const app = buildTestApp({
      GATEWAY_DOWNLOADS_DIR: downloadsDir,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/downloads/%2e%2e/books.json',
    })

    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('outside secret')
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
      },
      features: {
        books: {
          available: true,
        },
        audio: {
          available: true,
          mode: 'local-directory',
        },
      },
    })
    expect(response.json().auth).not.toHaveProperty('mode')
    expect(response.json()).not.toHaveProperty('limits')
    expect(response.json().features).not.toHaveProperty('aiSearch')
    expect(response.json().features).not.toHaveProperty('embeddings')
  })

  it('does not expose upstream configuration from public capabilities', async () => {
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
        requiredByDefault: true,
      },
      features: {
        audio: {
          available: true,
        },
      },
    })
    expect(response.json().auth).not.toHaveProperty('adminTokenConfigured')
    expect(response.json().auth).not.toHaveProperty('mobileTokenConfigured')
    expect(response.json().auth).not.toHaveProperty('tokenSecretConfigured')
    expect(response.json().features).not.toHaveProperty('aiSearch')
    expect(response.json().features).not.toHaveProperty('embeddings')
  })

  it('does not expose the runtime environment from the public version endpoint', async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: 'GET',
      url: '/version',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      service: 'novel-reader-gateway',
      version: '0.1.0',
    })
  })

  it('rejects production config without explicit admin and mobile tokens', () => {
    expect(() =>
      loadConfig({
        GATEWAY_ENV: 'production',
        GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      }),
    ).toThrow(/requires GATEWAY_ADMIN_ACCESS_TOKEN and GATEWAY_MOBILE_ACCESS_TOKEN/)
    expect(() =>
      loadConfig({
        GATEWAY_ENV: 'production',
        GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
        GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      }),
    ).toThrow(/requires GATEWAY_ADMIN_ACCESS_TOKEN and GATEWAY_MOBILE_ACCESS_TOKEN/)
    expect(() =>
      loadConfig({
        GATEWAY_ENV: 'production',
        GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
        GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      }),
    ).toThrow(/requires GATEWAY_ADMIN_ACCESS_TOKEN and GATEWAY_MOBILE_ACCESS_TOKEN/)
  })

  it('does not use the development token as a production scoped-auth fallback', () => {
    const config = loadConfig({
      GATEWAY_ENV: 'production',
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
    })

    expect(config.auth.devAccessToken).toBe('dev-token')
    expect(config.auth.adminAccessToken).toBe('admin-token')
    expect(config.auth.mobileAccessToken).toBe('mobile-token')
    expect(config.auth.adminAccessToken).not.toBe(config.auth.devAccessToken)
    expect(config.auth.mobileAccessToken).not.toBe(config.auth.devAccessToken)
  })

  it('rejects wildcard CORS origins in production', () => {
    expect(() =>
      loadConfig({
        GATEWAY_ENV: 'production',
        GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
        GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
        GATEWAY_CORS_ORIGINS: '*',
      }),
    ).toThrow(/does not allow wildcard GATEWAY_CORS_ORIGINS/)
  })

  it('serves the admin UI under /admin/ui without shadowing admin APIs', async () => {
    const dataDir = await makeDataDir()
    const adminUiDir = await makeDataDir()
    await writeFile(join(adminUiDir, 'index.html'), '<!doctype html><title>Gateway Admin</title>', 'utf8')
    await writeFile(join(adminUiDir, 'app.css'), 'body{color:#111}', 'utf8')
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_ADMIN_UI_DIR: adminUiDir,
    })
    const htmlResponse = await app.inject({
      method: 'GET',
      url: '/admin/ui',
    })
    const cssResponse = await app.inject({
      method: 'GET',
      url: '/admin/ui/app.css',
    })
    const spaResponse = await app.inject({
      method: 'GET',
      url: '/admin/ui/books',
    })
    const apiResponse = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(htmlResponse.statusCode).toBe(200)
    expect(htmlResponse.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(htmlResponse.body).toContain('Gateway Admin')
    expect(cssResponse.statusCode).toBe(200)
    expect(cssResponse.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(cssResponse.body).toBe('body{color:#111}')
    expect(spaResponse.statusCode).toBe(200)
    expect(spaResponse.body).toContain('Gateway Admin')
    expect(apiResponse.statusCode).toBe(200)
    expect(apiResponse.json()).toMatchObject({
      schemaVersion: 1,
      books: [],
    })
  })

  it('reports Ollama embeddings as configured without an API key', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_EMBEDDING_PROVIDER: 'ollama',
      GATEWAY_EMBEDDING_BASE_URL: 'http://192.168.88.100:11434',
      GATEWAY_EMBEDDING_MODEL: 'qwen3-embedding:8b',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/capabilities',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().features).not.toHaveProperty('embeddings')
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

  it('separates admin and mobile bearer token audiences while keeping dev token fallback', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const adminWithAdminToken = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer admin-token' },
    })
    const adminWithMobileToken = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer mobile-token' },
    })
    const mobileWithMobileToken = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: { authorization: 'Bearer mobile-token' },
    })
    const mobileWithAdminToken = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: 'Bearer admin-token' },
    })

    expect(adminWithAdminToken.statusCode).toBe(200)
    expect(adminWithMobileToken.statusCode).toBe(401)
    expect(adminWithMobileToken.json().error).toMatchObject({ code: 'invalid_token' })
    expect(mobileWithMobileToken.statusCode).toBe(200)
    expect(mobileWithAdminToken.statusCode).toBe(401)
    expect(mobileWithAdminToken.json().error).toMatchObject({ code: 'invalid_token' })
  })

  it('falls back scoped admin and mobile auth to the development token', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const adminResponse = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer dev-token' },
    })
    const mobileResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: { authorization: 'Bearer dev-token' },
    })

    expect(adminResponse.statusCode).toBe(200)
    expect(mobileResponse.statusCode).toBe(200)
  })

  it('rejects the development token on scoped routes when production tokens are configured', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_ENV: 'production',
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const adminWithDevToken = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer dev-token' },
    })
    const mobileWithDevToken = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: { authorization: 'Bearer dev-token' },
    })
    const adminWithAdminToken = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer admin-token' },
    })
    const mobileWithMobileToken = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: { authorization: 'Bearer mobile-token' },
    })

    expect(adminWithDevToken.statusCode).toBe(401)
    expect(adminWithDevToken.json().error).toMatchObject({ code: 'invalid_token' })
    expect(mobileWithDevToken.statusCode).toBe(401)
    expect(mobileWithDevToken.json().error).toMatchObject({ code: 'invalid_token' })
    expect(adminWithAdminToken.statusCode).toBe(200)
    expect(mobileWithMobileToken.statusCode).toBe(200)
  })

  it('enriches admin books with package-derived coverage', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-ready',
            title: '已有包',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-ready'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-ready', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-26T00:00:00.000Z',
        book: {
          id: 'book-ready',
          title: '已有包',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
        summaries: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
        knowledgeGraph: {
          entityMentions: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
          relationMentions: [],
        },
        embeddings: {
          chunks: [{ chapterId: 'chapter-1', embedding: [0.1, 0.2] }],
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: { authorization: 'Bearer dev-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      books: [
        {
          id: 'book-ready',
          summaryCoverage: 1,
          kgCoverage: 1,
          embeddingCoverage: 0.5,
          embeddingVectorCoverage: 0.5,
          embeddingChunkVectorCount: 1,
          embeddingSummaryVectorCount: 0,
        },
      ],
    })
  })

  it('enriches mobile books with package-derived RAG coverage', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-ready',
            title: '已有包',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-ready'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-ready', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-26T00:00:00.000Z',
        book: {
          id: 'book-ready',
          title: '已有包',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
        summaries: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
        knowledgeGraph: {
          entityMentions: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
          relationMentions: [],
        },
        embeddings: {
          chunks: [{ chapterId: 'chapter-1', embedding: [0.1, 0.2] }],
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const listResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: { authorization: 'Bearer dev-token' },
    })
    const detailResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-ready',
      headers: { authorization: 'Bearer dev-token' },
    })

    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json()).toMatchObject({
      books: [
        {
          id: 'book-ready',
          summaryCoverage: 1,
          kgCoverage: 1,
          embeddingCoverage: 0.5,
          embeddingVectorCoverage: 0.5,
          embeddingChunkVectorCount: 1,
          embeddingSummaryVectorCount: 0,
        },
      ],
    })
    expect(detailResponse.statusCode).toBe(200)
    expect(detailResponse.json()).toMatchObject({
      book: {
        id: 'book-ready',
        summaryCoverage: 1,
        kgCoverage: 1,
        embeddingCoverage: 0.5,
        embeddingVectorCoverage: 0.5,
        embeddingChunkVectorCount: 1,
        embeddingSummaryVectorCount: 0,
      },
    })
  })

  it('records device names from protected session requests', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-name': 'Android Phone',
      },
    })
    const devicesResponse = await app.inject({
      method: 'GET',
      url: '/auth/devices',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(sessionResponse.statusCode).toBe(200)
    expect(sessionResponse.json()).toMatchObject({
      auth: {
        deviceName: 'Android Phone',
      },
    })
    expect(devicesResponse.statusCode).toBe(200)
    expect(devicesResponse.json()).toMatchObject({
      schemaVersion: 1,
      devices: [
        {
          id: 'legacy:android-phone',
          name: 'Android Phone',
          role: 'default',
        },
      ],
    })
  })

  it('records stable device metadata and returns role-scoped session auth', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'device-1',
            name: '客厅平板',
            model: 'Xiaomi Pad',
            platform: 'android',
            appVersion: '0.1.0',
            pairingCode: '428193',
            role: 'trusted',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
            lastIp: '192.168.1.2',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/auth/session',
      remoteAddress: '192.168.1.9',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'device-1',
        'x-device-name': '客厅平板新名',
        'x-device-model': 'Xiaomi Pad 6',
        'x-device-platform': 'android',
        'x-app-version': '0.2.0',
      },
    })
    const devices = JSON.parse(await readFile(join(dataDir, 'devices.json'), 'utf8')) as {
      devices: Array<Record<string, unknown>>
    }

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      authenticated: true,
      auth: {
        mode: 'development-static-token',
        deviceId: 'device-1',
        deviceName: '客厅平板新名',
        role: 'trusted',
        allowedVisibilities: ['default', 'trusted'],
        pairingCode: '428193',
      },
    })
    expect(devices.devices[0]).toMatchObject({
      id: 'device-1',
      name: '客厅平板新名',
      model: 'Xiaomi Pad 6',
      platform: 'android',
      appVersion: '0.2.0',
      pairingCode: '428193',
      role: 'trusted',
      firstSeenAt: '2026-06-29T00:00:00.000Z',
      lastIp: '192.168.1.9',
    })
    expect(Date.parse(String(devices.devices[0].lastSeenAt))).not.toBeNaN()
  })

  it('handles concurrent mobile device touches without temp file collisions', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const headers = {
      authorization: 'Bearer dev-token',
      'x-device-id': 'xiaomi-phone',
      'x-device-name': 'Xiaomi Phone',
      'x-device-model': '23127PN0CC',
      'x-device-platform': 'android',
      'x-app-version': '0.2.0',
    }

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: 'GET',
          url: '/auth/session',
          headers,
        }),
      ),
    )
    const devices = JSON.parse(await readFile(join(dataDir, 'devices.json'), 'utf8')) as {
      devices: Array<Record<string, unknown>>
    }

    expect(responses.map((response) => response.statusCode)).toEqual(Array(12).fill(200))
    expect(devices.devices).toHaveLength(1)
    expect(devices.devices[0]).toMatchObject({
      id: 'xiaomi-phone',
      name: 'Xiaomi Phone',
      model: '23127PN0CC',
      platform: 'android',
      appVersion: '0.2.0',
    })
  })

  it('normalizes legacy name-only device records for admin listing', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [{ name: 'Old Tablet' }],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/admin/devices',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().devices[0]).toMatchObject({
      id: 'legacy:old-tablet',
      name: 'Old Tablet',
      role: 'default',
    })
    expect(response.json().devices[0].pairingCode).toMatch(/^\d{6}$/)
  })

  it('returns an empty protected book catalog when no catalog file exists', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
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
    expect(authorizedResponse.statusCode).toBe(200)
    expect(authorizedResponse.json()).toMatchObject({
      schemaVersion: 1,
      books: [],
    })
    expect(authorizedResponse.json().generatedAt).toBeTruthy()
  })

  it('returns normalized protected book catalog entries', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-old',
            title: '旧书',
            author: '作者乙',
            chapterCount: 8,
            updatedAt: '2026-06-20T00:00:00.000Z',
          },
          {
            id: 'book-new',
            title: '新书',
            chapterCount: 12,
            wordCount: 56000,
            summaryCoverage: 0.5,
            kgCoverage: 0.25,
            embeddingCoverage: 0.75,
            audioChapterCount: 3,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      books: [
        {
          id: 'book-new',
          title: '新书',
          chapterCount: 12,
          wordCount: 56000,
          summaryCoverage: 0.5,
          kgCoverage: 0.25,
          embeddingCoverage: 0.75,
          audioChapterCount: 0,
          visibility: 'default',
          labels: [],
        },
        {
          id: 'book-old',
          title: '旧书',
          author: '作者乙',
          chapterCount: 8,
          visibility: 'default',
          labels: [],
        },
      ],
    })
  })

  it('filters mobile book APIs by device role and hides unauthorized books as not found', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'default-book',
            title: '默认书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
            visibility: 'default',
          },
          {
            id: 'trusted-book',
            title: '受信书',
            chapterCount: 1,
            updatedAt: '2026-06-26T00:00:00.000Z',
            visibility: 'trusted',
            labels: ['private'],
          },
          {
            id: 'hidden-book',
            title: '隐藏书',
            chapterCount: 1,
            updatedAt: '2026-06-27T00:00:00.000Z',
            visibility: 'hidden',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'trusted-book'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'trusted-book', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'trusted-book',
          title: '受信书',
          chapterCount: 1,
          updatedAt: '2026-06-26T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1', title: '第一章' }],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'trusted-device',
            name: 'Trusted',
            pairingCode: '111111',
            role: 'trusted',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
          {
            id: 'disabled-device',
            name: 'Disabled',
            pairingCode: '222222',
            role: 'disabled',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const defaultCatalog = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'default-device',
        'x-device-name': 'Default',
      },
    })
    const defaultTrustedBook = await app.inject({
      method: 'GET',
      url: '/mobile/books/trusted-book',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'default-device',
      },
    })
    const trustedCatalog = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'trusted-device',
      },
    })
    const trustedPackage = await app.inject({
      method: 'GET',
      url: '/mobile/books/trusted-book/package',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'trusted-device',
      },
    })
    const hiddenBook = await app.inject({
      method: 'GET',
      url: '/mobile/books/hidden-book',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'trusted-device',
      },
    })
    const disabledCatalog = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
        'x-device-id': 'disabled-device',
      },
    })

    expect(defaultCatalog.statusCode).toBe(200)
    expect(defaultCatalog.json().books.map((book: { id: string }) => book.id)).toEqual(['default-book'])
    expect(defaultTrustedBook.statusCode).toBe(404)
    expect(defaultTrustedBook.json().error).toMatchObject({ code: 'book_not_found' })
    expect(trustedCatalog.statusCode).toBe(200)
    expect(trustedCatalog.json().books.map((book: { id: string }) => book.id)).toEqual(['trusted-book', 'default-book'])
    expect(trustedPackage.statusCode).toBe(200)
    expect(trustedPackage.json().package.book.id).toBe('trusted-book')
    expect(hiddenBook.statusCode).toBe(404)
    expect(hiddenBook.json().error).toMatchObject({ code: 'book_not_found' })
    expect(disabledCatalog.statusCode).toBe(403)
    expect(disabledCatalog.json().error).toMatchObject({ code: 'device_disabled', statusCode: 403 })
  })

  it('manages all book visibility, labels, and device roles through admin APIs', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '后台书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
            visibility: 'hidden',
            labels: ['test'],
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'device-a',
            name: '旧设备',
            pairingCode: '333333',
            role: 'default',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }
    const booksBefore = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: authHeaders,
    })
    const visibilityResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/books/book-a/visibility',
      headers: authHeaders,
      payload: { visibility: 'trusted' },
    })
    const labelsResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/books/book-a/labels',
      headers: authHeaders,
      payload: { labels: ['private', 'adult', 'private', '  '] },
    })
    const devicesBefore = await app.inject({
      method: 'GET',
      url: '/admin/devices',
      headers: authHeaders,
    })
    const deviceResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/devices/device-a',
      headers: authHeaders,
      payload: { name: '客厅平板', role: 'trusted' },
    })

    expect(booksBefore.statusCode).toBe(200)
    expect(booksBefore.json().books).toEqual([
      expect.objectContaining({
        id: 'book-a',
        visibility: 'hidden',
        labels: ['test'],
      }),
    ])
    expect(visibilityResponse.statusCode).toBe(200)
    expect(visibilityResponse.json().book).toMatchObject({
      id: 'book-a',
      visibility: 'trusted',
      labels: ['test'],
    })
    expect(labelsResponse.statusCode).toBe(200)
    expect(labelsResponse.json().book).toMatchObject({
      id: 'book-a',
      visibility: 'trusted',
      labels: ['adult', 'private'],
    })
    expect(devicesBefore.statusCode).toBe(200)
    expect(devicesBefore.json().devices[0]).toMatchObject({
      id: 'device-a',
      role: 'default',
    })
    expect(deviceResponse.statusCode).toBe(200)
    expect(deviceResponse.json().device).toMatchObject({
      id: 'device-a',
      name: '客厅平板',
      role: 'trusted',
    })
  })

  it('enforces patched device roles on mobile APIs', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'default-book',
            title: '默认书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
            visibility: 'default',
          },
          {
            id: 'trusted-book',
            title: '受信书',
            chapterCount: 1,
            updatedAt: '2026-06-26T00:00:00.000Z',
            visibility: 'trusted',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'device-a',
            name: '客厅平板',
            pairingCode: '333333',
            role: 'default',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const adminHeaders = { authorization: 'Bearer dev-token' }
    const mobileHeaders = {
      authorization: 'Bearer dev-token',
      'x-device-id': 'device-a',
    }

    const trustedPatch = await app.inject({
      method: 'PATCH',
      url: '/admin/devices/device-a',
      headers: adminHeaders,
      payload: { role: 'trusted' },
    })
    const trustedCatalog = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: mobileHeaders,
    })
    const disabledPatch = await app.inject({
      method: 'PATCH',
      url: '/admin/devices/device-a',
      headers: adminHeaders,
      payload: { role: 'disabled' },
    })
    const disabledCatalog = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: mobileHeaders,
    })

    expect(trustedPatch.statusCode).toBe(200)
    expect(trustedCatalog.statusCode).toBe(200)
    expect(trustedCatalog.json().books.map((book: { id: string }) => book.id)).toEqual(['trusted-book', 'default-book'])
    expect(disabledPatch.statusCode).toBe(200)
    expect(disabledCatalog.statusCode).toBe(403)
    expect(disabledCatalog.json().error).toMatchObject({ code: 'device_disabled', statusCode: 403 })
  })

  it('reports request metrics, download counts, and recent events for admin overview', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '指标书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '指标书',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      }),
      'utf8',
    )
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
    await writeFile(join(bookAudioDir, 'chapter-1.mp3'), 'fake mp3 data', 'utf8')
    await writeFile(
      join(bookAudioDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            title: '第一章',
            fileName: 'chapter-1.mp3',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }

    const downloadResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package/download',
      headers: authHeaders,
    })
    const audioDownloadResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio/chapter-1/download',
      headers: authHeaders,
    })
    const missingResponse = await app.inject({
      method: 'GET',
      url: '/missing-metrics-route',
    })
    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/admin/metrics',
      headers: authHeaders,
    })
    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/admin/events',
      headers: authHeaders,
    })

    expect(downloadResponse.statusCode).toBe(200)
    expect(audioDownloadResponse.statusCode).toBe(200)
    expect(missingResponse.statusCode).toBe(404)
    expect(metricsResponse.statusCode).toBe(200)
    expect(metricsResponse.json()).toMatchObject({
      schemaVersion: 1,
      requests: {
        last24Hours: expect.any(Number),
        errorRate: expect.any(Number),
        p95Ms: expect.any(Number),
      },
      downloads: {
        packageLast24Hours: 1,
        audioLast24Hours: 1,
        topBooks: [
          {
            bookId: 'book-a',
            title: '指标书',
            packageDownloads: 1,
            audioDownloads: 1,
          },
        ],
      },
      trends: {
        bucketMinutes: 5,
        requests: expect.any(Array),
        downloads: expect.any(Array),
      },
    })
    expect(metricsResponse.json().trends.requests).toHaveLength(12)
    expect(metricsResponse.json().trends.downloads).toHaveLength(12)
    expect(metricsResponse.json().trends.requests.at(-1)).toMatchObject({
      requestCount: expect.any(Number),
      errorCount: expect.any(Number),
      p95Ms: expect.any(Number),
    })
    expect(metricsResponse.json().trends.requests.at(-1).requestCount).toBeGreaterThanOrEqual(3)
    expect(metricsResponse.json().trends.requests.at(-1).errorCount).toBeGreaterThanOrEqual(1)
    expect(metricsResponse.json().trends.downloads.at(-1)).toMatchObject({
      packageDownloads: 1,
      audioDownloads: 1,
    })
    expect(metricsResponse.json().requests.last24Hours).toBeGreaterThanOrEqual(2)
    expect(metricsResponse.json().requests.errorRate).toBeGreaterThan(0)
    expect(eventsResponse.statusCode).toBe(200)
    expect(eventsResponse.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          text: '下载 book-a 数据包',
          bookId: 'book-a',
        }),
        expect.objectContaining({
          level: 'warn',
          statusCode: 404,
        }),
        expect.objectContaining({
          level: 'info',
          text: '下载 book-a 章节音频',
          bookId: 'book-a',
        }),
      ]),
    )
  })

  it('returns an empty admin event list before notable requests happen', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/admin/events',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(eventsResponse.statusCode).toBe(200)
    expect(eventsResponse.json()).toMatchObject({
      schemaVersion: 1,
      events: [],
    })
  })

  it('returns admin package import status for every catalog book', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-ready',
            title: '已有包',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
          {
            id: 'book-missing',
            title: '缺包',
            chapterCount: 3,
            updatedAt: '2026-06-24T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-ready'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-ready', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-26T00:00:00.000Z',
        book: {
          id: 'book-ready',
          title: '已有包',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
        summaries: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
        knowledgeGraph: {
          entityMentions: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
          relationMentions: [],
        },
        embeddings: {
          coverage: {
            chunks: { embeddedChunks: 2, embeddedChapters: 2, totalChapters: 2, coverage: 1 },
          },
          chunks: [{ chapterId: 'chapter-1', embedding: [0.1, 0.2] }],
          summaries: [],
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/admin/packages',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      packages: [
        {
          bookId: 'book-ready',
          title: '已有包',
          status: 'imported',
          importStatus: 'imported',
          chapterCount: 2,
          packageChapterCount: 2,
          summaryCoverage: 1,
          kgCoverage: 1,
          embeddingCoverage: 1,
          embeddingVectorCoverage: 0.5,
          embeddingChunkVectorCount: 1,
          embeddingSummaryVectorCount: 0,
          importedAt: '2026-06-26T00:00:00.000Z',
          sizeBytes: expect.any(Number),
          updatedAt: expect.any(String),
        },
        {
          bookId: 'book-missing',
          title: '缺包',
          status: 'missing',
          importStatus: 'missing',
          chapterCount: 3,
          packageChapterCount: 0,
          sizeBytes: 0,
        },
      ],
    })
    expect(response.json().packages[0].sizeBytes).toBeGreaterThan(0)
  })

  it('distinguishes reported embedding coverage from imported vectors in admin package status', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-ready',
            title: '覆盖率包',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-ready'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-ready', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-26T00:00:00.000Z',
        book: {
          id: 'book-ready',
          title: '覆盖率包',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
        embeddings: {
          coverage: {
            chunks: { embeddedChunks: 2, embeddedChapters: 2, totalChapters: 2, coverage: 1 },
          },
          chunks: [],
          summaries: [],
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/packages',
      headers: { authorization: 'Bearer dev-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().packages[0]).toMatchObject({
      bookId: 'book-ready',
      embeddingCoverage: 1,
      embeddingVectorCoverage: 0,
      embeddingChunkVectorCount: 0,
      embeddingSummaryVectorCount: 0,
    })
  })

  it('imports protected admin packages with embedding vectors preserved for Gateway search', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const importResponse = await app.inject({
      method: 'PUT',
      url: '/admin/books/book-a/package',
      headers: { authorization: 'Bearer dev-token' },
      payload: {
        schemaVersion: 1,
        generatedAt: '2026-06-26T00:00:00.000Z',
        book: {
          id: 'book-a',
          title: '向量包',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1', title: '第一章', content: '正文' }],
        embeddings: {
          coverage: {
            chunks: { embeddedChunks: 1, embeddedChapters: 1, totalChapters: 1, coverage: 1 },
          },
          chunks: [{ chapterId: 'chapter-1', text: '正文', embedding: [0.1, 0.2] }],
          summaries: [{ chapterId: 'chapter-1', embedding: [0.2, 0.3] }],
        },
      },
    })
    const statusResponse = await app.inject({
      method: 'GET',
      url: '/admin/packages',
      headers: { authorization: 'Bearer dev-token' },
    })
    const stored = JSON.parse(await readFile(join(dataDir, 'books', 'book-a', 'package.json'), 'utf8'))

    expect(importResponse.statusCode).toBe(200)
    expect(stored.embeddings.chunks[0].embedding).toEqual([0.1, 0.2])
    expect(statusResponse.json().packages[0]).toMatchObject({
      bookId: 'book-a',
      embeddingCoverage: 1,
      embeddingVectorCoverage: 1,
      embeddingChunkVectorCount: 1,
      embeddingSummaryVectorCount: 1,
    })
  })

  it('downloads full book packages through the admin API', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-ready',
            title: '已有包',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-ready'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-ready', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-ready',
          title: '已有包',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1', content: '正文' }],
        embeddings: { chunks: [{ chapterId: 'chapter-1', embedding: [0.1, 0.2] }] },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const unauthorizedResponse = await app.inject({
      method: 'GET',
      url: '/admin/books/book-ready/package/download',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/admin/books/book-ready/package/download',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBe('attachment; filename="book-ready-package-full.json"')
    expect(response.json()).toMatchObject({
      book: {
        id: 'book-ready',
      },
      embeddings: {
        chunks: [{ chapterId: 'chapter-1' }],
      },
    })
  })

  it('returns admin audio coverage, missing chapters, and total size for every catalog book', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-audio',
            title: '音频书',
            chapterCount: 3,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-audio'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-audio', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-audio',
          title: '音频书',
          chapterCount: 3,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [
          { id: 'chapter-1', title: '第一章' },
          { id: 'chapter-2', title: '第二章' },
          { id: 'chapter-3', title: '第三章' },
        ],
      }),
      'utf8',
    )
    await mkdir(join(audioDir, 'books', 'book-audio'), { recursive: true })
    await writeFile(join(audioDir, 'books', 'book-audio', 'chapter-1.mp3'), 'audio-one', 'utf8')
    await writeFile(join(audioDir, 'books', 'book-audio', 'chapter-3.mp3'), 'audio-three', 'utf8')
    await writeFile(
      join(audioDir, 'books', 'book-audio', 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            fileName: 'chapter-1.mp3',
            updatedAt: '2026-06-27T00:00:00.000Z',
          },
          {
            chapterId: 'chapter-3',
            fileName: 'chapter-3.mp3',
            sizeBytes: 11,
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audio',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      audio: [
        {
          bookId: 'book-audio',
          title: '音频书',
          chapterCount: 3,
          audioChapterCount: 2,
          missingChapterCount: 1,
          missingChapterIds: ['chapter-2'],
          coverage: 2 / 3,
          totalSizeBytes: 20,
          updatedAt: expect.any(String),
        },
      ],
    })
    expect(Date.parse(response.json().audio[0].updatedAt)).not.toBeNaN()
  })

  it('refreshes and clears one book audio state through admin APIs', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-audio')
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-audio',
            title: '音频书',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-audio'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-audio', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-audio',
          title: '音频书',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
      }),
      'utf8',
    )
    await mkdir(bookAudioDir, { recursive: true })
    await writeFile(join(bookAudioDir, 'chapter-1.mp3'), 'audio-one', 'utf8')
    await writeFile(
      join(bookAudioDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            fileName: 'chapter-1.mp3',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/admin/books/book-audio/audio/refresh',
      headers: authHeaders,
    })
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/admin/books/book-audio/audio',
      headers: authHeaders,
    })
    const refreshAfterDeleteResponse = await app.inject({
      method: 'POST',
      url: '/admin/books/book-audio/audio/refresh',
      headers: authHeaders,
    })
    const adminAudioAfterDeleteResponse = await app.inject({
      method: 'GET',
      url: '/admin/audio',
      headers: authHeaders,
    })

    expect(refreshResponse.statusCode).toBe(200)
    expect(refreshResponse.json()).toMatchObject({
      schemaVersion: 1,
      audio: {
        bookId: 'book-audio',
        audioChapterCount: 1,
        missingChapterIds: ['chapter-2'],
        totalSizeBytes: 9,
      },
    })
    expect(deleteResponse.statusCode).toBe(200)
    expect(deleteResponse.json()).toMatchObject({
      cleanup: {
        bookId: 'book-audio',
        removed: true,
        deletedFileCount: 2,
        deletedFiles: ['audio.json', 'chapter-1.mp3'],
      },
      audio: {
        audioChapterCount: 0,
        missingChapterCount: 2,
        missingChapterIds: ['chapter-1', 'chapter-2'],
      },
    })
    await expect(readFile(join(bookAudioDir, 'audio.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(bookAudioDir, 'chapter-1.mp3'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(refreshAfterDeleteResponse.statusCode).toBe(200)
    expect(refreshAfterDeleteResponse.json().audio).toMatchObject({
      audioChapterCount: 0,
      missingChapterIds: ['chapter-1', 'chapter-2'],
    })
    expect(adminAudioAfterDeleteResponse.statusCode).toBe(200)
    expect(adminAudioAfterDeleteResponse.json().audio).toEqual([
      expect.objectContaining({
        bookId: 'book-audio',
        audioChapterCount: 0,
        missingChapterCount: 2,
        missingChapterIds: ['chapter-1', 'chapter-2'],
        coverage: 0,
        totalSizeBytes: 0,
      }),
    ])
  })

  it('returns recent request logs with fields needed by the admin requests view', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }

    const missingResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/missing-book/package',
      headers: authHeaders,
      remoteAddress: '192.168.88.42',
    })
    const requestsResponse = await app.inject({
      method: 'GET',
      url: '/admin/requests',
      headers: authHeaders,
    })

    expect(missingResponse.statusCode).toBe(404)
    expect(requestsResponse.statusCode).toBe(200)
    expect(requestsResponse.json()).toMatchObject({
      schemaVersion: 1,
      requests: [
        expect.objectContaining({
          requestId: expect.any(String),
          time: expect.any(String),
          method: 'GET',
          url: '/mobile/books/missing-book/package',
          statusCode: 404,
          durationMs: expect.any(Number),
          ip: '192.168.88.42',
          bookId: 'missing-book',
        }),
      ],
    })
  })

  it('uses forwarded client IPs when Gateway runs behind a trusted proxy', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_TRUST_PROXY: 'true',
    })
    const authHeaders = {
      authorization: 'Bearer dev-token',
      'x-forwarded-for': '192.168.88.77, 172.18.0.3',
      'x-device-id': 'device-forwarded',
      'x-device-name': 'Forwarded Phone',
    }

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: authHeaders,
      remoteAddress: '172.18.0.3',
    })
    const devicesResponse = await app.inject({
      method: 'GET',
      url: '/admin/devices',
      headers: { authorization: 'Bearer dev-token' },
    })
    const requestsResponse = await app.inject({
      method: 'GET',
      url: '/admin/requests',
      headers: { authorization: 'Bearer dev-token' },
    })

    expect(sessionResponse.statusCode).toBe(200)
    expect(devicesResponse.json().devices).toEqual([
      expect.objectContaining({
        id: 'device-forwarded',
        lastIp: '192.168.88.77',
      }),
    ])
    expect(requestsResponse.json().requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: '/auth/session',
        ip: '192.168.88.77',
        deviceId: 'device-forwarded',
        deviceName: 'Forwarded Phone',
      }),
    ]))
  })

  it('reports book catalog audio counts from the current audio manifests', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    await mkdir(join(audioDir, 'books', 'book-new'), { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-new',
            title: '新书',
            chapterCount: 120,
            audioChapterCount: 3,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(audioDir, 'books', 'book-new', 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: Array.from({ length: 120 }, (_, index) => ({
          chapterId: `chapter-${index + 1}`,
          fileName: `chapter-${index + 1}.mp3`,
        })),
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().books[0]).toMatchObject({
      id: 'book-new',
      audioChapterCount: 120,
    })
  })

  it('returns a protected book summary by id', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '单书',
            chapterCount: 10,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      book: {
        id: 'book-a',
        title: '单书',
        chapterCount: 10,
      },
    })
  })

  it('returns a stable not found error for unknown protected books', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/missing-book',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatchObject({
      code: 'book_not_found',
      statusCode: 404,
    })
  })

  it('returns a protected mobile book package', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '完整包',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '完整包',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [
          {
            id: 'chapter-1',
            title: '第一章',
            content: '正文',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      package: {
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '完整包',
        },
        chapters: [
          {
            id: 'chapter-1',
            title: '第一章',
          },
        ],
      },
    })
    expect(response.json().generatedAt).toBeTruthy()
  })

  it('downloads protected mobile book packages without embedding vectors', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '完整下载包',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '完整下载包',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [
          {
            id: 'chapter-1',
            title: '第一章',
            content: '正文',
          },
        ],
        embeddings: {
          chunks: [{ chapterId: 'chapter-1', text: '正文', embedding: [0.1, 0.2] }],
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })

    const unauthorizedResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package/download',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package/download',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBe('attachment; filename="book-a-package-full.json"')
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0)
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      book: {
        id: 'book-a',
      },
    })
    expect(response.json()).not.toHaveProperty('embeddings')
  })

  it('returns a stable not found error when a protected book package is missing', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '无包',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatchObject({
      code: 'book_package_not_found',
      statusCode: 404,
    })
  })

  it('returns a stable not found error for unknown protected package downloads', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/missing-book/package/download',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatchObject({
      code: 'book_not_found',
      statusCode: 404,
    })
  })

  it('rejects protected mobile book packages with mismatched ids', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '错包',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-b',
          title: '错包',
        },
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().error).toMatchObject({
      code: 'book_package_invalid',
      statusCode: 500,
    })
  })

  it('imports protected mobile book packages and refreshes the catalog', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const packageBody = {
      schemaVersion: 1,
      book: {
        id: 'book-imported',
        title: '导入书',
        author: '作者甲',
        chapterCount: 2,
        wordCount: 12345,
        updatedAt: '2026-06-25T01:00:00.000Z',
      },
      chapters: [
        {
          id: 'chapter-1',
          title: '第一章',
          content: '正文',
        },
      ],
    }
    const unauthorizedResponse = await app.inject({
      method: 'PUT',
      url: '/admin/books/book-imported/package',
      payload: packageBody,
    })
    const importResponse = await app.inject({
      method: 'PUT',
      url: '/admin/books/book-imported/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: packageBody,
    })
    const catalogResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })
    const packageResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-imported/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(importResponse.statusCode).toBe(200)
    expect(importResponse.json()).toMatchObject({
      schemaVersion: 1,
      book: {
        id: 'book-imported',
        title: '导入书',
        chapterCount: 2,
      },
    })
    expect(catalogResponse.json()).toMatchObject({
      books: [
        {
          id: 'book-imported',
          title: '导入书',
          author: '作者甲',
          chapterCount: 2,
          wordCount: 12345,
        },
      ],
    })
    expect(packageResponse.json()).toMatchObject({
      package: {
        book: {
          id: 'book-imported',
          title: '导入书',
        },
        chapters: [
          {
            id: 'chapter-1',
          },
        ],
      },
    })
  })

  it('imports local mobile packages with numeric ids and generated timestamps', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const packageBody = {
      schemaVersion: 1,
      generatedAt: '2026-06-25T03:00:00.000Z',
      book: {
        id: 42,
        title: '本地导出书',
        importedAt: '2026-06-20T00:00:00.000Z',
        chapterCount: 3,
        wordCount: 67890,
      },
      chapters: [
        {
          id: 1,
          title: '第一章',
          content: '正文',
        },
      ],
    }
    const importResponse = await app.inject({
      method: 'PUT',
      url: '/admin/books/42/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: packageBody,
    })
    const packageResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/42/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(importResponse.statusCode).toBe(200)
    expect(importResponse.json()).toMatchObject({
      book: {
        id: '42',
        title: '本地导出书',
        updatedAt: '2026-06-25T03:00:00.000Z',
      },
    })
    expect(packageResponse.json()).toMatchObject({
      package: {
        book: {
          id: '42',
          title: '本地导出书',
        },
      },
    })
  })

  it('deletes a catalog book together with its package and audio files', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const bookDir = join(dataDir, 'books', 'book-delete')
    const audioBookDir = join(audioDir, 'books', 'book-delete')
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-keep',
            title: '保留书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
          {
            id: 'book-delete',
            title: '待删除书',
            chapterCount: 2,
            updatedAt: '2026-06-26T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(bookDir, { recursive: true })
    await writeFile(
      join(bookDir, 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-delete',
          title: '待删除书',
          chapterCount: 2,
          updatedAt: '2026-06-26T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
      }),
      'utf8',
    )
    await mkdir(audioBookDir, { recursive: true })
    await writeFile(join(audioBookDir, 'chapter-1.mp3'), 'audio-one', 'utf8')
    await writeFile(join(audioBookDir, 'chapter-1.manifest.json'), '{"timeline":[]}', 'utf8')
    await writeFile(
      join(audioBookDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            fileName: 'chapter-1.mp3',
            manifestFileName: 'chapter-1.manifest.json',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }

    const unauthorizedResponse = await app.inject({
      method: 'DELETE',
      url: '/admin/books/book-delete',
    })
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/admin/books/book-delete',
      headers: authHeaders,
    })
    const catalogResponse = await app.inject({
      method: 'GET',
      url: '/admin/books',
      headers: authHeaders,
    })
    const deletedBookResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-delete',
      headers: authHeaders,
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(deleteResponse.statusCode).toBe(200)
    expect(deleteResponse.json()).toMatchObject({
      schemaVersion: 1,
      deleted: {
        bookId: 'book-delete',
        title: '待删除书',
        removed: true,
        packageRemoved: true,
        audioRemoved: true,
      },
    })
    expect(catalogResponse.statusCode).toBe(200)
    expect(catalogResponse.json().books.map((book: { id: string }) => book.id)).toEqual(['book-keep'])
    expect(deletedBookResponse.statusCode).toBe(404)
    expect(deletedBookResponse.json().error).toMatchObject({ code: 'book_not_found' })
    await expect(readFile(bookDir, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(audioBookDir, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves existing book visibility and labels when importing replacement packages', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-imported',
            title: '旧标题',
            chapterCount: 1,
            updatedAt: '2026-06-20T00:00:00.000Z',
            visibility: 'trusted',
            labels: ['private'],
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/books/book-imported/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        schemaVersion: 1,
        book: {
          id: 'book-imported',
          title: '新标题',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().book).toMatchObject({
      id: 'book-imported',
      title: '新标题',
      visibility: 'trusted',
      labels: ['private'],
    })
  })

  it('rejects imported mobile book packages with mismatched ids', async () => {
    const dataDir = await makeDataDir()
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/books/book-a/package',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        schemaVersion: 1,
        book: {
          id: 'book-b',
          title: '错包',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatchObject({
      code: 'invalid_book_package',
      statusCode: 400,
    })
  })

  it('forwards protected chat requests to an OpenAI-compatible upstream', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'chatcmpl-test', choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_AI_BASE_URL: 'https://openai.example.test/v1',
      GATEWAY_AI_API_KEY: 'upstream-secret',
      GATEWAY_AI_MODEL: 'gpt-test',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        messages: [{ role: 'user', content: '你好' }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: 'chatcmpl-test',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openai.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer upstream-secret',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          messages: [{ role: 'user', content: '你好' }],
          model: 'gpt-test',
        }),
      }),
    )
  })

  it('forwards protected embedding requests to an OpenAI-compatible upstream', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_EMBEDDING_BASE_URL: 'https://openai.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
      GATEWAY_EMBEDDING_MODEL: 'text-embedding-test',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/ai/embeddings',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        input: '文本',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: [{ embedding: [0.1, 0.2] }],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openai.example.test/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer embedding-secret',
        }),
        body: JSON.stringify({
          input: '文本',
          model: 'text-embedding-test',
        }),
      }),
    )
  })

  it('protects admin AI proxy routes and redacts upstream secrets from errors', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: 'upstream rejected api key upstream-secret and embedding-secret',
          },
        },
        { status: 401 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_AI_BASE_URL: 'https://openai.example.test/v1',
      GATEWAY_AI_API_KEY: 'upstream-secret',
      GATEWAY_EMBEDDING_BASE_URL: 'https://openai.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
    })

    const chatWithMobileToken = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      headers: {
        authorization: 'Bearer mobile-token',
      },
      payload: {
        messages: [{ role: 'user', content: '你好' }],
      },
    })
    const embeddingsWithMobileToken = await app.inject({
      method: 'POST',
      url: '/ai/embeddings',
      headers: {
        authorization: 'Bearer mobile-token',
      },
      payload: {
        input: '文本',
      },
    })
    const chatUpstreamError = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      headers: {
        authorization: 'Bearer admin-token',
      },
      payload: {
        messages: [{ role: 'user', content: '你好' }],
      },
    })
    const embeddingsUpstreamError = await app.inject({
      method: 'POST',
      url: '/ai/embeddings',
      headers: {
        authorization: 'Bearer admin-token',
      },
      payload: {
        input: '文本',
      },
    })

    expect(chatWithMobileToken.statusCode).toBe(401)
    expect(chatWithMobileToken.json().error).toMatchObject({ code: 'invalid_token' })
    expect(embeddingsWithMobileToken.statusCode).toBe(401)
    expect(embeddingsWithMobileToken.json().error).toMatchObject({ code: 'invalid_token' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(chatUpstreamError.statusCode).toBe(502)
    expect(chatUpstreamError.json().error).toMatchObject({
      code: 'ai_upstream_error',
      message: 'OpenAI-compatible upstream returned HTTP 401.',
    })
    expect(embeddingsUpstreamError.statusCode).toBe(502)
    expect(embeddingsUpstreamError.json().error).toMatchObject({
      code: 'embedding_upstream_error',
      message: 'OpenAI-compatible upstream returned HTTP 401.',
    })
    const responseBodies = `${chatWithMobileToken.body}\n${embeddingsWithMobileToken.body}\n${chatUpstreamError.body}\n${embeddingsUpstreamError.body}`
    expect(responseBodies).not.toContain('upstream-secret')
    expect(responseBodies).not.toContain('embedding-secret')
  })

  it('forwards protected embedding requests to an Ollama upstream', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embedding: [0.3, 0.4, 0.5] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_EMBEDDING_PROVIDER: 'ollama',
      GATEWAY_EMBEDDING_BASE_URL: 'http://ollama.example.test:11434',
      GATEWAY_EMBEDDING_MODEL: 'qwen3-embedding:8b',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/ai/embeddings',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        input: '文本',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      object: 'list',
      model: 'qwen3-embedding:8b',
      data: [{ embedding: [0.3, 0.4, 0.5], index: 0 }],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.example.test:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({
          authorization: expect.any(String),
        }),
        body: JSON.stringify({
          model: 'qwen3-embedding:8b',
          prompt: '文本',
        }),
      }),
    )
  })

  it('allows mobile devices to run scoped RAG search with the mobile token', async () => {
    const dataDir = await makeDataDir()
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '默认书',
            chapterCount: 1,
            updatedAt: '2026-06-30T00:00:00.000Z',
            visibility: 'default',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '默认书',
          chapterCount: 1,
          updatedAt: '2026-06-30T00:00:00.000Z',
          visibility: 'default',
        },
        chapters: [{ id: 'chapter-1', title: '第一章', index: 1 }],
        embeddings: {
          chunks: [{ chapterId: 'chapter-1', chapterIndex: 1, text: '耿照和阿傻相遇。', embedding: [0.1, 0.2] }],
        },
      }),
      'utf8',
    )
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
      GATEWAY_EMBEDDING_MODEL: 'text-embedding-test',
    })

    const mobileResponse = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'device-a',
        'x-device-name': '客厅平板',
      },
      payload: {
        bookId: 'book-a',
        query: '耿照',
      },
    })
    const adminResponse = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer admin-token',
        'x-device-id': 'device-a',
        'x-device-name': '客厅平板',
      },
      payload: {
        bookId: 'book-a',
        query: '耿照',
      },
    })

    expect(mobileResponse.statusCode).toBe(200)
    expect(mobileResponse.json()).toMatchObject({
      bookId: 'book-a',
      results: [expect.objectContaining({ chapterId: 'chapter-1' })],
    })
    expect(adminResponse.statusCode).toBe(401)
    expect(adminResponse.json().error).toMatchObject({ code: 'invalid_token' })
  })

  it('falls back to keyword RAG search when package embedding vectors are not inlined', async () => {
    const dataDir = await makeDataDir()
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '红楼梦',
            chapterCount: 2,
            updatedAt: '2026-06-30T00:00:00.000Z',
            visibility: 'default',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '红楼梦',
          chapterCount: 2,
          embeddingCoverage: 1,
          updatedAt: '2026-06-30T00:00:00.000Z',
          visibility: 'default',
        },
        chapters: [
          { id: 'chapter-1', title: '第一回', index: 1, content: '甄士隐梦幻识通灵，贾雨村风尘怀闺秀。' },
          { id: 'chapter-2', title: '第二回', index: 2, content: '贾夫人仙逝扬州城，冷子兴演说荣国府。' },
        ],
        summaries: [
          { chapterId: 'chapter-1', short: '甄士隐梦见通灵宝玉，贾雨村寄居葫芦庙。' },
          { chapterId: 'chapter-2', short: '冷子兴向贾雨村演说荣国府人物。' },
        ],
        embeddings: {
          coverage: {
            chunks: { embeddedChunks: 2, embeddedChapters: 2, totalChapters: 2, coverage: 1 },
          },
          chunks: [],
          summaries: [],
        },
      }),
      'utf8',
    )
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
      GATEWAY_EMBEDDING_MODEL: 'text-embedding-test',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'device-a',
        'x-device-name': '客厅平板',
      },
      payload: {
        bookId: 'book-a',
        query: '通灵宝玉',
        limit: 5,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      bookId: 'book-a',
      results: [
        expect.objectContaining({
          chapterId: 'chapter-1',
          source: expect.stringMatching(/summary|chapter/),
          snippet: expect.stringContaining('通灵宝玉'),
        }),
      ],
    })
  })

  it('prioritizes earlier chapters for first-event RAG searches when vector scores are close', async () => {
    const dataDir = await makeDataDir()
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '妖刀记',
            chapterCount: 21,
            updatedAt: '2026-06-30T00:00:00.000Z',
            visibility: 'default',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '妖刀记',
          chapterCount: 21,
          updatedAt: '2026-06-30T00:00:00.000Z',
          visibility: 'default',
        },
        chapters: [
          { id: 'chapter-3', title: '早期证据', index: 3 },
          { id: 'chapter-21', title: '后文证据', index: 21 },
        ],
        embeddings: {
          chunks: [
            { chapterId: 'chapter-21', chapterIndex: 21, text: '后文更直白地回忆某次关系。', embedding: [0.61, 0.79] },
            { chapterId: 'chapter-3', chapterIndex: 3, text: '耿照先看到无关景物。黄缨出现在更早章节里的第一次事件。', embedding: [0.59, 0.81] },
          ],
        },
      }),
      'utf8',
    )
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
      GATEWAY_EMBEDDING_MODEL: 'text-embedding-test',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'device-a',
      },
      payload: {
        bookId: 'book-a',
        query: '第一个发生关系的人是谁',
        limit: 2,
      },
    })

    expect(response.statusCode).toBe(200)
    const results = response.json().results as Array<{ chapterId: string; snippet: string }>
    expect(results.map((result) => result.chapterId)).toEqual([
      'chapter-3',
      'chapter-21',
    ])
    expect(results[0].snippet).toContain('黄缨')
    expect(results[0]).not.toHaveProperty('contextText')
  })

  it('applies device visibility rules to mobile AI search and RAG answer routes', async () => {
    const dataDir = await makeDataDir()
    await mkdir(join(dataDir, 'books', 'trusted-book'), { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'trusted-book',
            title: '受信书',
            chapterCount: 1,
            updatedAt: '2026-06-30T00:00:00.000Z',
            visibility: 'trusted',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'books', 'trusted-book', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'trusted-book',
          title: '受信书',
          chapterCount: 1,
          updatedAt: '2026-06-30T00:00:00.000Z',
          visibility: 'trusted',
        },
        chapters: [{ id: 'chapter-1', title: '第一章', index: 1 }],
        embeddings: {
          chunks: [{ chapterId: 'chapter-1', chapterIndex: 1, text: '耿照和阿傻在妖刀旁相遇。', embedding: [0.1, 0.2] }],
        },
      }),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'trusted-device',
            name: 'Trusted',
            pairingCode: '111111',
            role: 'trusted',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
          {
            id: 'disabled-device',
            name: 'Disabled',
            pairingCode: '222222',
            role: 'disabled',
            firstSeenAt: '2026-06-29T00:00:00.000Z',
            lastSeenAt: '2026-06-29T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/embeddings')) return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] })
      if (url.includes('/chat/completions')) return jsonResponse({ choices: [{ message: { content: '耿照和阿傻在妖刀旁相遇。' } }] })
      return jsonResponse({ error: 'unexpected upstream' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AI_BASE_URL: 'https://ai.example.test/v1',
      GATEWAY_AI_API_KEY: 'ai-secret',
      GATEWAY_AI_MODEL: 'chat-test',
      GATEWAY_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
      GATEWAY_EMBEDDING_API_KEY: 'embedding-secret',
      GATEWAY_EMBEDDING_MODEL: 'text-embedding-test',
    })

    const defaultSearch = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'default-device',
      },
      payload: {
        bookId: 'trusted-book',
        query: '耿照',
      },
    })
    const trustedSearch = await app.inject({
      method: 'POST',
      url: '/ai/search',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'trusted-device',
      },
      payload: {
        bookId: 'trusted-book',
        query: '耿照',
      },
    })
    const trustedAnswer = await app.inject({
      method: 'POST',
      url: '/ai/rag-answer',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'trusted-device',
      },
      payload: {
        bookId: 'trusted-book',
        query: '耿照在哪里遇到阿傻？',
      },
    })
    const disabledAnswer = await app.inject({
      method: 'POST',
      url: '/ai/rag-answer',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'disabled-device',
      },
      payload: {
        bookId: 'trusted-book',
        query: '耿照',
      },
    })

    expect(defaultSearch.statusCode).toBe(404)
    expect(defaultSearch.json().error).toMatchObject({ code: 'book_not_found' })
    expect(trustedSearch.statusCode).toBe(200)
    expect(trustedSearch.json()).toMatchObject({
      bookId: 'trusted-book',
      results: [expect.objectContaining({ chapterId: 'chapter-1' })],
    })
    expect(trustedAnswer.statusCode).toBe(200)
    expect(trustedAnswer.json()).toMatchObject({
      bookId: 'trusted-book',
      answer: '耿照和阿傻在妖刀旁相遇。',
      results: [expect.objectContaining({ chapterId: 'chapter-1' })],
    })
    expect(disabledAnswer.statusCode).toBe(403)
    expect(disabledAnswer.json().error).toMatchObject({ code: 'device_disabled', statusCode: 403 })
  })

  it('returns stable errors when OpenAI-compatible upstreams are not configured', async () => {
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
    })
    const chatResponse = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        messages: [{ role: 'user', content: '你好' }],
      },
    })
    const embeddingResponse = await app.inject({
      method: 'POST',
      url: '/ai/embeddings',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        input: '文本',
      },
    })

    expect(chatResponse.statusCode).toBe(503)
    expect(chatResponse.json().error).toMatchObject({
      code: 'ai_not_configured',
      statusCode: 503,
    })
    expect(embeddingResponse.statusCode).toBe(503)
    expect(embeddingResponse.json().error).toMatchObject({
      code: 'embeddings_not_configured',
      statusCode: 503,
    })
  })

  it('returns an empty protected audio catalog when no audio catalog exists', async () => {
    const dataDir = await makeDataDir()
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '音频书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: dataDir,
    })
    const unauthorizedResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio',
    })
    const authorizedResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(unauthorizedResponse.statusCode).toBe(401)
    expect(authorizedResponse.statusCode).toBe(200)
    expect(authorizedResponse.json()).toMatchObject({
      schemaVersion: 1,
      chapters: [],
    })
  })

  it('returns a protected audio catalog and downloads audio files', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '音频书',
            chapterCount: 2,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '音频书',
          chapterCount: 2,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [
          { id: 'chapter-1', title: '第一章', content: '正文一' },
          { id: 'chapter-2', title: '第二章', content: '正文二' },
        ],
      }),
      'utf8',
    )
    await writeFile(join(bookAudioDir, 'chapter-1.mp3'), 'fake mp3 data')
    await writeFile(
      join(bookAudioDir, 'chapter-1.manifest.json'),
      JSON.stringify({
        kind: 'novel-reader-tts-audio-manifest',
        version: 2,
        timelineVersion: 1,
        duration: 1.2,
        timeline: [{ id: 'seg-1', text: '正文', startTime: 0, endTime: 1, nextStartTime: 1.2 }],
      }),
      'utf8',
    )
    await writeFile(
      join(bookAudioDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            title: '第一章',
            fileName: 'chapter-1.mp3',
            manifestFileName: 'chapter-1.manifest.json',
            timelineVersion: 1,
            durationMs: 1200,
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const catalogResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })
    const downloadResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio/chapter-1/download',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })
    const manifestResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio/chapter-1/manifest',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(catalogResponse.statusCode).toBe(200)
    expect(catalogResponse.json()).toMatchObject({
      summary: {
        bookId: 'book-a',
        title: '音频书',
        chapterCount: 2,
        audioChapterCount: 1,
        missingChapterCount: 1,
        missingChapterIds: ['chapter-2'],
        coverage: 0.5,
        totalSizeBytes: 'fake mp3 data'.length,
      },
      chapters: [
        {
          chapterId: 'chapter-1',
          title: '第一章',
          fileName: 'chapter-1.mp3',
          manifestFileName: 'chapter-1.manifest.json',
          timelineVersion: 1,
        },
      ],
    })
    expect(downloadResponse.statusCode).toBe(200)
    expect(downloadResponse.headers['content-type']).toContain('audio/mpeg')
    expect(downloadResponse.body).toBe('fake mp3 data')
    expect(manifestResponse.statusCode).toBe(200)
    expect(manifestResponse.json()).toMatchObject({
      version: 2,
      timelineVersion: 1,
      timeline: [{ text: '正文' }],
    })
  })

  it('returns signed MP3 stream URLs and supports byte range playback', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '音频书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await mkdir(join(dataDir, 'books', 'book-a'), { recursive: true })
    await writeFile(
      join(dataDir, 'books', 'book-a', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        book: {
          id: 'book-a',
          title: '音频书',
          chapterCount: 1,
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        chapters: [{ id: 'chapter-1', title: '第一章', content: '正文一' }],
      }),
      'utf8',
    )
    await writeFile(join(bookAudioDir, 'chapter-1.mp3'), 'fake mp3 data')
    await writeFile(
      join(bookAudioDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            title: '第一章',
            fileName: 'chapter-1.mp3',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const headers = {
      authorization: 'Bearer dev-token',
      'x-device-id': 'device-a',
    }

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/mobile/books/book-a/audio/chapter-1/stream-token',
      headers,
    })

    expect(tokenResponse.statusCode).toBe(200)
    expect(tokenResponse.json()).toMatchObject({
      schemaVersion: 1,
    })
    expect(tokenResponse.json().streamUrl).toMatch(/^\/mobile\/books\/book-a\/audio\/chapter-1\/stream\.mp3\?token=/)

    const streamUrl = tokenResponse.json().streamUrl as string
    const streamResponse = await app.inject({
      method: 'GET',
      url: streamUrl,
    })
    const rangeResponse = await app.inject({
      method: 'GET',
      url: streamUrl,
      headers: {
        range: 'bytes=5-7',
      },
    })
    const legacyRangeResponse = await app.inject({
      method: 'GET',
      url: streamUrl.replace('/stream.mp3?', '/stream?'),
      headers: {
        range: 'bytes=5-7',
      },
    })
    const unsatisfiableRangeResponse = await app.inject({
      method: 'GET',
      url: streamUrl,
      headers: {
        range: 'bytes=999-1000',
      },
    })

    expect(streamResponse.statusCode).toBe(200)
    expect(streamResponse.headers['accept-ranges']).toBe('bytes')
    expect(streamResponse.body).toBe('fake mp3 data')
    expect(rangeResponse.statusCode).toBe(206)
    expect(rangeResponse.headers['content-range']).toBe('bytes 5-7/13')
    expect(rangeResponse.body).toBe('mp3')
    expect(legacyRangeResponse.statusCode).toBe(206)
    expect(legacyRangeResponse.body).toBe('mp3')
    expect(unsatisfiableRangeResponse.statusCode).toBe(416)
    expect(unsatisfiableRangeResponse.headers['content-range']).toBe('bytes */13')

    const tamperedResponse = await app.inject({
      method: 'GET',
      url: `${streamUrl}x`,
    })
    const expiredToken = createTestAudioStreamToken('dev-token', {
      bookId: 'book-a',
      chapterId: 'chapter-1',
      deviceId: 'device-a',
      exp: Date.now() - 1000,
    })
    const expiredResponse = await app.inject({
      method: 'GET',
      url: `/mobile/books/book-a/audio/chapter-1/stream?token=${encodeURIComponent(expiredToken)}`,
    })
    const mismatchedToken = createTestAudioStreamToken('dev-token', {
      bookId: 'book-a',
      chapterId: 'chapter-2',
      deviceId: 'device-a',
      exp: Date.now() + 60_000,
    })
    const mismatchedResponse = await app.inject({
      method: 'GET',
      url: `/mobile/books/book-a/audio/chapter-1/stream?token=${encodeURIComponent(mismatchedToken)}`,
    })

    expect(tamperedResponse.statusCode).toBe(401)
    expect(tamperedResponse.json()).toMatchObject({ error: { code: 'audio_stream_token_invalid' } })
    expect(expiredResponse.statusCode).toBe(401)
    expect(expiredResponse.json()).toMatchObject({ error: { code: 'audio_stream_token_expired' } })
    expect(mismatchedResponse.statusCode).toBe(401)
    expect(mismatchedResponse.json()).toMatchObject({ error: { code: 'audio_stream_token_invalid' } })
  })

  it('protects MP3 downloads with mobile auth, device role, and book visibility', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const defaultBookAudioDir = join(audioDir, 'books', 'book-default')
    const trustedBookAudioDir = join(audioDir, 'books', 'book-trusted')
    await mkdir(defaultBookAudioDir, { recursive: true })
    await mkdir(trustedBookAudioDir, { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-default',
            title: '普通音频书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
            visibility: 'default',
          },
          {
            id: 'book-trusted',
            title: '受信音频书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
            visibility: 'trusted',
          },
        ],
      }),
      'utf8',
    )
    for (const bookId of ['book-default', 'book-trusted']) {
      const bookAudioDir = join(audioDir, 'books', bookId)
      await writeFile(join(bookAudioDir, 'chapter-1.mp3'), `${bookId} mp3 data`)
      await writeFile(
        join(bookAudioDir, 'audio.json'),
        JSON.stringify({
          schemaVersion: 1,
          chapters: [
            {
              chapterId: 'chapter-1',
              title: '第一章',
              fileName: 'chapter-1.mp3',
              durationMs: 1200,
            },
          ],
        }),
        'utf8',
      )
    }
    await writeFile(
      join(dataDir, 'devices.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [
          {
            id: 'trusted-device',
            name: '受信设备',
            role: 'trusted',
            pairingCode: '111111',
            firstSeenAt: '2026-06-25T00:00:00.000Z',
            lastSeenAt: '2026-06-25T00:00:00.000Z',
          },
          {
            id: 'disabled-device',
            name: '禁用设备',
            role: 'disabled',
            pairingCode: '222222',
            firstSeenAt: '2026-06-25T00:00:00.000Z',
            lastSeenAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_ADMIN_ACCESS_TOKEN: 'admin-token',
      GATEWAY_MOBILE_ACCESS_TOKEN: 'mobile-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })

    const noTokenResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-default/audio/chapter-1/download',
    })
    const adminTokenResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-default/audio/chapter-1/download',
      headers: {
        authorization: 'Bearer admin-token',
      },
    })
    const defaultDeviceTrustedBookResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-trusted/audio/chapter-1/download',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'default-device',
      },
    })
    const trustedDeviceResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-trusted/audio/chapter-1/download',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'trusted-device',
      },
    })
    const disabledDeviceResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-default/audio/chapter-1/download',
      headers: {
        authorization: 'Bearer mobile-token',
        'x-device-id': 'disabled-device',
      },
    })

    expect(noTokenResponse.statusCode).toBe(401)
    expect(adminTokenResponse.statusCode).toBe(401)
    expect(defaultDeviceTrustedBookResponse.statusCode).toBe(404)
    expect(defaultDeviceTrustedBookResponse.json()).toMatchObject({ error: { code: 'book_not_found' } })
    expect(trustedDeviceResponse.statusCode).toBe(200)
    expect(trustedDeviceResponse.headers['content-type']).toContain('audio/mpeg')
    expect(trustedDeviceResponse.body).toBe('book-trusted mp3 data')
    expect(disabledDeviceResponse.statusCode).toBe(403)
    expect(disabledDeviceResponse.json()).toMatchObject({ error: { code: 'device_disabled' } })
  })

  it('rejects unsafe protected audio catalog paths', async () => {
    const dataDir = await makeDataDir()
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
    await writeFile(
      join(dataDir, 'books.json'),
      JSON.stringify({
        schemaVersion: 1,
        books: [
          {
            id: 'book-a',
            title: '音频书',
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(bookAudioDir, 'audio.json'),
      JSON.stringify({
        schemaVersion: 1,
        chapters: [
          {
            chapterId: 'chapter-1',
            fileName: '../secret.mp3',
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
      GATEWAY_AUDIO_DIR: audioDir,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/audio',
      headers: {
        authorization: 'Bearer dev-token',
      },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().error).toMatchObject({
      code: 'audio_catalog_invalid',
      statusCode: 500,
    })
  })
})

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  })
}
