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
  firstChapterIndex?: number
  lastChapterIndex?: number
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
  firstChapterIndex?: number
  lastChapterIndex?: number
}

type KgEntityDetail = {
  entity: KgEntity
  mentions: KgMention[]
  relations: KgRelation[]
}

type KgRelationDetail = {
  relation: KgRelation
  mentions: KgMention[]
}

type KgReviewEntity = KgEntity & { reasons: string[] }

type KgReviewRelation = KgRelation & { reasons: string[] }

type KgReviewQueueResponse = {
  entities: KgReviewEntity[]
  relations: KgReviewRelation[]
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

type KgScanJob = {
  id: string
  bookId: string
  scope: string
  status: 'running' | 'completed' | 'failed'
  totalChapters: number
  completedChapters: number
  failedChapters: number
  error: string | null
  createdAt: string
  updatedAt: string
}

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

function formatReviewReason(reason: string): string {
  const labels: Record<string, string> = {
    alias_suspicious: '别名可疑',
    confidence_low: '置信度低',
    description_missing: '缺少描述',
    name_too_short: '名称过短',
    self_loop: '自环关系',
    type_unclear: '类型模糊',
  }
  return labels[reason] ?? reason
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
  const [kgScanConcurrency, setKgScanConcurrency] = useState(10)
  const [isKgScanning, setIsKgScanning] = useState(false)
  const [kgScanProgress, setKgScanProgress] = useState('')
  const [kgScanJob, setKgScanJob] = useState<KgScanJob | null>(null)
  const [kgRelationDetail, setKgRelationDetail] = useState<KgRelationDetail | null>(null)
  const [kgEntitySearch, setKgEntitySearch] = useState('')
  const [kgEntityTypeFilter, setKgEntityTypeFilter] = useState('')
  const [kgRelationTypeFilter, setKgRelationTypeFilter] = useState('')
  const [kgEntityEdit, setKgEntityEdit] = useState<KgEntity | null>(null)
  const [kgEntityEditName, setKgEntityEditName] = useState('')
  const [kgEntityEditType, setKgEntityEditType] = useState('')
  const [kgEntityEditAliases, setKgEntityEditAliases] = useState('')
  const [kgEntityEditDescription, setKgEntityEditDescription] = useState('')
  const [kgRelationEdit, setKgRelationEdit] = useState<KgRelation | null>(null)
  const [kgRelationEditType, setKgRelationEditType] = useState('')
  const [kgRelationEditDescription, setKgRelationEditDescription] = useState('')
  const [kgMergeSource, setKgMergeSource] = useState<KgEntity | null>(null)
  const [kgMergeTargetId, setKgMergeTargetId] = useState('')
  const [kgMergeCandidates, setKgMergeCandidates] = useState<KgEntity[]>([])
  const [kgMergeQuery, setKgMergeQuery] = useState('')
  const [kgBatchMergeMode, setKgBatchMergeMode] = useState(false)
  const [kgBatchMergeSelectedIds, setKgBatchMergeSelectedIds] = useState<string[]>([])
  const [kgBatchMergeTargetId, setKgBatchMergeTargetId] = useState('')
  const [kgBatchMergeCandidates, setKgBatchMergeCandidates] = useState<KgEntity[]>([])
  const [kgBatchMergeQuery, setKgBatchMergeQuery] = useState('')
  const [showKgReviewQueue, setShowKgReviewQueue] = useState(false)
  const [kgReviewEntities, setKgReviewEntities] = useState<KgReviewEntity[]>([])
  const [kgReviewRelations, setKgReviewRelations] = useState<KgReviewRelation[]>([])
  const [kgReviewKind, setKgReviewKind] = useState<'all' | 'entity' | 'relation'>('all')
  const [kgReviewSelectedIds, setKgReviewSelectedIds] = useState<string[]>([])

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
    if (view !== 'reader' || !activeChapter) return

    window.requestAnimationFrame(() => {
      if (readerRef.current) {
        readerRef.current.scrollTop = 0
      }
    })
  }, [view, activeChapter?.id])

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
    void checkKgScanStatus()
  }, [view, state.book?.id])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book) return

    const interval = setInterval(() => {
      void checkKgScanStatus()
    }, 5000)

    return () => clearInterval(interval)
  }, [view, state.book?.id])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book) return
    void fetchKgEntities()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id, kgEntitySearch, kgEntityTypeFilter])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book) return
    void fetchKgRelations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id, kgRelationTypeFilter])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book || !showKgReviewQueue) return
    void fetchKgReviewQueue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id, showKgReviewQueue, kgReviewKind])

  useEffect(() => {
    if (kgEntityEdit) {
      setKgEntityEditName(kgEntityEdit.name)
      setKgEntityEditType(kgEntityEdit.type)
      setKgEntityEditAliases(kgEntityEdit.aliases.join('、'))
      setKgEntityEditDescription(kgEntityEdit.description ?? '')
    } else {
      setKgEntityEditName('')
      setKgEntityEditType('')
      setKgEntityEditAliases('')
      setKgEntityEditDescription('')
    }
  }, [kgEntityEdit])

  useEffect(() => {
    if (kgRelationEdit) {
      setKgRelationEditType(kgRelationEdit.type)
      setKgRelationEditDescription(kgRelationEdit.description ?? '')
    } else {
      setKgRelationEditType('')
      setKgRelationEditDescription('')
    }
  }, [kgRelationEdit])

  useEffect(() => {
    if (!state.book) return

    setKgScanStart(activeChapter?.index ?? 1)
    setKgScanEnd(activeChapter?.index ?? 1)
  }, [state.book?.id, activeChapter?.id])

  async function checkKgScanStatus() {
    if (!state.book) return

    try {
      const response = await fetch(`/api/kg/scan/status?bookId=${encodeURIComponent(state.book.id)}`)
      if (!response.ok) throw new Error('读取扫描状态失败。')
      const payload = (await response.json()) as { job: KgScanJob | null }
      setKgScanJob(payload.job)

      if (payload.job?.status === 'running' && !isKgScanning) {
        const staleThresholdMs = 30_000
        const lastUpdate = new Date(payload.job.updatedAt).getTime()
        if (Date.now() - lastUpdate > staleThresholdMs) {
          void resumeKnowledgeGraphScan()
        }
      }
    } catch {
      // ignore non-fatal errors
    }
  }

  async function refreshKnowledgeGraph() {
    if (!state.book) return

    setKgError('')

    try {
      const [overviewResponse, chaptersResponse] = await Promise.all([
        fetch(`/api/kg/overview?bookId=${encodeURIComponent(state.book.id)}`),
        fetch(`/api/kg/chapters?bookId=${encodeURIComponent(state.book.id)}`),
      ])

      if (!overviewResponse.ok || !chaptersResponse.ok) {
        throw new Error('知识图谱 API 请求失败。')
      }

      const overviewPayload = (await overviewResponse.json()) as { overview: KgOverview }
      const chaptersPayload = (await chaptersResponse.json()) as { chapters: KgScannedChapter[] }
      setKgOverview(overviewPayload.overview)
      setKgScannedChapters(chaptersPayload.chapters)
      await Promise.all([fetchKgEntities(), fetchKgRelations(), fetchKgReviewQueue()])
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取知识图谱失败。')
    }
  }

  async function fetchKgEntities() {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&type=${encodeURIComponent(kgEntityTypeFilter)}&q=${encodeURIComponent(kgEntitySearch)}&limit=200`,
      )
      if (!response.ok) throw new Error('读取实体列表失败。')
      const payload = (await response.json()) as { entities: KgEntity[] }
      setKgEntities(payload.entities)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取实体列表失败。')
    }
  }

  async function fetchKgRelations() {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/relations?bookId=${encodeURIComponent(state.book.id)}&type=${encodeURIComponent(kgRelationTypeFilter)}&limit=300`,
      )
      if (!response.ok) throw new Error('读取关系列表失败。')
      const payload = (await response.json()) as { relations: KgRelation[] }
      setKgRelations(payload.relations)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取关系列表失败。')
    }
  }

  async function fetchKgReviewQueue() {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/review-queue?bookId=${encodeURIComponent(state.book.id)}&kind=${encodeURIComponent(kgReviewKind)}&limit=300`,
      )
      if (!response.ok) throw new Error('读取复审队列失败。')
      const payload = (await response.json()) as KgReviewQueueResponse
      setKgReviewEntities(payload.entities)
      setKgReviewRelations(payload.relations)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取复审队列失败。')
    }
  }

  async function fetchKgScannedChapters() {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/chapters?bookId=${encodeURIComponent(state.book.id)}`,
      )
      if (!response.ok) throw new Error('读取已扫描章节失败。')
      const payload = (await response.json()) as { chapters: KgScannedChapter[] }
      setKgScannedChapters(payload.chapters)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取已扫描章节失败。')
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

  async function openKgRelationDetail(relationId: string) {
    setKgError('')

    try {
      const response = await fetch(`/api/kg/relations/${encodeURIComponent(relationId)}`)

      if (!response.ok) {
        throw new Error('读取关系详情失败。')
      }

      setKgRelationDetail((await response.json()) as KgRelationDetail)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取关系详情失败。')
    }
  }

  async function updateKgEntity(entityId: string, payload: Partial<KgEntity>) {
    setKgError('')

    try {
      const response = await fetch(`/api/kg/entities/${encodeURIComponent(entityId)}`, {
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'PUT',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '更新实体失败。')
      }

      setKgEntityEdit(null)
      await Promise.all([fetchKgEntities(), openKgEntityDetail(entityId), fetchKgReviewQueue()])
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '更新实体失败。')
    }
  }

  async function deleteKgEntity(entityId: string) {
    if (!window.confirm('确定要删除这个实体吗？相关的提及和关系也会被删除。')) return

    setKgError('')

    try {
      const response = await fetch(`/api/kg/entities/${encodeURIComponent(entityId)}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '删除实体失败。')
      }

      setKgEntityDetail(null)
      setKgEntityEdit(null)
      setKgMergeSource(null)
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '删除实体失败。')
    }
  }

  async function searchKgMergeCandidates(query: string) {
    if (!state.book || !kgMergeSource) return

    try {
      const response = await fetch(
        `/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&type=${encodeURIComponent(kgMergeSource.type)}&q=${encodeURIComponent(query)}&limit=50`,
      )
      if (!response.ok) throw new Error('读取候选实体失败。')
      const payload = (await response.json()) as { entities: KgEntity[] }
      setKgMergeCandidates(payload.entities.filter((entity) => entity.id !== kgMergeSource.id))
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取候选实体失败。')
    }
  }

  function openKgMergeModal(sourceEntity: KgEntity) {
    setKgMergeSource(sourceEntity)
    setKgMergeTargetId('')
    setKgMergeQuery('')
    setKgMergeCandidates([])
    void searchKgMergeCandidates('')
  }

  async function mergeKgEntities(sourceId: string, targetId: string) {
    setKgError('')

    try {
      const response = await fetch('/api/kg/entities/merge', {
        body: JSON.stringify({ sourceId, targetId }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '合并实体失败。')
      }

      const result = (await response.json()) as { entity: KgEntity }
      setKgMergeSource(null)
      setKgMergeTargetId('')
      setKgMergeCandidates([])
      setKgEntityDetail(null)
      await refreshKnowledgeGraph()
      await openKgEntityDetail(result.entity.id)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '合并实体失败。')
    }
  }

  async function deleteKgRelation(relationId: string) {
    if (!window.confirm('确定要删除这条关系吗？相关的证据章节也会被删除。')) return

    setKgError('')

    try {
      const response = await fetch(`/api/kg/relations/${encodeURIComponent(relationId)}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '删除关系失败。')
      }

      setKgRelationDetail(null)
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '删除关系失败。')
    }
  }

  async function updateKgRelation(relationId: string, payload: { type: string; description: string }) {
    setKgError('')

    try {
      const response = await fetch(`/api/kg/relations/${encodeURIComponent(relationId)}`, {
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'PUT',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '更新关系失败。')
      }

      setKgRelationEdit(null)
      await Promise.all([fetchKgRelations(), openKgRelationDetail(relationId), fetchKgReviewQueue()])
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '更新关系失败。')
    }
  }

  function toggleKgBatchMergeMode() {
    setKgBatchMergeMode((current) => {
      if (current) {
        setKgBatchMergeSelectedIds([])
      }
      return !current
    })
  }

  function toggleKgBatchMergeSelection(entityId: string) {
    setKgBatchMergeSelectedIds((current) =>
      current.includes(entityId) ? current.filter((id) => id !== entityId) : [...current, entityId],
    )
  }

  function selectAllKgBatchMergeEntities() {
    setKgBatchMergeSelectedIds(kgEntities.map((entity) => entity.id))
  }

  function clearKgBatchMergeSelection() {
    setKgBatchMergeSelectedIds([])
  }

  async function searchKgBatchMergeCandidates(query: string) {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&type=&q=${encodeURIComponent(query)}&limit=50`,
      )
      if (!response.ok) throw new Error('读取候选实体失败。')
      const payload = (await response.json()) as { entities: KgEntity[] }
      setKgBatchMergeCandidates(payload.entities)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取候选实体失败。')
    }
  }

  function openKgBatchMergeModal() {
    if (kgBatchMergeSelectedIds.length === 0) {
      setKgError('请先选择要合并的实体。')
      return
    }

    setKgBatchMergeTargetId('')
    setKgBatchMergeQuery('')
    setKgBatchMergeCandidates([])
    void searchKgBatchMergeCandidates('')
  }

  async function mergeKgEntitiesBatch(sourceIds: string[], targetId: string) {
    setKgError('')

    try {
      const response = await fetch('/api/kg/entities/merge-batch', {
        body: JSON.stringify({ sourceIds, targetId }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '批量合并失败。')
      }

      const result = (await response.json()) as { entity: KgEntity; mergedCount: number; sourceNames: string[] }
      setKgBatchMergeSelectedIds([])
      setKgBatchMergeTargetId('')
      setKgBatchMergeCandidates([])
      setKgBatchMergeQuery('')
      setKgBatchMergeMode(false)
      setKgEntityDetail(null)
      await refreshKnowledgeGraph()
      await openKgEntityDetail(result.entity.id)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '批量合并失败。')
    }
  }

  const kgReviewItems = kgReviewKind === 'all'
    ? [...kgReviewEntities, ...kgReviewRelations]
    : kgReviewKind === 'entity'
      ? kgReviewEntities
      : kgReviewRelations

  function isKgReviewEntity(item: KgReviewEntity | KgReviewRelation): item is KgReviewEntity {
    return !('sourceName' in item)
  }

  function toggleKgReviewSelection(itemId: string) {
    setKgReviewSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    )
  }

  function selectAllKgReviewItems() {
    setKgReviewSelectedIds(kgReviewItems.map((item) => item.id))
  }

  function clearKgReviewSelection() {
    setKgReviewSelectedIds([])
  }

  async function markKgReviewItems(ids: string[], status: 'approved' | 'ignored') {
    if (ids.length === 0) return

    setKgError('')

    const entityIds = ids.filter((id) => kgReviewEntities.some((entity) => entity.id === id))
    const relationIds = ids.filter((id) => kgReviewRelations.some((relation) => relation.id === id))

    try {
      if (entityIds.length > 0) {
        const response = await fetch('/api/kg/review-queue/mark', {
          body: JSON.stringify({ ids: entityIds, kind: 'entities', status }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string }
          throw new Error(payload.error ?? '标记实体失败。')
        }
      }

      if (relationIds.length > 0) {
        const response = await fetch('/api/kg/review-queue/mark', {
          body: JSON.stringify({ ids: relationIds, kind: 'relations', status }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string }
          throw new Error(payload.error ?? '标记关系失败。')
        }
      }

      setKgReviewSelectedIds([])
      await Promise.all([fetchKgReviewQueue(), refreshKnowledgeGraph()])
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '标记失败。')
    }
  }

  function openChapterFromKnowledgeGraph(chapterId: string) {
    updateActiveChapter(chapterId)
    setView('reader')
  }

  function getKgScanScopeDescription(selectedCount: number, pendingCount: number): string {
    if (kgScanMode === 'current') return `当前章节（${pendingCount}/${selectedCount}）`
    if (kgScanMode === 'page') return `当前页 ${selectedCount} 章（${pendingCount} 待扫）`
    if (kgScanMode === 'all') return `全书 ${selectedCount} 章（${pendingCount} 待扫）`
    const start = Math.min(kgScanStart, kgScanEnd)
    const end = Math.max(kgScanStart, kgScanEnd)
    return `范围 ${start}-${end}（${pendingCount} 待扫）`
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

  function getAllPendingKgScanChapters(): Chapter[] {
    if (!state.book) return []

    const completedChapterIds = new Set(
      kgScannedChapters
        .filter((chapter) => chapter.status === 'completed')
        .map((chapter) => chapter.chapterId),
    )

    return state.book.chapters.filter((chapter) => !completedChapterIds.has(chapter.id))
  }

  async function scanSelectedKnowledgeGraphChapters(options?: { forcePending?: boolean }) {
    const selectedChapters = options?.forcePending
      ? state.book?.chapters ?? []
      : getSelectedKgScanChapters()
    const chapters = options?.forcePending ? getAllPendingKgScanChapters() : getPendingKgScanChapters()

    if (!state.book || !selectedChapters.length) {
      setKgError('没有可扫描的章节。')
      return
    }

    if (!chapters.length) {
      setKgScanProgress(options?.forcePending ? '没有需要恢复的章节。' : `选中的 ${selectedChapters.length} 章都已经扫描完成。`)
      return
    }

    if (
      !options?.forcePending &&
      chapters.length > 50 &&
      !window.confirm(
        `已跳过 ${selectedChapters.length - chapters.length} 个已完成章节，将扫描剩余 ${chapters.length} 章，可能耗时较长并产生模型调用成本。确定开始吗？`,
      )
    ) {
      return
    }

    setKgError('')
    setIsKgScanning(true)

    let jobId: string | null = null
    let completedCount = 0
    let failedCount = 0

    async function updateJobProgress(status: KgScanJob['status']) {
      if (!jobId) return
      try {
        await fetch(`/api/kg/scan/jobs/${encodeURIComponent(jobId)}`, {
          body: JSON.stringify({
            status,
            completedChapters: completedCount,
            failedChapters: failedCount,
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'PUT',
        })
      } catch {
        // non-blocking
      }
    }

    try {
      const scope = options?.forcePending
        ? `恢复：全书 ${chapters.length} 个未完成章节`
        : getKgScanScopeDescription(selectedChapters.length, chapters.length)

      const createResponse = await fetch('/api/kg/scan/jobs', {
        body: JSON.stringify({
          bookId: state.book.id,
          scope,
          totalChapters: chapters.length,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (createResponse.ok) {
        const payload = (await createResponse.json()) as { job: KgScanJob }
        jobId = payload.job.id
        setKgScanJob(payload.job)
      }
    } catch {
      // non-blocking: continue scanning even if job creation fails
    }

    try {
      let nextIndex = 0
      const concurrency = Math.max(1, Math.min(10, Math.floor(kgScanConcurrency)))

      async function worker() {
        while (nextIndex < chapters.length) {
          const chapter = chapters[nextIndex]
          nextIndex += 1
          setKgScanProgress(
            `并发 ${concurrency}，正在扫描 ${completedCount + failedCount + 1}/${chapters.length}：第 ${chapter.index} 章 ${chapter.title}`,
          )

          try {
            const { extraction, model } = await generateKnowledgeGraphExtraction(chapter)
            await saveChapterExtraction(chapter, extraction, model)
            completedCount += 1
          } catch {
            failedCount += 1
          }

          setKgScanProgress(`并发 ${concurrency}，已完成 ${completedCount}/${chapters.length}，失败 ${failedCount} 章`)
          await updateJobProgress('running')
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()),
      )

      const finalStatus: KgScanJob['status'] = failedCount > 0 && failedCount === chapters.length ? 'failed' : 'completed'
      const finalError = failedCount > 0 ? `${failedCount} 章扫描失败` : null

      setKgScanProgress(
        finalStatus === 'completed'
          ? `已完成 ${chapters.length} 章扫描。`
          : `扫描结束，成功 ${completedCount} 章，失败 ${failedCount} 章。`,
      )

      await updateJobProgress(finalStatus)
      setKgScanJob((prev) =>
        prev
          ? { ...prev, status: finalStatus, completedChapters: completedCount, failedChapters: failedCount, error: finalError }
          : null,
      )

      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '章节扫描失败。')
      await updateJobProgress('failed')
      setKgScanJob((prev) => (prev ? { ...prev, status: 'failed' } : null))
    } finally {
      setIsKgScanning(false)
    }
  }

  async function resumeKnowledgeGraphScan() {
    if (!state.book) return

    // Make sure we have the latest scanned chapter list before resuming,
    // otherwise getAllPendingKgScanChapters() will treat every chapter as pending.
    await fetchKgScannedChapters()
    await scanSelectedKnowledgeGraphChapters({ forcePending: true })
  }

  function getDisplayKgScanJobStatus(): { label: string; isInterrupted: boolean } {
    if (!kgScanJob) return { label: '', isInterrupted: false }

    if (kgScanJob.status === 'running') {
      const staleThresholdMs = 30_000
      const lastUpdate = new Date(kgScanJob.updatedAt).getTime()
      if (Date.now() - lastUpdate > staleThresholdMs) {
        return { label: '已中断', isInterrupted: true }
      }
      return { label: '进行中', isInterrupted: false }
    }

    if (kgScanJob.status === 'completed') return { label: '已完成', isInterrupted: false }
    return { label: '失败', isInterrupted: false }
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

          {kgEntityEdit && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-edit-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">实体编辑</p>
                    <h2 id="kg-edit-title">编辑实体</h2>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => setKgEntityEdit(null)}>
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <label htmlFor="kg-edit-name">名称</label>
                  <input
                    id="kg-edit-name"
                    type="text"
                    value={kgEntityEditName}
                    onChange={(event) => setKgEntityEditName(event.target.value)}
                  />

                  <label htmlFor="kg-edit-type">类型</label>
                  <select
                    id="kg-edit-type"
                    value={kgEntityEditType}
                    onChange={(event) => setKgEntityEditType(event.target.value)}
                  >
                    <option value="character">人物</option>
                    <option value="sect">门派/组织</option>
                    <option value="item">道具/法宝</option>
                    <option value="skill">功法/法术</option>
                    <option value="location">地点</option>
                    <option value="beast">灵兽/妖兽</option>
                    <option value="event">事件</option>
                    <option value="other">其他</option>
                  </select>

                  <label htmlFor="kg-edit-aliases">别名（用中文顿号“、”分隔）</label>
                  <input
                    id="kg-edit-aliases"
                    type="text"
                    value={kgEntityEditAliases}
                    onChange={(event) => setKgEntityEditAliases(event.target.value)}
                  />

                  <label htmlFor="kg-edit-description">描述</label>
                  <input
                    id="kg-edit-description"
                    type="text"
                    value={kgEntityEditDescription}
                    onChange={(event) => setKgEntityEditDescription(event.target.value)}
                  />
                </div>

                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={() => setKgEntityEdit(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={!kgEntityEditName.trim()}
                    onClick={() =>
                      void updateKgEntity(kgEntityEdit.id, {
                        name: kgEntityEditName.trim(),
                        type: kgEntityEditType,
                        aliases: kgEntityEditAliases
                          .split('、')
                          .map((alias) => alias.trim())
                          .filter(Boolean),
                        description: kgEntityEditDescription.trim(),
                      })
                    }
                  >
                    保存
                  </button>
                </div>
              </section>
            </div>
          )}

          {kgRelationEdit && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-relation-edit-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">关系编辑</p>
                    <h2 id="kg-relation-edit-title">编辑关系</h2>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => setKgRelationEdit(null)}>
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <p>
                    {kgRelationEdit.sourceName} <strong>--</strong> {kgRelationEdit.targetName}
                  </p>

                  <label htmlFor="kg-relation-edit-type">关系类型</label>
                  <select
                    id="kg-relation-edit-type"
                    value={kgRelationEditType}
                    onChange={(event) => setKgRelationEditType(event.target.value)}
                  >
                    <option value="knows">认识</option>
                    <option value="ally_of">盟友</option>
                    <option value="enemy_of">敌对</option>
                    <option value="master_of">师父</option>
                    <option value="disciple_of">徒弟</option>
                    <option value="member_of">成员</option>
                    <option value="belongs_to">属于</option>
                    <option value="owns">拥有</option>
                    <option value="uses">使用</option>
                    <option value="learns">学习</option>
                    <option value="created_by">创造者</option>
                    <option value="located_in">位于</option>
                    <option value="appears_with">一起出现</option>
                    <option value="transforms_into">转化为</option>
                    <option value="related_to">相关</option>
                  </select>

                  <label htmlFor="kg-relation-edit-description">描述</label>
                  <input
                    id="kg-relation-edit-description"
                    type="text"
                    value={kgRelationEditDescription}
                    onChange={(event) => setKgRelationEditDescription(event.target.value)}
                  />
                </div>

                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={() => setKgRelationEdit(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateKgRelation(kgRelationEdit.id, {
                        type: kgRelationEditType,
                        description: kgRelationEditDescription.trim(),
                      })
                    }
                  >
                    保存
                  </button>
                </div>
              </section>
            </div>
          )}

          {kgBatchMergeSelectedIds.length > 0 && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-batch-merge-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">批量合并</p>
                    <h2 id="kg-batch-merge-title">合并 {kgBatchMergeSelectedIds.length} 个实体</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgBatchMergeTargetId('')
                      setKgBatchMergeCandidates([])
                      setKgBatchMergeQuery('')
                    }}
                  >
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <label>将被合并的实体</label>
                  <div className="kg-merge-candidate-list">
                    {kgBatchMergeSelectedIds
                      .map((id) => kgEntities.find((entity) => entity.id === id))
                      .filter(Boolean)
                      .map((entity) => (
                        <div className="kg-entity-row" key={entity!.id}>
                          <div>
                            <strong>{entity!.name}</strong>
                            <span>{entity!.type}</span>
                          </div>
                          <p>
                            出现 {entity!.mentionCount} 次
                            {entity!.aliases.length ? ` · 别名 ${entity!.aliases.join('、')}` : ''}
                          </p>
                        </div>
                      ))}
                  </div>

                  <label htmlFor="kg-batch-merge-search">搜索主实体</label>
                  <input
                    id="kg-batch-merge-search"
                    type="text"
                    placeholder="输入名称或别名"
                    value={kgBatchMergeQuery}
                    onChange={(event) => {
                      setKgBatchMergeQuery(event.target.value)
                      void searchKgBatchMergeCandidates(event.target.value)
                    }}
                  />

                  <label>选择主实体</label>
                  {kgBatchMergeCandidates.length ? (
                    <div className="kg-merge-candidate-list">
                      {kgBatchMergeCandidates
                        .filter((candidate) => !kgBatchMergeSelectedIds.includes(candidate.id))
                        .map((candidate) => (
                          <button
                            type="button"
                            key={candidate.id}
                            className={candidate.id === kgBatchMergeTargetId ? 'kg-entity-row active' : 'kg-entity-row'}
                            onClick={() => setKgBatchMergeTargetId(candidate.id)}
                          >
                            <div>
                              <strong>{candidate.name}</strong>
                              <span>{candidate.type}</span>
                            </div>
                            <p>
                              出现 {candidate.mentionCount} 次
                              {candidate.aliases.length ? ` · 别名 ${candidate.aliases.join('、')}` : ''}
                            </p>
                          </button>
                        ))}
                    </div>
                  ) : (
                    <p className="empty-summary">没有候选实体，请尝试其他搜索词。</p>
                  )}
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgBatchMergeTargetId('')
                      setKgBatchMergeCandidates([])
                      setKgBatchMergeQuery('')
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={!kgBatchMergeTargetId}
                    onClick={() => void mergeKgEntitiesBatch(kgBatchMergeSelectedIds, kgBatchMergeTargetId)}
                  >
                    {(() => {
                      const target = kgBatchMergeCandidates.find((candidate) => candidate.id === kgBatchMergeTargetId)
                      return target
                        ? `合并到 ${target.name}`
                        : `合并 ${kgBatchMergeSelectedIds.length} 个实体`
                    })()}
                  </button>
                </div>
              </section>
            </div>
          )}

          {kgMergeSource && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-merge-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">实体合并</p>
                    <h2 id="kg-merge-title">合并实体</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgMergeSource(null)
                      setKgMergeTargetId('')
                      setKgMergeCandidates([])
                      setKgMergeQuery('')
                    }}
                  >
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <p>
                    将 <strong>{kgMergeSource.name}</strong> 合并到另一个实体。合并后，源实体的别名、提及和关系都会迁移到目标实体。
                  </p>

                  <label htmlFor="kg-merge-search">搜索目标实体</label>
                  <input
                    id="kg-merge-search"
                    type="text"
                    placeholder="输入名称或别名"
                    value={kgMergeQuery}
                    onChange={(event) => {
                      setKgMergeQuery(event.target.value)
                      void searchKgMergeCandidates(event.target.value)
                    }}
                  />

                  <label>选择目标实体</label>
                  {kgMergeCandidates.length ? (
                    <div className="kg-merge-candidate-list">
                      {kgMergeCandidates.map((candidate) => (
                        <button
                          type="button"
                          key={candidate.id}
                          className={candidate.id === kgMergeTargetId ? 'kg-entity-row active' : 'kg-entity-row'}
                          onClick={() => setKgMergeTargetId(candidate.id)}
                        >
                          <div>
                            <strong>{candidate.name}</strong>
                            <span>{candidate.type}</span>
                          </div>
                          <p>
                            出现 {candidate.mentionCount} 次
                            {candidate.aliases.length ? ` · 别名 ${candidate.aliases.join('、')}` : ''}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-summary">没有候选实体，请尝试其他搜索词。</p>
                  )}

                  {kgMergeTargetId && (
                    <p className="empty-summary">
                      已选择目标实体，确认后将把 <strong>{kgMergeSource.name}</strong> 合并进去。
                    </p>
                  )}
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgMergeSource(null)
                      setKgMergeTargetId('')
                      setKgMergeCandidates([])
                      setKgMergeQuery('')
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={!kgMergeTargetId}
                    onClick={() => void mergeKgEntities(kgMergeSource.id, kgMergeTargetId)}
                  >
                    确认合并
                  </button>
                </div>
              </section>
            </div>
          )}

          <div className="kg-stats">
            <button
              type="button"
              className={showKgScannedChapters ? 'active' : ''}
              onClick={() => {
                setShowKgScannedChapters((current) => !current)
                setShowKgReviewQueue(false)
              }}
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
                setShowKgReviewQueue(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
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
                setShowKgReviewQueue(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
              }}
            >
              <span>关系</span>
              <strong>{kgOverview?.relation_count ?? 0}</strong>
            </button>
            <button
              type="button"
              className={showKgReviewQueue ? 'active' : ''}
              onClick={() => {
                setShowKgReviewQueue((current) => !current)
                setShowKgEntities(false)
                setShowKgRelations(false)
                setShowKgScannedChapters(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
              }}
            >
              <span>待复审</span>
              <strong>{kgReviewEntities.length + kgReviewRelations.length}</strong>
            </button>
          </div>

          {showKgReviewQueue && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>复审队列</h3>
                  <p>自动标记置信度低、类型模糊或内容可疑的实体和关系，供人工审核。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgReviewQueue(false)}>
                  收起
                </button>
              </div>

              <div className="kg-batch-actions">
                <span>已选 {kgReviewSelectedIds.length} 项</span>
                <button type="button" className="ghost-button" onClick={() => selectAllKgReviewItems()}>
                  全选
                </button>
                <button type="button" className="ghost-button" onClick={() => clearKgReviewSelection()}>
                  取消全选
                </button>
                <button
                  type="button"
                  disabled={kgReviewSelectedIds.length === 0}
                  onClick={() => void markKgReviewItems(kgReviewSelectedIds, 'approved')}
                >
                  标记已审
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={kgReviewSelectedIds.length === 0}
                  onClick={() => void markKgReviewItems(kgReviewSelectedIds, 'ignored')}
                >
                  忽略
                </button>
              </div>

              <div className="kg-filter-bar">
                <select value={kgReviewKind} onChange={(event) => setKgReviewKind(event.target.value as 'all' | 'entity' | 'relation')}>
                  <option value="all">全部</option>
                  <option value="entity">实体</option>
                  <option value="relation">关系</option>
                </select>
                <span className="kg-review-count">
                  实体 {kgReviewEntities.length} 条 · 关系 {kgReviewRelations.length} 条
                </span>
              </div>

              {kgReviewItems.length ? (
                <div className="kg-entity-list kg-large-list">
                  {kgReviewItems.map((item) => {
                    const isSelected = kgReviewSelectedIds.includes(item.id)
                    const isEntity = isKgReviewEntity(item)

                    return (
                      <div
                        className={isSelected ? 'kg-entity-row selected' : 'kg-entity-row'}
                        key={item.id}
                      >
                        <div className="kg-review-row-main">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleKgReviewSelection(item.id)}
                          />
                          <button
                            type="button"
                            className="kg-review-row-content"
                            onClick={() =>
                              isEntity
                                ? void openKgEntityDetail(item.id)
                                : void openKgRelationDetail(item.id)
                            }
                          >
                            <div>
                              <div className="kg-entity-row-main">
                                <strong>{isEntity ? item.name : `${item.sourceName} → ${item.targetName}`}</strong>
                                <span>{item.type}</span>
                              </div>
                              <p>
                                {isEntity
                                  ? `出现 ${item.mentionCount} 次`
                                  : `证据 ${item.mentionCount ?? 0} 次`}
                                {' · '}
                                置信度 {Math.round(item.confidence * 100)}%
                              </p>
                            </div>
                            <div className="kg-review-reasons">
                              {item.reasons.map((reason) => (
                                <span className="tag" key={reason}>
                                  {formatReviewReason(reason)}
                                </span>
                              ))}
                            </div>
                          </button>
                        </div>
                        <div className="kg-review-row-actions">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              isEntity
                                ? setKgEntityEdit(item)
                                : setKgRelationEdit(item)
                            }
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => void markKgReviewItems([item.id], 'approved')}
                          >
                            已审
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => void markKgReviewItems([item.id], 'ignored')}
                          >
                            忽略
                          </button>
                          <button
                            type="button"
                            className="ghost-button danger-button"
                            onClick={() =>
                              isEntity
                                ? void deleteKgEntity(item.id)
                                : void deleteKgRelation(item.id)
                            }
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="empty-summary">没有需要复审的项。</p>
              )}
            </section>
          )}

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
                <div className="kg-detail-actions">
                  {!kgBatchMergeMode ? (
                    <button type="button" className="ghost-button" onClick={() => toggleKgBatchMergeMode()}>
                      批量合并
                    </button>
                  ) : (
                    <button type="button" className="ghost-button" onClick={() => toggleKgBatchMergeMode()}>
                      退出批量模式
                    </button>
                  )}
                  <button type="button" className="ghost-button" onClick={() => setShowKgEntities(false)}>
                    收起
                  </button>
                </div>
              </div>

              {kgBatchMergeMode && (
                <div className="kg-batch-actions">
                  <span>已选 {kgBatchMergeSelectedIds.length} 个实体</span>
                  <button type="button" className="ghost-button" onClick={() => selectAllKgBatchMergeEntities()}>
                    全选
                  </button>
                  <button type="button" className="ghost-button" onClick={() => clearKgBatchMergeSelection()}>
                    取消全选
                  </button>
                  <button
                    type="button"
                    disabled={kgBatchMergeSelectedIds.length === 0}
                    onClick={() => openKgBatchMergeModal()}
                  >
                    选择主实体合并
                  </button>
                </div>
              )}

              <div className="kg-filter-bar">
                <input
                  type="text"
                  placeholder="搜索实体名称或别名"
                  value={kgEntitySearch}
                  onChange={(event) => setKgEntitySearch(event.target.value)}
                />
                <select
                  value={kgEntityTypeFilter}
                  onChange={(event) => setKgEntityTypeFilter(event.target.value)}
                >
                  <option value="">全部类型</option>
                  <option value="character">人物</option>
                  <option value="sect">门派/组织</option>
                  <option value="item">道具/法宝</option>
                  <option value="skill">功法/法术</option>
                  <option value="location">地点</option>
                  <option value="beast">灵兽/妖兽</option>
                </select>
                {(kgEntitySearch || kgEntityTypeFilter) && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgEntitySearch('')
                      setKgEntityTypeFilter('')
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
              {kgEntities.length ? (
                <div className="kg-entity-list kg-large-list">
                  {kgEntities.map((entity) => {
                    const isSelected = kgBatchMergeSelectedIds.includes(entity.id)

                    return (
                      <button
                        type="button"
                        className={isSelected ? 'kg-entity-row kg-clickable-row selected' : 'kg-entity-row kg-clickable-row'}
                        key={entity.id}
                        onClick={() =>
                          kgBatchMergeMode
                            ? toggleKgBatchMergeSelection(entity.id)
                            : void openKgEntityDetail(entity.id)
                        }
                      >
                        <div>
                          <div className="kg-entity-row-main">
                            {kgBatchMergeMode && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleKgBatchMergeSelection(entity.id)}
                                onClick={(event) => event.stopPropagation()}
                              />
                            )}
                            <strong>{entity.name}</strong>
                          </div>
                          <span>{entity.type}</span>
                        </div>
                        <p>
                          出现 {entity.mentionCount} 次
                          {entity.aliases.length ? ` · 别名 ${entity.aliases.join('、')}` : ''}
                          {entity.description ? ` · ${entity.description}` : ''}
                        </p>
                      </button>
                    )
                  })}
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
                    {' · '}
                    出现 {kgEntityDetail.entity.mentionCount} 次
                    {' · '}
                    关系 {kgEntityDetail.relations.length} 条
                    {kgEntityDetail.entity.firstChapterIndex != null ? ` · 首次出现 第${kgEntityDetail.entity.firstChapterIndex}章` : ''}
                    {kgEntityDetail.entity.lastChapterIndex != null ? ` · 末次出现 第${kgEntityDetail.entity.lastChapterIndex}章` : ''}
                  </p>
                </div>
                <div className="kg-detail-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setKgEntityEdit(kgEntityDetail.entity)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => openKgMergeModal(kgEntityDetail.entity)}
                  >
                    合并
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={() => void deleteKgEntity(kgEntityDetail.entity.id)}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgEntityDetail(null)
                      setKgRelationDetail(null)
                    }}
                  >
                    关闭详情
                  </button>
                </div>
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
                    <button
                      type="button"
                      className="kg-mini-row"
                      key={relation.id}
                      onClick={() => void openKgRelationDetail(relation.id)}
                    >
                      <strong>
                        {relation.sourceName} -- {relation.type} -- {relation.targetName}
                      </strong>
                      {relation.description && <span>{relation.description}</span>}
                    </button>
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
              <div className="kg-filter-bar">
                <select
                  value={kgRelationTypeFilter}
                  onChange={(event) => setKgRelationTypeFilter(event.target.value)}
                >
                  <option value="">全部关系类型</option>
                  <option value="knows">认识</option>
                  <option value="ally_of">盟友</option>
                  <option value="enemy_of">敌对</option>
                  <option value="master_of">师父</option>
                  <option value="disciple_of">徒弟</option>
                  <option value="member_of">成员</option>
                  <option value="belongs_to">属于</option>
                  <option value="owns">拥有</option>
                  <option value="uses">使用</option>
                  <option value="learns">学习</option>
                  <option value="created_by">创造者</option>
                  <option value="located_in">位于</option>
                  <option value="appears_with">一起出现</option>
                  <option value="transforms_into">转化为</option>
                  <option value="related_to">相关</option>
                </select>
                {kgRelationTypeFilter && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setKgRelationTypeFilter('')}
                  >
                    清除
                  </button>
                )}
              </div>
              {kgRelations.length ? (
                <div className="kg-relation-list">
                  {kgRelations.map((relation) => (
                    <button
                      type="button"
                      className="kg-relation-row kg-clickable-row"
                      key={relation.id}
                      onClick={() => void openKgRelationDetail(relation.id)}
                    >
                      <div>
                        <strong>{relation.sourceName}</strong>
                        <span>{relation.type}</span>
                        <strong>{relation.targetName}</strong>
                      </div>
                      <p>
                        {relation.description || '暂无描述'}
                        {' · '}
                        证据 {relation.mentionCount ?? 0} · 置信度 {Math.round(relation.confidence * 100)}%
                        {relation.firstChapterIndex != null ? ` · 首次出现 第${relation.firstChapterIndex}章` : ''}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-summary">还没有关系。</p>
              )}
            </section>
          )}

          {kgRelationDetail && (
            <section className="kg-card kg-detail-card">
              <div className="kg-card-heading">
                <div>
                  <h3>
                    {kgRelationDetail.relation.sourceName} -- {kgRelationDetail.relation.type} -- {kgRelationDetail.relation.targetName}
                  </h3>
                  <p>
                    {kgRelationDetail.relation.sourceType} → {kgRelationDetail.relation.targetType}
                    {kgRelationDetail.relation.firstChapterIndex != null ? ` · 首次出现 第${kgRelationDetail.relation.firstChapterIndex}章` : ''}
                    {kgRelationDetail.relation.lastChapterIndex != null ? ` · 末次出现 第${kgRelationDetail.relation.lastChapterIndex}章` : ''}
                  </p>
                </div>
                <div className="kg-detail-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setKgRelationEdit(kgRelationDetail.relation)}
                  >
                    编辑关系
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={() => void deleteKgRelation(kgRelationDetail.relation.id)}
                  >
                    删除关系
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgRelationDetail(null)
                      setKgEntityDetail(null)
                    }}
                  >
                    关闭详情
                  </button>
                </div>
              </div>
              {kgRelationDetail.relation.description && <p>{kgRelationDetail.relation.description}</p>}
              <div className="kg-detail-grid">
                <div>
                  <h4>源实体</h4>
                  <button
                    type="button"
                    className="kg-mini-row"
                    onClick={() => void openKgEntityDetail(kgRelationDetail.relation.sourceId)}
                  >
                    <strong>{kgRelationDetail.relation.sourceName}</strong>
                    <span>{kgRelationDetail.relation.sourceType}</span>
                  </button>
                </div>
                <div>
                  <h4>目标实体</h4>
                  <button
                    type="button"
                    className="kg-mini-row"
                    onClick={() => void openKgEntityDetail(kgRelationDetail.relation.targetId)}
                  >
                    <strong>{kgRelationDetail.relation.targetName}</strong>
                    <span>{kgRelationDetail.relation.targetType}</span>
                  </button>
                </div>
              </div>
              <h4>证据章节</h4>
              <div className="kg-scanned-list">
                {kgRelationDetail.mentions.map((mention) => (
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
              {kgScanJob && !isKgScanning && (
                <div className="kg-scan-status">
                  <p>
                    上次任务：{getDisplayKgScanJobStatus().label}
                    {' '}
                    {kgScanJob.status === 'running' && !getDisplayKgScanJobStatus().isInterrupted && (
                      <span>({kgScanJob.completedChapters}/{kgScanJob.totalChapters} 章)</span>
                    )}
                    {getDisplayKgScanJobStatus().isInterrupted && (
                      <span>（{kgScanJob.completedChapters}/{kgScanJob.totalChapters} 章，可恢复）</span>
                    )}
                    {kgScanJob.status === 'completed' && (
                      <span>（{kgScanJob.completedChapters}/{kgScanJob.totalChapters} 章）</span>
                    )}
                    {kgScanJob.status === 'failed' && (
                      <span>（成功 {kgScanJob.completedChapters}，失败 {kgScanJob.failedChapters}）</span>
                    )}
                    {kgScanJob.error && <span className="error"> · {kgScanJob.error}</span>}
                  </p>
                  {getDisplayKgScanJobStatus().isInterrupted && (
                    <button type="button" onClick={() => void resumeKnowledgeGraphScan()}>
                      恢复扫描
                    </button>
                  )}
                </div>
              )}
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
              <div className="kg-filter-bar">
                <input
                  type="text"
                  placeholder="搜索实体名称或别名"
                  value={kgEntitySearch}
                  onChange={(event) => setKgEntitySearch(event.target.value)}
                />
                <select
                  value={kgEntityTypeFilter}
                  onChange={(event) => setKgEntityTypeFilter(event.target.value)}
                >
                  <option value="">全部类型</option>
                  <option value="character">人物</option>
                  <option value="sect">门派/组织</option>
                  <option value="item">道具/法宝</option>
                  <option value="skill">功法/法术</option>
                  <option value="location">地点</option>
                  <option value="beast">灵兽/妖兽</option>
                </select>
                {(kgEntitySearch || kgEntityTypeFilter) && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgEntitySearch('')
                      setKgEntityTypeFilter('')
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
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
