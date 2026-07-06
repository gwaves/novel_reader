import { describe, expect, it, vi } from 'vitest'
import {
  buildAudioChapterStatusRows,
  buildSubmittedAppLogs,
  appendAppLogToStorage,
  gatewayGenerateRagAnswer,
  gatewayUserFacingError,
  isAudioPlaybackDisabled,
  loadAppLogEntriesFromStorage,
  listCachedAudioChapterIdsFromStorage,
  loadAudioCacheIndexFromStorage,
  loadLatestReadingProgressFromStorage,
  loadReadingProgressFromStorage,
  ragFallbackStatus,
  readCachedAudioChapterFromStorage,
  readCachedAudioFromStorage,
  removeReadingProgressFromStorage,
  resolveCurrentAudio,
  scrollElementStartToViewportCenter,
  searchGatewayRag,
  writeCachedAudioToStorage,
  updateCachedAudioManifestInStorage,
  saveReadingProgressToStorage,
  type AudioChapter,
} from './App'
import { createGatewayError } from './deviceIdentity'

const cachedChapter: AudioChapter = {
  chapterId: 'chapter-46',
  fileName: 'chapter-46.mp3',
  sizeBytes: 1024,
  updatedAt: '2026-06-30T00:00:00.000Z',
}

const gatewaySettings = {
  baseUrl: 'https://gateway.example/',
  token: 'mobile-token',
  deviceId: 'device-1',
  deviceName: 'Pixel 9',
}

describe('reader audio playback availability', () => {
  it('keeps cached MP3 playback enabled while background audio sync is running', () => {
    expect(isAudioPlaybackDisabled(cachedChapter, false)).toBe(false)
  })

  it('disables MP3 playback only when the current chapter is missing or actively loading', () => {
    expect(isAudioPlaybackDisabled(null, false)).toBe(true)
    expect(isAudioPlaybackDisabled(cachedChapter, true)).toBe(true)
  })

  it('uses cached MP3 metadata when the remote audio catalog is not loaded', () => {
    expect(resolveCurrentAudio('chapter-46', [], cachedChapter)).toEqual(cachedChapter)
  })

  it('prefers the cloud catalog entry when both cloud and cached metadata exist', () => {
    const cloudChapter: AudioChapter = {
      chapterId: 'chapter-46',
      fileName: 'chapter-46-new.mp3',
      sizeBytes: 2048,
      updatedAt: '2026-06-30T01:00:00.000Z',
    }

    expect(resolveCurrentAudio('chapter-46', [cloudChapter], cachedChapter)).toEqual(cloudChapter)
  })

  it('matches cloud MP3 chapters by canonical chapter ordinal when local ids use an older form', () => {
    const cloudChapter: AudioChapter = {
      chapterId: 'file-96ea5baedc1b3c681739e403:ch00003',
      fileName: 'ch003-file-96ea5baedc1b3c681739e403-ch00003/chapter.mp3',
    }

    expect(
      resolveCurrentAudio(
        { id: 'chapter-3', index: 3 },
        [cloudChapter],
        null,
        'file-96ea5baedc1b3c681739e403',
      ),
    ).toEqual(cloudChapter)
  })

  it('does not use cached metadata from another chapter', () => {
    expect(resolveCurrentAudio('chapter-47', [], cachedChapter)).toBeNull()
  })

  it('builds visible MP3 cache status for every chapter', () => {
    const rows = buildAudioChapterStatusRows(
      [
        { id: 'chapter-44', title: '第四十四章' },
        { id: 'chapter-45', title: '第四十五章' },
        { id: 'chapter-46', title: '第四十六章' },
        { id: 'chapter-47', title: '第四十七章' },
      ],
      [
        { chapterId: 'chapter-44', fileName: 'chapter-44.mp3' },
        { chapterId: 'chapter-45', fileName: 'chapter-45.mp3' },
        { chapterId: 'chapter-46', fileName: 'chapter-46.mp3' },
      ],
      new Set(['chapter-44', 'chapter-46']),
      'chapter-46',
    )

    expect(rows).toEqual([
      expect.objectContaining({ chapterId: 'chapter-44', cached: true, hasAudio: true, isCurrent: false, audioChapter: expect.objectContaining({ chapterId: 'chapter-44' }) }),
      expect.objectContaining({ chapterId: 'chapter-45', cached: false, hasAudio: true, isCurrent: false, audioChapter: expect.objectContaining({ chapterId: 'chapter-45' }) }),
      expect.objectContaining({ chapterId: 'chapter-46', cached: true, hasAudio: true, isCurrent: true, audioChapter: expect.objectContaining({ chapterId: 'chapter-46' }) }),
      expect.objectContaining({ chapterId: 'chapter-47', cached: false, hasAudio: false, isCurrent: false, audioChapter: null }),
    ])
  })

  it('builds visible MP3 status when package and audio chapter ids differ only by canonical form', () => {
    const rows = buildAudioChapterStatusRows(
      [
        { id: 'chapter-1', title: '第一回', index: 1 },
        { id: 'chapter-3', title: '第三回', index: 3 },
      ],
      [
        {
          chapterId: 'file-96ea5baedc1b3c681739e403:ch00003',
          fileName: 'ch003-file-96ea5baedc1b3c681739e403-ch00003/chapter.mp3',
        },
      ],
      new Set(),
      'chapter-3',
      'file-96ea5baedc1b3c681739e403',
    )

    expect(rows).toEqual([
      expect.objectContaining({ chapterId: 'chapter-1', hasAudio: false, audioChapter: null }),
      expect.objectContaining({
        chapterId: 'chapter-3',
        hasAudio: true,
        isCurrent: true,
        audioChapter: expect.objectContaining({ chapterId: 'file-96ea5baedc1b3c681739e403:ch00003' }),
      }),
    ])
  })
})

