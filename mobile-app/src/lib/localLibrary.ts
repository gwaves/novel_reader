import type { MobileApiSettings, MobileBookPackage } from './mobileApi'

export type ExternalLlmSettings = {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export type EmbeddingServiceSettings = {
  baseUrl: string
  apiKey: string
  model: string
}

export type ReaderBackground = 'paper' | 'warm' | 'green' | 'dark'

export type ReaderSettings = {
  fontSize: number
  background: ReaderBackground
}

export type MobileAppSettings = MobileApiSettings & {
  externalLlm: ExternalLlmSettings
  embeddingService: EmbeddingServiceSettings
  reader: ReaderSettings
}

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

export type ReadingProgress = {
  bookId: string
  chapterId: string
  scrollY: number
  updatedAt: string
}

const DB_NAME = 'novel-reader-mobile'
const DB_VERSION = 2
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS: MobileAppSettings = {
  baseUrl: 'http://localhost:5174',
  syncToken: '',
  externalLlm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
  },
  embeddingService: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  reader: {
    fontSize: 19,
    background: 'paper',
  },
}

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
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'bookId' })
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

function sanitizeSettings(settings: Partial<MobileAppSettings> | undefined): MobileAppSettings {
  return {
    baseUrl: typeof settings?.baseUrl === 'string' ? settings.baseUrl : DEFAULT_SETTINGS.baseUrl,
    syncToken: typeof settings?.syncToken === 'string' ? settings.syncToken : DEFAULT_SETTINGS.syncToken,
    externalLlm: {
      baseUrl:
        typeof settings?.externalLlm?.baseUrl === 'string'
          ? settings.externalLlm.baseUrl
          : DEFAULT_SETTINGS.externalLlm.baseUrl,
      apiKey:
        typeof settings?.externalLlm?.apiKey === 'string'
          ? settings.externalLlm.apiKey
          : DEFAULT_SETTINGS.externalLlm.apiKey,
      model:
        typeof settings?.externalLlm?.model === 'string'
          ? settings.externalLlm.model
          : DEFAULT_SETTINGS.externalLlm.model,
      temperature:
        typeof settings?.externalLlm?.temperature === 'number' && Number.isFinite(settings.externalLlm.temperature)
          ? Math.max(0, Math.min(2, settings.externalLlm.temperature))
          : DEFAULT_SETTINGS.externalLlm.temperature,
    },
    embeddingService: {
      baseUrl:
        typeof settings?.embeddingService?.baseUrl === 'string'
          ? settings.embeddingService.baseUrl
          : DEFAULT_SETTINGS.embeddingService.baseUrl,
      apiKey:
        typeof settings?.embeddingService?.apiKey === 'string'
          ? settings.embeddingService.apiKey
          : DEFAULT_SETTINGS.embeddingService.apiKey,
      model:
        typeof settings?.embeddingService?.model === 'string'
          ? settings.embeddingService.model
          : DEFAULT_SETTINGS.embeddingService.model,
    },
    reader: {
      fontSize:
        typeof settings?.reader?.fontSize === 'number' && Number.isFinite(settings.reader.fontSize)
          ? Math.max(15, Math.min(28, settings.reader.fontSize))
          : DEFAULT_SETTINGS.reader.fontSize,
      background:
        settings?.reader?.background === 'warm' ||
        settings?.reader?.background === 'green' ||
        settings?.reader?.background === 'dark'
          ? settings.reader.background
          : DEFAULT_SETTINGS.reader.background,
    },
  }
}

export async function loadSettings(): Promise<MobileAppSettings> {
  const db = await openDb()
  const tx = db.transaction('settings', 'readonly')
  const settings = await requestToPromise<Partial<MobileAppSettings> | undefined>(tx.objectStore('settings').get(SETTINGS_KEY))
  return sanitizeSettings(settings)
}

export async function saveSettings(settings: MobileAppSettings): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('settings', 'readwrite')
  await requestToPromise(tx.objectStore('settings').put(sanitizeSettings(settings), SETTINGS_KEY))
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

export async function getReadingProgress(bookId: string): Promise<ReadingProgress | null> {
  const db = await openDb()
  const tx = db.transaction('progress', 'readonly')
  const progress = await requestToPromise<ReadingProgress | undefined>(tx.objectStore('progress').get(bookId))
  return progress ?? null
}

export async function saveReadingProgress(progress: Omit<ReadingProgress, 'updatedAt'>): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('progress', 'readwrite')
  await requestToPromise(
    tx.objectStore('progress').put({
      ...progress,
      scrollY: Math.max(0, Math.round(progress.scrollY)),
      updatedAt: new Date().toISOString(),
    }),
  )
}
