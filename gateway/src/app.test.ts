import { afterEach, describe, expect, it, vi } from 'vitest'
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
        books: {
          available: true,
        },
        aiSearch: {
          available: false,
        },
        embeddings: {
          available: false,
        },
        audio: {
          available: true,
          mode: 'local-directory',
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
    expect(response.json()).toMatchObject({
      features: {
        embeddings: {
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
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
      GATEWAY_DATA_DIR: dataDir,
    })
    const authHeaders = { authorization: 'Bearer dev-token' }

    const downloadResponse = await app.inject({
      method: 'GET',
      url: '/mobile/books/book-a/package/download',
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
        audioLast24Hours: 0,
        topBooks: [
          {
            bookId: 'book-a',
            title: '指标书',
            packageDownloads: 1,
          },
        ],
      },
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
      ]),
    )
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
            chapterCount: 1,
            updatedAt: '2026-06-25T00:00:00.000Z',
          },
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
