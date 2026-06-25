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
  chapters?: unknown[]
  summaries?: unknown
  kg?: unknown
  embeddings?: unknown
}

type ConnectionState = 'idle' | 'checking' | 'connected' | 'error'

const settingsKey = 'novel-reader-gateway-settings'

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
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [loadingPackage, setLoadingPackage] = useState(false)

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

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
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      setBookPackage(response.package as BookPackage)
      setMessage('数据包已加载')
    } catch (error) {
      setBookPackage(null)
      setMessage(errorMessage(error))
    } finally {
      setLoadingPackage(false)
    }
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
            </div>
          ) : (
            <div className="empty-state">选择书籍</div>
          )}
        </div>
      </section>
    </main>
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
  const chapterCount = Array.isArray(bookPackage.chapters) ? bookPackage.chapters.length : 0
  return chapterCount > 0 ? `${chapterCount} 章` : '已加载'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}

export default App
