import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'

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
  kg?: unknown
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

const settingsKey = 'novel-reader-gateway-settings'
const readerSettingsKey = 'novel-reader-gateway-reader-settings'
const readingProgressKey = 'novel-reader-gateway-reading-progress'
const packageCachePrefix = 'novel-reader-gateway-package:'
const packageCacheDbName = 'novel-reader-gateway'
const packageCacheStoreName = 'book-packages'
const audioCacheStoreName = 'chapter-audio'
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
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [bookPackage, setBookPackage] = useState<BookPackage | null>(null)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null)
  const [audioChapters, setAudioChapters] = useState<AudioChapter[]>([])
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioManifest, setAudioManifest] = useState<AudioManifest | null>(null)
  const [audioTime, setAudioTime] = useState(0)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [loadingPackage, setLoadingPackage] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [cachedAudioIds, setCachedAudioIds] = useState<Set<string>>(() => new Set())
  const [audioSyncProgress, setAudioSyncProgress] = useState<{ done: number; total: number } | null>(null)

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const chapters = useMemo(() => packageChapters(bookPackage), [bookPackage])
  const currentChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === currentChapterId) ?? chapters[0] ?? null,
    [chapters, currentChapterId],
  )
  const currentAudio = useMemo(
    () => audioChapters.find((chapter) => chapter.chapterId === currentChapter?.id) ?? null,
    [audioChapters, currentChapter],
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
    if (autoConnectAttemptedRef.current || !isGatewayConfigured(settings)) return
    autoConnectAttemptedRef.current = true
    void checkSession()
  }, [settings.baseUrl, settings.token])

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

  async function refreshBooks() {
    setLoadingBooks(true)
    setMessage('')
    try {
      const response = await gatewayFetch(settings, '/mobile/books')
      const nextBooks = Array.isArray(response.books) ? (response.books as BookSummary[]) : []
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

  async function openBook(bookId: string, options: { restoreProgress?: ReadingProgress | null } = {}) {
    setSelectedBookId(bookId)
    setLoadingPackage(true)
    setMessage('')
    setAudioChapters([])
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

  async function refreshAudio(bookId = selectedBookId, showMessage = true) {
    if (!bookId) return
    setLoadingAudio(true)
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
      const nextAudioChapters = Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
      setAudioChapters(nextAudioChapters)
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
      const cachedAudio = await readAudioFromIndexedDb(selectedBookId, currentChapter.id)
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
        const cached = await cacheAudioChapter(selectedBookId, currentAudio, manifest)
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
      return
    }
    const ids = await listCachedAudioChapterIds(bookId)
    setCachedAudioIds(new Set(ids))
  }

  async function syncCurrentBookAudio() {
    if (!selectedBookId) return
    let chaptersToSync = audioChapters
    if (chaptersToSync.length === 0) {
      await refreshAudio(selectedBookId, false)
      chaptersToSync = await fetchAudioCatalog(selectedBookId)
      setAudioChapters(chaptersToSync)
    }
    if (chaptersToSync.length === 0) {
      setMessage('当前书籍暂无音频')
      return
    }

    setLoadingAudio(true)
    setAudioSyncProgress({ done: 0, total: chaptersToSync.length })
    try {
      let done = 0
      for (const audioChapter of chaptersToSync) {
        const cached = await readAudioFromIndexedDb(selectedBookId, audioChapter.chapterId)
        if (!cached) {
          await cacheAudioChapter(selectedBookId, audioChapter, null)
        }
        done += 1
        setAudioSyncProgress({ done, total: chaptersToSync.length })
        setCachedAudioIds((current) => new Set(current).add(audioChapter.chapterId))
      }
      await refreshCachedAudioIds(selectedBookId)
      setMessage(`音频已缓存 ${chaptersToSync.length}/${chaptersToSync.length} 章`)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setLoadingAudio(false)
      setAudioSyncProgress(null)
    }
  }

  async function fetchAudioCatalog(bookId: string) {
    const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
    return Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
  }

  async function cacheAudioChapter(bookId: string, audioChapter: AudioChapter, manifest: AudioManifest | null): Promise<AudioCachePayload> {
    if (Capacitor.isNativePlatform()) {
      const downloaded = await downloadAudioToNativeFile(settings, bookId, audioChapter.chapterId)
      const payload: AudioCachePayload = {
        kind: 'file',
        filePath: downloaded.filePath,
        sizeBytes: downloaded.sizeBytes,
      }
      await writeAudioToIndexedDb(bookId, audioChapter, payload, manifest)
      return payload
    }

    const blob = await gatewayFetchBlob(
      settings,
      `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(audioChapter.chapterId)}/download`,
    )
    const payload: AudioCachePayload = { kind: 'blob', blob }
    await writeAudioToIndexedDb(bookId, audioChapter, payload, manifest)
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
                    <dd>{selectedBook.audioChapterCount ?? 0} 章</dd>
                  </div>
                  <div>
                    <dt>更新</dt>
                    <dd>{formatDate(selectedBook.updatedAt)}</dd>
                  </div>
                </dl>
                <div className="coverage-row">
                  <Coverage label="概要" value={selectedBook.summaryCoverage} />
                  <Coverage label="图谱" value={selectedBook.kgCoverage} />
                  <Coverage label="向量" value={selectedBook.embeddingCoverage} />
                </div>
                <div className="package-line">
                  <span>Package</span>
                  <strong>{bookPackage ? packageSummary(bookPackage) : '未加载'}</strong>
                </div>
                <div className="package-line">
                  <span>Audio</span>
                  <strong>
                    {audioSyncProgress
                      ? `${audioSyncProgress.done}/${audioSyncProgress.total}`
                      : loadingAudio
                        ? '同步中'
                        : `${cachedAudioIds.size}/${audioChapters.length || selectedBook.audioChapterCount || 0} 已缓存`}
                  </strong>
                </div>
                <button
                  className="secondary-button full-width-button"
                  type="button"
                  onClick={() => void syncCurrentBookAudio()}
                  disabled={!selectedBookId || loadingAudio}
                >
                  {audioSyncProgress ? `同步音频 ${audioSyncProgress.done}/${audioSyncProgress.total}` : '同步 Audio'}
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
              <div className="reader-toolbar">
                <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                  {chapters.map((chapter, index) => (
                    <option key={chapter.id} value={chapter.id}>
                      {index + 1}. {chapter.title}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                  上一章
                </button>
                <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                  下一章
                </button>
              </div>
              {message ? <div className={`status-line reader-status status-${connectionState}`}>{message}</div> : null}
              <article
                className={`reading-surface ${readerSettings.background}`}
                onClick={handleReaderTap}
                style={{ '--reader-font-size': `${readerSettings.fontSize}px` } as CSSProperties}
              >
                <h1>{currentChapter.title}</h1>
                {activeTimelineEntry?.text ? (
                  <div className="now-playing">
                    <span>正在播放</span>
                    <strong>{activeTimelineEntry.text}</strong>
                  </div>
                ) : null}
                <TextContent text={chapterContent(currentChapter)} activeEntry={activeTimelineEntry} />
                <div className="reader-bottom-nav">
                  <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                    上一章
                  </button>
                  <button type="button" onClick={() => setChapterPickerOpen(true)}>
                    章节
                  </button>
                  <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                    下一章
                  </button>
                </div>
              </article>
              {audioUrl ? (
                <div className="audio-dock">
                  <audio
                    className="audio-player"
                    src={audioUrl}
                    controls
                    autoPlay
                    onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
                  />
                </div>
              ) : null}
              {chapterPickerOpen ? (
                <div className="chapter-picker-overlay" role="presentation" onClick={() => setChapterPickerOpen(false)}>
                  <section className="chapter-picker-sheet" role="dialog" aria-modal="true" aria-label="阅读控制" onClick={(event) => event.stopPropagation()}>
                    <div className="chapter-picker-header">
                      <div>
                        <strong>阅读控制</strong>
                        <span>{currentChapterPosition + 1}/{chapters.length}</span>
                      </div>
                      <button type="button" onClick={() => setChapterPickerOpen(false)}>关闭</button>
                    </div>
                    <label className="chapter-select-field">
                      <span>章节</span>
                      <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                        {chapters.map((chapter, index) => (
                          <option key={chapter.id} value={chapter.id}>
                            {index + 1}. {chapter.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="chapter-picker-actions">
                      <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                        上一章
                      </button>
                      <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                        下一章
                      </button>
                    </div>
                    <div className="reader-menu-group">
                      <strong>音频</strong>
                      <div className="audio-action-row">
                        <button type="button" onClick={() => void playCurrentAudio()} disabled={!currentAudio || loadingAudio}>
                          {audioButtonLabel(currentAudio, loadingAudio)}
                        </button>
                        <span>{currentAudio ? `${formatDuration(currentAudio.durationMs)} · ${formatBytes(currentAudio.sizeBytes)}` : '当前章节暂无音频'}</span>
                      </div>
                      {audioUrl ? (
                        <audio
                          className="audio-player"
                          src={audioUrl}
                          controls
                          onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
                        />
                      ) : null}
                    </div>
                    <div className="reader-menu-group">
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
                    </div>
                    <div className="reader-menu-group">
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
                <dd>{cachedAudioIds.size}/{audioChapters.length || selectedBook?.audioChapterCount || 0} 章</dd>
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

function Coverage({ label, value }: { label: string; value?: number }) {
  const percent = typeof value === 'number' ? Math.round(value * 100) : 0
  return (
    <div className="coverage">
      <span>{label}</span>
      <div className="meter">
        <div style={{ width: `${percent}%` }} />
      </div>
      <strong>{percent}%</strong>
    </div>
  )
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

async function writeAudioToIndexedDb(bookId: string, audioChapter: AudioChapter, payload: AudioCachePayload, manifest: AudioManifest | null) {
  const db = await openPackageCacheDb()
  try {
    await runPackageStoreRequest(db, 'readwrite', audioCacheStoreName, (store) =>
      store.put({
        id: audioCacheKey(bookId, audioChapter.chapterId),
        bookId,
        chapterId: audioChapter.chapterId,
        audioChapter,
        blob: payload.kind === 'blob' ? payload.blob : undefined,
        filePath: payload.kind === 'file' ? payload.filePath : undefined,
        manifest,
        sizeBytes: payload.kind === 'blob' ? payload.blob.size || audioChapter.sizeBytes : payload.sizeBytes || audioChapter.sizeBytes,
        cachedAt: new Date().toISOString(),
        updatedAt: audioChapter.updatedAt,
      }),
    )
  } finally {
    db.close()
  }
}

async function readAudioFromIndexedDb(bookId: string, chapterId: string): Promise<CachedAudio | null> {
  try {
    const db = await openPackageCacheDb()
    try {
      const record = await runPackageStoreRequest(db, 'readonly', audioCacheStoreName, (store) => store.get(audioCacheKey(bookId, chapterId)))
      if (!isRecord(record)) return null
      const blob = record.blob instanceof Blob ? record.blob : undefined
      const filePath = typeof record.filePath === 'string' ? record.filePath : undefined
      if (!blob && !filePath) return null
      return {
        blob,
        filePath,
        manifest: isRecord(record.manifest) ? normalizeAudioManifest(record.manifest) : null,
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

async function listCachedAudioChapterIds(bookId: string) {
  try {
    const db = await openPackageCacheDb()
    try {
      const records = await runPackageStoreRequest(db, 'readonly', audioCacheStoreName, (store) => store.getAll())
      return Array.isArray(records)
        ? records
            .filter((record): record is Record<string, unknown> => isRecord(record) && record.bookId === bookId && typeof record.chapterId === 'string')
            .map((record) => record.chapterId as string)
        : []
    } finally {
      db.close()
    }
  } catch {
    return []
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

    const request = indexedDB.open(packageCacheDbName, 2)
    request.onerror = () => reject(request.error ?? new Error('Failed to open package cache.'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(packageCacheStoreName)) {
        db.createObjectStore(packageCacheStoreName, { keyPath: 'bookId' })
      }
      if (!db.objectStoreNames.contains(audioCacheStoreName)) {
        db.createObjectStore(audioCacheStoreName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
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

function audioButtonLabel(currentAudio: AudioChapter | null, loadingAudio: boolean) {
  if (loadingAudio) return '加载中'
  return currentAudio ? '播放' : '无音频'
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