describe('local diagnostics log', () => {
  it('keeps local log entries and redacts sensitive context', () => {
    const storage = createMemoryStorage()

    const entry = appendAppLogToStorage(storage, 'error', 'MP3 播放失败', {
      action: 'chapterAudioError',
      token: 'stream-secret',
      nested: {
        authorization: 'Bearer secret',
      },
    })

    const entries = loadAppLogEntriesFromStorage(storage)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(expect.objectContaining({ id: entry.id, level: 'error', message: 'MP3 播放失败' }))
    expect(entries[0].context).toEqual(
      expect.objectContaining({
        token: '[redacted]',
        nested: expect.objectContaining({ authorization: '[redacted]' }),
      }),
    )
  })

  it('keeps only the latest local diagnostics entries', () => {
    const storage = createMemoryStorage()

    for (let index = 0; index < 205; index += 1) {
      appendAppLogToStorage(storage, 'info', `log-${index}`)
    }

    const entries = loadAppLogEntriesFromStorage(storage)
    expect(entries).toHaveLength(200)
    expect(entries[0].message).toBe('log-5')
    expect(entries.at(-1)?.message).toBe('log-204')
  })

  it('includes the current visible issue when localStorage could not persist it', () => {
    const storage = createMemoryStorage()
    const stored = appendAppLogToStorage(storage, 'info', 'MP3 catalog loaded')
    const latestIssue = {
      id: 'visible-quota-error',
      timestamp: '2026-07-06T09:46:00.000Z',
      level: 'error' as const,
      message: "完整包同步失败：Failed to execute 'setItem' on 'Storage': quota exceeded",
      source: 'app',
    }

    expect(buildSubmittedAppLogs(loadAppLogEntriesFromStorage(storage), latestIssue)).toEqual([stored, latestIssue])
  })
})

