import { useEffect, useMemo, useState } from 'react'

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
  chapterIndex?: number
}

type AudioChapter = {
  chapterId: string
  title?: string
  fileName: string
  durationMs?: number
  sizeBytes?: number
  updatedAt?: string
}

type ConnectionState = 'idle' | 'checking' | 'connected' | 'error'

const settingsKey = 'novel-reader-gateway-settings'
const packageCachePrefix = 'novel-reader-gateway-package:'

const defaultSettings: GatewaySettings = {
  baseUrl: 'https://',
  token: '',
  deviceName: 'Android Phone',
}

function App() {
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings())
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [message, setMessage] = useState('')
  const [books, setBooks] = useState<BookSummary[]>([])
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [bookPackage, setBookPackage] = useState<BookPackage | null>(null)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null)
  const [audioChapters, setAudioChapters] = useState<AudioChapter[]>([])
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [loadingPackage, setLoadingPackage] = useState(false)

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
      cacheBookPackage(bookId, nextPackage)
      setMessage('数据包已加载')
      await refreshAudio(bookId, false)
    } catch (error) {
      const cachedPackage = loadCachedBookPackage(bookId)
      setBookPackage(cachedPackage)
      setCurrentChapterId(packageChapters(cachedPackage)[0]?.id ?? null)
      setMessage(cachedPackage ? `已使用本地缓存：${errorMessage(error)}` : errorMessage(error))
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
    setLoadingAudio(true)
    try {
      const blob = await gatewayFetchBlob(
        settings,
        `/mobile/books/${encodeURIComponent(selectedBookId)}/audio/${encodeURIComponent(currentChapter.id)}/download`,
      )
      clearAudioUrl()
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
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Novel Gateway</h1>
          <p>{connectionLabel(connectionState)}</p>
        </div>
        <button className="icon-button" type="button" onClick={() => void refreshBooks()} disabled={loadingBooks}>
          刷新
        </button>
      </header>

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
        <button className="primary-button" type="button" onClick={() => void checkSession()} disabled={connectionState === 'checking'}>
          {connectionState === 'checking' ? '连接中' : '连接'}
        </button>
      </section>

      {message ? <div className={`status-line status-${connectionState}`}>{message}</div> : null}

      <section className="content-grid">
        <div className="book-list">
          <div className="section-title">
            <h2>书库</h2>
            <span>{loadingBooks ? '同步中' : `${books.length} 本`}</span>
          </div>
          {books.length === 0 ? (
            <div className="empty-state">暂无书籍</div>
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
            <h2>{selectedBook?.title ?? '详情'}</h2>
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
              {bookPackage ? (
                <div className="reader-panel">
                  <div className="chapter-strip">
                    {chapters.length === 0 ? (
                      <span className="chapter-placeholder">暂无章节</span>
                    ) : (
                      chapters.map((chapter, index) => (
                        <button
                          key={chapter.id}
                          className={chapter.id === currentChapter?.id ? 'chapter-chip active' : 'chapter-chip'}
                          type="button"
                          onClick={() => setCurrentChapterId(chapter.id)}
                        >
                          {chapter.title || `第 ${index + 1} 章`}
                        </button>
                      ))
                    )}
                  </div>
                  <article className="reader-text">
                    <div className="reader-heading">
                      <h3>{currentChapter?.title ?? '正文'}</h3>
                      <button
                        type="button"
                        className="audio-button"
                        onClick={() => void playCurrentAudio()}
                        disabled={!currentAudio || loadingAudio}
                      >
                        {currentAudio ? '播放' : '无音频'}
                      </button>
                    </div>
                    {audioUrl ? <audio className="audio-player" src={audioUrl} controls autoPlay /> : null}
                    {currentChapter ? (
                      <TextContent text={chapterContent(currentChapter)} />
                    ) : (
                      <p className="muted-text">数据包中没有可显示的章节正文。</p>
                    )}
                  </article>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">选择书籍</div>
          )}
        </div>
      </section>
    </main>
  )
}

function TextContent({ text }: { text: string }) {
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

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${settings.token.trim()}`,
      'x-device-name': settings.deviceName.trim() || 'Android Phone',
    },
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

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${settings.token.trim()}`,
      'x-device-name': settings.deviceName.trim() || 'Android Phone',
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(body.error?.message || `Gateway HTTP ${response.status}`)
  }
  return response.blob()
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
    const leftIndex = left.chapterIndex ?? 0
    const rightIndex = right.chapterIndex ?? 0
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

  const rawChapters = Array.isArray(value.chapters) ? value.chapters.filter(isChapter) : []
  return {
    ...value,
    schemaVersion: 1,
    book: value.book as BookSummary,
    chapters: rawChapters,
  }
}

function cacheBookPackage(bookId: string, bookPackage: BookPackage) {
  localStorage.setItem(`${packageCachePrefix}${bookId}`, JSON.stringify(bookPackage))
}

function loadCachedBookPackage(bookId: string): BookPackage | null {
  try {
    const cached = localStorage.getItem(`${packageCachePrefix}${bookId}`)
    return cached ? normalizeBookPackage(JSON.parse(cached) as unknown) : null
  } catch {
    return null
  }
}

function isChapter(value: unknown): value is Chapter {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.title === 'string'
}

function isAudioChapter(value: unknown): value is AudioChapter {
  if (!isRecord(value)) return false
  return typeof value.chapterId === 'string' && typeof value.fileName === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}

export default App
