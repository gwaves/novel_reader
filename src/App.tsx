import { useEffect, useRef } from 'react'
import { useReaderState } from './hooks/useReaderState.ts'
import type { AIProvider, ImportEncoding } from './hooks/useReaderState.ts'
import './App.css'

function App() {
  const readerRef = useRef<HTMLElement | null>(null)
  const chapterListRef = useRef<HTMLDivElement | null>(null)
  const activeChapterButtonRef = useRef<HTMLButtonElement | null>(null)

  const {
    state,
    setState,
    view,
    setView,
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
    currentProgressLabel,
    activeProviderLabel,
    activeModelName,
    activeThinkingEnabled,
    activeTemperature,
    activeConcurrency,
    draftActiveOpenAIConfig,
    importedDate,
    handleImport,
    updateActiveChapter,
    handleGenerateSummary,
    handleBatchGenerateCurrentPage,
    navigateToPreviousChapter,
    navigateToNextChapter,
    resetBook,
    openModelConfig,
    closeModelConfig,
    updateActiveOpenAIConfig,
    addOpenAIConfig,
    removeActiveOpenAIConfig,
    saveModelConfig,
  } = useReaderState()

  useEffect(() => {
    if (!activeChapter) return

    const activePage = Math.ceil(activeChapter.index / 100)
    setChapterPage(activePage)
  }, [activeChapter?.id, setChapterPage])

  useEffect(() => {
    if (view !== 'reader' || !activeChapter) return

    window.requestAnimationFrame(() => {
      activeChapterButtonRef.current?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    })
  }, [view, activeChapter?.id, chapterPage])

  useEffect(() => {
    if (view !== 'reader' || isConfigOpen) return

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName
      const isEditing =
        target?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        tagName === 'BUTTON'

      if (isEditing) return

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        navigateToPreviousChapter()
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        navigateToNextChapter()
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        readerRef.current?.scrollBy({ top: -Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        readerRef.current?.scrollBy({ top: Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [view, isConfigOpen, previousChapter?.id, nextChapter?.id, navigateToPreviousChapter, navigateToNextChapter])

  if (!isHydrated) {
    return (
      <main className="app-shell">
        <section className="loading-panel">
          <p className="eyebrow">Novel Reader MVP 0.1</p>
          <h1>正在打开本地书库...</h1>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Novel Reader MVP 0.1</p>
          <h1>长篇小说陪读助手</h1>
        </div>
        {state.book && view === 'reader' && (
          <button type="button" className="ghost-button home-button" onClick={() => setView('home')}>
            返回首页
          </button>
        )}
        <div className="model-status">
          <span>{activeProviderLabel}</span>
          <small>
            {activeModelName || '未配置'} · Temp {activeTemperature} · 并发 {activeConcurrency} · Thinking{' '}
            {activeThinkingEnabled ? '开' : '关'}
          </small>
          <button type="button" className="ghost-button" onClick={openModelConfig}>
            模型配置
          </button>
        </div>
      </header>

      {isConfigOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="config-title">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">AI 设置</p>
                <h2 id="config-title">模型配置</h2>
              </div>
              <button type="button" className="ghost-button" onClick={closeModelConfig}>
                取消
              </button>
            </div>

            <div className="config-form">
              <label htmlFor="draft-ai-provider">AI 提供商</label>
              <select
                id="draft-ai-provider"
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

              {modelConfigDraft.aiProvider === 'ollama' ? (
                <>
                  <label htmlFor="draft-ollama-temperature">Ollama Temperature</label>
                  <input
                    id="draft-ollama-temperature"
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
                  <small>默认 1。保存前会用当前值验证本地模型。</small>
                  <label htmlFor="draft-ollama-concurrency">Ollama 并发度</label>
                  <input
                    id="draft-ollama-concurrency"
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
                  <small>默认 1。本地模型通常建议保持低并发。</small>
                  <label className="thinking-toggle" htmlFor="draft-thinking-enabled">
                    <input
                      id="draft-thinking-enabled"
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
                  <small>
                    {modelConfigDraft.thinkingEnabled
                      ? '开启：适合本地推理模型，最终仍要求只输出 JSON'
                      : '关闭：会发送 /no_think，摘要更快更干净'}
                  </small>
                  <label htmlFor="draft-ollama-model">Ollama 模型</label>
                  {ollamaModels.length ? (
                    <select
                      id="draft-ollama-model"
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
                      id="draft-ollama-model"
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
                  <small>
                    {ollamaModels.length
                      ? `已发现 ${ollamaModels.length} 个本地模型。保存前会实际测试一次。`
                      : '未自动发现模型，可手动填写；保存前会实际测试一次。'}
                  </small>
                </>
              ) : (
                <>
                  <div className="external-model-row">
                    <label htmlFor="draft-openai-config">选择外部模型</label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={isTestingConfig}
                      onClick={addOpenAIConfig}
                    >
                      新增模型
                    </button>
                  </div>
                  <select
                    id="draft-openai-config"
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
                        {config.name || config.model || '未命名外部模型'}
                      </option>
                    ))}
                  </select>

                  <label htmlFor="draft-openai-name">配置名称</label>
                  <input
                    id="draft-openai-name"
                    value={draftActiveOpenAIConfig?.name ?? ''}
                    disabled={isTestingConfig}
                    placeholder="例如 Moonshot K2"
                    onChange={(event) => updateActiveOpenAIConfig({ name: event.target.value })}
                  />
                  <label htmlFor="draft-openai-base-url">Base URL</label>
                  <input
                    id="draft-openai-base-url"
                    value={draftActiveOpenAIConfig?.baseUrl ?? ''}
                    disabled={isTestingConfig}
                    placeholder="https://api.openai.com/v1"
                    onChange={(event) => updateActiveOpenAIConfig({ baseUrl: event.target.value })}
                  />
                  <label htmlFor="draft-openai-api-key">API Key</label>
                  <input
                    id="draft-openai-api-key"
                    type="password"
                    value={draftActiveOpenAIConfig?.apiKey ?? ''}
                    disabled={isTestingConfig}
                    placeholder="sk-..."
                    onChange={(event) => updateActiveOpenAIConfig({ apiKey: event.target.value })}
                  />
                  <label htmlFor="draft-openai-model">Model Name</label>
                  <input
                    id="draft-openai-model"
                    value={draftActiveOpenAIConfig?.model ?? ''}
                    disabled={isTestingConfig}
                    placeholder="gpt-4.1-mini"
                    onChange={(event) => updateActiveOpenAIConfig({ model: event.target.value })}
                  />
                  <label htmlFor="draft-openai-temperature">当前外部模型 Temperature</label>
                  <input
                    id="draft-openai-temperature"
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
                  <small>默认 1。部分兼容接口只接受特定值，保存前会用当前值验证。</small>
                  <label htmlFor="draft-openai-concurrency">当前外部模型并发度</label>
                  <input
                    id="draft-openai-concurrency"
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
                  <small>默认 3。批量生成当前章节页时会同时请求这么多章节。</small>
                  <label className="thinking-toggle" htmlFor="draft-openai-thinking-enabled">
                    <input
                      id="draft-openai-thinking-enabled"
                      type="checkbox"
                      checked={Boolean(draftActiveOpenAIConfig?.thinkingEnabled)}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        updateActiveOpenAIConfig({ thinkingEnabled: event.target.checked })
                      }
                    />
                    当前外部模型启用 Thinking
                  </label>
                  <small>
                    {draftActiveOpenAIConfig?.thinkingEnabled
                      ? '当前外部模型会发送 /think，但最终仍要求只输出 JSON'
                      : '当前外部模型会发送 /no_think，适合不需要思考模式的模型'}
                  </small>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    disabled={isTestingConfig || modelConfigDraft.openaiConfigs.length <= 1}
                    onClick={removeActiveOpenAIConfig}
                  >
                    删除当前外部模型
                  </button>
                  <small>支持 /chat/completions 兼容接口。保存前会实际测试一次。</small>
                </>
              )}

              {configError && <p className="error">{configError}</p>}
            </div>

            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={closeModelConfig} disabled={isTestingConfig}>
                取消
              </button>
              <button type="button" onClick={() => void saveModelConfig()} disabled={isTestingConfig}>
                {isTestingConfig ? '测试中...' : '测试并保存'}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === 'home' ? (
        <section className="home-panel">
          <div className="import-copy">
            <p className="eyebrow">首页</p>
            <h2>{state.book ? '本地书架' : '导入一本 txt 小说'}</h2>
            <p>
              章节切分结果、当前阅读位置和已生成概要都会保存在本机浏览器数据库里。返回首页不会清空数据，只有重新导入会替换当前书籍。
            </p>
            <label className="encoding-field" htmlFor="import-encoding">
              文本编码
              <select
                id="import-encoding"
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
          </div>

          {state.book && (
            <div className="book-card">
              <p className="eyebrow">当前书籍</p>
              <h2>{state.book.title}</h2>
              <dl>
                <div>
                  <dt>章节</dt>
                  <dd>{state.book.chapters.length} 章</dd>
                </div>
                <div>
                  <dt>概要</dt>
                  <dd>{processedCount} 章</dd>
                </div>
                <div>
                  <dt>进度</dt>
                  <dd>{currentProgressLabel}</dd>
                </div>
                <div>
                  <dt>导入时间</dt>
                  <dd>{importedDate}</dd>
                </div>
              </dl>
              <div className="book-actions">
                <button type="button" onClick={() => setView('reader')}>
                  继续阅读
                </button>
                <button type="button" className="ghost-button" onClick={resetBook}>
                  清空并重新导入
                </button>
              </div>
            </div>
          )}

          <label className="upload-box">
            <input
              type="file"
              accept=".txt,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
              }}
            />
            <span>{state.book ? '导入新 txt 替换当前书' : '选择 txt 文件'}</span>
            <small>支持“第1章 / 第一章 / Chapter 1”等常见标题格式</small>
          </label>
          {error && <p className="error">{error}</p>}
        </section>
      ) : state.book ? (
        <section className="reader-layout">
          <aside className="chapter-list" aria-label="章节目录">
            <div className="book-status">
              <p className="eyebrow">书架</p>
              <h2>{state.book.title}</h2>
              <p>
                共 {state.book.chapters.length} 章，已生成概要 {processedCount} 章，当前：
                {activeChapter?.title ?? '未开始'}
              </p>
              <button type="button" className="ghost-button" onClick={resetBook}>
                重新导入
              </button>
            </div>

            <div className="chapter-pager">
              <label htmlFor="chapter-search">
                搜索章节
                <input
                  id="chapter-search"
                  value={chapterSearch}
                  placeholder="章节号、标题关键词"
                  onChange={(event) => setChapterSearch(event.target.value)}
                />
              </label>
              {normalizedChapterSearch && (
                <div className="search-status">
                  找到 {searchedChapters.length} 章
                  <button type="button" className="ghost-button" onClick={() => setChapterSearch('')}>
                    清除
                  </button>
                </div>
              )}
              <button
                type="button"
                className="ghost-button"
                disabled={chapterPage <= 1 || Boolean(normalizedChapterSearch)}
                onClick={() => setChapterPage((page) => Math.max(1, page - 1))}
              >
                上 100 章
              </button>
              <label htmlFor="chapter-page">
                章节页
                <select
                  id="chapter-page"
                  value={chapterPage}
                  disabled={Boolean(normalizedChapterSearch)}
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
              </label>
              <button
                type="button"
                className="ghost-button"
                disabled={chapterPage >= chapterPageCount || Boolean(normalizedChapterSearch)}
                onClick={() => setChapterPage((page) => Math.min(chapterPageCount, page + 1))}
              >
                下 100 章
              </button>
            </div>

            <div className="chapter-scroll" ref={chapterListRef}>
              {visibleChapters.map((chapter) => (
                <button
                  key={chapter.id}
                  ref={chapter.id === activeChapter?.id ? activeChapterButtonRef : null}
                  type="button"
                  className={chapter.id === activeChapter?.id ? 'chapter active' : 'chapter'}
                  onClick={() => updateActiveChapter(chapter.id)}
                >
                  <span>{chapter.title}</span>
                  <small>
                    {chapter.wordCount} 字
                    {state.summaries[chapter.id] ? ' · 已概要' : ''}
                  </small>
                </button>
              ))}
              {normalizedChapterSearch && !visibleChapters.length && (
                <div className="empty-chapter-search">没有匹配的章节。</div>
              )}
            </div>
          </aside>

          <article className="chapter-reader" ref={readerRef}>
            {activeChapter && (
              <>
                <div className="chapter-heading">
                  <p className="eyebrow">
                    位置 {activeChapter.index}/{state.book.chapters.length}
                  </p>
                  <h2>{activeChapter.title}</h2>
                  <div className="chapter-nav">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!previousChapter}
                      onClick={navigateToPreviousChapter}
                    >
                      上一章
                    </button>
                    <span>键盘：↑↓ 滚动，←→ 切换章节</span>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!nextChapter}
                      onClick={navigateToNextChapter}
                    >
                      下一章
                    </button>
                  </div>
                  <div className="reader-controls">
                    <p>{activeChapter.wordCount} 字</p>
                    <label htmlFor="reader-font-size">
                      字号
                      <input
                        id="reader-font-size"
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
                    </label>
                  </div>
                </div>
                <div
                  className="chapter-content"
                  style={{ fontSize: `${state.readerFontSize}px` }}
                >
                  {activeChapter.content.split('\n').map((line, index) => (
                    <p key={`${activeChapter.id}-${index}`}>{line || ' '}</p>
                  ))}
                </div>
              </>
            )}
          </article>

          <aside className="ai-panel" aria-label="AI 辅助栏">
            <p className="eyebrow">AI 辅助栏</p>
            <h2>本章概要</h2>
            <div className="summary-actions">
              <button
                type="button"
                onClick={() => void handleGenerateSummary(true)}
                disabled={isGenerating}
              >
                {isGenerating
                  ? '生成中...'
                  : state.aiProvider === 'openai'
                    ? '用外部模型生成'
                    : '用 Ollama 生成'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleGenerateSummary(false)}
                disabled={isGenerating}
              >
                本地粗略概要
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleBatchGenerateCurrentPage()}
                disabled={isGenerating}
              >
                批量生成本页缺失概要
              </button>
            </div>
            <p className="batch-status">
              本页已生成 {pageSummaryCount}/{pagedChapters.length} 章
              {batchProgress ? ` · ${batchProgress}` : ''}
            </p>

            {error && <p className="error">{error}</p>}

            {activeSummary ? (
              <div className="summary-card">
                <span className="tag">
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
              <div className="empty-summary">
                <p>这一章还没有概要。你可以先用本地粗略概要测试流程，再用 Ollama 生成更像样的版本。</p>
              </div>
            )}
          </aside>
        </section>
      ) : (
        <section className="home-panel">
          <div className="empty-summary">
            <p>还没有导入书籍，请先返回首页选择 txt 文件。</p>
            <button type="button" onClick={() => setView('home')}>
              返回首页
            </button>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
