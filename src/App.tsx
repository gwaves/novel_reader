import { useEffect, useRef, useState } from 'react'
import { useReaderState } from './hooks/useReaderState.ts'
import type { AIProvider, Chapter, ImportEncoding, OpenAIConfig } from './hooks/useReaderState.ts'
import './App.css'

type KgOverview = {
  scanned_chapters: number
  entity_count: number
  relation_count: number
}

type KgEntity = {
  id: string
  type: string
  name: string
  aliases: string[]
  description: string | null
  confidence: number
  mentionCount: number
}

type KgMention = {
  id: string
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  evidence: string | null
  confidence: number
}

type KgRelation = {
  id: string
  type: string
  description: string | null
  confidence: number
  sourceId: string
  sourceName: string
  sourceType: string
  targetId: string
  targetName: string
  targetType: string
  mentionCount?: number
}

type KgEntityDetail = {
  entity: KgEntity
  mentions: KgMention[]
  relations: KgRelation[]
}

type KgScannedChapter = {
  chapterId: string
  chapterIndex: number
  title: string
  status: string
  model: string | null
  scannedAt: string | null
  updatedAt: string
  entityCount: number
  relationCount: number
}

type KgScanMode = 'current' | 'page' | 'range' | 'all'

function buildKnowledgeGraphPrompt(chapter: Chapter): string {
  return `你是长篇小说知识图谱抽取器。请从章节中抽取人物、门派/组织、道具/法宝、功法/法术、地点、灵兽/妖兽、重要事件，以及它们之间的关系。

只输出 JSON，不要输出 Markdown，不要解释。

JSON 结构必须是：
{
  "entities": [
    {
      "name": "实体名",
      "type": "character|sect|item|skill|location|beast|event|other",
      "aliases": ["别名"],
      "description": "只基于本章的简短描述",
      "confidence": 0.0到1.0,
      "evidence": ["1到3条原文短证据"]
    }
  ],
  "relations": [
    {
      "source": "实体名",
      "target": "实体名",
      "type": "knows|ally_of|enemy_of|master_of|disciple_of|member_of|belongs_to|owns|uses|learns|created_by|located_in|appears_with|transforms_into|related_to",
      "description": "只基于本章的关系描述",
      "confidence": 0.0到1.0,
      "evidence": ["1到3条原文短证据"]
    }
  ]
}

要求：
1. source 和 target 必须出现在 entities 中。
2. 不确定的实体 type 用 other，不确定的关系 type 用 related_to。
3. evidence 必须来自原文短句，不要编造。
4. 同一实体不要重复输出。

章节标题：${chapter.title}
章节序号：${chapter.index}
章节正文：
${chapter.content.slice(0, 16000)}`
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('模型没有返回 JSON 对象。')
    return JSON.parse(match[0])
  }
}

function formatLocalDateTime(timestamp: string): string {
  const normalizedTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z`
    : timestamp

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(normalizedTimestamp))
}

async function generateKnowledgeGraphWithOllama(
  chapter: Chapter,
  model: string,
  temperature: number,
): Promise<unknown> {
  const response = await fetch('http://localhost:11434/api/generate', {
    body: JSON.stringify({
      model,
      prompt: buildKnowledgeGraphPrompt(chapter),
      stream: false,
      format: 'json',
      options: {
        temperature,
      },
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Ollama 图谱扫描失败：${response.status}`)
  }

  const payload = (await response.json()) as { response?: string }
  return parseJsonObject(payload.response ?? '')
}

async function generateKnowledgeGraphWithOpenAI(
  chapter: Chapter,
  config: OpenAIConfig,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`
  }

  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'user',
          content: buildKnowledgeGraphPrompt(chapter),
        },
      ],
      temperature: config.temperature,
      response_format: { type: 'json_object' },
      chat_template_kwargs: config.thinkingEnabled ? undefined : { enable_thinking: false },
    }),
    headers,
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`外部模型图谱扫描失败 ${response.status}：${body || '请求失败'}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return parseJsonObject(payload.choices?.[0]?.message?.content ?? '')
}

