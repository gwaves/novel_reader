import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { createSpeechChapter, type SpeechSegment } from './speechSegments'
import { NovelReaderTts, type TtsVoice } from './ttsPlugin'

type GatewaySettings = {
  baseUrl: string
  token: string
  deviceName: string
}

type BookSummary = {
  id: string
  title: string
  author?: string
  chapterCount: number
  wordCount?: number
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  audioChapterCount?: number
  updatedAt: string
}

type BookPackage = {
  schemaVersion: 1
  book: BookSummary
  chapters?: Chapter[]
  summaries?: unknown
  knowledgeGraph?: unknown
  embeddings?: unknown
}

type Chapter = {
  id: string
  title: string
  content?: string
  text?: string
  index?: number
  chapterIndex?: number
}

type AudioChapter = {
  chapterId: string
  title?: string
  fileName: string
  manifestFileName?: string
  timelineVersion?: number
  durationMs?: number
  sizeBytes?: number
  updatedAt?: string
}

type AudioManifest = {
  version?: number
  timelineVersion?: number
  duration?: number
  timeline?: AudioTimelineEntry[]
}

type CachedAudio = {
  blob?: Blob
  filePath?: string
  manifest: AudioManifest | null
  sizeBytes?: number
}

type CachedAudioRecord = {
  bookId: string
  chapterId: string
  audioChapter: AudioChapter
  filePath: string
  sizeBytes?: number
  cachedAt: string
  updatedAt?: string
}

type AudioCachePayload =
  | {
      kind: 'blob'
      blob: Blob
    }
  | {
      kind: 'file'
      filePath: string
      sizeBytes?: number
    }

type NativeAudioPlugin = {
  downloadAudio(options: {
    url: string
    token: string
    deviceName: string
    bookId: string
    chapterId: string
  }): Promise<{ filePath: string; sizeBytes: number }>
  downloadPackage(options: {
    url: string
    token: string
    deviceName: string
    bookId: string
  }): Promise<{ filePath: string; sizeBytes: number }>
  importPackage(options: {
    bookId: string
    filePath: string
    expectedChapterCount?: number
  }): Promise<FullPackageImportStats & { metadataPath?: string }>
  clearAudioCache(options: { bookId: string }): Promise<{ deletedBytes?: number }>
  clearPackageCache(options: { bookId: string }): Promise<{ deletedBytes?: number }>
  addListener(eventName: 'packageSyncProgress', listenerFunc: (event: PackageSyncProgress) => void): Promise<PluginListenerHandle>
}

type AudioTimelineEntry = {
  id?: string
  text?: string
  sourceStart?: number
  sourceEnd?: number
  startTime?: number
  endTime?: number
  nextStartTime?: number
}

type ChapterAudioTimelineItem = {
  index: number
  startTime: number
  endTime: number
  nextStartTime: number
}

type ConnectionState = 'idle' | 'checking' | 'connected' | 'error'
type GatewayTab = 'library' | 'reader' | 'settings'
type ReaderBackground = 'paper' | 'warm' | 'green' | 'dark'

type ReaderSettings = {
  fontSize: number
  background: ReaderBackground
}

type TtsSettings = {
  engine: 'local-tts' | 'cloud-mp3'
  locale: string
  voiceId: string
  rate: number
  pitch: number
  autoFollow: boolean
}

type SpeechPlaybackState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'playing'; segmentIndex: number; segmentId: string }
  | { status: 'paused'; segmentIndex: number; segmentId: string }
  | { status: 'error'; message: string }

type ReadingProgress = {
  bookId: string
  chapterId: string
  scrollY: number
  updatedAt: string
}

type FullPackageCache = {
  bookId: string
  filePath: string
  sizeBytes: number
  cachedAt: string
  importedAt?: string
  importStats?: FullPackageImportStats
  metadataPath?: string
}

type FullPackageImportStats = {
  chapterCount?: number
  summaryCount?: number
  knowledgeGraph?: {
    entityCount?: number
    entityMentionCount?: number
    relationCount?: number
    relationMentionCount?: number
  }
  embeddings?: {
    summaryCount?: number
    chunkCount?: number
  }
}

type PackageSyncProgress = {
  bookId?: string
  phase?: 'download' | 'import'
  status?: string
  done?: number
  total?: number
}

type FullPackageStatus = 'idle' | 'downloading' | 'downloaded' | 'importing' | 'imported' | 'error'

type BookCacheSummary = {
  bookId: string
  title: string
  packageCache: FullPackageCache | null
  audioCount: number
  audioSizeBytes: number
  totalSizeBytes: number
}

const settingsKey = 'novel-reader-gateway-settings'
const readerSettingsKey = 'novel-reader-gateway-reader-settings'
const ttsSettingsKey = 'novel-reader-gateway-tts-settings'
const readingProgressKey = 'novel-reader-gateway-reading-progress'
const fullPackageCacheKey = 'novel-reader-gateway-full-package-cache'
const fullPackageCacheIndexKey = 'novel-reader-gateway-full-package-cache-index'
const audioCacheIndexKey = 'novel-reader-gateway-audio-cache-index'
const packageCachePrefix = 'novel-reader-gateway-package:'
const packageCacheDbName = 'novel-reader-gateway'
const packageCacheStoreName = 'book-packages'
const legacyAudioCacheStoreName = 'chapter-audio'
const defaultGatewayBaseUrl = import.meta.env.VITE_GATEWAY_DEFAULT_BASE_URL ?? 'https://'
const defaultGatewayToken = import.meta.env.VITE_GATEWAY_DEFAULT_TOKEN ?? '123456'
const NativeAudio = registerPlugin<NativeAudioPlugin>('GatewayAudio')
const TTS_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2, 3] as const
const MIN_TTS_RATE = 0.5
const MAX_TTS_RATE = 3
const MIN_TTS_PITCH = 0.5
const MAX_TTS_PITCH = 2
const TTS_PREFETCH_WINDOW = 8

const defaultSettings: GatewaySettings = {
  baseUrl: defaultGatewayBaseUrl,
  token: defaultGatewayToken,
  deviceName: 'Android Phone',
}

const defaultReaderSettings: ReaderSettings = {
  fontSize: 18,
  background: 'paper',
}

const defaultTtsSettings: TtsSettings = {
  engine: 'cloud-mp3',
  locale: 'zh-CN',
  voiceId: '',
  rate: 1,
  pitch: 1,
  autoFollow: true,
}