describe('audio cache storage', () => {
  it('keeps cached MP3 metadata separated by book id even when chapter ids match', () => {
    const storage = createMemoryStorage()

    writeCachedAudioToStorage(
      storage,
      'book-a',
      { chapterId: 'chapter-1', fileName: 'book-a-chapter-1.mp3', sizeBytes: 1024 },
      { kind: 'file', filePath: '/audio/book-a/chapter-1.mp3', sizeBytes: 1024 },
    )
    writeCachedAudioToStorage(
      storage,
      'book-b',
      { chapterId: 'chapter-1', fileName: 'book-b-chapter-1.mp3', sizeBytes: 2048 },
      { kind: 'file', filePath: '/audio/book-b/chapter-1.mp3', sizeBytes: 2048 },
    )

    expect(readCachedAudioFromStorage(storage, 'book-a', 'chapter-1')).toEqual(
      expect.objectContaining({ filePath: '/audio/book-a/chapter-1.mp3', sizeBytes: 1024 }),
    )
    expect(readCachedAudioFromStorage(storage, 'book-b', 'chapter-1')).toEqual(
      expect.objectContaining({ filePath: '/audio/book-b/chapter-1.mp3', sizeBytes: 2048 }),
    )
    expect(readCachedAudioChapterFromStorage(storage, 'book-a', 'chapter-1')).toEqual(
      expect.objectContaining({ fileName: 'book-a-chapter-1.mp3' }),
    )
    expect(readCachedAudioChapterFromStorage(storage, 'book-b', 'chapter-1')).toEqual(
      expect.objectContaining({ fileName: 'book-b-chapter-1.mp3' }),
    )
    expect(listCachedAudioChapterIdsFromStorage(storage, 'book-a')).toEqual(['chapter-1'])
    expect(listCachedAudioChapterIdsFromStorage(storage, 'book-b')).toEqual(['chapter-1'])
  })

  it('keeps cached MP3 timeline manifests for offline position playback', () => {
    const storage = createMemoryStorage()

    writeCachedAudioToStorage(
      storage,
      'book-a',
      { chapterId: 'chapter-1', fileName: 'book-a-chapter-1.mp3', sizeBytes: 1024 },
      {
        kind: 'file',
        filePath: '/audio/book-a/chapter-1.mp3',
        manifestFilePath: '/audio/book-a/chapter-1.manifest.json',
        manifest: {
          timeline: [
            { startTime: 12, endTime: 18, sourceStart: 100, sourceEnd: 160 },
          ],
        },
        sizeBytes: 1024,
      },
    )

    expect(readCachedAudioFromStorage(storage, 'book-a', 'chapter-1')).toEqual(
      expect.objectContaining({
        filePath: '/audio/book-a/chapter-1.mp3',
        manifestFilePath: '/audio/book-a/chapter-1.manifest.json',
        manifest: expect.objectContaining({
          timeline: [expect.objectContaining({ startTime: 12, sourceStart: 100 })],
        }),
      }),
    )
  })

  it('backfills cached MP3 timeline manifests without replacing the audio file', () => {
    const storage = createMemoryStorage()
    writeCachedAudioToStorage(
      storage,
      'book-a',
      { chapterId: 'chapter-1', fileName: 'book-a-chapter-1.mp3', sizeBytes: 1024 },
      { kind: 'file', filePath: '/audio/book-a/chapter-1.mp3', sizeBytes: 1024 },
    )

    updateCachedAudioManifestInStorage(storage, 'book-a', 'chapter-1', {
      manifestFilePath: '/audio/book-a/chapter-1.manifest.json',
      manifest: {
        timeline: [
          { startTime: 30, endTime: 45, sourceStart: 200, sourceEnd: 260 },
        ],
      },
    })

    expect(readCachedAudioFromStorage(storage, 'book-a', 'chapter-1')).toEqual(
      expect.objectContaining({
        filePath: '/audio/book-a/chapter-1.mp3',
        manifestFilePath: '/audio/book-a/chapter-1.manifest.json',
        manifest: expect.objectContaining({
          timeline: [expect.objectContaining({ startTime: 30, sourceStart: 200 })],
        }),
      }),
    )
  })

  it('ignores broken cache records instead of leaking them into visible counts', () => {
    const storage = createMemoryStorage({
      'novel-reader-gateway-audio-cache-index': JSON.stringify({
        'book-a:chapter-1': {
          bookId: 'book-a',
          chapterId: 'chapter-1',
          audioChapter: { chapterId: 'chapter-1', fileName: 'chapter-1.mp3' },
          filePath: '/audio/book-a/chapter-1.mp3',
          cachedAt: '2026-06-30T01:00:00.000Z',
        },
        'book-a:chapter-2': {
          bookId: 'book-a',
          chapterId: 'chapter-2',
          audioChapter: { chapterId: 'chapter-2' },
          filePath: '/audio/book-a/chapter-2.mp3',
          cachedAt: '2026-06-30T01:00:00.000Z',
        },
        'book-b:chapter-1': {
          bookId: 'book-b',
          chapterId: 'chapter-1',
          audioChapter: { chapterId: 'chapter-1', fileName: 'chapter-1.mp3' },
          filePath: '',
          cachedAt: '2026-06-30T01:00:00.000Z',
        },
      }),
    })

    expect(Object.keys(loadAudioCacheIndexFromStorage(storage))).toEqual(['book-a:chapter-1'])
    expect(listCachedAudioChapterIdsFromStorage(storage, 'book-a')).toEqual(['chapter-1'])
    expect(listCachedAudioChapterIdsFromStorage(storage, 'book-b')).toEqual([])
  })
})