function App() {
  const readerRef = useRef<HTMLElement | null>(null)
  const chapterListRef = useRef<HTMLDivElement | null>(null)
  const activeChapterButtonRef = useRef<HTMLButtonElement | null>(null)
  const [kgOverview, setKgOverview] = useState<KgOverview | null>(null)
  const [kgEntities, setKgEntities] = useState<KgEntity[]>([])
  const [kgRelations, setKgRelations] = useState<KgRelation[]>([])
  const [kgEntityDetail, setKgEntityDetail] = useState<KgEntityDetail | null>(null)
  const [kgScannedChapters, setKgScannedChapters] = useState<KgScannedChapter[]>([])
  const [showKgScannedChapters, setShowKgScannedChapters] = useState(false)
  const [showKgEntities, setShowKgEntities] = useState(false)
  const [showKgRelations, setShowKgRelations] = useState(false)
  const [kgExtractionText, setKgExtractionText] = useState('')
  const [kgError, setKgError] = useState('')
  const [kgScanMode, setKgScanMode] = useState<KgScanMode>('current')
  const [kgScanStart, setKgScanStart] = useState(1)
  const [kgScanEnd, setKgScanEnd] = useState(1)
  const [kgScanConcurrency, setKgScanConcurrency] = useState(1)
  const [isKgScanning, setIsKgScanning] = useState(false)
  const [kgScanProgress, setKgScanProgress] = useState('')

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
    activeOpenAIConfig,
    activeModelName,
    activeThinkingEnabled,
    activeTemperature,
    activeConcurrency,
    draftActiveOpenAIConfig,
    importedDate,
    handleImport,
    selectBook,
    deleteBook,
    updateActiveChapter,
    handleGenerateSummary,
    handleBatchGenerateCurrentPage,
    navigateToPreviousChapter,
    navigateToNextChapter,
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

  useEffect(() => {
    if (view !== 'knowledge' || !state.book) return

    void refreshKnowledgeGraph()
  }, [view, state.book?.id])

  useEffect(() => {
    if (!state.book) return

    setKgScanStart(activeChapter?.index ?? 1)
    setKgScanEnd(activeChapter?.index ?? 1)
  }, [state.book?.id, activeChapter?.id])

  async function refreshKnowledgeGraph() {
    if (!state.book) return

    setKgError('')

    try {
      const [overviewResponse, entitiesResponse, relationsResponse, chaptersResponse] = await Promise.all([
        fetch(`/api/kg/overview?bookId=${encodeURIComponent(state.book.id)}`),
        fetch(`/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&limit=50`),
        fetch(`/api/kg/relations?bookId=${encodeURIComponent(state.book.id)}&limit=150`),
        fetch(`/api/kg/chapters?bookId=${encodeURIComponent(state.book.id)}`),
      ])

      if (!overviewResponse.ok || !entitiesResponse.ok || !relationsResponse.ok || !chaptersResponse.ok) {
        throw new Error('知识图谱 API 请求失败。')
      }

      const overviewPayload = (await overviewResponse.json()) as { overview: KgOverview }
      const entitiesPayload = (await entitiesResponse.json()) as { entities: KgEntity[] }
      const relationsPayload = (await relationsResponse.json()) as { relations: KgRelation[] }
      const chaptersPayload = (await chaptersResponse.json()) as { chapters: KgScannedChapter[] }
      setKgOverview(overviewPayload.overview)
      setKgEntities(entitiesPayload.entities)
      setKgRelations(relationsPayload.relations)
      setKgScannedChapters(chaptersPayload.chapters)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取知识图谱失败。')
    }
  }

  async function saveCurrentChapterExtraction() {
    if (!state.book || !activeChapter) return

    setKgError('')

    try {
      const extraction = JSON.parse(kgExtractionText) as unknown
      const response = await fetch(
        `/api/kg/chapters/${encodeURIComponent(activeChapter.id)}/extraction`,
        {
          body: JSON.stringify({
            bookId: state.book.id,
            extraction,
            model: 'manual-json',
          }),
          headers: {
            'Content-Type': 'application/json',
          },
          method: 'PUT',
        },
      )

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '保存章节抽取结果失败。')
      }

      setKgExtractionText('')
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '保存章节抽取结果失败。')
    }
  }

  async function openKgEntityDetail(entityId: string) {
    setKgError('')

    try {
      const response = await fetch(`/api/kg/entities/${encodeURIComponent(entityId)}`)

      if (!response.ok) {
        throw new Error('读取实体详情失败。')
      }

      setKgEntityDetail((await response.json()) as KgEntityDetail)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取实体详情失败。')
    }
  }

  function openChapterFromKnowledgeGraph(chapterId: string) {
    updateActiveChapter(chapterId)
    setView('reader')
  }

  function getSelectedKgScanChapters(): Chapter[] {
    if (!state.book) return []

    if (kgScanMode === 'current') {
      return activeChapter ? [activeChapter] : []
    }

    if (kgScanMode === 'page') {
      return pagedChapters
    }

    if (kgScanMode === 'all') {
      return state.book.chapters
    }

    const start = Math.max(1, Math.min(kgScanStart, kgScanEnd))
    const end = Math.min(state.book.chapters.length, Math.max(kgScanStart, kgScanEnd))

    return state.book.chapters.filter((chapter) => chapter.index >= start && chapter.index <= end)
  }

  function getPendingKgScanChapters(): Chapter[] {
    const completedChapterIds = new Set(
      kgScannedChapters
        .filter((chapter) => chapter.status === 'completed')
        .map((chapter) => chapter.chapterId),
    )

    return getSelectedKgScanChapters().filter((chapter) => !completedChapterIds.has(chapter.id))
  }

  async function saveChapterExtraction(chapter: Chapter, extraction: unknown, model: string) {
    if (!state.book) return

    const response = await fetch(`/api/kg/chapters/${encodeURIComponent(chapter.id)}/extraction`, {
      body: JSON.stringify({
        bookId: state.book.id,
        extraction,
        model,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'PUT',
    })

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      throw new Error(payload.error ?? `保存第 ${chapter.index} 章抽取结果失败。`)
    }
  }

  async function generateKnowledgeGraphExtraction(chapter: Chapter): Promise<{ extraction: unknown; model: string }> {
    if (state.aiProvider === 'openai') {
      if (!activeOpenAIConfig) throw new Error('请先配置外部模型。')

      return {
        extraction: await generateKnowledgeGraphWithOpenAI(chapter, activeOpenAIConfig),
        model: activeOpenAIConfig.model,
      }
    }

    return {
      extraction: await generateKnowledgeGraphWithOllama(
        chapter,
        state.ollamaModel,
        state.ollamaTemperature,
      ),
      model: state.ollamaModel,
    }
  }

  async function scanSelectedKnowledgeGraphChapters() {
    const selectedChapters = getSelectedKgScanChapters()
    const chapters = getPendingKgScanChapters()

    if (!state.book || !selectedChapters.length) {
      setKgError('没有可扫描的章节。')
      return
    }

    if (!chapters.length) {
      setKgScanProgress(`选中的 ${selectedChapters.length} 章都已经扫描完成。`)
      return
    }

    if (
      chapters.length > 50 &&
      !window.confirm(
        `已跳过 ${selectedChapters.length - chapters.length} 个已完成章节，将扫描剩余 ${chapters.length} 章，可能耗时较长并产生模型调用成本。确定开始吗？`,
      )
    ) {
      return
    }

    setKgError('')
    setIsKgScanning(true)

    try {
      let nextIndex = 0
      let completedCount = 0
      const concurrency = Math.max(1, Math.min(10, Math.floor(kgScanConcurrency)))

      async function worker() {
        while (nextIndex < chapters.length) {
          const chapter = chapters[nextIndex]
          nextIndex += 1
          setKgScanProgress(
            `并发 ${concurrency}，正在扫描 ${completedCount + 1}/${chapters.length}：第 ${chapter.index} 章 ${chapter.title}`,
          )

          const { extraction, model } = await generateKnowledgeGraphExtraction(chapter)
          await saveChapterExtraction(chapter, extraction, model)
          completedCount += 1

          setKgScanProgress(`并发 ${concurrency}，已完成 ${completedCount}/${chapters.length}`)
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()),
      )
      setKgScanProgress(`已完成 ${chapters.length} 章扫描。`)
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '章节扫描失败。')
    } finally {
      setIsKgScanning(false)
    }
  }

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
        <div className="model-status">
          {state.book && (
            <div className="topbar-actions">
              <button type="button" className="ghost-button home-button" onClick={() => setView('home')}>
                首页
              </button>
              <button type="button" className="ghost-button home-button" onClick={() => setView('reader')}>
                阅读
              </button>
              <button type="button" className="ghost-button home-button" onClick={() => setView('knowledge')}>
                知识图谱
              </button>
            </div>
          )}
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
            <h2>{state.books.length ? '本地书架' : '导入一本 txt 小说'}</h2>
            <p>
              章节切分结果、每本书的阅读位置和已生成概要都会保存在本机 SQLite 数据库里。导入新 txt 会新增到书架，不会替换已有书籍。
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
                <button type="button" className="ghost-button" onClick={() => deleteBook(state.book!.id)}>
                  删除当前书
                </button>
              </div>
            </div>
          )}

          {state.books.length > 0 && (
            <div className="book-card book-list-card">
              <p className="eyebrow">全部书籍</p>
              <div className="book-list">
                {state.books.map((libraryBook) => {
                  const isActive = libraryBook.book.id === state.activeBookId

                  return (
                    <div className={isActive ? 'book-row active' : 'book-row'} key={libraryBook.book.id}>
                      <div>
                        <h3>{libraryBook.book.title}</h3>
                        <p>
                          {libraryBook.book.chapters.length} 章 · 概要 {Object.keys(libraryBook.summaries).length} 章
                        </p>
                      </div>
                      <div className="book-row-actions">
                        <button type="button" onClick={() => selectBook(libraryBook.book.id)}>
                          {isActive ? '继续阅读' : '打开'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => deleteBook(libraryBook.book.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )
                })}
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
            <span>{state.books.length ? '导入新 txt 到书架' : '选择 txt 文件'}</span>
            <small>支持“第1章 / 第一章 / Chapter 1”等常见标题格式</small>
          </label>
          {error && <p className="error">{error}</p>}
        </section>
      ) : view === 'knowledge' && state.book ? (
        <section className="kg-panel">
          <div className="kg-heading">
            <div>
              <p className="eyebrow">知识图谱</p>
              <h2>{state.book.title}</h2>
              <p>
                第一阶段已接入 SQLite 图谱表和 API。现在可以保存章节级抽取 JSON，并查看实体和关系统计。
              </p>
            </div>
            <button type="button" onClick={() => void refreshKnowledgeGraph()}>
              刷新图谱
            </button>
          </div>

          <div className="kg-stats">
            <button
              type="button"
              className={showKgScannedChapters ? 'active' : ''}
              onClick={() => setShowKgScannedChapters((current) => !current)}
            >
              <span>已扫描章节</span>
              <strong>{kgOverview?.scanned_chapters ?? 0}</strong>
            </button>
            <button
              type="button"
              className={showKgEntities ? 'active' : ''}
              onClick={() => {
                setShowKgEntities((current) => !current)
                setShowKgRelations(false)
              }}
            >
              <span>实体</span>
              <strong>{kgOverview?.entity_count ?? 0}</strong>
            </button>
            <button
              type="button"
              className={showKgRelations ? 'active' : ''}
              onClick={() => {
                setShowKgRelations((current) => !current)
                setShowKgEntities(false)
              }}
            >
              <span>关系</span>
              <strong>{kgOverview?.relation_count ?? 0}</strong>
            </button>
          </div>

          {showKgScannedChapters && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>已扫描章节</h3>
                  <p>点击章节可跳转到阅读器中的对应章节。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgScannedChapters(false)}>
                  收起
                </button>
              </div>
              {kgScannedChapters.length ? (
                <div className="kg-scanned-list">
                  {kgScannedChapters.map((chapter) => (
                    <button
                      type="button"
                      className="kg-scanned-row"
                      key={chapter.chapterId}
                      onClick={() => {
                        updateActiveChapter(chapter.chapterId)
                        setView('reader')
                      }}
                    >
                      <div>
                        <strong>
                          第 {chapter.chapterIndex} 章 · {chapter.title}
                        </strong>
                        <span>{chapter.status}</span>
                      </div>
                      <p>
                        实体 {chapter.entityCount} · 关系 {chapter.relationCount}
                        {chapter.model ? ` · ${chapter.model}` : ''}
                        {' · '}
                        {formatLocalDateTime(chapter.scannedAt ?? chapter.updatedAt)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-summary">还没有已扫描章节。</p>
              )}
            </section>
          )}

          {showKgEntities && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>实体内容</h3>
                  <p>点击实体可查看描述、出现章节和相关关系。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgEntities(false)}>
                  收起
                </button>
              </div>
              {kgEntities.length ? (
                <div className="kg-entity-list kg-large-list">
                  {kgEntities.map((entity) => (
                    <button
                      type="button"
                      className="kg-entity-row kg-clickable-row"
                      key={entity.id}
                      onClick={() => void openKgEntityDetail(entity.id)}
                    >
                      <div>
                        <strong>{entity.name}</strong>
                        <span>{entity.type}</span>
                      </div>
                      <p>
                        出现 {entity.mentionCount} 次
                        {entity.aliases.length ? ` · 别名 ${entity.aliases.join('、')}` : ''}
                        {entity.description ? ` · ${entity.description}` : ''}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-summary">还没有实体。</p>
              )}
            </section>
          )}

          {kgEntityDetail && (
            <section className="kg-card kg-detail-card">
              <div className="kg-card-heading">
                <div>
                  <h3>{kgEntityDetail.entity.name}</h3>
                  <p>
                    {kgEntityDetail.entity.type}
                    {kgEntityDetail.entity.aliases.length ? ` · 别名 ${kgEntityDetail.entity.aliases.join('、')}` : ''}
                  </p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setKgEntityDetail(null)}>
                  关闭详情
                </button>
              </div>
              {kgEntityDetail.entity.description && <p>{kgEntityDetail.entity.description}</p>}
              <div className="kg-detail-grid">
                <div>
                  <h4>出现章节</h4>
                  {kgEntityDetail.mentions.map((mention) => (
                    <button
                      type="button"
                      className="kg-mini-row"
                      key={mention.id}
                      onClick={() => openChapterFromKnowledgeGraph(mention.chapterId)}
                    >
                      <strong>
                        第 {mention.chapterIndex} 章 · {mention.chapterTitle}
                      </strong>
                      {mention.evidence && <span>{mention.evidence}</span>}
                    </button>
                  ))}
                </div>
                <div>
                  <h4>相关关系</h4>
                  {kgEntityDetail.relations.map((relation) => (
                    <div className="kg-mini-row" key={relation.id}>
                      <strong>
                        {relation.sourceName} -- {relation.type} -- {relation.targetName}
                      </strong>
                      {relation.description && <span>{relation.description}</span>}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {showKgRelations && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>关系内容</h3>
                  <p>展示当前书中抽取出的实体关系，按出现证据数量和置信度排序。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgRelations(false)}>
                  收起
                </button>
              </div>
              {kgRelations.length ? (
                <div className="kg-relation-list">
                  {kgRelations.map((relation) => (
                    <div className="kg-relation-row" key={relation.id}>
                      <div>
                        <strong>{relation.sourceName}</strong>
                        <span>{relation.type}</span>
                        <strong>{relation.targetName}</strong>
                      </div>
                      <p>
                        {relation.description || '暂无描述'}
                        {' · '}
                        证据 {relation.mentionCount ?? 0} · 置信度 {Math.round(relation.confidence * 100)}%
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-summary">还没有关系。</p>
              )}
            </section>
          )}

          <section className="kg-card kg-scan-card">
            <div>
              <h3>章节扫描</h3>
              <p>
                选择要扫描的章节范围。扫描会使用当前模型配置，逐章提取实体和关系，并把每章中间结果保存到 SQLite。
              </p>
            </div>

            <div className="kg-scan-options">
              <label>
                <input
                  type="radio"
                  checked={kgScanMode === 'current'}
                  onChange={() => setKgScanMode('current')}
                />
                当前章节
              </label>
              <label>
                <input
                  type="radio"
                  checked={kgScanMode === 'page'}
                  onChange={() => setKgScanMode('page')}
                />
                当前章节页（{pagedChapters.length} 章）
              </label>
              <label>
                <input
                  type="radio"
                  checked={kgScanMode === 'range'}
                  onChange={() => setKgScanMode('range')}
                />
                指定范围
              </label>
              <label>
                <input
                  type="radio"
                  checked={kgScanMode === 'all'}
                  onChange={() => setKgScanMode('all')}
                />
                完全扫描全书（{state.book.chapters.length} 章）
              </label>
            </div>

            {kgScanMode === 'range' && (
              <div className="kg-range-fields">
                <label htmlFor="kg-scan-start">
                  起始章
                  <input
                    id="kg-scan-start"
                    type="number"
                    min="1"
                    max={state.book.chapters.length}
                    value={kgScanStart}
                    onChange={(event) => setKgScanStart(Number(event.target.value))}
                  />
                </label>
                <label htmlFor="kg-scan-end">
                  结束章
                  <input
                    id="kg-scan-end"
                    type="number"
                    min="1"
                    max={state.book.chapters.length}
                    value={kgScanEnd}
                    onChange={(event) => setKgScanEnd(Number(event.target.value))}
                  />
                </label>
              </div>
            )}

            <div className="kg-range-fields">
              <label htmlFor="kg-scan-concurrency">
                并发数
                <input
                  id="kg-scan-concurrency"
                  type="number"
                  min="1"
                  max="10"
                  value={kgScanConcurrency}
                  onChange={(event) =>
                    setKgScanConcurrency(Math.max(1, Math.min(10, Number(event.target.value))))
                  }
                />
              </label>
            </div>

            <div className="kg-scan-actions">
              <button
                type="button"
                disabled={isKgScanning || getSelectedKgScanChapters().length === 0}
                onClick={() => void scanSelectedKnowledgeGraphChapters()}
              >
                {isKgScanning ? '扫描中...' : `开始扫描 ${getPendingKgScanChapters().length} 章`}
              </button>
              <p>
                已选 {getSelectedKgScanChapters().length} 章，已完成将自动跳过{' '}
                {getSelectedKgScanChapters().length - getPendingKgScanChapters().length} 章。
              </p>
              {kgScanProgress && <p>{kgScanProgress}</p>}
            </div>
          </section>

          <div className="kg-grid">
            <section className="kg-card">
              <h3>当前章节中间结果</h3>
              <p>
                当前章节：{activeChapter ? `${activeChapter.title}（第 ${activeChapter.index} 章）` : '未选择'}
              </p>
              <textarea
                value={kgExtractionText}
                placeholder={`粘贴章节抽取 JSON，例如：\n{\n  "entities": [\n    {"name": "韩立", "type": "character", "aliases": [], "description": "本章人物", "confidence": 0.9, "evidence": ["原文短句"]}\n  ],\n  "relations": []\n}`}
                onChange={(event) => setKgExtractionText(event.target.value)}
              />
              <button
                type="button"
                disabled={!activeChapter || !kgExtractionText.trim()}
                onClick={() => void saveCurrentChapterExtraction()}
              >
                保存到图谱
              </button>
              {kgError && <p className="error">{kgError}</p>}
            </section>

            <section className="kg-card">
              <h3>实体列表</h3>
              {kgEntities.length ? (
                <div className="kg-entity-list">
                  {kgEntities.map((entity) => (
                    <button
                      type="button"
                      className="kg-entity-row kg-clickable-row"
                      key={entity.id}
                      onClick={() => void openKgEntityDetail(entity.id)}
                    >
                      <div>
                        <strong>{entity.name}</strong>
                        <span>{entity.type}</span>
                      </div>
                      <p>
                        出现 {entity.mentionCount} 次
                        {entity.aliases.length ? ` · 别名 ${entity.aliases.join('、')}` : ''}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-summary">还没有实体。先保存一个章节抽取 JSON，后续会接入自动扫描。</p>
              )}
            </section>
          </div>
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
              <button type="button" className="ghost-button" onClick={() => setView('home')}>
                返回书架
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