function App() {
  const [tab, setTab] = useState<GatewayTab>('library')
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings())
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => loadReaderSettings())
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>(() => loadTtsSettings())
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [message, setMessage] = useState('')
  const [books, setBooks] = useState<BookSummary[]>([])
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() => loadReadingProgress()?.bookId ?? loadFullPackageCache()?.bookId ?? null)
  const [bookPackage, setBookPackage] = useState<BookPackage | null>(null)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null)
  const [audioChapters, setAudioChapters] = useState<AudioChapter[]>([])
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioManifest, setAudioManifest] = useState<AudioManifest | null>(null)
  const [audioTime, setAudioTime] = useState(0)
  const [chapterAudioPlaying, setChapterAudioPlaying] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [audioCatalogBookId, setAudioCatalogBookId] = useState<string | null>(null)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [loadingPackage, setLoadingPackage] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [cachedAudioIds, setCachedAudioIds] = useState<Set<string>>(() => new Set())
  const [cachedAudioBookId, setCachedAudioBookId] = useState<string | null>(null)
  const [audioSyncProgress, setAudioSyncProgress] = useState<{ done: number; total: number } | null>(null)
  const [audioSyncBookId, setAudioSyncBookId] = useState<string | null>(null)
  const [fullPackageCache, setFullPackageCache] = useState<FullPackageCache | null>(() => loadFullPackageCache())
  const [fullPackageStatus, setFullPackageStatus] = useState<FullPackageStatus>(() => {
    const cache = loadFullPackageCache()
    return cache?.importStats ? 'imported' : cache ? 'downloaded' : 'idle'
  })
  const [fullPackageProgress, setFullPackageProgress] = useState<PackageSyncProgress | null>(null)
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([])
  const [ttsStatusMessage, setTtsStatusMessage] = useState('')
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlaybackState>({ status: 'idle' })
  const [activeSpeechSegmentId, setActiveSpeechSegmentId] = useState<string | null>(null)
  const [speechAutoFollowSuspended, setSpeechAutoFollowSuspended] = useState(false)
  const [cacheVersion, setCacheVersion] = useState(0)
  const [clearingCacheKey, setClearingCacheKey] = useState<string | null>(null)

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const chapters = useMemo(() => packageChapters(bookPackage), [bookPackage])
  const currentChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === currentChapterId) ?? chapters[0] ?? null,
    [chapters, currentChapterId],
  )
  const visibleAudioChapters = useMemo(
    () => (audioCatalogBookId === selectedBookId ? audioChapters : []),
    [audioCatalogBookId, audioChapters, selectedBookId],
  )
  const visibleCachedAudioIds = useMemo(
    () => (cachedAudioBookId === selectedBookId ? cachedAudioIds : new Set<string>()),
    [cachedAudioBookId, cachedAudioIds, selectedBookId],
  )
  const visibleAudioSyncProgress = audioSyncBookId === selectedBookId ? audioSyncProgress : null
  const visibleFullPackageCache = fullPackageCache?.bookId === selectedBookId ? fullPackageCache : null
  const visibleFullPackageProgress = fullPackageProgress?.bookId === selectedBookId ? fullPackageProgress : null
  const displaySummaryCoverage = hasImportedPackage(visibleFullPackageCache) ? 1 : inferredSummaryCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayKgCoverage = inferredKgCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayEmbeddingCoverage = inferredEmbeddingCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayAudioChapterCount =
    visibleAudioChapters.length || visibleCachedAudioIds.size || selectedBook?.audioChapterCount || 0
  const cacheSummaries = useMemo(() => buildBookCacheSummaries(books, cacheVersion), [books, cacheVersion])
  const currentAudio = useMemo(
    () => visibleAudioChapters.find((chapter) => chapter.chapterId === currentChapter?.id) ?? null,
    [currentChapter, visibleAudioChapters],
  )
  const activeTimelineEntry = useMemo(
    () => findActiveTimelineEntry(audioManifest, audioTime),
    [audioManifest, audioTime],
  )
  const currentChapterPosition = useMemo(
    () => (currentChapter ? chapters.findIndex((chapter) => chapter.id === currentChapter.id) : -1),
    [chapters, currentChapter],
  )
  const speechChapter = useMemo(() => {
    if (!currentChapter || !selectedBookId) return null
    return createSpeechChapter({
      id: currentChapter.id,
      bookId: selectedBookId,
      index: currentChapter.index ?? currentChapter.chapterIndex ?? currentChapterPosition + 1,
      content: chapterContent(currentChapter),
    })
  }, [currentChapter, currentChapterPosition, selectedBookId])
  const previousChapter = currentChapterPosition > 0 ? chapters[currentChapterPosition - 1] : null
  const nextChapter =
    currentChapterPosition >= 0 && currentChapterPosition < chapters.length - 1 ? chapters[currentChapterPosition + 1] : null
  const lastReaderCenterTapAtRef = useRef(0)
  const chapterAudioRef = useRef<HTMLAudioElement | null>(null)
  const chapterAudioTimelineRef = useRef<ChapterAudioTimelineItem[]>([])
  const autoConnectAttemptedRef = useRef(false)
  const autoRestoreAttemptedRef = useRef(false)
  const lastReaderScrollYRef = useRef(0)
  const pendingRestoreScrollRef = useRef<number | null>(null)
  const speechPlaybackRef = useRef<SpeechPlaybackState>({ status: 'idle' })
  const speechSegmentsRef = useRef<SpeechSegment[]>([])
  const currentUtteranceIdRef = useRef<string | null>(null)
  const speechUtteranceIndexRef = useRef<Map<string, number>>(new Map())
  const speechQueueIdRef = useRef(0)
  const speechAutoFollowRef = useRef(true)
  const speechFollowSuspendedRef = useRef(false)
  const speechFollowTimerRef = useRef<number | null>(null)
  const isSpeechAutoScrollingRef = useRef(false)
  const playbackEngineTouchedRef = useRef(false)

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(readerSettingsKey, JSON.stringify(readerSettings))
  }, [readerSettings])

  useEffect(() => {
    localStorage.setItem(ttsSettingsKey, JSON.stringify(ttsSettings))
    speechAutoFollowRef.current = ttsSettings.autoFollow
  }, [ttsSettings])

  useEffect(() => {
    speechPlaybackRef.current = speechPlayback
  }, [speechPlayback])

  useEffect(() => {
    speechSegmentsRef.current = speechChapter?.segments ?? []
  }, [speechChapter])

  useEffect(() => {
    if (!currentAudio || playbackEngineTouchedRef.current || ttsSettings.engine === 'cloud-mp3') return
    setTtsSettings((current) => ({ ...current, engine: 'cloud-mp3' }))
    setTtsStatusMessage('')
    if (speechPlaybackRef.current.status !== 'idle') {
      void stopSpeechReading()
    }
  }, [currentAudio, ttsSettings.engine])

  useEffect(() => {
    void clearLegacyAudioIndexedDbCache()
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let listener: PluginListenerHandle | null = null
    void NativeAudio.addListener('packageSyncProgress', (event) => {
      setFullPackageProgress(event)
      if (event.phase === 'download' && event.status === 'downloading') setFullPackageStatus('downloading')
      if (event.phase === 'download' && event.status === 'downloaded') setFullPackageStatus('downloaded')
      if (event.phase === 'import') setFullPackageStatus(event.status === 'imported' ? 'imported' : 'importing')
    }).then((nextListener) => {
      listener = nextListener
    })

    return () => {
      void listener?.remove()
    }
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let cancelled = false
    const handles: PluginListenerHandle[] = []

    async function bindTtsEvents() {
      handles.push(
        await NovelReaderTts.addListener('utteranceStart', (event) => {
          if (cancelled) return
          const segmentIndex = speechUtteranceIndexRef.current.get(event.utteranceId)
          if (segmentIndex == null) return
          const segment = speechSegmentsRef.current[segmentIndex]
          if (!segment) return
          setActiveSpeechSegmentId(segment.id)
          setSpeechPlayback({ status: 'playing', segmentIndex, segmentId: segment.id })
          scrollToSpeechSegment(segment.id)
        }),
      )
      handles.push(
        await NovelReaderTts.addListener('utteranceDone', (event) => {
          if (cancelled) return
          const current = speechPlaybackRef.current
          const segmentIndex = speechUtteranceIndexRef.current.get(event.utteranceId)
          if (segmentIndex != null && current.status === 'playing') {
            const nextSegment = speechSegmentsRef.current[segmentIndex + 1]
            if (nextSegment) {
              setActiveSpeechSegmentId(nextSegment.id)
              setSpeechPlayback({ status: 'playing', segmentIndex: segmentIndex + 1, segmentId: nextSegment.id })
              scrollToSpeechSegment(nextSegment.id)
              return
            }
          }

          if (event.utteranceId !== currentUtteranceIdRef.current) return
          currentUtteranceIdRef.current = null
          speechUtteranceIndexRef.current.clear()
          setActiveSpeechSegmentId(null)
          setSpeechPlayback({ status: 'idle' })
        }),
      )
      handles.push(
        await NovelReaderTts.addListener('utteranceError', (event) => {
          if (cancelled || !speechUtteranceIndexRef.current.has(event.utteranceId)) return
          const message = event.error || '系统 TTS 朗读失败。'
          currentUtteranceIdRef.current = null
          speechUtteranceIndexRef.current.clear()
          setSpeechPlayback({ status: 'error', message })
          setTtsStatusMessage(message)
        }),
      )
    }

    void bindTtsEvents()

    return () => {
      cancelled = true
      for (const handle of handles) {
        void handle.remove()
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (speechFollowTimerRef.current != null) window.clearTimeout(speechFollowTimerRef.current)
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      void NovelReaderTts.stop().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (tab !== 'reader' || !selectedBookId || !currentChapterId) return

    let saveTimer: number | undefined
    const save = () => {
      if (
        speechPlaybackRef.current.status === 'playing' &&
        !isSpeechAutoScrollingRef.current &&
        !speechFollowSuspendedRef.current
      ) {
        speechFollowSuspendedRef.current = true
        setSpeechAutoFollowSuspended(true)
        if (speechFollowTimerRef.current != null) window.clearTimeout(speechFollowTimerRef.current)
        speechFollowTimerRef.current = window.setTimeout(() => {
          speechFollowSuspendedRef.current = false
          setSpeechAutoFollowSuspended(false)
        }, 7000)
      }
      lastReaderScrollYRef.current = Math.max(0, window.scrollY)
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        persistReadingProgress(selectedBookId, currentChapterId, lastReaderScrollYRef.current)
      }, 250)
    }

    window.addEventListener('scroll', save, { passive: true })
    return () => {
      window.removeEventListener('scroll', save)
      window.clearTimeout(saveTimer)
      persistReadingProgress(selectedBookId, currentChapterId, lastReaderScrollYRef.current)
    }
  }, [currentChapterId, selectedBookId, tab])

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  async function refreshBooks() {
    setLoadingBooks(true)
    setMessage('')
    try {
      const response = await gatewayFetch(settings, '/mobile/books')
      const nextBooks = Array.isArray(response.books) ? (response.books as BookSummary[]) : []
      const cachedFullPackage = loadFullPackageCache()
      if (cachedFullPackage && nextBooks.some((book) => book.id === cachedFullPackage.bookId)) {
        setFullPackageCache(cachedFullPackage)
        setFullPackageStatus(cachedFullPackage.importStats ? 'imported' : 'downloaded')
      }
      setBooks(nextBooks)
      const nextSelectedBookId = nextBooks.some((book) => book.id === selectedBookId) ? selectedBookId : nextBooks[0]?.id
      const cachedForSelectedBook = nextSelectedBookId ? loadFullPackageCache(nextSelectedBookId) : null
      setFullPackageCache(cachedForSelectedBook)
      setFullPackageStatus(cachedForSelectedBook?.importStats ? 'imported' : cachedForSelectedBook ? 'downloaded' : 'idle')
      if (nextBooks.length > 0 && !nextBooks.some((book) => book.id === selectedBookId)) {
        setSelectedBookId(nextBooks[0].id)
      }
      if (nextBooks.length === 0) {
        setSelectedBookId(null)
        setBookPackage(null)
        setCurrentChapterId(null)
        setAudioChapters([])
        setAudioCatalogBookId(null)
        setCachedAudioBookId(null)
        clearAudioUrl()
      }
      void refreshCachedAudioIds(nextSelectedBookId ?? null)
      refreshCacheSummaries()
      setConnectionState('connected')
      setMessage(`书库 ${nextBooks.length} 本`)
      if (!autoRestoreAttemptedRef.current) {
        autoRestoreAttemptedRef.current = true
        void restoreLastReading(nextBooks)
      }
    } catch (error) {
      setConnectionState('error')
      setMessage(errorMessage(error))
    } finally {
      setLoadingBooks(false)
    }
  }

  async function checkSession() {
    setConnectionState('checking')
    setMessage('')
    try {
      const session = await gatewayFetch(settings, '/auth/session')
      if (!session.authenticated) {
        throw new Error('Gateway session is not authenticated.')
      }
      setConnectionState('connected')
      setMessage('已连接')
      await refreshBooks()
    } catch (error) {
      setConnectionState('error')
      setMessage(errorMessage(error))
    }
  }

  useEffect(() => {
    if (autoConnectAttemptedRef.current || !isGatewayConfigured(settings)) return
    autoConnectAttemptedRef.current = true
    void checkSession()
  }, [settings])

  async function openBook(bookId: string, options: { restoreProgress?: ReadingProgress | null } = {}) {
    setSelectedBookId(bookId)
    const cachedFullPackage = loadFullPackageCache(bookId)
    setFullPackageCache(cachedFullPackage)
    setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
    setFullPackageProgress(null)
    setLoadingPackage(true)
    setMessage('')
    setAudioChapters([])
    setAudioCatalogBookId(null)
    setCachedAudioBookId(null)
    setCachedAudioIds(new Set())
    setAudioSyncProgress(null)
    setAudioSyncBookId(null)
    clearAudioUrl()
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      const nextPackage = normalizeBookPackage(response.package)
      const nextChapters = packageChapters(nextPackage)
      const restoredChapterId =
        options.restoreProgress?.bookId === bookId && nextChapters.some((chapter) => chapter.id === options.restoreProgress?.chapterId)
          ? options.restoreProgress.chapterId
          : null
      setBookPackage(nextPackage)
      setCurrentChapterId(restoredChapterId ?? nextChapters[0]?.id ?? null)
      const cached = await cacheBookPackage(bookId, nextPackage)
      setMessage(cached ? '数据包已加载' : '数据包已加载，缓存空间不足')
      await refreshAudio(bookId, false)
      await refreshCachedAudioIds(bookId)
      pendingRestoreScrollRef.current = restoredChapterId ? options.restoreProgress?.scrollY ?? 0 : 0
      setTab('reader')
      restorePendingScroll()
      syncFullPackageIfNeeded(bookId)
    } catch (error) {
      const cachedPackage = await loadCachedBookPackage(bookId)
      const cachedChapters = packageChapters(cachedPackage)
      const restoredChapterId =
        options.restoreProgress?.bookId === bookId && cachedChapters.some((chapter) => chapter.id === options.restoreProgress?.chapterId)
          ? options.restoreProgress.chapterId
          : null
      setBookPackage(cachedPackage)
      setCurrentChapterId(restoredChapterId ?? cachedChapters[0]?.id ?? null)
      setMessage(cachedPackage ? `已使用本地缓存：${errorMessage(error)}` : errorMessage(error))
      await refreshCachedAudioIds(bookId)
      if (cachedPackage) {
        pendingRestoreScrollRef.current = restoredChapterId ? options.restoreProgress?.scrollY ?? 0 : 0
        setTab('reader')
        restorePendingScroll()
      }
    } finally {
      setLoadingPackage(false)
    }
  }

  function selectBook(bookId: string) {
    setSelectedBookId(bookId)
    const cachedFullPackage = loadFullPackageCache(bookId)
    setFullPackageCache(cachedFullPackage)
    setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
    setFullPackageProgress(null)
    setMessage('')
    setBookPackage(null)
    setCurrentChapterId(null)
    setAudioChapters([])
    setAudioCatalogBookId(null)
    setCachedAudioBookId(null)
    setCachedAudioIds(new Set())
    setAudioSyncProgress(null)
    setAudioSyncBookId(null)
    clearAudioUrl()
    void refreshCachedAudioIds(bookId)
  }

  async function syncFullPackage(bookId: string) {
    if (!Capacitor.isNativePlatform()) return
    if (fullPackageStatus === 'downloading' || fullPackageStatus === 'importing') return
    setFullPackageStatus('downloading')
    setFullPackageProgress({ bookId, phase: 'download', status: 'downloading', done: 0, total: 0 })
    try {
      const downloaded = await downloadPackageToNativeFile(settings, bookId)
      const downloadedCache: FullPackageCache = {
        bookId,
        filePath: downloaded.filePath,
        sizeBytes: downloaded.sizeBytes,
        cachedAt: new Date().toISOString(),
      }
      saveFullPackageCache(downloadedCache)
      setFullPackageCache(downloadedCache)
      setFullPackageStatus('importing')
      setFullPackageProgress({ bookId, phase: 'import', status: 'parsing', done: 0, total: 4 })
      const importStats = await importPackageToNativeStore(bookId, downloaded.filePath, selectedBook?.chapterCount)
      const importedCache: FullPackageCache = {
        ...downloadedCache,
        importedAt: new Date().toISOString(),
        importStats,
        metadataPath: importStats.metadataPath,
      }
      saveFullPackageCache(importedCache)
      setFullPackageCache(importedCache)
      setFullPackageStatus('imported')
      setFullPackageProgress({ bookId, phase: 'import', status: 'imported', done: 4, total: 4 })
      setMessage('完整数据包已导入')
    } catch (error) {
      setFullPackageStatus('error')
      setMessage(`完整包同步失败：${errorMessage(error)}`)
    }
  }

  function syncFullPackageIfNeeded(bookId: string) {
    if (!Capacitor.isNativePlatform()) return
    const cached = loadFullPackageCache(bookId)
    if (cached?.bookId === bookId && cached.importStats) {
      setFullPackageCache(cached)
      setFullPackageStatus('imported')
      setFullPackageProgress(null)
      return
    }
    void syncFullPackage(bookId)
  }

  async function syncCurrentFullPackage() {
    if (!selectedBookId) return
    await syncFullPackage(selectedBookId)
  }

  async function refreshAudio(bookId = selectedBookId, showMessage = true) {
    if (!bookId) return
    setLoadingAudio(true)
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
      const nextAudioChapters = Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
      setAudioChapters(nextAudioChapters)
      setAudioCatalogBookId(bookId)
      await refreshCachedAudioIds(bookId)
      if (showMessage) setMessage(`音频 ${nextAudioChapters.length} 章`)
    } catch (error) {
      if (showMessage) setMessage(errorMessage(error))
    } finally {
      setLoadingAudio(false)
    }
  }

  async function playCurrentAudio() {
    if (!selectedBookId || !currentChapter) return
    await stopSpeechReading()
    if (!currentAudio) {
      setMessage('当前章节暂无音频')
      return
    }
    setLoadingAudio(true)
    try {
      const cachedAudio = readCachedAudio(selectedBookId, currentChapter.id)
      const manifest =
        cachedAudio?.manifest ??
        (currentAudio?.manifestFileName
          ? await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(selectedBookId)}/audio/${encodeURIComponent(currentChapter.id)}/manifest`)
              .then(normalizeAudioManifest)
              .catch(() => null)
          : null)
      let playbackUrl = cachedAudio?.filePath ? Capacitor.convertFileSrc(cachedAudio.filePath) : ''
      let blob: Blob | undefined = cachedAudio?.blob
      if (!cachedAudio) {
        const cached = await cacheAudioChapter(selectedBookId, currentAudio)
        if (cached.kind === 'file') {
          playbackUrl = Capacitor.convertFileSrc(cached.filePath)
        } else {
          blob = cached.blob
        }
        await refreshCachedAudioIds(selectedBookId)
      }
      if (!playbackUrl && blob) {
        playbackUrl = URL.createObjectURL(blob)
      }
      clearAudioUrl()
      buildChapterAudioTimeline(manifest?.timeline ?? [])
      setAudioManifest(manifest)
      setAudioTime(0)
      setAudioUrl(playbackUrl)
      setMessage('音频已加载')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setLoadingAudio(false)
    }
  }

  async function refreshCachedAudioIds(bookId = selectedBookId) {
    if (!bookId) {
      setCachedAudioIds(new Set())
      setCachedAudioBookId(null)
      return
    }
    const ids = await listCachedAudioChapterIds(bookId)
    setCachedAudioIds(new Set(ids))
    setCachedAudioBookId(bookId)
  }

  async function syncCurrentBookAudio() {
    if (!selectedBookId) return
    const bookId = selectedBookId
    let chaptersToSync = audioCatalogBookId === bookId ? audioChapters : []
    if (chaptersToSync.length === 0) {
      chaptersToSync = await fetchAudioCatalog(bookId)
      setAudioChapters(chaptersToSync)
      setAudioCatalogBookId(bookId)
      await refreshCachedAudioIds(bookId)
    }
    if (chaptersToSync.length === 0) {
      setMessage('当前书籍暂无音频')
      return
    }

    setLoadingAudio(true)
    setAudioSyncBookId(bookId)
    setAudioSyncProgress({ done: 0, total: chaptersToSync.length })
    try {
      let done = 0
      for (const audioChapter of chaptersToSync) {
        const cached = readCachedAudio(bookId, audioChapter.chapterId)
        if (!cached) {
          await cacheAudioChapter(bookId, audioChapter)
        }
        done += 1
        setAudioSyncProgress({ done, total: chaptersToSync.length })
        setCachedAudioIds((current) => new Set(current).add(audioChapter.chapterId))
      }
      await refreshCachedAudioIds(bookId)
      setMessage(`音频已缓存 ${chaptersToSync.length}/${chaptersToSync.length} 章`)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setLoadingAudio(false)
      setAudioSyncProgress(null)
      setAudioSyncBookId(null)
    }
  }

  function refreshCacheSummaries() {
    setCacheVersion((version) => version + 1)
  }

  async function clearBookAudioCache(bookId: string) {
    const key = `${bookId}:audio`
    setClearingCacheKey(key)
    try {
      if (bookId === selectedBookId) clearAudioUrl()
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.clearAudioCache({ bookId })
      }
      const index = loadAudioCacheIndex()
      for (const cacheKey of Object.keys(index)) {
        if (index[cacheKey]?.bookId === bookId) delete index[cacheKey]
      }
      saveAudioCacheIndex(index)
      if (bookId === selectedBookId) {
        setCachedAudioIds(new Set())
        setCachedAudioBookId(bookId)
      }
      refreshCacheSummaries()
      setMessage('音频缓存已清除')
    } catch (error) {
      setMessage(`清除音频缓存失败：${errorMessage(error)}`)
    } finally {
      setClearingCacheKey(null)
    }
  }

  async function clearBookPackageCache(bookId: string) {
    const key = `${bookId}:package`
    setClearingCacheKey(key)
    try {
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.clearPackageCache({ bookId })
      }
      removeFullPackageCache(bookId)
      await deleteBookPackageFromIndexedDb(bookId)
      localStorage.removeItem(`${packageCachePrefix}${bookId}`)
      if (bookId === selectedBookId) {
        setFullPackageCache(null)
        setFullPackageStatus('idle')
        setFullPackageProgress(null)
      }
      refreshCacheSummaries()
      setMessage('完整数据包缓存已清除')
    } catch (error) {
      setMessage(`清除完整包缓存失败：${errorMessage(error)}`)
    } finally {
      setClearingCacheKey(null)
    }
  }

  async function fetchAudioCatalog(bookId: string) {
    const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
    return Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
  }

  async function cacheAudioChapter(bookId: string, audioChapter: AudioChapter): Promise<AudioCachePayload> {
    if (Capacitor.isNativePlatform()) {
      const downloaded = await downloadAudioToNativeFile(settings, bookId, audioChapter.chapterId)
      const payload: AudioCachePayload = {
        kind: 'file',
        filePath: downloaded.filePath,
        sizeBytes: downloaded.sizeBytes,
      }
      writeCachedAudio(bookId, audioChapter, payload)
      return payload
    }

    const blob = await gatewayFetchBlob(
      settings,
      `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(audioChapter.chapterId)}/download`,
    )
    const payload: AudioCachePayload = { kind: 'blob', blob }
    return payload
  }

  function clearAudioUrl() {
    chapterAudioRef.current?.pause()
    chapterAudioTimelineRef.current = []
    setAudioUrl((currentUrl) => {
      if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl)
      return null
    })
    setAudioManifest(null)
    setAudioTime(0)
    setChapterAudioPlaying(false)
    if (speechPlaybackRef.current.status !== 'playing') setActiveSpeechSegmentId(null)
  }

  async function toggleChapterAudioPlayback() {
    const audio = chapterAudioRef.current
    if (!audio) {
      await playCurrentAudio()
      return
    }

    if (audio.paused) {
      await audio.play().catch((error) => setMessage(errorMessage(error)))
    } else {
      audio.pause()
    }
  }

  function getAudioTimeForSegment(segmentIndex: number): number {
    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length) return 0
    const exact = timeline.find((item) => item.index === segmentIndex)
    if (exact) return exact.startTime
    return timeline.find((item) => item.index > segmentIndex)?.startTime ?? timeline.at(-1)?.startTime ?? 0
  }

  async function playCurrentAudioFromVisiblePosition() {
    if (!audioUrl) {
      await playCurrentAudio()
    }
    window.setTimeout(() => {
      const audio = chapterAudioRef.current
      if (!audio) return
      const segmentIndex = findCurrentVisibleSpeechSegmentIndex() ?? 0
      audio.currentTime = Math.min(getAudioTimeForSegment(segmentIndex), Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.05) : Number.MAX_SAFE_INTEGER)
      void audio.play().catch((error) => setMessage(errorMessage(error)))
    }, 80)
  }

  function selectChapter(chapterId: string) {
    void stopSpeechReading()
    setCurrentChapterId(chapterId)
    clearAudioUrl()
    lastReaderScrollYRef.current = 0
    window.scrollTo({ top: 0 })
    if (selectedBookId) {
      persistReadingProgress(selectedBookId, chapterId, 0)
    }
  }

  function switchTab(nextTab: GatewayTab) {
    if (tab === 'reader' && selectedBookId && currentChapterId) {
      const scrollY = Math.max(0, window.scrollY)
      lastReaderScrollYRef.current = scrollY
      persistReadingProgress(selectedBookId, currentChapterId, scrollY)
    }

    if (nextTab === 'reader') {
      prepareReaderScrollRestore()
    }

    setTab(nextTab)
    if (nextTab === 'reader') {
      restorePendingScroll()
    }
  }

  function prepareReaderScrollRestore() {
    if (!selectedBookId) return
    const progress = loadReadingProgress()
    if (!progress || progress.bookId !== selectedBookId) return

    const canRestoreChapter = chapters.some((chapter) => chapter.id === progress.chapterId)
    if (canRestoreChapter) {
      if (progress.chapterId !== currentChapterId) {
        setCurrentChapterId(progress.chapterId)
      }
      pendingRestoreScrollRef.current = progress.scrollY
      lastReaderScrollYRef.current = progress.scrollY
    }
  }

  async function restoreLastReading(nextBooks: BookSummary[]) {
    const progress = loadReadingProgress()
    if (!progress || !nextBooks.some((book) => book.id === progress.bookId)) return
    await openBook(progress.bookId, { restoreProgress: progress })
  }

  function restorePendingScroll() {
    const scrollY = pendingRestoreScrollRef.current
    if (scrollY === null) return
    pendingRestoreScrollRef.current = null
    window.setTimeout(() => {
      window.scrollTo({ top: scrollY, behavior: 'auto' })
      lastReaderScrollYRef.current = Math.max(0, scrollY)
    }, 120)
  }

  function updateReaderFontSize(nextFontSize: number) {
    setReaderSettings((current) => ({
      ...current,
      fontSize: Math.min(28, Math.max(15, nextFontSize)),
    }))
  }

  function updateReaderBackground(background: ReaderBackground) {
    setReaderSettings((current) => ({
      ...current,
      background,
    }))
  }

  function scrollReaderPage(direction: 'up' | 'down') {
    const distance = Math.max(320, window.innerHeight * 0.72)
    window.scrollBy({
      top: direction === 'down' ? distance : -distance,
      behavior: 'smooth',
    })
  }

  async function refreshTtsAvailability() {
    if (!Capacitor.isNativePlatform()) {
      setTtsVoices([])
      setTtsStatusMessage('语音阅读需要在 Android App 中使用。')
      return false
    }

    setTtsStatusMessage('正在检测系统语音引擎...')
    try {
      const availability = await withTimeout(
        NovelReaderTts.getAvailability({ locale: ttsSettings.locale }),
        10000,
        '系统 TTS 检测超时，请在系统设置中选择默认文字转语音引擎。',
      )
      setTtsVoices(availability.voices)
      if (!availability.available || !availability.languageAvailable) {
        setTtsStatusMessage(availability.error || '当前系统 TTS 不可用，请检查系统语音设置。')
        return false
      }
      setTtsStatusMessage(
        availability.voices.length
          ? `系统 TTS 可用，发现 ${availability.voices.length} 个 ${ttsSettings.locale} 音色。`
          : '系统 TTS 可用，将使用默认音色。',
      )
      return true
    } catch (error) {
      setTtsVoices([])
      setTtsStatusMessage(errorMessage(error) || '系统 TTS 检测失败。')
      return false
    }
  }

  async function openSystemTtsSettings() {
    if (!Capacitor.isNativePlatform()) {
      setTtsStatusMessage('系统语音设置只能在 Android App 中打开。')
      return
    }
    try {
      await NovelReaderTts.openTtsSettings()
      setTtsStatusMessage('请在系统页面选择文字转语音引擎，然后返回本应用重新检测。')
    } catch (error) {
      setTtsStatusMessage(errorMessage(error) || '无法打开系统语音设置。')
    }
  }

  async function openSystemTtsDataCheck() {
    if (!Capacitor.isNativePlatform()) {
      setTtsStatusMessage('系统语音检查只能在 Android App 中打开。')
      return
    }
    try {
      await NovelReaderTts.checkTtsData()
      setTtsStatusMessage('请按系统提示安装或启用语音数据，然后返回本应用重新检测。')
    } catch (error) {
      setTtsStatusMessage(errorMessage(error) || '无法打开系统语音检查。')
    }
  }

  function scrollToSpeechSegment(segmentId: string, force = false) {
    if (!force && (!speechAutoFollowRef.current || speechFollowSuspendedRef.current)) return
    const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segmentId)}"]`)
    if (!target) return

    isSpeechAutoScrollingRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      isSpeechAutoScrollingRef.current = false
    }, 800)
  }

  function clampAudioRatio(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
  }

  function mapSpeechSegmentToAudioTimeline(
    segment: SpeechSegment,
    index: number,
    audioTimeline: AudioTimelineEntry[],
  ): ChapterAudioTimelineItem | null {
    let startTime = Number.POSITIVE_INFINITY
    let endTime = Number.NEGATIVE_INFINITY
    let nextStartTime = Number.NEGATIVE_INFINITY

    for (const entry of audioTimeline) {
      if (typeof entry.sourceStart !== 'number' || typeof entry.sourceEnd !== 'number') continue
      const overlapStart = Math.max(segment.startChar, entry.sourceStart)
      const overlapEnd = Math.min(segment.endChar, entry.sourceEnd)
      if (overlapEnd <= overlapStart) continue

      const sourceLength = Math.max(1, entry.sourceEnd - entry.sourceStart)
      const speechDuration = Math.max(0, (entry.endTime ?? entry.startTime ?? 0) - (entry.startTime ?? 0))
      const mappedStart = (entry.startTime ?? 0) + clampAudioRatio((overlapStart - entry.sourceStart) / sourceLength) * speechDuration
      const mappedEnd = (entry.startTime ?? 0) + clampAudioRatio((overlapEnd - entry.sourceStart) / sourceLength) * speechDuration
      startTime = Math.min(startTime, mappedStart)
      endTime = Math.max(endTime, mappedEnd)
      nextStartTime = Math.max(nextStartTime, entry.nextStartTime ?? entry.endTime ?? mappedEnd)
    }

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
    return {
      index,
      startTime,
      endTime,
      nextStartTime: Number.isFinite(nextStartTime) ? Math.max(nextStartTime, endTime) : endTime,
    }
  }

  function buildChapterAudioTimeline(audioTimeline: AudioTimelineEntry[]) {
    const segments = speechSegmentsRef.current
    const mappedTimeline = segments
      .map((segment, index) => mapSpeechSegmentToAudioTimeline(segment, index, audioTimeline))
      .filter((item): item is ChapterAudioTimelineItem => Boolean(item))
      .sort((left, right) => left.startTime - right.startTime)
    chapterAudioTimelineRef.current = mappedTimeline.map((item, index) => {
      const nextItem = mappedTimeline[index + 1]
      return {
        ...item,
        nextStartTime: nextItem ? Math.max(item.endTime, nextItem.startTime) : item.nextStartTime,
      }
    })
  }

  function findAudioSegmentIndex(currentTime: number): number | null {
    const activeEntry = findActiveTimelineEntry(audioManifest, currentTime)
    const sourceIndex = findAudioSegmentIndexBySourcePosition(activeEntry, currentTime)
    if (sourceIndex != null) return sourceIndex

    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length) return null
    const active = timeline.find((item) => currentTime >= item.startTime && currentTime < item.nextStartTime)
    if (active) return active.index
    return timeline.find((item) => currentTime < item.startTime)?.index ?? timeline.at(-1)?.index ?? null
  }

  function findAudioSegmentIndexBySourcePosition(activeEntry: AudioTimelineEntry | null, currentTime: number): number | null {
    if (!activeEntry || typeof activeEntry.sourceStart !== 'number' || typeof activeEntry.sourceEnd !== 'number') return null
    const segments = speechSegmentsRef.current
    if (!segments.length) return null

    const entryStartTime = activeEntry.startTime ?? 0
    const entryEndTime = activeEntry.endTime ?? activeEntry.nextStartTime ?? entryStartTime
    const duration = Math.max(0.001, entryEndTime - entryStartTime)
    const ratio = clampAudioRatio((currentTime - entryStartTime) / duration)
    const sourcePosition = activeEntry.sourceStart + ratio * Math.max(1, activeEntry.sourceEnd - activeEntry.sourceStart)

    const containingIndex = segments.findIndex((segment) => sourcePosition >= segment.startChar && sourcePosition < segment.endChar)
    if (containingIndex >= 0) return containingIndex

    let nearest: { index: number; distance: number } | null = null
    segments.forEach((segment, index) => {
      const distance =
        sourcePosition < segment.startChar
          ? segment.startChar - sourcePosition
          : sourcePosition > segment.endChar
            ? sourcePosition - segment.endChar
            : 0
      if (!nearest || distance < nearest.distance) nearest = { index, distance }
    })
    return nearest?.index ?? null
  }

  function handleChapterAudioTimeUpdate(audio: HTMLAudioElement) {
    const currentTime = audio.currentTime
    setAudioTime(currentTime)
    const currentIndex = findAudioSegmentIndex(currentTime)
    if (currentIndex == null) return
    const segment = speechSegmentsRef.current[currentIndex]
    if (!segment || activeSpeechSegmentId === segment.id) return
    setActiveSpeechSegmentId(segment.id)
    setSpeechPlayback({ status: 'playing', segmentIndex: currentIndex, segmentId: segment.id })
    scrollToSpeechSegment(segment.id)
  }

  function findCurrentVisibleSpeechSegmentIndex(): number | null {
    const segments = speechSegmentsRef.current
    if (!segments.length) return null

    const viewportBottom = window.innerHeight || document.documentElement.clientHeight
    const viewportCenter = viewportBottom * 0.45
    let nearestVisible: { index: number; distance: number } | null = null

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segment.id)}"]`)
      if (!(target instanceof HTMLElement)) continue

      const bounds = target.getBoundingClientRect()
      if (bounds.bottom < 0 || bounds.top > viewportBottom) continue
      if (bounds.top <= viewportCenter && bounds.bottom >= viewportCenter) return index

      const segmentCenter = (bounds.top + bounds.bottom) / 2
      const distance = Math.abs(segmentCenter - viewportCenter)
      if (!nearestVisible || distance < nearestVisible.distance) nearestVisible = { index, distance }
    }

    return nearestVisible?.index ?? null
  }

  async function playSpeechSegment(segmentIndex: number) {
    const segment = speechSegmentsRef.current[segmentIndex]
    if (!segment) {
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      setActiveSpeechSegmentId(null)
      setSpeechPlayback({ status: 'idle' })
      return
    }

    speechQueueIdRef.current += 1
    const queueId = speechQueueIdRef.current
    const utterances = speechSegmentsRef.current.slice(segmentIndex).map((entry, offset) => {
      const utteranceId = `speech-${queueId}-${segmentIndex + offset}`
      return { text: entry.text, utteranceId }
    })
    speechUtteranceIndexRef.current = new Map(
      utterances.map((utterance, offset) => [utterance.utteranceId, segmentIndex + offset]),
    )
    currentUtteranceIdRef.current = utterances.at(-1)?.utteranceId ?? null
    setActiveSpeechSegmentId(segment.id)
    setSpeechPlayback({ status: 'playing', segmentIndex, segmentId: segment.id })
    scrollToSpeechSegment(segment.id)

    try {
      if (typeof NovelReaderTts.speakPrefetchedQueue === 'function') {
        await NovelReaderTts.speakPrefetchedQueue({
          locale: ttsSettings.locale,
          pitch: ttsSettings.pitch,
          prefetchWindow: TTS_PREFETCH_WINDOW,
          rate: ttsSettings.rate,
          utterances,
          voiceId: ttsSettings.voiceId || undefined,
        })
        return
      }

      await NovelReaderTts.speakQueue({
        locale: ttsSettings.locale,
        pitch: ttsSettings.pitch,
        rate: ttsSettings.rate,
        utterances,
        voiceId: ttsSettings.voiceId || undefined,
      })
    } catch (error) {
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      const message = errorMessage(error) || '语音朗读失败。'
      setSpeechPlayback({ status: 'error', message })
      setTtsStatusMessage(message)
    }
  }

  async function startSpeechReading(startIndexOverride: number | null = null) {
    if (!speechChapter?.segments.length) return
    clearAudioUrl()
    setSpeechPlayback({ status: 'checking' })
    setTtsStatusMessage('')
    try {
      const available = await refreshTtsAvailability()
      if (!available) {
        setSpeechPlayback({ status: 'error', message: '系统 TTS 不可用。' })
        return
      }
      await playSpeechSegment(startIndexOverride ?? findCurrentVisibleSpeechSegmentIndex() ?? 0)
    } catch (error) {
      const message = errorMessage(error) || '语音阅读启动失败。'
      setSpeechPlayback({ status: 'error', message })
      setTtsStatusMessage(message)
    }
  }

  async function pauseSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'playing') return
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setSpeechPlayback({ status: 'paused', segmentIndex: current.segmentIndex, segmentId: current.segmentId })
  }

  async function resumeSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'paused') return
    await playSpeechSegment(current.segmentIndex)
  }

  async function startSpeechReadingFromCurrentPosition() {
    await startSpeechReading(findCurrentVisibleSpeechSegmentIndex() ?? 0)
  }

  async function stopSpeechReading() {
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setActiveSpeechSegmentId(null)
    setSpeechPlayback({ status: 'idle' })
  }

  function followSpeechSegment() {
    const current = speechPlaybackRef.current
    if (current.status !== 'playing' && current.status !== 'paused') return
    speechFollowSuspendedRef.current = false
    setSpeechAutoFollowSuspended(false)
    scrollToSpeechSegment(current.segmentId, true)
  }

  function updateTtsSettings(nextSettings: TtsSettings) {
    const normalized = normalizeTtsSettings(nextSettings)
    setTtsSettings(normalized)
    if (chapterAudioRef.current) {
      chapterAudioRef.current.defaultPlaybackRate = normalized.rate
      chapterAudioRef.current.playbackRate = normalized.rate
    }
    if (speechPlaybackRef.current.status === 'playing') {
      void NovelReaderTts.setRate({ rate: normalized.rate }).catch(() => undefined)
      void NovelReaderTts.setPitch({ pitch: normalized.pitch }).catch(() => undefined)
    }
  }

  function getSpeechPlaybackLabel() {
    if (ttsSettings.engine === 'cloud-mp3') {
      if (chapterAudioPlaying) return `正在播放 MP3 · ${formatDuration(audioTime * 1000)}`
      if (audioUrl) return `MP3 已加载 · ${formatDuration(audioTime * 1000)}`
      return currentAudio ? '本章可播放云端 MP3' : '当前章节暂无 MP3'
    }
    if (speechPlayback.status === 'playing') return `正在朗读 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'paused') return `已暂停在 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'checking') return '正在检测系统语音'
    if (speechPlayback.status === 'error') return speechPlayback.message
    return `本章 ${speechChapter?.segments.length ?? 0} 个朗读片段`
  }

  function renderSpeechActions() {
    if (ttsSettings.engine === 'cloud-mp3') {
      return (
        <div className="speech-actions">
          <button type="button" onClick={() => void (audioUrl ? toggleChapterAudioPlayback() : playCurrentAudio())} disabled={!currentAudio || loadingAudio}>
            {audioUrl ? (chapterAudioPlaying ? '暂停' : '继续播放') : audioButtonLabel(currentAudio, loadingAudio)}
          </button>
          <button type="button" onClick={() => void playCurrentAudioFromVisiblePosition()} disabled={!currentAudio || loadingAudio}>
            从当前位置播放
          </button>
        </div>
      )
    }

    return (
      <div className="speech-actions">
        {(speechPlayback.status === 'idle' || speechPlayback.status === 'error') && (
          <>
            <button type="button" onClick={() => void startSpeechReading()} disabled={!speechChapter?.segments.length}>开始播放</button>
            <button type="button" onClick={() => void startSpeechReadingFromCurrentPosition()} disabled={!speechChapter?.segments.length}>从当前位置播放</button>
          </>
        )}
        {speechPlayback.status === 'checking' && <button type="button" disabled>检测中</button>}
        {speechPlayback.status === 'playing' && (
          <>
            <button type="button" onClick={() => void pauseSpeechReading()}>暂停</button>
            <button type="button" onClick={() => void stopSpeechReading()}>停止</button>
          </>
        )}
        {speechPlayback.status === 'paused' && (
          <>
            <button type="button" onClick={() => void resumeSpeechReading()}>继续</button>
            <button type="button" onClick={() => void startSpeechReadingFromCurrentPosition()}>从当前位置播放</button>
            <button type="button" onClick={() => void stopSpeechReading()}>停止</button>
          </>
        )}
        {speechAutoFollowSuspended && <button type="button" onClick={followSpeechSegment}>跟随朗读</button>}
      </div>
    )
  }

  function renderSpeechRateField() {
    const selectedIndex = Math.max(0, TTS_RATE_PRESETS.findIndex((rate) => Math.abs(ttsSettings.rate - rate) < 0.001))
    const safeIndex = selectedIndex >= 0 ? selectedIndex : closestRatePresetIndex(ttsSettings.rate)
    return (
      <label className="tts-rate-field">
        <span>语速 · {ttsSettings.rate.toFixed(ttsSettings.rate % 1 === 0 ? 0 : 2)}x</span>
        <div className="rate-slider-field">
          <input
            aria-label="语音朗读倍速"
            max={TTS_RATE_PRESETS.length - 1}
            min={0}
            step={1}
            type="range"
            value={safeIndex}
            onChange={(event) => updateTtsSettings({ ...ttsSettings, rate: TTS_RATE_PRESETS[Number(event.target.value)] })}
          />
          <div className="rate-slider-dots" aria-hidden="true">
            {TTS_RATE_PRESETS.map((rate, index) => (
              <span className={index === safeIndex ? 'active' : ''} key={rate} />
            ))}
          </div>
          <div className="rate-slider-labels">
            {TTS_RATE_PRESETS.map((rate, index) => (
              <button
                aria-label={`${rate}x`}
                className={index === safeIndex ? 'active' : ''}
                key={rate}
                type="button"
                onClick={() => updateTtsSettings({ ...ttsSettings, rate })}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </label>
    )
  }

  function renderPlaybackEngineField() {
    return (
      <div className="segmented-control" aria-label="播放引擎">
        <button
          className={ttsSettings.engine === 'local-tts' ? 'active' : ''}
          type="button"
          onClick={() => {
            playbackEngineTouchedRef.current = true
            updateTtsSettings({ ...ttsSettings, engine: 'local-tts' })
          }}
        >
          本地 TTS
        </button>
        <button
          className={ttsSettings.engine === 'cloud-mp3' ? 'active' : ''}
          type="button"
          onClick={() => {
            playbackEngineTouchedRef.current = true
            updateTtsSettings({ ...ttsSettings, engine: 'cloud-mp3' })
          }}
        >
          云端 MP3
        </button>
      </div>
    )
  }

  function handleReaderTap(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, label, audio')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const xRatio = (event.clientX - bounds.left) / bounds.width

    if (xRatio >= 0.25 && xRatio <= 0.75) {
      const now = event.timeStamp
      if (now - lastReaderCenterTapAtRef.current < 360) {
        lastReaderCenterTapAtRef.current = 0
        setChapterPickerOpen(true)
        return
      }
      lastReaderCenterTapAtRef.current = now
      return
    }

    lastReaderCenterTapAtRef.current = 0
    scrollReaderPage(xRatio < 0.25 ? 'up' : 'down')
  }

  return (
    <main className="app-shell">
      {tab !== 'reader' ? (
        <header className="top-bar">
          <div>
            <h1>{tab === 'library' ? '书库' : '设置'}</h1>
            <p>{tab === 'library' ? `${books.length} 本 · ${connectionLabel(connectionState)}` : connectionLabel(connectionState)}</p>
          </div>
          <button className="icon-button" type="button" onClick={() => void refreshBooks()} disabled={loadingBooks}>
            刷新
          </button>
        </header>
      ) : null}

      {message && tab !== 'reader' ? <div className={`status-line status-${connectionState}`}>{message}</div> : null}

      {tab === 'library' ? (
        <section className="library-page">
          <div className="book-list">
            <div className="section-title">
              <h2>书库</h2>
              <span>{loadingBooks ? '同步中' : `${books.length} 本`}</span>
            </div>
            {books.length === 0 ? (
              <div className="empty-state">
                <p>暂无书籍</p>
                <button type="button" onClick={() => switchTab('settings')}>去设置连接</button>
              </div>
            ) : (
              <div className="book-items">
                {books.map((book) => (
                  <button
                    className={book.id === selectedBookId ? 'book-row active' : 'book-row'}
                    type="button"
                    key={book.id}
                    onClick={() => selectBook(book.id)}
                  >
                    <span className="book-title">{book.title}</span>
                    <span className="book-meta">{formatBookMeta(book)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="book-detail">
            <div className="section-title">
              <h2>{selectedBook?.title ?? '阅读'}</h2>
              <span>{loadingPackage ? '加载中' : selectedBook ? `${selectedBook.chapterCount} 章` : ''}</span>
            </div>
            {selectedBook ? (
              <div className="detail-body">
                <dl>
                  <div>
                    <dt>作者</dt>
                    <dd>{selectedBook.author || '未标注'}</dd>
                  </div>
                  <div>
                    <dt>字数</dt>
                    <dd>{selectedBook.wordCount ? selectedBook.wordCount.toLocaleString('zh-CN') : '未统计'}</dd>
                  </div>
                  <div>
                    <dt>音频</dt>
                    <dd>{displayAudioChapterCount} 章</dd>
                  </div>
                  <div>
                    <dt>更新</dt>
                    <dd>{formatDate(selectedBook.updatedAt)}</dd>
                  </div>
                </dl>
                <div className="coverage-row">
                  <Coverage label="概要" value={displaySummaryCoverage} />
                  <Coverage label="图谱" value={displayKgCoverage} />
                  <Coverage label="向量" value={displayEmbeddingCoverage} />
                </div>
                <div className="package-line">
                  <span>Package</span>
                  <strong>{bookPackage ? packageSummary(bookPackage) : '未加载'}</strong>
                </div>
                <div className="package-line">
                  <span>完整数据包</span>
                  <strong>{fullPackageLabel(visibleFullPackageCache, fullPackageStatus)}</strong>
                </div>
                {visibleFullPackageProgress ? (
                  <div className="package-line">
                    <span>{visibleFullPackageProgress.phase === 'download' ? '下载进度' : '导入进度'}</span>
                    <strong>{fullPackageProgressLabel(visibleFullPackageProgress)}</strong>
                  </div>
                ) : null}
                <button
                  className="secondary-button full-width-button"
                  type="button"
                  onClick={() => void syncCurrentFullPackage()}
                  disabled={!selectedBookId || fullPackageStatus === 'downloading' || fullPackageStatus === 'importing'}
                >
                  {fullPackageStatus === 'downloading'
                    ? '下载数据包中'
                    : fullPackageStatus === 'importing'
                      ? '导入数据包中'
                      : visibleFullPackageCache
                        ? '重新同步数据包'
                        : '下载完整数据包'}
                </button>
                <div className="package-line">
                  <span>Audio</span>
                  <strong>
                    {visibleAudioSyncProgress
                      ? `${visibleAudioSyncProgress.done}/${visibleAudioSyncProgress.total}`
                      : loadingAudio
                        ? '同步中'
                        : `${visibleCachedAudioIds.size}/${visibleAudioChapters.length || selectedBook.audioChapterCount || 0} 已缓存`}
                  </strong>
                </div>
                <button
                  className="secondary-button full-width-button"
                  type="button"
                  onClick={() => void syncCurrentBookAudio()}
                  disabled={!selectedBookId || loadingAudio}
                >
                  {visibleAudioSyncProgress ? `同步音频 ${visibleAudioSyncProgress.done}/${visibleAudioSyncProgress.total}` : '同步 Audio'}
                </button>
                <button className="primary-button full-width-button" type="button" onClick={() => void openBook(selectedBook.id)} disabled={loadingPackage}>
                  开始阅读
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <p>选择书籍</p>
                <button type="button" onClick={() => switchTab('settings')}>同步书库</button>
              </div>
            )}
          </div>
        </section>
      ) : tab === 'reader' ? (
        <section className="reader-page">
          {!bookPackage || !currentChapter ? (
            <div className="empty-state reader-empty">
              <p>请选择一本书。</p>
              <button type="button" onClick={() => switchTab('library')}>回到书库</button>
            </div>
          ) : (
            <>
              <div className="chapter-toolbar">
                <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                  {chapters.map((chapter, index) => (
                    <option key={chapter.id} value={chapter.id}>
                      {index + 1}. {chapter.title}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setChapterPickerOpen(true)}>菜单</button>
              </div>
              <div className="chapter-nav-row">
                <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                  上一章
                </button>
                <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                  下一章
                </button>
              </div>
              {message ? <div className={`status-line reader-status status-${connectionState}`}>{message}</div> : null}
              <article
                className={`reader-card ${readerSettings.background}`}
                onClick={handleReaderTap}
                style={{ '--reader-font-size': `${readerSettings.fontSize}px` } as CSSProperties}
              >
                <h2>{currentChapter.title}</h2>
                <ChapterSummary bookPackage={bookPackage} chapter={currentChapter} />
                <div className="chapter-text">
                  {speechChapter ? (
                    <SpeechTextContent speechChapter={speechChapter} activeSegmentId={activeSpeechSegmentId} />
                  ) : (
                    <TextContent text={chapterContent(currentChapter)} activeEntry={activeTimelineEntry} />
                  )}
                </div>
              </article>
              <div className="chapter-nav-row bottom">
                <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                  上一章
                </button>
                <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                  下一章
                </button>
              </div>
              {chapterPickerOpen ? (
                <div className="reader-menu-overlay" role="presentation" onClick={() => setChapterPickerOpen(false)}>
                  <section className="reader-menu-sheet" role="dialog" aria-modal="true" aria-label="阅读控制" onClick={(event) => event.stopPropagation()}>
                    <div className="reader-menu-header">
                      <div>
                        <strong>{currentChapter.title}</strong>
                        <span>{currentChapterPosition + 1}/{chapters.length}</span>
                      </div>
                      <button className="reader-menu-close" type="button" aria-label="关闭" onClick={() => setChapterPickerOpen(false)}>×</button>
                    </div>
                    <label className="chapter-select-field reader-menu-group">
                      <span>章节</span>
                      <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                        {chapters.map((chapter, index) => (
                          <option key={chapter.id} value={chapter.id}>
                            {index + 1}. {chapter.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="chapter-nav-row reader-menu-nav">
                      <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                        上一章
                      </button>
                      <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                        下一章
                      </button>
                    </div>
                    <div className="speech-control-panel reader-menu-group">
                      <div>
                        <strong>{ttsSettings.engine === 'cloud-mp3' ? '章节 MP3' : '语音阅读'}</strong>
                        <span>{getSpeechPlaybackLabel()}</span>
                      </div>
                      {renderPlaybackEngineField()}
                      {renderSpeechActions()}
                      {renderSpeechRateField()}
                      {ttsSettings.engine === 'local-tts' ? (
                        <>
                          <label className="tts-toggle-row">
                            <input
                              type="checkbox"
                              checked={ttsSettings.autoFollow}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, autoFollow: event.target.checked })}
                            />
                            <span>朗读时跟随正文</span>
                          </label>
                          <label className="tts-select-field">
                            <span>音调</span>
                            <input
                              max={MAX_TTS_PITCH}
                              min={MIN_TTS_PITCH}
                              step={0.05}
                              type="number"
                              value={ttsSettings.pitch}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, pitch: Number(event.target.value) })}
                            />
                          </label>
                          <label className="tts-select-field">
                            <span>语言</span>
                            <input
                              value={ttsSettings.locale}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, locale: event.target.value })}
                            />
                          </label>
                          {ttsVoices.length > 0 ? (
                        <label className="tts-select-field">
                          <span>音色</span>
                          <select
                            value={ttsSettings.voiceId}
                            onChange={(event) => updateTtsSettings({ ...ttsSettings, voiceId: event.target.value })}
                          >
                            <option value="">系统默认</option>
                            {ttsVoices.map((voice) => (
                              <option key={voice.id} value={voice.id}>
                                {voice.name || voice.id}
                              </option>
                            ))}
                          </select>
                        </label>
                          ) : null}
                          <div className="tts-secondary-actions">
                            <button type="button" onClick={() => void refreshTtsAvailability()}>检测语音</button>
                            <button type="button" onClick={() => void openSystemTtsSettings()}>系统语音设置</button>
                            <button type="button" onClick={() => void openSystemTtsDataCheck()}>安装语音包</button>
                          </div>
                        </>
                      ) : null}
                      {ttsSettings.engine === 'local-tts' && ttsStatusMessage ? <p className="speech-status">{ttsStatusMessage}</p> : null}
                    </div>
                    <div className="reader-settings reader-menu-group">
                      <strong>字号</strong>
                      <div className="reader-size-control">
                        <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize - 1)}>A-</button>
                        <input
                          aria-label="字体大小"
                          max={28}
                          min={15}
                          type="range"
                          value={readerSettings.fontSize}
                          onChange={(event) => updateReaderFontSize(Number(event.target.value))}
                        />
                        <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize + 1)}>A+</button>
                        <span>{readerSettings.fontSize}px</span>
                      </div>
                      <strong>背景</strong>
                      <div className="reader-background-control">
                        {(['paper', 'warm', 'green', 'dark'] as ReaderBackground[]).map((background) => (
                          <button
                            aria-label={backgroundLabel(background)}
                            className={`reader-swatch ${background} ${readerSettings.background === background ? 'active' : ''}`}
                            key={background}
                            type="button"
                            onClick={() => updateReaderBackground(background)}
                          />
                        ))}
                      </div>
                    </div>
                  </section>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <section className="settings-page">
          <section className="settings-panel">
            <label>
              <span>Gateway</span>
              <input
                value={settings.baseUrl}
                inputMode="url"
                onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
              />
            </label>
            <label>
              <span>Token</span>
              <input
                value={settings.token}
                type="password"
                onChange={(event) => setSettings({ ...settings, token: event.target.value })}
              />
            </label>
            <label>
              <span>设备</span>
              <input
                value={settings.deviceName}
                onChange={(event) => setSettings({ ...settings, deviceName: event.target.value })}
              />
            </label>
            <div className="settings-actions">
              <button className="primary-button" type="button" onClick={() => void checkSession()} disabled={connectionState === 'checking'}>
                {connectionState === 'checking' ? '连接中' : '重新连接'}
              </button>
              <button className="secondary-button" type="button" onClick={() => void refreshBooks()} disabled={loadingBooks}>
                {loadingBooks ? '同步中' : '刷新书库'}
              </button>
            </div>
          </section>

          <section className="cache-manager">
            <div className="section-title">
              <h2>缓存管理</h2>
              <button className="secondary-button compact-button" type="button" onClick={refreshCacheSummaries}>
                刷新
              </button>
            </div>
            {cacheSummaries.length ? (
              <div className="cache-book-list">
                {cacheSummaries.map((cache) => (
                  <article className="cache-book-card" key={cache.bookId}>
                    <div className="cache-book-heading">
                      <strong>{cache.title}</strong>
                      <span>{formatBytes(cache.totalSizeBytes)}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>完整数据包</dt>
                        <dd>{cache.packageCache ? formatBytes(cache.packageCache.sizeBytes) : '无缓存'}</dd>
                      </div>
                      <div>
                        <dt>MP3 音频</dt>
                        <dd>{cache.audioCount} 章 · {formatBytes(cache.audioSizeBytes)}</dd>
                      </div>
                    </dl>
                    <div className="cache-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!cache.packageCache || clearingCacheKey === `${cache.bookId}:package`}
                        onClick={() => void clearBookPackageCache(cache.bookId)}
                      >
                        {clearingCacheKey === `${cache.bookId}:package` ? '清除中' : '清除数据包'}
                      </button>
                      <button
                        className="secondary-button danger-button"
                        type="button"
                        disabled={cache.audioCount === 0 || clearingCacheKey === `${cache.bookId}:audio`}
                        onClick={() => void clearBookAudioCache(cache.bookId)}
                      >
                        {clearingCacheKey === `${cache.bookId}:audio` ? '清除中' : '清除 MP3'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="cache-empty">还没有本地缓存。打开书籍或同步音频后会显示在这里。</p>
            )}
          </section>

          <section className="sync-summary">
            <div className="section-title">
              <h2>同步状态</h2>
              <span>{books.length} 本</span>
            </div>
            <dl>
              <div>
                <dt>连接</dt>
                <dd>{connectionLabel(connectionState)}</dd>
              </div>
              <div>
                <dt>当前书籍</dt>
                <dd>{selectedBook?.title ?? '未选择'}</dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>{bookPackage ? packageSummary(bookPackage) : '未加载'}</dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>{visibleCachedAudioIds.size}/{visibleAudioChapters.length || selectedBook?.audioChapterCount || 0} 章</dd>
              </div>
            </dl>
          </section>
        </section>
      )}

      {audioUrl ? (
        <audio
          className="persistent-audio-player"
          ref={chapterAudioRef}
          src={audioUrl}
          autoPlay
          onTimeUpdate={(event) => handleChapterAudioTimeUpdate(event.currentTarget)}
          onLoadedMetadata={(event) => {
            event.currentTarget.defaultPlaybackRate = ttsSettings.rate
            event.currentTarget.playbackRate = ttsSettings.rate
          }}
          onPlay={(event) => {
            event.currentTarget.playbackRate = ttsSettings.rate
            setChapterAudioPlaying(true)
          }}
          onPause={() => setChapterAudioPlaying(false)}
          onEnded={() => setChapterAudioPlaying(false)}
        />
      ) : null}

      <nav className="bottom-nav" aria-label="主导航">
        <button className={tab === 'library' ? 'active' : ''} type="button" onClick={() => switchTab('library')}>
          书库
        </button>
        <button className={tab === 'reader' ? 'active' : ''} type="button" onClick={() => switchTab('reader')}>
          阅读
        </button>
        <button className={tab === 'settings' ? 'active' : ''} type="button" onClick={() => switchTab('settings')}>
          设置
        </button>
      </nav>
    </main>
  )
}

function TextContent({ text, activeEntry }: { text: string; activeEntry?: AudioTimelineEntry | null }) {
  const highlighted = splitHighlightedText(text, activeEntry)
  if (highlighted) {
    return (
      <p className="highlighted-text">
        <span>{highlighted.before}</span>
        <mark>{highlighted.active}</mark>
        <span>{highlighted.after}</span>
      </p>
    )
  }

  const paragraphs = text
    .split(/\n{2,}|\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) {
    return <p className="muted-text">这一章没有正文。</p>
  }
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
      ))}
    </>
  )
}

function SpeechTextContent({
  speechChapter,
  activeSegmentId,
}: {
  speechChapter: ReturnType<typeof createSpeechChapter>
  activeSegmentId: string | null
}) {
  if (speechChapter.paragraphs.length === 0) {
    return <p className="muted-text">这一章没有正文。</p>
  }

  return (
    <>
      {speechChapter.paragraphs.map((paragraph) => (
        <p key={`speech-paragraph-${paragraph.paragraphIndex}`}>
          {paragraph.segments.map((segment, index) => (
            <span
              className={segment.id === activeSegmentId ? 'speech-segment active' : 'speech-segment'}
              data-speech-segment-id={segment.id}
              key={segment.id}
            >
              {segment.text}
              {index < paragraph.segments.length - 1 ? ' ' : ''}
            </span>
          ))}
        </p>
      ))}
    </>
  )
}

function ChapterSummary({ bookPackage, chapter }: { bookPackage: BookPackage; chapter: Chapter }) {
  const summary = findChapterSummary(bookPackage, chapter)
  const short = summary ? summaryText(summary, ['short', 'brief', 'summary', 'title']) : ''
  const detail = summary ? summaryText(summary, ['detail', 'details', 'content', 'description']) : ''
  const keyPoints = summary ? summaryList(summary, ['keyPoints', 'keypoints', 'points', 'bullets']) : []
  const skippable = summary ? summaryText(summary, ['skippable', 'skipReason', 'readingTip']) : ''

  return (
    <aside className={summary ? 'summary-box' : 'summary-box summary-empty'}>
      <strong>本章概要</strong>
      {summary ? (
        <>
          {short ? <p className="summary-short">{short}</p> : null}
          {detail ? <p>{detail}</p> : null}
          {keyPoints.length > 0 ? (
            <ul>
              {keyPoints.map((point, index) => (
                <li key={`${chapter.id}-summary-${index}`}>{point}</li>
              ))}
            </ul>
          ) : null}
          {skippable ? <p className="summary-skip">{skippable}</p> : null}
          {!short && !detail && keyPoints.length === 0 && !skippable ? <p>当前概要为空。</p> : null}
        </>
      ) : (
        <p>当前同步包没有这章的概要。可以回到书库重新同步完整数据包。</p>
      )}
    </aside>
  )
}

function Coverage({ label, value }: { label: string; value?: number }) {
  const percent = typeof value === 'number' ? Math.round(value * 100) : null
  return (
    <div className="coverage">
      <span>{label}</span>
      <div className="meter">
        <div style={{ width: `${percent ?? 0}%` }} />
      </div>
      <strong>{percent === null ? '读取中' : `${percent}%`}</strong>
    </div>
  )
}

function findChapterSummary(bookPackage: BookPackage, chapter: Chapter): Record<string, unknown> | null {
  const summaries = bookPackage.summaries
  if (Array.isArray(summaries)) {
    const matched = summaries.find((entry) => {
      if (!isRecord(entry)) return false
      return (
        entry.chapterId === chapter.id ||
        entry.id === chapter.id ||
        sameOptionalInteger(entry.chapterIndex, chapter.index) ||
        sameOptionalInteger(entry.index, chapter.index) ||
        sameOptionalInteger(entry.chapterIndex, chapter.chapterIndex) ||
        sameOptionalInteger(entry.index, chapter.chapterIndex)
      )
    })
    return isRecord(matched) ? matched : null
  }
  if (isRecord(summaries)) {
    const byId = summaries[chapter.id]
    if (isRecord(byId)) return byId
  }
  return null
}

function sameOptionalInteger(left: unknown, right: unknown) {
  return typeof left === 'number' && typeof right === 'number' && left === right
}

function summaryText(summary: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = summary[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function summaryList(summary: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = summary[key]
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())
    }
  }
  return []
}

async function gatewayFetch(settings: GatewaySettings, path: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const headers = {
    authorization: `Bearer ${settings.token.trim()}`,
    'x-device-name': settings.deviceName.trim() || 'Android Phone',
  }
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      headers,
      readTimeout: 120000,
      connectTimeout: 15000,
      url: `${baseUrl}${path}`,
    })
    const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
    if (response.status < 200 || response.status >= 300) {
      throw new Error(body?.error?.message || `Gateway HTTP ${response.status}`)
    }
    return body as Record<string, unknown>
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
  })
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) {
    throw new Error(body.error?.message || `Gateway HTTP ${response.status}`)
  }
  return body as Record<string, unknown>
}

