import { type CSSProperties, type MouseEvent, useEffect, useRef, useState } from 'react'
import { countBookWords, formatWordCount, useReaderState } from './hooks/useReaderState.ts'
import type { AIProvider, EmbeddingProvider, ImportEncoding, OpenAIConfig } from './hooks/useReaderState.ts'
import './MobileApp.css'

type RagSearchResult = {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  summary: {
    short: string
    detail: string
    keyPoints: string[]
  }
  similarity: number
  matchType: 'vector' | 'chunk' | 'entity' | 'both' | 'entity-first'
  matchedEntities: string[]
  contentSnippet: string | null
  chunkIndex?: number | null
}

type RagEntityMatch = {
  entityId: string
  entityName: string
  entityType: string
  firstChapterIndex: number | null
  lastChapterIndex: number | null
}

type EmbeddingStatus = {
  totalChapters: number
  summarizedChapters?: number
  missingSummaries?: number
  embeddedChapters: number
  missingChapters: number
  totalChunks?: number
  embeddedChunks?: number
  missingChunks?: number
  model: string
  dimension: number | null
}

function MobileApp() {
  const readerRef = useRef<HTMLDivElement | null>(null)
  const readerScrollSaveTimerRef = useRef<number | null>(null)
  const {
    state,
    setState,
    mobileTab,
    setMobileTab,
    chapterPage,
    setChapterPage,
    chapterSearch,
    setChapterSearch,
    isHydrated,
    isGenerating,
    batchProgress,
    isConfigOpen,
    modelConfigDraft,
    setModelConfigDraft,
    isTestingConfig,
    configError,
    ollamaModels,
    isCheckingOllama,
    error,
    activeChapter,
    activeSummary,
    previousChapter,
    nextChapter,
    chapterPageCount,
    pagedChapters,
    normalizedChapterSearch,
    searchedChapters,
    visibleChapters,
    processedCount,
    pageSummaryCount,
    activeModelName,
    activeTemperature,
    draftActiveOpenAIConfig,
    importedDate,
    handleImport,
    selectBook,
    deleteBook,
    updateActiveChapter,
    handleGenerateSummary,
    handleBatchGenerateCurrentPage,
    handleBatchGenerateAllMissingSummaries,
    navigateToPreviousChapter,
    navigateToNextChapter,
    openModelConfig,
    closeModelConfig,
    updateActiveOpenAIConfig,
    addOpenAIConfig,
    removeActiveOpenAIConfig,
    saveModelConfig,
  } = useReaderState()

  const [showSearch, setShowSearch] = useState(false)

  const [ragQuery, setRagQuery] = useState('')
  const [ragResults, setRagResults] = useState<RagSearchResult[]>([])
  const [ragEntityMatches, setRagEntityMatches] = useState<RagEntityMatch[]>([])
  const [ragAnswer, setRagAnswer] = useState('')
  const [ragIsSearching, setRagIsSearching] = useState(false)
  const [ragIsGeneratingAnswer, setRagIsGeneratingAnswer] = useState(false)
  const [ragTopK, setRagTopK] = useState(10)
  const [ragIncludeSnippets, setRagIncludeSnippets] = useState(true)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [isGeneratingEmbeddings, setIsGeneratingEmbeddings] = useState(false)
  const [embeddingProgress, setEmbeddingProgress] = useState('')
  const [ragError, setRagError] = useState('')
  const [readerProgress, setReaderProgress] = useState(0)

  useEffect(() => {
    if (mobileTab === 'reader' && activeChapter) {
      requestAnimationFrame(() => {
        if (readerRef.current) {
          const key = `${state.book?.id ?? 'book'}:${activeChapter.id}`
          readerRef.current.scrollTop = state.chapterScrollPositions[key] ?? 0
        }
      })
    }
  }, [activeChapter?.id, mobileTab, state.book?.id])

  useEffect(() => {
    if (mobileTab !== 'reader' || !activeChapter) return

    if (!readerRef.current) return
    const readerElement = readerRef.current

    const key = `${state.book?.id ?? 'book'}:${activeChapter.id}`

    function updateReaderProgress() {
      const scrollable = Math.max(1, readerElement.scrollHeight - readerElement.clientHeight)
      setReaderProgress(Math.max(0, Math.min(100, (readerElement.scrollTop / scrollable) * 100)))

      if (readerScrollSaveTimerRef.current) {
        window.clearTimeout(readerScrollSaveTimerRef.current)
      }

      readerScrollSaveTimerRef.current = window.setTimeout(() => {
        setState((current) => ({
          ...current,
          chapterScrollPositions: {
            ...current.chapterScrollPositions,
            [key]: readerElement.scrollTop,
          },
        }))
      }, 500)
    }

    updateReaderProgress()
    readerElement.addEventListener('scroll', updateReaderProgress, { passive: true })

    return () => {
      readerElement.removeEventListener('scroll', updateReaderProgress)
      if (readerScrollSaveTimerRef.current) {
        window.clearTimeout(readerScrollSaveTimerRef.current)
        readerScrollSaveTimerRef.current = null
      }
    }
  }, [activeChapter?.id, mobileTab, setState, state.book?.id])

  function handleChapterClick(id: string) {
    updateActiveChapter(id)
    setMobileTab('reader')
  }

  function handleNavigatePrevious() {
    navigateToPreviousChapter()
  }

  function handleNavigateNext() {
    navigateToNextChapter()
  }

  function handleReaderTap(event: MouseEvent<HTMLDivElement>) {
    if (window.getSelection()?.toString()) return

    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    if (ratio < 0.34) {
      readerRef.current?.scrollBy({ top: -Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
    } else if (ratio > 0.66) {
      readerRef.current?.scrollBy({ top: Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
    }
  }

  function getEmbeddingConfig() {
    const { embeddingConfig } = state
    const provider = embeddingConfig.provider
    const model = embeddingConfig.model.trim()
    const baseUrl = embeddingConfig.baseUrl.trim()
    const apiKey = embeddingConfig.apiKey

    if (!model) return null
    if (!baseUrl) return null

    return {
      provider,
      model,
      baseUrl,
      apiKey,
    }
  }

  async function fetchEmbeddingStatus(): Promise<EmbeddingStatus | null> {
    if (!state.book) return null

    const config = getEmbeddingConfig()
    if (!config) {
      setEmbeddingStatus(null)
      return null
    }

    try {
      const response = await fetch(
        `/api/rag/embeddings/status?bookId=${encodeURIComponent(state.book.id)}&model=${encodeURIComponent(config.model)}`,
      )
      if (!response.ok) throw new Error('读取 embedding 状态失败。')
      const payload = (await response.json()) as EmbeddingStatus
      setEmbeddingStatus(payload)
      return payload
    } catch (err) {
      setRagError(err instanceof Error ? err.message : '读取 embedding 状态失败。')
      return null
    }
  }

  async function handleGenerateEmbeddings() {
    if (!state.book) return

    const config = getEmbeddingConfig()
    if (!config) {
      setRagError('请先配置 embedding 模型。')
      return
    }

    setIsGeneratingEmbeddings(true)
    setRagError('')
    setEmbeddingProgress('准备生成概要与正文片段 embedding...')

    try {
      const response = await fetch('/api/rag/embeddings/batch', {
        body: JSON.stringify({
          bookId: state.book.id,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const payload = (await response.json()) as {
        completed: number
        failed: number
        total: number
        chunkCompleted?: number
        chunkFailed?: number
        error?: string
      }
      if (!response.ok) {
        throw new Error(payload.error ?? '生成 embedding 失败。')
      }

      setEmbeddingProgress(
        `已处理 ${payload.completed}/${payload.total} 章，失败 ${payload.failed} 章；正文片段 ${payload.chunkCompleted ?? 0} 个。`,
      )
      const status = await fetchEmbeddingStatus()
      if (status?.dimension) {
        setState((current) => ({
          ...current,
          embeddingConfig: { ...current.embeddingConfig, dimension: status.dimension },
        }))
        setModelConfigDraft((current) => ({
          ...current,
          embeddingConfig: { ...current.embeddingConfig, dimension: status.dimension },
        }))
      }
    } catch (err) {
      setRagError(err instanceof Error ? err.message : '生成 embedding 失败。')
    } finally {
      setIsGeneratingEmbeddings(false)
    }
  }

  async function handleRagSearch() {
    if (!state.book || !ragQuery.trim()) return

    const config = getEmbeddingConfig()
    if (!config) {
      setRagError('请先配置 embedding 模型。')
      return
    }

    setRagIsSearching(true)
    setRagError('')
    setRagResults([])
    setRagEntityMatches([])
    setRagAnswer('')

    try {
      const response = await fetch('/api/rag/search', {
        body: JSON.stringify({
          bookId: state.book.id,
          query: ragQuery.trim(),
          topK: ragTopK,
          includeSnippets: ragIncludeSnippets,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (response.status === 409) {
        const payload = (await response.json()) as { error?: string; embeddedCount?: number; totalChapters?: number }
        setRagError(
          `${payload.error ?? 'embedding 未就绪'}（${payload.embeddedCount ?? 0}/${payload.totalChapters ?? 0}）。请先点击「生成 embedding」。`,
        )
        return
      }

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '搜索失败。')
      }

      const payload = (await response.json()) as { results: RagSearchResult[]; entityMatches: RagEntityMatch[] }
      setRagResults(payload.results)
      setRagEntityMatches(payload.entityMatches)
    } catch (err) {
      setRagError(err instanceof Error ? err.message : '搜索失败。')
    } finally {
      setRagIsSearching(false)
    }
  }

  function buildRagAnswerPrompt(question: string, results: RagSearchResult[]): string {
    const sorted = [...results].sort((a, b) => a.chapterIndex - b.chapterIndex)
    const context = sorted
      .map((result) => {
        const lines = [`[第 ${result.chapterIndex} 章] ${result.chapterTitle}`]
        if (result.summary.detail) lines.push(`摘要：${result.summary.detail}`)
        if (result.contentSnippet) lines.push(`原文片段：${result.contentSnippet}`)
        return lines.join('\n')
      })
      .join('\n\n')

    return `你是长篇小说阅读助手。请根据以下按章节顺序排列的相关内容回答问题。回答要简洁准确，并引用章节号。如果信息不足，请明确说明。

问题：${question}

相关内容：
${context}

请给出回答：`
  }

  async function generateRagAnswerWithOllama(prompt: string, model: string, temperature: number): Promise<string> {
    const response = await fetch('http://localhost:11434/api/generate', {
      body: JSON.stringify({
        model: model.trim(),
        prompt,
        stream: false,
        options: { temperature },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama 返回 ${response.status}：${body || '请求失败'}`)
    }

    const data = (await response.json()) as { response?: string }
    return (data.response ?? '').trim()
  }

  async function generateRagAnswerWithOpenAI(prompt: string, config: OpenAIConfig): Promise<string> {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, '')
    if (!normalizedBaseUrl) throw new Error('请先填写 OpenAI-compatible Base URL。')
    if (!config.model.trim()) throw new Error('请先填写 OpenAI-compatible Model Name。')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`
    }

    const requestBody: Record<string, unknown> = {
      model: config.model.trim(),
      messages: [
        { role: 'system', content: '你是长篇网络小说陪读助手。请直接回答问题，不需要输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: config.temperature,
    }

    if (!config.thinkingEnabled) {
      requestBody.chat_template_kwargs = { enable_thinking: false }
    }

    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      body: JSON.stringify(requestBody),
      headers,
      method: 'POST',
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`OpenAI 返回 ${response.status}：${body || '请求失败'}`)
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    return (data.choices?.[0]?.message?.content ?? '').trim()
  }

  async function handleGenerateRagAnswer() {
    if (!ragQuery.trim() || ragResults.length === 0) return

    setRagIsGeneratingAnswer(true)
    setRagError('')

    try {
      const prompt = buildRagAnswerPrompt(ragQuery.trim(), ragResults)
      let answer = ''
      if (state.aiProvider === 'openai') {
        if (!draftActiveOpenAIConfig) throw new Error('请先配置外部模型。')
        answer = await generateRagAnswerWithOpenAI(prompt, draftActiveOpenAIConfig)
      } else {
        answer = await generateRagAnswerWithOllama(prompt, state.ollamaModel, state.ollamaTemperature)
      }
      setRagAnswer(answer)
    } catch (err) {
      setRagError(err instanceof Error ? err.message : '生成答案失败。')
    } finally {
      setRagIsGeneratingAnswer(false)
    }
  }

  useEffect(() => {
    if (mobileTab !== 'search' || !state.book) return

    void fetchEmbeddingStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileTab, state.book?.id])

  if (!isHydrated) {
    return (
      <div className="mobile-shell">
        <div className="mobile-loading">
          <p className="eyebrow">Novel Reader MVP 0.1</p>
          <h1>正在打开本地书库...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-shell">
      <header className={mobileTab === 'reader' ? 'mobile-header mobile-header-reader' : 'mobile-header'}>
        {mobileTab === 'reader' ? (
          <>
            <button
              type="button"
              className="mobile-icon-button"
              onClick={() => setMobileTab('chapters')}
              aria-label="目录"
            >
              ☰
            </button>
            <div className="mobile-header-title">
              <h1>{state.book?.title ?? '长篇小说陪读助手'}</h1>
            </div>
            <button
              type="button"
              className="mobile-icon-button"
              onClick={openModelConfig}
              aria-label="模型配置"
            >
              ⚙️
            </button>
          </>
        ) : (
          <>
            <div className="mobile-header-title">
              <h1>{state.book ? state.book.title : '长篇小说陪读助手'}</h1>
              {state.book && activeChapter && (
                <small>
                  第 {activeChapter.index}/{state.book.chapters.length} 章 · {activeModelName || '未配置'} · Temp {activeTemperature}
                </small>
              )}
            </div>
            <button
              type="button"
              className="mobile-icon-button"
              onClick={openModelConfig}
              aria-label="模型配置"
            >
              ⚙️
            </button>
          </>
        )}
      </header>

      <main className="mobile-main" ref={readerRef}>
        {mobileTab === 'bookshelf' && (
          <section className="mobile-panel">
            <div className="mobile-section">
              <h2>书架</h2>
              <p className="mobile-hint">
                书籍、阅读进度和概要都会保存在本机 SQLite 数据库里。
              </p>
            </div>

            {state.book ? (
              <div className="mobile-card">
                <h3>{state.book.title}</h3>
                <div className="mobile-stats">
                  <div>
                    <span className="mobile-stat-label">章节</span>
                    <span className="mobile-stat-value">{state.book.chapters.length}</span>
                  </div>
                  <div>
                    <span className="mobile-stat-label">字数</span>
                    <span className="mobile-stat-value mobile-stat-small">{formatWordCount(countBookWords(state.book))}</span>
                  </div>
                  <div>
                    <span className="mobile-stat-label">概要</span>
                    <span className="mobile-stat-value">{processedCount}</span>
                  </div>
                  <div>
                    <span className="mobile-stat-label">进度</span>
                    <span className="mobile-stat-value mobile-stat-small">
                      {activeChapter?.title ?? '未开始'}
                    </span>
                  </div>
                  <div>
                    <span className="mobile-stat-label">导入时间</span>
                    <span className="mobile-stat-value mobile-stat-small">{importedDate}</span>
                  </div>
                </div>
                <div className="mobile-actions">
                  <button
                    type="button"
                    className="mobile-primary-button"
                    onClick={() => {
                      if (activeChapter) {
                        setMobileTab('reader')
                      } else if (state.book?.chapters[0]) {
                        updateActiveChapter(state.book.chapters[0].id)
                        setMobileTab('reader')
                      }
                    }}
                  >
                    继续阅读
                  </button>
                  <button type="button" className="mobile-ghost-button" onClick={() => state.book && deleteBook(state.book.id)}>
                    删除当前书
                  </button>
                </div>
              </div>
            ) : (
              <div className="mobile-empty">
                <p>还没有导入书籍。</p>
              </div>
            )}

            {state.books.length > 0 && (
              <div className="mobile-section">
                <h2>全部书籍</h2>
                <div className="mobile-book-list">
                  {state.books.map((libraryBook) => {
                    const isActive = libraryBook.book.id === state.activeBookId

                    return (
                      <div className={isActive ? 'mobile-book-row active' : 'mobile-book-row'} key={libraryBook.book.id}>
                        <div>
	                          <h3>{libraryBook.book.title}</h3>
	                          <p>
	                            {libraryBook.book.chapters.length} 章 · {formatWordCount(countBookWords(libraryBook.book))} · 概要{' '}
	                            {Object.keys(libraryBook.summaries).length} 章
	                          </p>
                        </div>
                        <div className="mobile-book-row-actions">
                          <button type="button" className="mobile-primary-button" onClick={() => selectBook(libraryBook.book.id)}>
                            {isActive ? '继续' : '打开'}
                          </button>
                          <button type="button" className="mobile-ghost-button" onClick={() => deleteBook(libraryBook.book.id)}>
                            删除
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="mobile-section">
              <label className="mobile-upload">
                <input
                  type="file"
                  accept=".txt,.epub,text/plain,application/epub+zip"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleImport(file)
                    event.target.value = ''
                  }}
                />
                <span className="mobile-primary-button">{state.books.length ? '导入新书到书架' : '选择 txt / epub 文件'}</span>
                <small>txt 自动拆章，epub 按 spine 导入</small>
              </label>

              <label className="mobile-field">
                文本编码
                <select
                  value={state.importEncoding}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      importEncoding: event.target.value as ImportEncoding,
                    }))
                  }
                >
                  <option value="auto">自动识别</option>
                  <option value="gb18030">GBK / GB18030</option>
                  <option value="utf-8">UTF-8</option>
                </select>
              </label>

              <label className="mobile-field mobile-font-field">
                字号
                <div className="mobile-font-row">
                  <input
                    type="range"
                    min="14"
                    max="28"
                    step="1"
                    value={state.readerFontSize}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        readerFontSize: Number(event.target.value),
                      }))
                    }
                  />
                  <span>{state.readerFontSize}px</span>
                </div>
              </label>
              <label className="mobile-field mobile-font-field">
                行高
                <div className="mobile-font-row">
                  <input
                    type="range"
                    min="1.5"
                    max="2.6"
                    step="0.05"
                    value={state.readerLineHeight}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        readerLineHeight: Number(event.target.value),
                      }))
                    }
                  />
                  <span>{state.readerLineHeight.toFixed(2)}</span>
                </div>
              </label>
              <label className="mobile-field mobile-font-field">
                段距
                <div className="mobile-font-row">
                  <input
                    type="range"
                    min="0.5"
                    max="1.8"
                    step="0.1"
                    value={state.readerParagraphSpacing}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        readerParagraphSpacing: Number(event.target.value),
                      }))
                    }
                  />
                  <span>{state.readerParagraphSpacing.toFixed(1)}</span>
                </div>
              </label>
              <label className="mobile-field">
                阅读主题
                <select
                  value={state.readerTheme}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      readerTheme: event.target.value as typeof current.readerTheme,
                    }))
                  }
                >
                  <option value="paper">纸张</option>
                  <option value="green">护眼</option>
                  <option value="night">夜间</option>
                </select>
              </label>
            </div>
            {error && <p className="mobile-error">{error}</p>}
          </section>
        )}

        {mobileTab === 'chapters' && (
          <section className="mobile-panel">
            <div className="mobile-section">
              <div className="mobile-search-row">
                {showSearch ? (
                  <>
                    <input
                      type="search"
                      value={chapterSearch}
                      placeholder="搜索章节号或标题"
                      onChange={(event) => setChapterSearch(event.target.value)}
                      autoFocus
                    />
                    <button type="button" className="mobile-ghost-button" onClick={() => {
                      setChapterSearch('')
                      setShowSearch(false)
                    }}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <h2>目录 · {state.book?.chapters.length ?? 0} 章</h2>
                    <button
                      type="button"
                      className="mobile-icon-button"
                      onClick={() => setShowSearch(true)}
                      aria-label="搜索章节"
                    >
                      🔍
                    </button>
                  </>
                )}
              </div>
            </div>

            {!normalizedChapterSearch && state.book && (
              <div className="mobile-pager">
                <button
                  type="button"
                  className="mobile-ghost-button"
                  disabled={chapterPage <= 1}
                  onClick={() => setChapterPage((page) => Math.max(1, page - 1))}
                >
                  上 100 章
                </button>
                <select
                  value={chapterPage}
                  onChange={(event) => setChapterPage(Number(event.target.value))}
                >
                  {Array.from({ length: chapterPageCount }, (_, index) => {
                    const page = index + 1
                    const start = index * 100 + 1
                    const end = Math.min(page * 100, state.book?.chapters.length ?? 0)

                    return (
                      <option key={page} value={page}>
                        {start}-{end} 章
                      </option>
                    )
                  })}
                </select>
                <button
                  type="button"
                  className="mobile-ghost-button"
                  disabled={chapterPage >= chapterPageCount}
                  onClick={() => setChapterPage((page) => Math.min(chapterPageCount, page + 1))}
                >
                  下 100 章
                </button>
              </div>
            )}

            {normalizedChapterSearch && (
              <div className="mobile-search-status">
                找到 {searchedChapters.length} 章
                <button type="button" className="mobile-ghost-button" onClick={() => setChapterSearch('')}>
                  清除
                </button>
              </div>
            )}

            <div className="mobile-chapter-list">
              {visibleChapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  className={chapter.id === activeChapter?.id ? 'mobile-chapter active' : 'mobile-chapter'}
                  onClick={() => handleChapterClick(chapter.id)}
                >
                  <span className="mobile-chapter-title">{chapter.title}</span>
                  <span className="mobile-chapter-meta">
                    {chapter.wordCount} 字
                    {state.summaries[chapter.id] ? ' · 已概要' : ''}
                  </span>
                </button>
              ))}
              {normalizedChapterSearch && !visibleChapters.length && (
                <div className="mobile-empty">没有匹配的章节。</div>
              )}
            </div>
          </section>
        )}

        {mobileTab === 'reader' && (
          <section
            className={`mobile-panel mobile-reader mobile-reader-theme-${state.readerTheme}`}
            style={{
              '--mobile-reader-line-height': state.readerLineHeight,
              '--mobile-reader-paragraph-spacing': `${state.readerParagraphSpacing}em`,
            } as CSSProperties}
          >
            {activeChapter ? (
              <>
                <div className="mobile-reader-progress" aria-hidden="true">
                  <span style={{ width: `${readerProgress}%` }} />
                </div>
                <div className="mobile-reader-heading">
                  <span>
                    第 {activeChapter.index}/{state.book?.chapters.length ?? 0} 章 · {activeChapter.wordCount} 字
                  </span>
                </div>

                <div
                  className="mobile-chapter-content"
                  style={{ fontSize: `${state.readerFontSize}px` }}
                  onClick={handleReaderTap}
                >
                  {activeChapter.content.split('\n').map((line, index) => (
                    <p key={`${activeChapter.id}-${index}`}>{line.trim() || ' '}</p>
                  ))}
                </div>

                <div className="mobile-chapter-nav">
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    disabled={!previousChapter}
                    onClick={handleNavigatePrevious}
                  >
                    ← 上一章
                  </button>
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    disabled={!nextChapter}
                    onClick={handleNavigateNext}
                  >
                    下一章 →
                  </button>
                </div>
              </>
            ) : (
              <div className="mobile-empty">
                <p>还没有选择章节。</p>
                {state.book ? (
                  <button
                    type="button"
                    className="mobile-primary-button"
                    onClick={() => {
                      updateActiveChapter(state.book!.chapters[0].id)
                    }}
                  >
                    从第一章开始
                  </button>
                ) : (
                  <button type="button" className="mobile-primary-button" onClick={() => setMobileTab('bookshelf')}>
                    去导入书籍
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {mobileTab === 'summary' && (
          <section className="mobile-panel">
            <div className="mobile-section">
              <h2>本章概要</h2>
              {activeChapter && <p className="mobile-hint">{activeChapter.title}</p>}
            </div>

            {activeChapter ? (
              <>
                <div className="mobile-actions">
                  <button
                    type="button"
                    className="mobile-primary-button"
                    onClick={() => void handleGenerateSummary(true)}
                    disabled={isGenerating}
                  >
                    {isGenerating ? '生成中...' : state.aiProvider === 'openai' ? '用外部模型生成' : '用 Ollama 生成'}
                  </button>
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    onClick={() => void handleGenerateSummary(false)}
                    disabled={isGenerating}
                  >
                    本地粗略概要
                  </button>
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    onClick={() => void handleBatchGenerateCurrentPage()}
                    disabled={isGenerating}
                  >
                    批量生成本页缺失概要
                  </button>
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    onClick={() => void handleBatchGenerateAllMissingSummaries()}
                    disabled={isGenerating}
                  >
                    批量生成全书缺失概要
                  </button>
                </div>

                <p className="mobile-batch-status">
                  全书已生成 {processedCount}/{state.book?.chapters.length ?? 0} 章 · 本页 {pageSummaryCount}/{pagedChapters.length} 章
                  {batchProgress ? ` · ${batchProgress}` : ''}
                </p>

                {error && <p className="mobile-error">{error}</p>}

                {activeSummary ? (
                  <div className="mobile-summary-card">
                    <span className="mobile-tag">
                      {activeSummary.generatedBy === 'ollama'
                        ? 'Ollama'
                        : activeSummary.generatedBy === 'openai'
                          ? '外部模型'
                          : '本地'}{' '}
                      生成
                    </span>
                    <h3>一句话</h3>
                    <p>{activeSummary.short}</p>
                    <h3>详细概要</h3>
                    <p>{activeSummary.detail}</p>
                    <h3>必须知道</h3>
                    <ul>
                      {activeSummary.keyPoints.map((point, index) => (
                        <li key={`${point}-${index}`}>{point}</li>
                      ))}
                    </ul>
                    <h3>跳读建议</h3>
                    <p>{activeSummary.skippable}</p>
                  </div>
                ) : (
                  <div className="mobile-empty">
                    <p>这一章还没有概要。点击下方按钮生成。</p>
                  </div>
                )}
              </>
            ) : (
              <div className="mobile-empty">
                <p>请先选择一章节。</p>
                <button type="button" className="mobile-primary-button" onClick={() => setMobileTab('chapters')}>
                  去选择章节
                </button>
              </div>
            )}
          </section>
        )}

        {mobileTab === 'search' && state.book && (
          <section className="mobile-panel mobile-search-panel">
            <div className="mobile-section">
              <h2>智能搜索</h2>
              <p className="mobile-hint">基于章节摘要、正文片段和知识图谱回答问题</p>
            </div>

            {embeddingStatus && (
              <div className="mobile-embedding-status">
                <span>
                  Embedding {embeddingStatus.embeddedChapters}/{embeddingStatus.totalChapters}
                  {typeof embeddingStatus.summarizedChapters === 'number' &&
                    ` · 概要 ${embeddingStatus.summarizedChapters}/${embeddingStatus.totalChapters}`}
                  {typeof embeddingStatus.embeddedChunks === 'number' &&
                    typeof embeddingStatus.totalChunks === 'number' &&
                    ` · 片段 ${embeddingStatus.embeddedChunks}/${embeddingStatus.totalChunks}`}
                  {typeof embeddingStatus.dimension === 'number' && ` · 维度 ${embeddingStatus.dimension}`}
                </span>
                {Boolean(embeddingStatus.missingSummaries) && (
                  <small>
                    还有 {embeddingStatus.missingSummaries} 章没有概要，建议先补齐概要再生成全书 embedding。
                  </small>
                )}
                {embeddingStatus.missingChapters > 0 && (
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    onClick={() => void handleGenerateEmbeddings()}
                    disabled={isGeneratingEmbeddings}
                  >
                    {isGeneratingEmbeddings ? '生成中...' : '生成'}
                  </button>
                )}
                {embeddingProgress && <small>{embeddingProgress}</small>}
              </div>
            )}

            <input
              className="mobile-search-input"
              type="text"
              placeholder="例如：某某功法第一次出现在哪里"
              value={ragQuery}
              onChange={(event) => setRagQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleRagSearch()
              }}
            />

            <div className="mobile-search-options">
              <label>
                Top-K
                <input
                  type="number"
                  min={3}
                  max={50}
                  value={ragTopK}
                  onChange={(event) => setRagTopK(Number(event.target.value))}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ragIncludeSnippets}
                  onChange={(event) => setRagIncludeSnippets(event.target.checked)}
                />
                原文片段
              </label>
            </div>

            <button
              type="button"
              className="mobile-primary-button"
              onClick={() => void handleRagSearch()}
              disabled={ragIsSearching}
            >
              {ragIsSearching ? '搜索中...' : '搜索'}
            </button>

            {ragError && <p className="mobile-error">{ragError}</p>}

            {ragEntityMatches.length > 0 && (
              <div className="mobile-entity-tags">
                {ragEntityMatches.map((entity) => (
                  <span className="mobile-entity-tag" key={entity.entityId}>
                    {entity.entityName}
                  </span>
                ))}
              </div>
            )}

            {ragAnswer && (
              <div className="mobile-search-answer">
                <h3>AI 回答</h3>
                <div className="mobile-search-answer-content">{ragAnswer}</div>
              </div>
            )}

            {ragResults.length > 0 && (
              <div className="mobile-search-results">
                <div className="mobile-search-results-header">
                  <h3>相关章节（{ragResults.length}）</h3>
                  <button
                    type="button"
                    className="mobile-ghost-button"
                    onClick={() => void handleGenerateRagAnswer()}
                    disabled={ragIsGeneratingAnswer}
                  >
                    {ragIsGeneratingAnswer ? '生成中...' : '生成答案'}
                  </button>
                </div>
                {ragResults.map((result) => (
                  <div className="mobile-search-result" key={result.chapterId}>
                    <div className="mobile-search-result-header">
                      <button
                        type="button"
                        className="mobile-ghost-button"
                        onClick={() => {
                          updateActiveChapter(result.chapterId)
                          setMobileTab('reader')
                        }}
                      >
                        第 {result.chapterIndex} 章
                      </button>
                      <span className={`mobile-match-type ${result.matchType}`}>
                        {result.matchType === 'vector'
                          ? '语义'
                          : result.matchType === 'chunk'
                            ? '原文'
                            : result.matchType === 'entity'
                              ? '实体'
                              : result.matchType === 'entity-first'
                                ? '实体（首次）'
                                : '混合'}
                      </span>
                    </div>
                    <h4>{result.chapterTitle}</h4>
                    <p className="mobile-search-result-summary">{result.summary.detail}</p>
                    {result.contentSnippet && (
                      <p className="mobile-search-result-snippet">{result.contentSnippet}...</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {isConfigOpen && (
        <div className="mobile-modal-backdrop" role="presentation">
          <section className="mobile-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-config-title">
            <div className="mobile-modal-header">
              <h2 id="mobile-config-title">模型配置</h2>
              <button type="button" className="mobile-icon-button" onClick={closeModelConfig}>
                ✕
              </button>
            </div>

            <div className="mobile-modal-body">
              <label className="mobile-field">
                AI 提供商
                <select
                  value={modelConfigDraft.aiProvider}
                  disabled={isTestingConfig}
                  onChange={(event) =>
                    setModelConfigDraft((current) => ({
                      ...current,
                      aiProvider: event.target.value as AIProvider,
                    }))
                  }
                >
                  <option value="ollama">Ollama 本地</option>
                  <option value="openai">OpenAI-compatible</option>
                </select>
              </label>

              {modelConfigDraft.aiProvider === 'ollama' ? (
                <>
                  <label className="mobile-field">
                    Temperature
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={modelConfigDraft.ollamaTemperature}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          ollamaTemperature: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="mobile-field">
                    并发度
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={modelConfigDraft.ollamaConcurrency}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          ollamaConcurrency: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="mobile-field mobile-checkbox">
                    <input
                      type="checkbox"
                      checked={modelConfigDraft.thinkingEnabled}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          thinkingEnabled: event.target.checked,
                        }))
                      }
                    />
                    Thinking 模式
                  </label>
                  <label className="mobile-field">
                    模型
                    {ollamaModels.length ? (
                      <select
                        value={modelConfigDraft.ollamaModel}
                        disabled={isTestingConfig}
                        onChange={(event) =>
                          setModelConfigDraft((current) => ({
                            ...current,
                            ollamaModel: event.target.value,
                          }))
                        }
                      >
                        {ollamaModels.map((model) => (
                          <option key={model.name} value={model.name}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={modelConfigDraft.ollamaModel}
                        disabled={isTestingConfig}
                        placeholder={isCheckingOllama ? '正在读取模型...' : '例如 qwen2.5:7b'}
                        onChange={(event) =>
                          setModelConfigDraft((current) => ({
                            ...current,
                            ollamaModel: event.target.value,
                          }))
                        }
                      />
                    )}
                  </label>
                  <div className="mobile-config-section-divider">
                    <h3>Embedding 配置</h3>
                    <p>用于 RAG 智能搜索的 embedding 模型</p>
                  </div>
                  <label className="mobile-field">
                    Embedding 提供商
                    <select
                      value={modelConfigDraft.embeddingConfig.provider}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            provider: event.target.value as EmbeddingProvider,
                          },
                        }))
                      }
                    >
                      <option value="ollama">Ollama 本地</option>
                      <option value="openai">OpenAI-compatible</option>
                    </select>
                  </label>
                  <label className="mobile-field">
                    Embedding Base URL
                    <input
                      value={modelConfigDraft.embeddingConfig.baseUrl}
                      disabled={isTestingConfig}
                      placeholder={
                        modelConfigDraft.embeddingConfig.provider === 'ollama'
                          ? 'http://localhost:11434'
                          : 'https://api.openai.com/v1'
                      }
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            baseUrl: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="mobile-field">
                    Embedding 模型名
                    <input
                      value={modelConfigDraft.embeddingConfig.model}
                      disabled={isTestingConfig}
                      placeholder={
                        modelConfigDraft.embeddingConfig.provider === 'ollama'
                          ? 'nomic-embed-text'
                          : 'text-embedding-3-small'
                      }
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            model: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  {modelConfigDraft.embeddingConfig.provider === 'openai' && (
                    <label className="mobile-field">
                      Embedding API Key
                      <input
                        type="password"
                        value={modelConfigDraft.embeddingConfig.apiKey}
                        disabled={isTestingConfig}
                        placeholder="sk-..."
                        onChange={(event) =>
                          setModelConfigDraft((current) => ({
                            ...current,
                            embeddingConfig: {
                              ...current.embeddingConfig,
                              apiKey: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  )}
                  {typeof modelConfigDraft.embeddingConfig.dimension === 'number' && (
                    <small>当前已生成 embedding 的维度：{modelConfigDraft.embeddingConfig.dimension}</small>
                  )}
                </>
              ) : (
                <>
                  <div className="mobile-config-row">
                    <label className="mobile-field">
                      选择配置
                      <select
                        value={modelConfigDraft.activeOpenAIConfigId}
                        disabled={isTestingConfig}
                        onChange={(event) =>
                          setModelConfigDraft((current) => ({
                            ...current,
                            activeOpenAIConfigId: event.target.value,
                          }))
                        }
                      >
                        {modelConfigDraft.openaiConfigs.map((config) => (
                          <option key={config.id} value={config.id}>
                            {config.name || config.model || '未命名'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="mobile-ghost-button"
                      disabled={isTestingConfig}
                      onClick={addOpenAIConfig}
                    >
                      新增
                    </button>
                  </div>

                  <label className="mobile-field">
                    配置名称
                    <input
                      value={draftActiveOpenAIConfig?.name ?? ''}
                      disabled={isTestingConfig}
                      placeholder="例如 Moonshot K2"
                      onChange={(event) => updateActiveOpenAIConfig({ name: event.target.value })}
                    />
                  </label>
                  <label className="mobile-field">
                    Base URL
                    <input
                      value={draftActiveOpenAIConfig?.baseUrl ?? ''}
                      disabled={isTestingConfig}
                      placeholder="https://api.openai.com/v1"
                      onChange={(event) => updateActiveOpenAIConfig({ baseUrl: event.target.value })}
                    />
                  </label>
                  <label className="mobile-field">
                    API Key
                    <input
                      type="password"
                      value={draftActiveOpenAIConfig?.apiKey ?? ''}
                      disabled={isTestingConfig}
                      placeholder="sk-..."
                      onChange={(event) => updateActiveOpenAIConfig({ apiKey: event.target.value })}
                    />
                  </label>
                  <label className="mobile-field">
                    Model Name
                    <input
                      value={draftActiveOpenAIConfig?.model ?? ''}
                      disabled={isTestingConfig}
                      placeholder="gpt-4.1-mini"
                      onChange={(event) => updateActiveOpenAIConfig({ model: event.target.value })}
                    />
                  </label>
                  <label className="mobile-field">
                    Temperature
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={draftActiveOpenAIConfig?.temperature ?? 1}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        updateActiveOpenAIConfig({ temperature: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="mobile-field">
                    并发度
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={draftActiveOpenAIConfig?.concurrency ?? 3}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        updateActiveOpenAIConfig({ concurrency: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="mobile-field mobile-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(draftActiveOpenAIConfig?.thinkingEnabled)}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        updateActiveOpenAIConfig({ thinkingEnabled: event.target.checked })
                      }
                    />
                    启用 Thinking
                  </label>
                  <div className="mobile-config-section-divider">
                    <h3>Embedding 配置</h3>
                    <p>用于 RAG 智能搜索的 embedding 模型</p>
                  </div>
                  <label className="mobile-field">
                    Embedding 提供商
                    <select
                      value={modelConfigDraft.embeddingConfig.provider}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            provider: event.target.value as EmbeddingProvider,
                          },
                        }))
                      }
                    >
                      <option value="ollama">Ollama 本地</option>
                      <option value="openai">OpenAI-compatible</option>
                    </select>
                  </label>
                  <label className="mobile-field">
                    Embedding Base URL
                    <input
                      value={modelConfigDraft.embeddingConfig.baseUrl}
                      disabled={isTestingConfig}
                      placeholder={
                        modelConfigDraft.embeddingConfig.provider === 'ollama'
                          ? 'http://localhost:11434'
                          : 'https://api.openai.com/v1'
                      }
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            baseUrl: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="mobile-field">
                    Embedding 模型名
                    <input
                      value={modelConfigDraft.embeddingConfig.model}
                      disabled={isTestingConfig}
                      placeholder={
                        modelConfigDraft.embeddingConfig.provider === 'ollama'
                          ? 'nomic-embed-text'
                          : 'text-embedding-3-small'
                      }
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          embeddingConfig: {
                            ...current.embeddingConfig,
                            model: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  {modelConfigDraft.embeddingConfig.provider === 'openai' && (
                    <label className="mobile-field">
                      Embedding API Key
                      <input
                        type="password"
                        value={modelConfigDraft.embeddingConfig.apiKey}
                        disabled={isTestingConfig}
                        placeholder="sk-..."
                        onChange={(event) =>
                          setModelConfigDraft((current) => ({
                            ...current,
                            embeddingConfig: {
                              ...current.embeddingConfig,
                              apiKey: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  )}
                  {typeof modelConfigDraft.embeddingConfig.dimension === 'number' && (
                    <small>当前已生成 embedding 的维度：{modelConfigDraft.embeddingConfig.dimension}</small>
                  )}

                  <button
                    type="button"
                    className="mobile-ghost-button danger-button"
                    disabled={isTestingConfig || modelConfigDraft.openaiConfigs.length <= 1}
                    onClick={removeActiveOpenAIConfig}
                  >
                    删除当前配置
                  </button>
                </>
              )}

              {configError && <p className="mobile-error">{configError}</p>}
            </div>

            <div className="mobile-modal-actions">
              <button type="button" className="mobile-ghost-button" onClick={closeModelConfig} disabled={isTestingConfig}>
                取消
              </button>
              <button type="button" className="mobile-primary-button" onClick={() => void saveModelConfig()} disabled={isTestingConfig}>
                {isTestingConfig ? '测试中...' : '测试并保存'}
              </button>
            </div>
          </section>
        </div>
      )}

      <nav className="mobile-bottom-nav">
        <button
          type="button"
          className={mobileTab === 'bookshelf' ? 'active' : ''}
          onClick={() => setMobileTab('bookshelf')}
        >
          <span>📚</span>
          <span>书架</span>
        </button>
        <button
          type="button"
          className={mobileTab === 'chapters' ? 'active' : ''}
          onClick={() => setMobileTab('chapters')}
        >
          <span>📑</span>
          <span>目录</span>
        </button>
        <button
          type="button"
          className={mobileTab === 'reader' ? 'active' : ''}
          onClick={() => setMobileTab('reader')}
        >
          <span>📖</span>
          <span>阅读</span>
        </button>
        <button
          type="button"
          className={mobileTab === 'summary' ? 'active' : ''}
          onClick={() => setMobileTab('summary')}
        >
          <span>✨</span>
          <span>概要</span>
        </button>
        <button
          type="button"
          className={mobileTab === 'search' ? 'active' : ''}
          onClick={() => setMobileTab('search')}
        >
          <span>🔍</span>
          <span>搜索</span>
        </button>
      </nav>
    </div>
  )
}

export default MobileApp
