import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
          name: 'Android Phone',
        },
      ],
    })
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
          audioChapterCount: 3,
        },
        {
          id: 'book-old',
          title: '旧书',
          author: '作者乙',
          chapterCount: 8,
        },
      ],
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
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
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
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
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
            durationMs: 1200,
          },
        ],
      }),
      'utf8',
    )
    const app = buildTestApp({
      GATEWAY_DEV_ACCESS_TOKEN: 'dev-token',
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

    expect(catalogResponse.statusCode).toBe(200)
    expect(catalogResponse.json()).toMatchObject({
      chapters: [
        {
          chapterId: 'chapter-1',
          title: '第一章',
          fileName: 'chapter-1.mp3',
        },
      ],
    })
    expect(downloadResponse.statusCode).toBe(200)
    expect(downloadResponse.headers['content-type']).toContain('audio/mpeg')
    expect(downloadResponse.body).toBe('fake mp3 data')
  })

  it('rejects unsafe protected audio catalog paths', async () => {
    const audioDir = await makeDataDir()
    const bookAudioDir = join(audioDir, 'books', 'book-a')
    await mkdir(bookAudioDir, { recursive: true })
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