async function gatewayFetchBlob(settings: GatewaySettings, path: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const headers = {
    authorization: `Bearer ${settings.token.trim()}`,
    'x-device-name': settings.deviceName.trim() || 'Android Phone',
  }
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      headers,
      readTimeout: 120000,
      connectTimeout: 15000,
      responseType: 'blob',
      url: `${baseUrl}${path}`,
    })
    if (response.status < 200 || response.status >= 300) {
      const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
      throw new Error(body?.error?.message || `Gateway HTTP ${response.status}`)
    }
    return capacitorDataToBlob(response.data)
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(body.error?.message || `Gateway HTTP ${response.status}`)
  }
  return response.blob()
}

async function downloadAudioToNativeFile(settings: GatewaySettings, bookId: string, chapterId: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  return NativeAudio.downloadAudio({
    bookId,
    chapterId,
    deviceName: settings.deviceName.trim() || 'Android Phone',
    token: settings.token.trim(),
    url: `${baseUrl}/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(chapterId)}/download`,
  })
}

async function downloadPackageToNativeFile(settings: GatewaySettings, bookId: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  return NativeAudio.downloadPackage({
    bookId,
    deviceName: settings.deviceName.trim() || 'Android Phone',
    token: settings.token.trim(),
    url: `${baseUrl}/mobile/books/${encodeURIComponent(bookId)}/package/download`,
  })
}

