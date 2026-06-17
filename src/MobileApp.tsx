import { useEffect, useRef, useState } from 'react'
import { useReaderState } from './hooks/useReaderState.ts'
import type { AIProvider, ImportEncoding } from './hooks/useReaderState.ts'
import './MobileApp.css'

function MobileApp() {
  const readerRef = useRef<HTMLDivElement | null>(null)
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

  useEffect(() => {
    if (!activeChapter) return

    const activePage = Math.ceil(activeChapter.index / 100)
    setChapterPage(activePage)
  }, [activeChapter?.id, setChapterPage])

  useEffect(() => {
    if (mobileTab === 'reader' && activeChapter) {
      requestAnimationFrame(() => {
        if (readerRef.current) {
          readerRef.current.scrollTop = 0
        }
      })
    }
  }, [activeChapter?.id, mobileTab])

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
                            {libraryBook.book.chapters.length} 章 · 概要 {Object.keys(libraryBook.summaries).length} 章
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
                  accept=".txt,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleImport(file)
                    event.target.value = ''
                  }}
                />
                <span className="mobile-primary-button">{state.books.length ? '导入新 txt 到书架' : '选择 txt 文件'}</span>
                <small>支持“第1章 / 第一章 / Chapter 1”等格式</small>
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
          <section className="mobile-panel mobile-reader">
            {activeChapter ? (
              <>
                <div className="mobile-reader-heading">
                  <span>
                    第 {activeChapter.index}/{state.book?.chapters.length ?? 0} 章 · {activeChapter.wordCount} 字
                  </span>
                </div>

                <div
                  className="mobile-chapter-content"
                  style={{ fontSize: `${state.readerFontSize}px` }}
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
      </nav>
    </div>
  )
}

export default MobileApp
