import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

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

type ConnectionState = 'idle' | 'checking' | 'connected' | 'error'
type GatewayTab = 'library' | 'reader' | 'settings'
type ReaderBackground = 'paper' | 'warm' | 'green' | 'dark'

type ReaderSettings = {
  fontSize: number
  background: ReaderBackground
}

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

const settingsKey = 'novel-reader-gateway-settings'
const readerSettingsKey = 'novel-reader-gateway-reader-settings'
const readingProgressKey = 'novel-reader-gateway-reading-progress'
const fullPackageCacheKey = 'novel-reader-gateway-full-package-cache'
const audioCacheIndexKey = 'novel-reader-gateway-audio-cache-index'
const packageCachePrefix = 'novel-reader-gateway-package:'
const packageCacheDbName = 'novel-reader-gateway'
const packageCacheStoreName = 'book-packages'
const legacyAudioCacheStoreName = 'chapter-audio'
const defaultGatewayBaseUrl = import.meta.env.VITE_GATEWAY_DEFAULT_BASE_URL ?? 'https://'
const defaultGatewayToken = import.meta.env.VITE_GATEWAY_DEFAULT_TOKEN ?? '123456'
const NativeAudio = registerPlugin<NativeAudioPlugin>('GatewayAudio')

const defaultSettings: GatewaySettings = {
  baseUrl: defaultGatewayBaseUrl,
  token: defaultGatewayToken,
  deviceName: 'Android Phone',
}

const defaultReaderSettings: ReaderSettings = {
  fontSize: 18,
  background: 'paper',
}