async function importPackageToNativeStore(bookId: string, filePath: string, expectedChapterCount?: number) {
  return NativeAudio.importPackage({
    bookId,
    filePath,
    expectedChapterCount,
  })
}

function loadFullPackageCache(bookId?: string | null): FullPackageCache | null {
  const index = loadFullPackageCacheIndex()
  if (bookId) return index[bookId] ?? null

  const progress = loadReadingProgress()
  if (progress?.bookId && index[progress.bookId]) return index[progress.bookId]

  const indexedCaches = Object.values(index).sort((left, right) => Date.parse(right.importedAt || right.cachedAt) - Date.parse(left.importedAt || left.cachedAt))
  if (indexedCaches[0]) return indexedCaches[0]
  return null
}

function loadFullPackageCacheIndex(): Record<string, FullPackageCache> {
  const index: Record<string, FullPackageCache> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(fullPackageCacheIndexKey) || '{}') as unknown
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const cache = normalizeFullPackageCache(value)
        if (cache && cache.bookId === key) index[key] = cache
      }
    }
  } catch {
    // Ignore invalid cache index and fall back to the legacy single-book key.
  }

  return index
}

function loadLegacyFullPackageCache(): FullPackageCache | null {
  try {
    const cached = localStorage.getItem(fullPackageCacheKey)
    if (!cached) return null
    const parsed = JSON.parse(cached) as unknown
    return normalizeFullPackageCache(parsed)
  } catch {
    return null
  }
}