describe('audio highlight auto-follow', () => {
  it('scrolls the highlight start to the viewport center', () => {
    const { scrollTo, viewport } = mockViewportScroll({ innerHeight: 600, scrollY: 300 })
    const target = createMeasuredElement({ top: 700 })

    scrollElementStartToViewportCenter(target, 'smooth', viewport)

    expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'smooth' })
  })

  it('clamps the centered scroll target at the page top', () => {
    const { scrollTo, viewport } = mockViewportScroll({ innerHeight: 600, scrollY: 0 })
    const target = createMeasuredElement({ top: 100 })

    scrollElementStartToViewportCenter(target, 'smooth', viewport)

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('centers the highlight start in the readable area above fixed bottom controls', () => {
    const { scrollTo, viewport } = mockViewportScroll({ innerHeight: 800, scrollY: 1000 })
    const target = createMeasuredElement({ top: 650 })

    scrollElementStartToViewportCenter(target, 'smooth', viewport, { top: 0, bottom: 700 })

    expect(scrollTo).toHaveBeenCalledWith({ top: 1300, behavior: 'smooth' })
  })
})

describe('RAG search fallback messaging', () => {
  it('calls Gateway semantic search and normalizes valid chunk results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              chapterId: 'chapter-2',
              chapterIndex: 2,
              chapterTitle: '第二章',
              snippet: '林青在雨夜醒来。',
              source: 'summary',
              score: 0.91,
            },
            {
              chapterIndex: 3,
              chapterTitle: '第三章',
              snippet: '缺少 chapterId 的结果会被过滤。',
              score: 0.77,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const results = await searchGatewayRag(gatewaySettings, 'book-a', '林青')
    const [, init] = fetchMock.mock.calls[0]

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/ai/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mobile-token',
          'X-Device-Id': 'device-1',
          'X-Device-Name': 'Pixel 9',
          'Content-Type': 'application/json',
        }),
      }),
    )
    expect(JSON.parse(String(init?.body))).toEqual({ bookId: 'book-a', query: '林青', limit: 20 })
    expect(results).toEqual([
      {
        chapterId: 'chapter-2',
        chapterIndex: 2,
        chapterTitle: '第二章',
        snippet: '林青在雨夜醒来。',
        source: 'summary',
        score: 0.91,
      },
    ])

    fetchMock.mockRestore()
  })

  it('calls Gateway RAG answer generation and filters invalid citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: '林青正在调查雨夜线索。',
          results: [
            {
              chapterId: 'chapter-5',
              chapterIndex: 5,
              chapterTitle: '第五章',
              snippet: '线索指向旧码头。',
              source: 'chapter',
              score: 0.86,
            },
            {
              chapterId: '',
              chapterIndex: 6,
              chapterTitle: '第六章',
              snippet: '空 chapterId 会被过滤。',
              score: 0.65,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const response = await gatewayGenerateRagAnswer(gatewaySettings, 'book-a', '林青在调查什么')
    const [, init] = fetchMock.mock.calls[0]

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/ai/rag-answer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mobile-token',
          'X-Device-Id': 'device-1',
          'X-Device-Name': 'Pixel 9',
          'Content-Type': 'application/json',
        }),
      }),
    )
    expect(JSON.parse(String(init?.body))).toEqual({ bookId: 'book-a', query: '林青在调查什么', limit: 10 })
    expect(response).toEqual({
      answer: '林青正在调查雨夜线索。',
      results: [
        {
          chapterId: 'chapter-5',
          chapterIndex: 5,
          chapterTitle: '第五章',
          snippet: '线索指向旧码头。',
          source: 'chapter',
          score: 0.86,
        },
      ],
    })

    fetchMock.mockRestore()
  })

  it('uses a friendly token message when Gateway embedding fails and local search is used', () => {
    const error = createGatewayError({
      error: {
        message: 'Bearer token is invalid.',
        statusCode: 401,
      },
    })

    expect(gatewayUserFacingError(error)).toBe('Gateway Token 无效，请在设置页检查 Token 后重试。')
    expect(ragFallbackStatus(error, 2)).toBe(
      'Gateway embedding 检索失败：Gateway Token 无效，请在设置页检查 Token 后重试；已自动改用本地关键词检索，召回 2 个相关章节。',
    )
  })
})

