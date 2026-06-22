import type { Chapter } from '../hooks/useReaderState'

type CachedChapter = Chapter & {
  bookId: string
  cachedAt: string
}

const DB_NAME = 'novel-reader-web-cache'
const DB_VERSION = 1
const CHAPTER_STORE = 'chapters'

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHAPTER_STORE)) {
        db.createObjectStore(CHAPTER_STORE, { keyPath: ['bookId', 'id'] })
      }
    }
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function getCachedChapters(bookId: string, chapterIds: string[]): Promise<Record<string, Chapter>> {
  if (!chapterIds.length) return {}

  const db = await openCacheDb()
  const tx = db.transaction(CHAPTER_STORE, 'readonly')
  const store = tx.objectStore(CHAPTER_STORE)
  const entries = await Promise.all(
    chapterIds.map((chapterId) =>
      requestToPromise<CachedChapter | undefined>(store.get([bookId, chapterId])),
    ),
  )

  return Object.fromEntries(
    entries
      .filter((entry): entry is CachedChapter => Boolean(entry?.content))
      .map((entry) => [
        entry.id,
        {
          id: entry.id,
          index: entry.index,
          title: entry.title,
          content: entry.content,
          wordCount: entry.wordCount,
        },
      ]),
  )
}

export async function saveCachedChapters(bookId: string, chapters: Chapter[]): Promise<void> {
  const chaptersWithContent = chapters.filter((chapter) => chapter.content)
  if (!chaptersWithContent.length) return

  const db = await openCacheDb()
  const tx = db.transaction(CHAPTER_STORE, 'readwrite')
  const store = tx.objectStore(CHAPTER_STORE)
  const cachedAt = new Date().toISOString()

  await Promise.all(
    chaptersWithContent.map((chapter) =>
      requestToPromise(
        store.put({
          ...chapter,
          bookId,
          cachedAt,
        } satisfies CachedChapter),
      ),
    ),
  )
}