function normalizeFullPackageCache(value: unknown): FullPackageCache | null {
  if (!isRecord(value)) return null
  if (typeof value.bookId !== 'string' || typeof value.filePath !== 'string') return null
  if (typeof value.sizeBytes !== 'number' || typeof value.cachedAt !== 'string') return null
  return {
    bookId: value.bookId,
    filePath: value.filePath,
    sizeBytes: value.sizeBytes,
    cachedAt: value.cachedAt,
    importedAt: typeof value.importedAt === 'string' ? value.importedAt : undefined,
    importStats: normalizeFullPackageImportStats(value.importStats),
    metadataPath: typeof value.metadataPath === 'string' ? value.metadataPath : undefined,
  }
}

function saveFullPackageCache(cache: FullPackageCache) {
  const index = loadFullPackageCacheIndex()
  index[cache.bookId] = cache
  localStorage.setItem(fullPackageCacheIndexKey, JSON.stringify(index))
  localStorage.setItem(fullPackageCacheKey, JSON.stringify(cache))
}

function removeFullPackageCache(bookId: string) {
  const index = loadFullPackageCacheIndex()
  delete index[bookId]
  localStorage.setItem(fullPackageCacheIndexKey, JSON.stringify(index))
  const legacy = loadLegacyFullPackageCache()
  if (legacy?.bookId === bookId) {
    localStorage.removeItem(fullPackageCacheKey)
  }
}

