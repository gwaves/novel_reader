import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

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

const settingsKey = 'novel-reader-gateway-settings'
const packageCachePrefix = 'novel-reader-gateway-package:'
const packageCacheDbName = 'novel-reader-gateway'
const packageCacheStoreName = 'book-packages'

const defaultSettings: GatewaySettings = {
  baseUrl: 'https://',
  token: '',
  deviceName: 'Android Phone',
}

function App() {
  const [tab, setTab] = useState<GatewayTab>('library')
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings())
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

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

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
      setConnectionState('connected')
      setMessage(`书库 ${nextBooks.length} 本`)
    } catch (error) {
      setConnectionState('error')
      setMessage(errorMessage(error))
    } finally {
      setLoadingBooks(false)
    }
  }

  async function openBook(bookId: string) {
    setSelectedBookId(bookId)
    setLoadingPackage(true)
    setMessage('')
    setAudioChapters([])
    clearAudioUrl()
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      const nextPackage = normalizeBookPackage(response.package)
      setBookPackage(nextPackage)
      setCurrentChapterId(packageChapters(nextPackage)[0]?.id ?? null)
      const cached = await cacheBookPackage(bookId, nextPackage)
      setMessage(cached ? '数据包已加载' : '数据包已加载，缓存空间不足')
      await refreshAudio(bookId, false)
      setTab('reader')
    } catch (error) {
      const cachedPackage = await loadCachedBookPackage(bookId)
      setBookPackage(cachedPackage)
      setCurrentChapterId(packageChapters(cachedPackage)[0]?.id ?? null)
      setMessage(cachedPackage ? `已使用本地缓存：${errorMessage(error)}` : errorMessage(error))
      if (cachedPackage) setTab('reader')
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
      const manifest = currentAudio?.manifestFileName
        ? await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(selectedBookId)}/audio/${encodeURIComponent(currentChapter.id)}/manifest`)
            .then(normalizeAudioManifest)
            .catch(() => null)
        : null
      const blob = await gatewayFetchBlob(
        settings,
        `/mobile/books/${encodeURIComponent(selectedBookId)}/audio/${encodeURIComponent(currentChapter.id)}/download`,
      )
      clearAudioUrl()
      setAudioManifest(manifest)
      setAudioTime(0)
      setAudioUrl(URL.createObjectURL(blob))
      setMessage('音频已加载')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setLoadingAudio(false)
    }
  }

  function clearAudioUrl() {
    setAudioUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      return null
    })
    setAudioManifest(null)
    setAudioTime(0)
  }

  function selectChapter(chapterId: string) {
    setCurrentChapterId(chapterId)
    setChapterPickerOpen(false)
    clearAudioUrl()
    window.scrollTo({ top: 0 })
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
                <button type="button" onClick={() => setTab('settings')}>去设置连接</button>
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
                  <strong>{loadingAudio ? '同步中' : `${audioChapters.length} 章`}</strong>
                </div>
                <button className="primary-button full-width-button" type="button" onClick={() => setTab('reader')} disabled={!bookPackage}>
                  开始阅读
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <p>选择书籍</p>
                <button type="button" onClick={() => setTab('settings')}>同步书库</button>
              </div>
            )}
          </div>
        </section>
      ) : tab === 'reader' ? (
        <section className="reader-page">
          {!bookPackage || !currentChapter ? (
            <div className="empty-state reader-empty">
              <p>请选择一本书。</p>
              <button type="button" onClick={() => setTab('library')}>回到书库</button>
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
              <article className="reading-surface" onClick={handleReaderTap}>
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
                  <section className="chapter-picker-sheet" role="dialog" aria-modal="true" aria-label="选择章节" onClick={(event) => event.stopPropagation()}>
                    <div className="chapter-picker-header">
                      <div>
                        <strong>选择章节</strong>
                        <span>{currentChapterPosition + 1}/{chapters.length}</span>
                      </div>
                      <button type="button" onClick={() => setChapterPickerOpen(false)}>关闭</button>
                    </div>
                    <div className="chapter-picker-actions">
                      <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                        上一章
                      </button>
                      <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                        下一章
                      </button>
                    </div>
                    <div className="chapter-picker-list">
                      {chapters.map((chapter, index) => (
                        <button
                          className={chapter.id === currentChapter.id ? 'active' : ''}
                          key={chapter.id}
                          type="button"
                          onClick={() => selectChapter(chapter.id)}
                        >
                          {index + 1}. {chapter.title}
                        </button>
                      ))}
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
                {connectionState === 'checking' ? '连接中' : '连接'}
              </button>
              <button className="secondary-button" type="button" onClick={() => void refreshBooks()} disabled={loadingBooks}>
                {loadingBooks ? '同步中' : '同步书库'}
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
                <dd>{audioChapters.length} 章</dd>
              </div>
            </dl>
          </section>
        </section>
      )}

      <nav className="bottom-nav" aria-label="主导航">
        <button className={tab === 'library' ? 'active' : ''} type="button" onClick={() => setTab('library')}>
          书库
        </button>
        <button className={tab === 'reader' ? 'active' : ''} type="button" onClick={() => setTab('reader')}>
          阅读
        </button>
        <button className={tab === 'settings' ? 'active' : ''} type="button" onClick={() => setTab('settings')}>
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
    await runPackageStoreRequest(db, 'readwrite', (store) =>
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
    const record = await runPackageStoreRequest(db, 'readonly', (store) => store.get(bookId))
    db.close()
    if (!isRecord(record)) return null
    return normalizeBookPackage(record.package)
  } catch {
    return null
  }
}

function openPackageCacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available.'))
      return
    }

    const request = indexedDB.open(packageCacheDbName, 1)
    request.onerror = () => reject(request.error ?? new Error('Failed to open package cache.'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(packageCacheStoreName)) {
        db.createObjectStore(packageCacheStoreName, { keyPath: 'bookId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function runPackageStoreRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(packageCacheStoreName, mode)
    const request = createRequest(transaction.objectStore(packageCacheStoreName))
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
