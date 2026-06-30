import { describe, expect, it } from 'vitest'
import {
  buildAudioChapterStatusRows,
  gatewayUserFacingError,
  loadLatestReadingProgressFromStorage,
  loadReadingProgressFromStorage,
  ragFallbackStatus,
  removeReadingProgressFromStorage,
  resolveCurrentAudio,
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

describe('reader audio playback availability', () => {
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
})

describe('RAG search fallback messaging', () => {
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