function parseJsonBody(value: string) {
  try {
    return JSON.parse(value) as { error?: { message?: string } } & Record<string, unknown>
  } catch {
    return {}
  }
}

function capacitorDataToBlob(value: unknown) {
  if (value instanceof Blob) return value
  if (typeof value === 'string') {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: 'audio/mpeg' })
  }
  return new Blob([], { type: 'audio/mpeg' })
}

function loadSettings(): GatewaySettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey) || 'null') as Partial<GatewaySettings> | null
    return {
      ...defaultSettings,
      ...parsed,
    }
  } catch {
    return defaultSettings
  }
}

function isGatewayConfigured(settings: GatewaySettings) {
  const baseUrl = settings.baseUrl.trim()
  return Boolean(baseUrl && baseUrl !== 'https://' && baseUrl !== 'https:' && settings.token.trim())
}

function loadReaderSettings(): ReaderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(readerSettingsKey) || 'null') as Partial<ReaderSettings> | null
    const background = isReaderBackground(parsed?.background) ? parsed.background : defaultReaderSettings.background
    const fontSize = typeof parsed?.fontSize === 'number' ? Math.min(28, Math.max(15, parsed.fontSize)) : defaultReaderSettings.fontSize
    return { fontSize, background }
  } catch {
    return defaultReaderSettings
  }
}