function App() {
  const [tab, setTab] = useState<GatewayTab>('library')
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings())
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => loadReaderSettings())
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
  const displaySummaryCoverage = inferredSummaryCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayKgCoverage = inferredKgCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayEmbeddingCoverage = inferredEmbeddingCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayAudioChapterCount =
    visibleAudioChapters.length || visibleCachedAudioIds.size || selectedBook?.audioChapterCount || 0
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
  const previousChapter = currentChapterPosition > 0 ? chapters[currentChapterPosition - 1] : null
  const nextChapter =
    currentChapterPosition >= 0 && currentChapterPosition < chapters.length - 1 ? chapters[currentChapterPosition + 1] : null
  const lastReaderCenterTapAtRef = useRef(0)
  const autoConnectAttemptedRef = useRef(false)
  const autoRestoreAttemptedRef = useRef(false)
  const lastReaderScrollYRef = useRef(0)
  const pendingRestoreScrollRef = useRef<number | null>(null)

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(readerSettingsKey, JSON.stringify(readerSettings))
  }, [readerSettings])

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
    if (tab !== 'reader' || !selectedBookId || !currentChapterId) return

    let saveTimer: number | undefined
    const save = () => {
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
      await refreshCachedAudioIds(nextSelectedBookId ?? null)
      setConnectionState('connected')
      setMessage(`书库 ${nextBooks.length} 本`)
      if (!autoRestoreAttemptedRef.current) {
        autoRestoreAttemptedRef.current = true
        await restoreLastReading(nextBooks)
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
    const cached = loadFullPackageCache()
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
    setAudioUrl((currentUrl) => {
      if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl)
      return null
    })
    setAudioManifest(null)
    setAudioTime(0)
  }

  function selectChapter(chapterId: string) {
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
                    onClick={() => void openBook(book.id)}
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
                <button className="primary-button full-width-button" type="button" onClick={() => switchTab('reader')} disabled={!bookPackage}>
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
              <div className="speech-control-panel">
                {audioUrl ? (
                  <audio
                    className="audio-player"
                    src={audioUrl}
                    controls
                    autoPlay
                    onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
                  />
                ) : (
                  <button className="tts-primary-action" type="button" onClick={() => void playCurrentAudio()} disabled={!currentAudio || loadingAudio}>
                    {audioButtonLabel(currentAudio, loadingAudio)}
                  </button>
                )}
              </div>
              <article
                className={`reader-card ${readerSettings.background}`}
                onClick={handleReaderTap}
                style={{ '--reader-font-size': `${readerSettings.fontSize}px` } as CSSProperties}
              >
                <h2>{currentChapter.title}</h2>
                <ChapterSummary bookPackage={bookPackage} chapter={currentChapter} />
                <div className="chapter-text">
                  <TextContent text={chapterContent(currentChapter)} activeEntry={activeTimelineEntry} />
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
                      <button type="button" onClick={() => setChapterPickerOpen(false)}>关闭</button>
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
                        <strong>语音阅读</strong>
                        <span>{audioUrl ? '正在播放' : currentAudio ? `${formatDuration(currentAudio.durationMs)} · ${formatBytes(currentAudio.sizeBytes)}` : '当前章节暂无音频'}</span>
                      </div>
                      {!audioUrl ? (
                        <button type="button" onClick={() => void playCurrentAudio()} disabled={!currentAudio || loadingAudio}>
                          {audioButtonLabel(currentAudio, loadingAudio)}
                        </button>
                      ) : null}
                      {audioUrl ? (
                        <audio
                          className="audio-player"
                          src={audioUrl}
                          controls
                          onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
                        />
                      ) : null}
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
        entry.chapterIndex === chapter.index ||
        entry.index === chapter.index ||
        entry.chapterIndex === chapter.chapterIndex ||
        entry.index === chapter.chapterIndex
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

function loadFullPackageCache(): FullPackageCache | null {
  try {
    const cached = localStorage.getItem(fullPackageCacheKey)
    if (!cached) return null
    const parsed = JSON.parse(cached) as unknown
    if (!isRecord(parsed)) return null
    if (typeof parsed.bookId !== 'string' || typeof parsed.filePath !== 'string') return null
    if (typeof parsed.sizeBytes !== 'number' || typeof parsed.cachedAt !== 'string') return null
    return {
      bookId: parsed.bookId,
      filePath: parsed.filePath,
      sizeBytes: parsed.sizeBytes,
      cachedAt: parsed.cachedAt,
      importedAt: typeof parsed.importedAt === 'string' ? parsed.importedAt : undefined,
      importStats: normalizeFullPackageImportStats(parsed.importStats),
      metadataPath: typeof parsed.metadataPath === 'string' ? parsed.metadataPath : undefined,
    }
  } catch {
    return null
  }
}

function saveFullPackageCache(cache: FullPackageCache) {
  localStorage.setItem(fullPackageCacheKey, JSON.stringify(cache))
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
  const importedSummaryCount = fullPackage?.importStats?.summaryCount ?? 0
  const importedChapterCount = fullPackage?.importStats?.chapterCount ?? 0
  if (importedSummaryCount > 0 && importedChapterCount > 0) {
    return Math.min(1, importedSummaryCount / importedChapterCount)
  }
  if (typeof book?.summaryCoverage === 'number' && book.summaryCoverage > 0) return book.summaryCoverage
  const summaries = bookPackage?.summaries
  const summaryCount = Array.isArray(summaries) ? summaries.length : isRecord(summaries) ? Object.keys(summaries).length : 0
  const chapterCount = bookPackage ? packageChapters(bookPackage).length : (book?.chapterCount ?? 0)
  return chapterCount > 0 ? Math.min(1, summaryCount / chapterCount) : book?.summaryCoverage
}

function inferredKgCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  if (typeof book?.kgCoverage === 'number' && book.kgCoverage > 0) return book.kgCoverage
  return hasKnowledgeGraph(bookPackage) || hasImportedKnowledgeGraph(fullPackage) ? 1 : book?.kgCoverage
}

function inferredEmbeddingCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  if (typeof book?.embeddingCoverage === 'number' && book.embeddingCoverage > 0) return book.embeddingCoverage
  if (hasEmbeddings(bookPackage) || hasImportedEmbeddings(fullPackage)) return 1
  return book?.embeddingCoverage
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