describe('reading progress storage', () => {
  it('loads legacy single-book progress by book id', () => {
    const storage = createMemoryStorage({
      'novel-reader-gateway-reading-progress': JSON.stringify({
        bookId: 'book-a',
        chapterId: 'chapter-2',
        scrollY: 42,
        updatedAt: '2026-06-30T01:00:00.000Z',
      }),
    })

    expect(loadReadingProgressFromStorage(storage, 'book-a')).toEqual(
      expect.objectContaining({ bookId: 'book-a', chapterId: 'chapter-2', scrollY: 42 }),
    )
    expect(loadReadingProgressFromStorage(storage, 'book-b')).toBeNull()
  })

  it('keeps separate progress for multiple books', () => {
    const storage = createMemoryStorage()

    saveReadingProgressToStorage(storage, {
      bookId: 'book-a',
      chapterId: 'chapter-8',
      scrollY: 120,
      updatedAt: '2026-06-30T01:00:00.000Z',
    })
    saveReadingProgressToStorage(storage, {
      bookId: 'book-b',
      chapterId: 'chapter-3',
      scrollY: 12,
      updatedAt: '2026-06-30T02:00:00.000Z',
    })

    expect(loadReadingProgressFromStorage(storage, 'book-a')).toEqual(
      expect.objectContaining({ bookId: 'book-a', chapterId: 'chapter-8', scrollY: 120 }),
    )
    expect(loadReadingProgressFromStorage(storage, 'book-b')).toEqual(
      expect.objectContaining({ bookId: 'book-b', chapterId: 'chapter-3', scrollY: 12 }),
    )
    expect(loadLatestReadingProgressFromStorage(storage)).toEqual(expect.objectContaining({ bookId: 'book-b' }))
  })

  it('removes only the deleted book progress', () => {
    const storage = createMemoryStorage()

    saveReadingProgressToStorage(storage, {
      bookId: 'book-a',
      chapterId: 'chapter-8',
      scrollY: 120,
      updatedAt: '2026-06-30T01:00:00.000Z',
    })
    saveReadingProgressToStorage(storage, {
      bookId: 'book-b',
      chapterId: 'chapter-3',
      scrollY: 12,
      updatedAt: '2026-06-30T02:00:00.000Z',
    })

    removeReadingProgressFromStorage(storage, 'book-a')

    expect(loadReadingProgressFromStorage(storage, 'book-a')).toBeNull()
    expect(loadReadingProgressFromStorage(storage, 'book-b')).toEqual(expect.objectContaining({ chapterId: 'chapter-3' }))
  })
})

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

function mockViewportScroll({ innerHeight, scrollY }: { innerHeight: number; scrollY: number }) {
  const scrollTo = vi.fn()
  return {
    scrollTo,
    viewport: {
      innerHeight,
      scrollY,
      pageYOffset: scrollY,
      scrollTo,
    },
  }
}

function createMeasuredElement({ top }: { top: number }) {
  return {
    getBoundingClientRect: () => ({
      x: 0,
      y: top,
      top,
      right: 0,
      bottom: top,
      left: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }),
  }
}