function loadTtsSettings(): TtsSettings {
  try {
    return normalizeTtsSettings(JSON.parse(localStorage.getItem(ttsSettingsKey) || 'null') as Partial<TtsSettings> | null)
  } catch {
    return defaultTtsSettings
  }
}

function normalizeTtsSettings(settings: Partial<TtsSettings> | null | undefined): TtsSettings {
  return {
    engine: settings?.engine === 'local-tts' || settings?.engine === 'cloud-mp3' ? settings.engine : defaultTtsSettings.engine,
    locale: typeof settings?.locale === 'string' && settings.locale.trim() ? settings.locale.trim() : defaultTtsSettings.locale,
    voiceId: typeof settings?.voiceId === 'string' ? settings.voiceId : defaultTtsSettings.voiceId,
    rate: clampNumber(settings?.rate, MIN_TTS_RATE, MAX_TTS_RATE, defaultTtsSettings.rate),
    pitch: clampNumber(settings?.pitch, MIN_TTS_PITCH, MAX_TTS_PITCH, defaultTtsSettings.pitch),
    autoFollow: typeof settings?.autoFollow === 'boolean' ? settings.autoFollow : defaultTtsSettings.autoFollow,
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function closestRatePresetIndex(value: number) {
  return TTS_RATE_PRESETS.reduce(
    (bestIndex, rate, index) => (Math.abs(rate - value) < Math.abs(TTS_RATE_PRESETS[bestIndex] - value) ? index : bestIndex),
    0,
  )
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) window.clearTimeout(timer)
  })
}

function loadReadingProgress(): ReadingProgress | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(readingProgressKey) || 'null') as Partial<ReadingProgress> | null
    if (!parsed || typeof parsed.bookId !== 'string' || typeof parsed.chapterId !== 'string') return null
    return {
      bookId: parsed.bookId,
      chapterId: parsed.chapterId,
      scrollY: typeof parsed.scrollY === 'number' && Number.isFinite(parsed.scrollY) ? Math.max(0, parsed.scrollY) : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function saveReadingProgress(progress: ReadingProgress) {
  try {
    localStorage.setItem(readingProgressKey, JSON.stringify(progress))
  } catch {
    // Best effort; reading should continue even if the WebView storage is full.
  }
}

function persistReadingProgress(bookId: string | null, chapterId: string | null, scrollY: number) {
  if (!bookId || !chapterId) return
  saveReadingProgress({
    bookId,
    chapterId,
    scrollY: Math.max(0, scrollY),
    updatedAt: new Date().toISOString(),
  })
}

function isReaderBackground(value: unknown): value is ReaderBackground {
  return value === 'paper' || value === 'warm' || value === 'green' || value === 'dark'
}

function backgroundLabel(background: ReaderBackground) {
  if (background === 'warm') return '暖色'
  if (background === 'green') return '护眼'
  if (background === 'dark') return '夜间'
  return '纸张'
}

function connectionLabel(state: ConnectionState) {
  if (state === 'connected') return '已连接'
  if (state === 'checking') return '连接中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function formatBookMeta(book: BookSummary) {
  const parts = [`${book.chapterCount} 章`]
  if (book.author) parts.push(book.author)
  if (book.audioChapterCount) parts.push(`${book.audioChapterCount} 音频`)
  return parts.join(' · ')
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function packageSummary(bookPackage: BookPackage) {
  const chapterCount = packageChapters(bookPackage).length
  return chapterCount > 0 ? `${chapterCount} 章` : '已加载'
}

function packageChapters(bookPackage: BookPackage | null): Chapter[] {
  if (!bookPackage || !Array.isArray(bookPackage.chapters)) return []
  return bookPackage.chapters.filter(isChapter).sort((left, right) => {
    const leftIndex = left.index ?? left.chapterIndex ?? 0
    const rightIndex = right.index ?? right.chapterIndex ?? 0
    return leftIndex - rightIndex || left.title.localeCompare(right.title)
  })
}

function chapterContent(chapter: Chapter) {
  return chapter.content ?? chapter.text ?? ''
}

function normalizeBookPackage(value: unknown): BookPackage {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.book)) {
    throw new Error('Gateway 返回的数据包格式无效')
  }

  const rawChapters = Array.isArray(value.chapters)
    ? value.chapters.map(normalizeChapter).filter((chapter): chapter is Chapter => Boolean(chapter))
    : []
  return {
    ...value,
    schemaVersion: 1,
    book: value.book as BookSummary,
    chapters: rawChapters,
  }
}

async function cacheBookPackage(bookId: string, bookPackage: BookPackage) {
  const indexedDbCached = await writeBookPackageToIndexedDb(bookId, bookPackage)
  if (indexedDbCached) {
    try {
      localStorage.removeItem(`${packageCachePrefix}${bookId}`)
    } catch {
      // Ignore cleanup failures; IndexedDB already has the current package.
    }
    return true
  }

  try {
    localStorage.setItem(`${packageCachePrefix}${bookId}`, JSON.stringify(bookPackage))
    return true
  } catch {
    return false
  }
}

async function loadCachedBookPackage(bookId: string): Promise<BookPackage | null> {
  const indexedDbPackage = await readBookPackageFromIndexedDb(bookId)
  if (indexedDbPackage) return indexedDbPackage

  try {
    const cached = localStorage.getItem(`${packageCachePrefix}${bookId}`)
    return cached ? normalizeBookPackage(JSON.parse(cached) as unknown) : null
  } catch {
    return null
  }
}

async function writeBookPackageToIndexedDb(bookId: string, bookPackage: BookPackage) {
  try {
    const db = await openPackageCacheDb()
    await runPackageStoreRequest(db, 'readwrite', packageCacheStoreName, (store) =>
      store.put({
        bookId,
        package: bookPackage,
        cachedAt: new Date().toISOString(),
      }),
    )
    db.close()
    return true
  } catch {
    return false
  }
}

async function readBookPackageFromIndexedDb(bookId: string) {
  try {
    const db = await openPackageCacheDb()
    const record = await runPackageStoreRequest(db, 'readonly', packageCacheStoreName, (store) => store.get(bookId))
    db.close()
    if (!isRecord(record)) return null
    return normalizeBookPackage(record.package)
  } catch {
    return null
  }
}

