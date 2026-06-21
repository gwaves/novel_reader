import type { MobileApiSettings, MobileBookPackage } from './mobileApi'

export type LocalBook = {
  id: string
  title: string
  chapterCount: number
  wordCount: number
  summaryCount: number
  entityCount: number
  relationCount: number
  chunkEmbeddingCount: number
  packageVersion: string
  syncedAt: string
}

const DB_NAME = 'novel-reader-mobile'
const DB_VERSION = 1
const SETTINGS_KEY = 'settings'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings')
      }
      if (!db.objectStoreNames.contains('packages')) {
        db.createObjectStore('packages', { keyPath: 'book.id' })
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

export async function loadSettings(): Promise<MobileApiSettings> {
  const db = await openDb()
  const tx = db.transaction('settings', 'readonly')
  const settings = await requestToPromise<MobileApiSettings | undefined>(tx.objectStore('settings').get(SETTINGS_KEY))
  return settings ?? { baseUrl: 'http://localhost:5174', syncToken: '' }
}

export async function saveSettings(settings: MobileApiSettings): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('settings', 'readwrite')
  await requestToPromise(tx.objectStore('settings').put(settings, SETTINGS_KEY))
}

export async function saveBookPackage(pkg: MobileBookPackage): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('packages', 'readwrite')
  await requestToPromise(tx.objectStore('packages').put(pkg))
}

export async function listLocalBooks(): Promise<LocalBook[]> {
  const db = await openDb()
  const tx = db.transaction('packages', 'readonly')
  const packages = await requestToPromise<MobileBookPackage[]>(tx.objectStore('packages').getAll())
  return packages
    .map((pkg) => ({
      id: pkg.book.id,
      title: pkg.book.title,
      chapterCount: pkg.book.chapterCount,
      wordCount: pkg.book.wordCount,
      summaryCount: pkg.summaries.length,
      entityCount: pkg.knowledgeGraph.entities.length,
      relationCount: pkg.knowledgeGraph.relations.length,
      chunkEmbeddingCount: pkg.embeddings.chunks.length,
      packageVersion: pkg.packageVersion,
      syncedAt: pkg.generatedAt,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

export async function getBookPackage(bookId: string): Promise<MobileBookPackage | null> {
  const db = await openDb()
  const tx = db.transaction('packages', 'readonly')
  const pkg = await requestToPromise<MobileBookPackage | undefined>(tx.objectStore('packages').get(bookId))
  return pkg ?? null
}
