import { useEffect, useMemo, useState } from 'react'
import { MobileApiClient, type MobileBookListItem, type MobileBookPackage } from './lib/mobileApi'
import {
  getBookPackage,
  listLocalBooks,
  loadSettings,
  saveBookPackage,
  saveSettings,
  type LocalBook,
} from './lib/localLibrary'

type Tab = 'library' | 'sync' | 'reader' | 'search'

type SearchResult = {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  snippet: string
}

function formatCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万`
  return String(count)
}

function formatSyncDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

function findSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, ' ')
  const index = normalizedText.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return normalizedText.slice(0, 120)
  const start = Math.max(0, index - 48)
  const end = Math.min(normalizedText.length, index + query.length + 96)
  return `${start > 0 ? '...' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '...' : ''}`
}

function App() {
  const [tab, setTab] = useState<Tab>('library')
  const [baseUrl, setBaseUrl] = useState('')
  const [syncToken, setSyncToken] = useState('')
  const [remoteBooks, setRemoteBooks] = useState<MobileBookListItem[]>([])
  const [localBooks, setLocalBooks] = useState<LocalBook[]>([])
  const [activePackage, setActivePackage] = useState<MobileBookPackage | null>(null)
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const client = useMemo(() => new MobileApiClient({ baseUrl, syncToken }), [baseUrl, syncToken])

  const activeChapter = useMemo(() => {
    if (!activePackage || !activeChapterId) return null
    return activePackage.chapters.find((chapter) => chapter.id === activeChapterId) ?? null
  }, [activeChapterId, activePackage])

  const activeSummary = activeChapter ? activePackage?.summaries.find((summary) => summary.chapterId === activeChapter.id) : null

  const searchResults = useMemo<SearchResult[]>(() => {
    const query = searchQuery.trim()
    if (!activePackage || !query) return []

    return activePackage.chapters
      .map((chapter) => {
        const summary = activePackage.summaries.find((entry) => entry.chapterId === chapter.id)
        const haystack = `${chapter.title}\n${summary?.short ?? ''}\n${summary?.detail ?? ''}\n${chapter.content}`
        if (!haystack.toLowerCase().includes(query.toLowerCase())) return null
        return {
          chapterId: chapter.id,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          snippet: findSnippet(haystack, query),
        }
      })
      .filter((result): result is SearchResult => Boolean(result))
      .slice(0, 30)
  }, [activePackage, searchQuery])

  useEffect(() => {
    void hydrate()
  }, [])

  async function hydrate() {
    const [settings, books] = await Promise.all([loadSettings(), listLocalBooks()])
    setBaseUrl(settings.baseUrl)
    setSyncToken(settings.syncToken)
    setLocalBooks(books)
  }

  async function persistSettings() {
    await saveSettings({ baseUrl, syncToken })
    setMessage('同步配置已保存。')
  }

  async function testConnection() {
    setIsBusy(true)
    setMessage('')
    try {
      const manifest = await client.getManifest()
      setMessage(`连接成功：schema v${manifest.schemaVersion}，服务时间 ${new Date(manifest.generatedAt).toLocaleString()}。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function loadRemoteBooks() {
    setIsBusy(true)
    setMessage('')
    try {
      await persistSettings()
      const books = await client.listBooks()
      setRemoteBooks(books)
      setMessage(`发现 ${books.length} 本可同步书籍。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取 PC 书架失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function downloadBook(bookId: string) {
    setIsBusy(true)
    setMessage('')
    try {
      const pkg = await client.downloadBookPackage(bookId)
      await saveBookPackage(pkg)
      setLocalBooks(await listLocalBooks())
      setActivePackage(pkg)
      setActiveChapterId(pkg.chapters[0]?.id ?? null)
      setTab('reader')
      setMessage(`已同步《${pkg.book.title}》。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同步书籍失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function openLocalBook(bookId: string) {
    const pkg = await getBookPackage(bookId)
    if (!pkg) {
      setMessage('本地书籍不存在，请重新同步。')
      return
    }
    setActivePackage(pkg)
    setActiveChapterId(pkg.chapters[0]?.id ?? null)
    setTab('reader')
  }

  function openChapter(chapterId: string) {
    setActiveChapterId(chapterId)
    setTab('reader')
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>{activePackage?.book.title ?? 'Novel Reader Mobile'}</h1>
          <p>{activePackage ? `${activePackage.book.chapterCount} 章 · ${formatCount(activePackage.book.wordCount)} 字` : '离线阅读与同步'}</p>
        </div>
        <button type="button" onClick={() => setTab('sync')}>同步</button>
      </header>

      <main className="main-panel">
        {message && <div className="status-line">{message}</div>}

        {tab === 'library' && (
          <section>
            <h2>本地书架</h2>
            {localBooks.length === 0 ? (
              <div className="empty-state">
                <p>还没有离线书籍。</p>
                <button type="button" onClick={() => setTab('sync')}>连接 PC 同步</button>
              </div>
            ) : (
              <div className="book-list">
                {localBooks.map((book) => (
                  <button className="book-row" key={book.id} type="button" onClick={() => void openLocalBook(book.id)}>
                    <span>
                      <strong>{book.title}</strong>
                      <small>
                        {book.chapterCount} 章 · 摘要 {book.summaryCount}/{book.chapterCount} ·
                        图谱 {book.entityCount} 实体/{book.relationCount} 关系
                      </small>
                    </span>
                    <small>已同步 {formatSyncDate(book.syncedAt)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'sync' && (
          <section>
            <h2>PC 同步</h2>
            <label className="field">
              <span>PC API 地址</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.1.8:5174" />
            </label>
            <label className="field">
              <span>同步 Token</span>
              <input value={syncToken} onChange={(event) => setSyncToken(event.target.value)} placeholder="开发期可为空" />
            </label>
            <div className="button-row">
              <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存</button>
              <button type="button" onClick={() => void testConnection()} disabled={isBusy || !baseUrl}>测试连接</button>
              <button type="button" onClick={() => void loadRemoteBooks()} disabled={isBusy || !baseUrl}>读取书架</button>
            </div>
            <div className="book-list">
              {remoteBooks.map((book) => (
                <article className="remote-book" key={book.id}>
                  <div>
                    <h3>{book.title}</h3>
                    <p>
                      {book.chapterCount} 章 · 摘要 {book.summaryCoverage.completed}/{book.summaryCoverage.total} ·
                      图谱 {book.graphCoverage.entityCount} 实体/{book.graphCoverage.relationCount} 关系
                    </p>
                    <p>
                      Embedding {book.embeddingCoverage.embeddedSummaries}/{book.embeddingCoverage.totalSummaries} 概要，
                      {book.embeddingCoverage.embeddedChunks}/{book.embeddingCoverage.totalChunks} chunk
                    </p>
                  </div>
                  <button type="button" onClick={() => void downloadBook(book.id)} disabled={isBusy}>下载</button>
                </article>
              ))}
            </div>
          </section>
        )}

        {tab === 'reader' && (
          <section>
            {!activePackage || !activeChapter ? (
              <div className="empty-state">
                <p>请选择一本本地书。</p>
                <button type="button" onClick={() => setTab('library')}>回到书架</button>
              </div>
            ) : (
              <>
                <div className="chapter-toolbar">
                  <select value={activeChapter.id} onChange={(event) => openChapter(event.target.value)}>
                    {activePackage.chapters.map((chapter) => (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.index}. {chapter.title}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setTab('search')}>搜索</button>
                </div>
                <article className="reader-card">
                  <h2>{activeChapter.title}</h2>
                  <aside className={activeSummary ? 'summary-box' : 'summary-box summary-empty'}>
                    <strong>本章概要</strong>
                    {activeSummary ? (
                      <>
                        {activeSummary.short && <p className="summary-short">{activeSummary.short}</p>}
                        {activeSummary.detail && <p>{activeSummary.detail}</p>}
                        {activeSummary.keyPoints.length > 0 && (
                          <ul>
                            {activeSummary.keyPoints.map((point, index) => (
                              <li key={`${activeSummary.chapterId}-${index}`}>{point}</li>
                            ))}
                          </ul>
                        )}
                        {activeSummary.skippable && <p className="summary-skip">{activeSummary.skippable}</p>}
                      </>
                    ) : (
                      <p>
                        当前同步包没有这章的概要。本书本地概要 {activePackage.summaries.length}/{activePackage.chapters.length}，
                        可以回到同步页重新下载最新数据包。
                      </p>
                    )}
                  </aside>
                  <div className="chapter-text">
                    {activeChapter.content.split(/\n+/).map((paragraph, index) => (
                      <p key={`${activeChapter.id}-${index}`}>{paragraph}</p>
                    ))}
                  </div>
                </article>
              </>
            )}
          </section>
        )}

        {tab === 'search' && (
          <section>
            <h2>本地搜索</h2>
            <input className="search-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索章节、摘要、正文" />
            <div className="search-results">
              {searchResults.map((result) => (
                <button className="search-result" key={result.chapterId} type="button" onClick={() => openChapter(result.chapterId)}>
                  <strong>{result.chapterIndex}. {result.chapterTitle}</strong>
                  <span>{result.snippet}</span>
                </button>
              ))}
              {searchQuery && searchResults.length === 0 && <p className="muted">没有匹配结果。</p>}
            </div>
          </section>
        )}
      </main>

      <nav className="bottom-nav">
        <button className={tab === 'library' ? 'active' : ''} type="button" onClick={() => setTab('library')}>书架</button>
        <button className={tab === 'reader' ? 'active' : ''} type="button" onClick={() => setTab('reader')}>阅读</button>
        <button className={tab === 'search' ? 'active' : ''} type="button" onClick={() => setTab('search')}>搜索</button>
        <button className={tab === 'sync' ? 'active' : ''} type="button" onClick={() => setTab('sync')}>同步</button>
      </nav>
    </div>
  )
}

export default App