async function deleteBookPackageFromIndexedDb(bookId: string) {
  try {
    const db = await openPackageCacheDb()
    await runPackageStoreRequest(db, 'readwrite', packageCacheStoreName, (store) => store.delete(bookId))
    db.close()
  } catch {
    // Best effort; package file/index cleanup should still continue.
  }
}

function writeCachedAudio(bookId: string, audioChapter: AudioChapter, payload: AudioCachePayload) {
  if (payload.kind !== 'file') return
  const index = loadAudioCacheIndex()
  index[audioCacheKey(bookId, audioChapter.chapterId)] = {
    bookId,
    chapterId: audioChapter.chapterId,
    audioChapter,
    filePath: payload.filePath,
    sizeBytes: payload.sizeBytes || audioChapter.sizeBytes,
    cachedAt: new Date().toISOString(),
    updatedAt: audioChapter.updatedAt,
  }
  saveAudioCacheIndex(index)
}

function readCachedAudio(bookId: string, chapterId: string): CachedAudio | null {
  const record = loadAudioCacheIndex()[audioCacheKey(bookId, chapterId)]
  if (!record?.filePath) return null
  return {
    filePath: record.filePath,
    manifest: null,
    sizeBytes: record.sizeBytes,
  }
}

async function listCachedAudioChapterIds(bookId: string) {
  return Object.values(loadAudioCacheIndex())
    .filter((record) => record.bookId === bookId)
    .map((record) => record.chapterId)
}

function loadAudioCacheIndex(): Record<string, CachedAudioRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(audioCacheIndexKey) || '{}') as unknown
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, CachedAudioRecord] => {
        const record = entry[1]
        return (
          isRecord(record) &&
          typeof record.bookId === 'string' &&
          typeof record.chapterId === 'string' &&
          typeof record.filePath === 'string' &&
          isAudioChapter(record.audioChapter)
        )
      }),
    )
  } catch {
    return {}
  }
}

function saveAudioCacheIndex(index: Record<string, CachedAudioRecord>) {
  try {
    localStorage.setItem(audioCacheIndexKey, JSON.stringify(index))
  } catch {
    // Audio files remain on disk; this only affects the cached-count display.
  }
}

function audioCacheKey(bookId: string, chapterId: string) {
  return `${bookId}:${chapterId}`
}

function buildBookCacheSummaries(books: BookSummary[], version: number): BookCacheSummary[] {
  void version
  const bookTitles = new Map(books.map((book) => [book.id, book.title]))
  const packageIndex = loadFullPackageCacheIndex()
  const audioIndex = loadAudioCacheIndex()
  const bookIds = new Set<string>([...bookTitles.keys(), ...Object.keys(packageIndex), ...Object.values(audioIndex).map((record) => record.bookId)])
  return Array.from(bookIds)
    .map((bookId) => {
      const audioRecords = Object.values(audioIndex).filter((record) => record.bookId === bookId)
      const audioSizeBytes = audioRecords.reduce((total, record) => total + (record.sizeBytes ?? record.audioChapter.sizeBytes ?? 0), 0)
      const packageCache = packageIndex[bookId] ?? null
      return {
        bookId,
        title: bookTitles.get(bookId) ?? packageCache?.bookId ?? bookId,
        packageCache,
        audioCount: audioRecords.length,
        audioSizeBytes,
        totalSizeBytes: audioSizeBytes + (packageCache?.sizeBytes ?? 0),
      }
    })
    .filter((summary) => summary.packageCache || summary.audioCount > 0)
    .sort((left, right) => right.totalSizeBytes - left.totalSizeBytes || left.title.localeCompare(right.title))
}

function openPackageCacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available.'))
      return
    }

    const request = indexedDB.open(packageCacheDbName, 3)
    request.onerror = () => reject(request.error ?? new Error('Failed to open package cache.'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(packageCacheStoreName)) {
        db.createObjectStore(packageCacheStoreName, { keyPath: 'bookId' })
      }
      if (db.objectStoreNames.contains(legacyAudioCacheStoreName)) {
        db.deleteObjectStore(legacyAudioCacheStoreName)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function clearLegacyAudioIndexedDbCache() {
  try {
    const db = await openPackageCacheDb()
    db.close()
  } catch {
    // Best effort cleanup for old audio Blob records.
  }
}

function runPackageStoreRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  storeName: string,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = createRequest(transaction.objectStore(storeName))
    request.onerror = () => reject(request.error ?? new Error('Package cache request failed.'))
    request.onsuccess = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('Package cache transaction failed.'))
  })
}

function isChapter(value: unknown): value is Chapter {
  return normalizeChapter(value) !== null
}

function normalizeChapter(value: unknown): Chapter | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id).trim() : ''
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (!id || !title) return null
  const index = readOptionalInteger(value.index)
  const chapterIndex = readOptionalInteger(value.chapterIndex)
  return {
    ...value,
    id,
    title,
    index,
    chapterIndex,
  } as Chapter
}

function isAudioChapter(value: unknown): value is AudioChapter {
  if (!isRecord(value)) return false
  return typeof value.chapterId === 'string' && typeof value.fileName === 'string'
}

function normalizeAudioManifest(value: Record<string, unknown>): AudioManifest | null {
  const timeline = Array.isArray(value.timeline) ? value.timeline.filter(isAudioTimelineEntry) : []
  return {
    version: readOptionalInteger(value.version),
    timelineVersion: readOptionalInteger(value.timelineVersion),
    duration: typeof value.duration === 'number' ? value.duration : undefined,
    timeline,
  }
}

function isAudioTimelineEntry(value: unknown): value is AudioTimelineEntry {
  if (!isRecord(value)) return false
  return typeof value.startTime === 'number' && typeof value.endTime === 'number'
}

function findActiveTimelineEntry(manifest: AudioManifest | null, currentTime: number) {
  const timeline = manifest?.timeline
  if (!timeline?.length) return null
  return (
    timeline.find((entry) => {
      const start = entry.startTime ?? 0
      const end = entry.nextStartTime ?? entry.endTime ?? start
      return currentTime >= start && currentTime < end
    }) ?? null
  )
}

function splitHighlightedText(text: string, activeEntry?: AudioTimelineEntry | null) {
  if (!activeEntry) return null
  const start = readBoundedIndex(activeEntry.sourceStart, text.length)
  const end = readBoundedIndex(activeEntry.sourceEnd, text.length)
  if (start == null || end == null || end <= start) return null
  return {
    before: text.slice(0, start),
    active: text.slice(start, end),
    after: text.slice(end),
  }
}

function readBoundedIndex(value: unknown, length: number) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return Math.max(0, Math.min(length, value))
}

function readOptionalInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function normalizeFullPackageImportStats(value: unknown): FullPackageImportStats | undefined {
  if (!isRecord(value)) return undefined
  const graph = isRecord(value.knowledgeGraph) ? value.knowledgeGraph : undefined
  const embeddings = isRecord(value.embeddings) ? value.embeddings : undefined
  return {
    chapterCount: readOptionalInteger(value.chapterCount),
    summaryCount: readOptionalInteger(value.summaryCount),
    knowledgeGraph: graph
      ? {
          entityCount: readOptionalInteger(graph.entityCount),
          entityMentionCount: readOptionalInteger(graph.entityMentionCount),
          relationCount: readOptionalInteger(graph.relationCount),
          relationMentionCount: readOptionalInteger(graph.relationMentionCount),
        }
      : undefined,
    embeddings: embeddings
      ? {
          summaryCount: readOptionalInteger(embeddings.summaryCount),
          chunkCount: readOptionalInteger(embeddings.chunkCount),
        }
      : undefined,
  }
}

function fullPackageProgressLabel(progress: PackageSyncProgress | null) {
  if (!progress) return ''
  if (progress.phase === 'download') {
    const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : 0
    const done = typeof progress.done === 'number' ? progress.done : 0
    if (total > 0) return `下载 ${Math.min(100, Math.round((done / total) * 100))}%`
    return done > 0 ? `已下载 ${formatBytes(done)}` : '准备下载'
  }
  if (progress.phase === 'import') {
    if (progress.status === 'parsing') return '解析完整包'
    if (progress.status === 'summaries') return '导入摘要'
    if (progress.status === 'knowledgeGraph') return '导入图谱'
    if (progress.status === 'embeddings') return '导入向量'
    if (progress.status === 'imported') return '导入完成'
    return '导入中'
  }
  return ''
}

function inferredSummaryCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  if (hasImportedPackage(fullPackage)) return 1
  const importedSummaryCount = fullPackage?.importStats?.summaryCount ?? 0
  const importedChapterCount = fullPackage?.importStats?.chapterCount ?? 0
  if (importedChapterCount > 0) {
    return importedSummaryCount > 0 ? Math.min(1, importedSummaryCount / importedChapterCount) : 1
  }
  const summaries = bookPackage?.summaries
  const summaryCount = Array.isArray(summaries) ? summaries.length : isRecord(summaries) ? Object.keys(summaries).length : 0
  const chapterCount = bookPackage ? packageChapters(bookPackage).length : (book?.chapterCount ?? 0)
  return bookPackage && chapterCount > 0 ? Math.min(1, summaryCount / chapterCount) : 0
}

function inferredKgCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  void book
  return hasKnowledgeGraph(bookPackage) || hasImportedKnowledgeGraph(fullPackage) ? 1 : 0
}

function inferredEmbeddingCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  void book
  return hasEmbeddings(bookPackage) || hasImportedEmbeddings(fullPackage) ? 1 : 0
}

function hasImportedPackage(fullPackage: FullPackageCache | null) {
  return Boolean(fullPackage?.importStats || fullPackage?.importedAt || fullPackage?.metadataPath)
}

function hasKnowledgeGraph(bookPackage: BookPackage | null) {
  const graph = bookPackage?.knowledgeGraph
  return isRecord(graph) && (
    hasNonEmptyArray(graph.entities) ||
    hasNonEmptyArray(graph.relations) ||
    hasPositiveCount(graph.entityMentions) ||
    hasPositiveCount(graph.relationMentions)
  )
}

function hasEmbeddings(bookPackage: BookPackage | null) {
  const embeddings = bookPackage?.embeddings
  return isRecord(embeddings) && (
    hasNonEmptyArray(embeddings.summaries) ||
    hasNonEmptyArray(embeddings.chunks) ||
    hasPositiveCount(embeddings.summaries) ||
    hasPositiveCount(embeddings.chunks)
  )
}

function hasImportedKnowledgeGraph(fullPackage: FullPackageCache | null) {
  const graph = fullPackage?.importStats?.knowledgeGraph
  return Boolean(
    graph &&
      ((graph.entityCount ?? 0) > 0 ||
        (graph.relationCount ?? 0) > 0 ||
        (graph.entityMentionCount ?? 0) > 0 ||
        (graph.relationMentionCount ?? 0) > 0),
  )
}

function hasImportedEmbeddings(fullPackage: FullPackageCache | null) {
  const embeddings = fullPackage?.importStats?.embeddings
  return Boolean(embeddings && ((embeddings.summaryCount ?? 0) > 0 || (embeddings.chunkCount ?? 0) > 0))
}

function hasNonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0
}

function hasPositiveCount(value: unknown) {
  return isRecord(value) && typeof value.count === 'number' && value.count > 0
}

function audioButtonLabel(currentAudio: AudioChapter | null, loadingAudio: boolean) {
  if (loadingAudio) return '加载中'
  return currentAudio ? '播放' : '无音频'
}

function fullPackageLabel(cache: FullPackageCache | null, status: FullPackageStatus) {
  if (status === 'downloading') return '后台下载中'
  if (status === 'importing') return '导入中'
  if (cache?.importStats) return `已导入 ${formatBytes(cache.sizeBytes)}`
  if (cache) return `已下载 ${formatBytes(cache.sizeBytes)}`
  if (status === 'error') return '下载失败'
  return '未下载'
}

function formatDuration(durationMs?: number) {
  if (!durationMs) return '时长未知'
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatBytes(sizeBytes?: number) {
  if (!sizeBytes) return '大小未知'
  const mb = sizeBytes / 1024 / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}

export default App
