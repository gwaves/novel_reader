import type { MobileApiSettings, MobileBookPackage, MobileChapterAudioTimelineEntry } from './mobileApi'

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

export type TtsSettings = {
  engine: 'local-tts' | 'cloud-mp3'
  locale: string
  voiceId: string
  rate: number
  pitch: number
  autoFollow: boolean
  resumeFromProgress: boolean
}

export type MobileAppSettings = MobileApiSettings & {
  externalLlm: ExternalLlmSettings
  embeddingService: EmbeddingServiceSettings
  reader: ReaderSettings
  tts: TtsSettings
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

export type SpeechProgress = {
  bookId: string
  chapterId: string
  segmentId: string
  segmentIndex: number
  voiceId: string | null
  rate: number
  pitch: number
  updatedAt: string
}

export type ChapterAudioCache = {
  id: string
  audioId: string
  bookId: string
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  filename: string
  bytes: number
  duration: number | null
  updatedAt: string
  timeline: MobileChapterAudioTimelineEntry[]
  timelineVersion: number
  cachedAt: string
  blob: Blob
}

const DB_NAME = 'novel-reader-mobile'
const DB_VERSION = 4
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
  tts: {
    engine: 'local-tts',
    locale: 'zh-CN',
    voiceId: '',
    rate: 1,
    pitch: 1,
    autoFollow: true,
    resumeFromProgress: true,
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
      if (!db.objectStoreNames.contains('speechProgress')) {
        db.createObjectStore('speechProgress', { keyPath: 'bookId' })
      }
      if (!db.objectStoreNames.contains('chapterAudio')) {
        db.createObjectStore('chapterAudio', { keyPath: 'id' })
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
    tts: {
      engine:
        settings?.tts?.engine === 'cloud-mp3' || settings?.tts?.engine === 'local-tts'
          ? settings.tts.engine
          : DEFAULT_SETTINGS.tts.engine,
      locale:
        typeof settings?.tts?.locale === 'string' && settings.tts.locale.trim()
          ? settings.tts.locale.trim()
          : DEFAULT_SETTINGS.tts.locale,
      voiceId:
        typeof settings?.tts?.voiceId === 'string'
          ? settings.tts.voiceId
          : DEFAULT_SETTINGS.tts.voiceId,
      rate:
        typeof settings?.tts?.rate === 'number' && Number.isFinite(settings.tts.rate)
          ? Math.max(0.5, Math.min(3, settings.tts.rate))
          : DEFAULT_SETTINGS.tts.rate,
      pitch:
        typeof settings?.tts?.pitch === 'number' && Number.isFinite(settings.tts.pitch)
          ? Math.max(0.5, Math.min(2, settings.tts.pitch))
          : DEFAULT_SETTINGS.tts.pitch,
      autoFollow:
        typeof settings?.tts?.autoFollow === 'boolean'
          ? settings.tts.autoFollow
          : DEFAULT_SETTINGS.tts.autoFollow,
      resumeFromProgress:
        typeof settings?.tts?.resumeFromProgress === 'boolean'
          ? settings.tts.resumeFromProgress
          : DEFAULT_SETTINGS.tts.resumeFromProgress,
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

export async function saveBookEmbeddings(embeddingPackage: MobileBookPackage): Promise<MobileBookPackage> {
  const db = await openDb()
  const tx = db.transaction('packages', 'readwrite')
  const store = tx.objectStore('packages')
  const current = await requestToPromise<MobileBookPackage | undefined>(store.get(embeddingPackage.book.id))
  if (!current) {
    throw new Error('请先下载正文包，再补下载 Embedding。')
  }

  const nextPackage: MobileBookPackage = {
    ...current,
    generatedAt: embeddingPackage.generatedAt,
    packageVersion: embeddingPackage.packageVersion,
    embeddings: embeddingPackage.embeddings,
    integrity: embeddingPackage.integrity,
  }
  await requestToPromise(store.put(nextPackage))
  return nextPackage
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

export async function getLatestReadingProgress(): Promise<ReadingProgress | null> {
  const db = await openDb()
  const tx = db.transaction('progress', 'readonly')
  const progresses = await requestToPromise<ReadingProgress[]>(tx.objectStore('progress').getAll())
  return progresses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
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

export async function getSpeechProgress(bookId: string): Promise<SpeechProgress | null> {
  const db = await openDb()
  const tx = db.transaction('speechProgress', 'readonly')
  const progress = await requestToPromise<SpeechProgress | undefined>(tx.objectStore('speechProgress').get(bookId))
  return progress ?? null
}

export async function saveSpeechProgress(progress: Omit<SpeechProgress, 'updatedAt'>): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('speechProgress', 'readwrite')
  await requestToPromise(
    tx.objectStore('speechProgress').put({
      ...progress,
      segmentIndex: Math.max(0, Math.round(progress.segmentIndex)),
      updatedAt: new Date().toISOString(),
    }),
  )
}

export async function getChapterAudioCache(bookId: string, chapterId: string): Promise<ChapterAudioCache | null> {
  const db = await openDb()
  const tx = db.transaction('chapterAudio', 'readonly')
  const cached = await requestToPromise<ChapterAudioCache | undefined>(tx.objectStore('chapterAudio').get(`${bookId}:${chapterId}`))
  return cached ?? null
}

export async function listChapterAudioCache(bookId: string): Promise<ChapterAudioCache[]> {
  const db = await openDb()
  const tx = db.transaction('chapterAudio', 'readonly')
  const cached = await requestToPromise<ChapterAudioCache[]>(tx.objectStore('chapterAudio').getAll())
  return cached
    .filter((item) => item.bookId === bookId)
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
}

export async function saveChapterAudioCache(audio: Omit<ChapterAudioCache, 'id' | 'cachedAt'>): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('chapterAudio', 'readwrite')
  await requestToPromise(
    tx.objectStore('chapterAudio').put({
      ...audio,
      id: `${audio.bookId}:${audio.chapterId}`,
      cachedAt: new Date().toISOString(),
    }),
  )
}
