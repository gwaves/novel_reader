import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useReaderState } from './hooks/useReaderState.ts'
import type { AIProvider, Chapter, EmbeddingProvider, ImportEncoding, OpenAIConfig } from './hooks/useReaderState.ts'
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

type KgNeighborhood = {
  centerId: string
  entities: KgEntity[]
  relations: KgRelation[]
}

type KgBookGraph = {
  entities: KgEntity[]
  relations: KgRelation[]
}

type KgEvidenceEntityHit = {
  mentionId: string
  entityId: string
  entityName: string
  entityType: string
  entityDescription: string | null
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  evidence: string | null
  confidence: number
}

type KgEvidenceRelationHit = {
  mentionId: string
  relationId: string
  relationType: string
  relationDescription: string | null
  sourceId: string
  sourceName: string
  sourceType: string
  targetId: string
  targetName: string
  targetType: string
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  evidence: string | null
  confidence: number
}

type KgEvidenceSearchResponse = {
  entities: KgEvidenceEntityHit[]
  relations: KgEvidenceRelationHit[]
}

type KgExtractionDiffEntity = {
  key: string
  name: string
  type: string
  description: string
  evidence: string
  confidence: number
}

type KgExtractionDiffRelation = {
  key: string
  sourceName: string
  targetName: string
  sourceType: string
  targetType: string
  type: string
  description: string
  evidence: string
  confidence: number
}

type KgExtractionDiff = {
  chapter: {
    id: string
    index: number
    title: string
  }
  summary: {
    entitiesAdded: number
    entitiesRemoved: number
    entitiesUnchanged: number
    relationsAdded: number
    relationsRemoved: number
    relationsUnchanged: number
  }
  entities: {
    added: KgExtractionDiffEntity[]
    removed: KgExtractionDiffEntity[]
    unchanged: KgExtractionDiffEntity[]
  }
  relations: {
    added: KgExtractionDiffRelation[]
    removed: KgExtractionDiffRelation[]
    unchanged: KgExtractionDiffRelation[]
  }
}

type KgExtractionPreviewItem = {
  chapter: Chapter
  diff: KgExtractionDiff
  extraction: unknown
  model: string
}

type KgExtractionPreview = {
  title: string
  items: KgExtractionPreviewItem[]
}

type KgGraphNodeData = {
  entity: KgEntity
  label: string
}

type KgGraphEdgeData = {
  relation: KgRelation
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
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  totalChapters: number
  completedChapters: number
  failedChapters: number
  error: string | null
  createdAt: string
  updatedAt: string
}

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
  matchType: 'vector' | 'entity' | 'both'
  matchedEntities: string[]
  contentSnippet: string | null
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
  embeddedChapters: number
  missingChapters: number
  model: string
  dimension: number | null
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

function getKgEntityTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    beast: '灵兽',
    character: '人物',
    event: '事件',
    item: '道具',
    location: '地点',
    other: '其他',
    sect: '组织',
    skill: '功法',
  }
  return labels[type] ?? type
}

function getKgEntityColor(type: string): string {
  const colors: Record<string, string> = {
    beast: '#7f5a9b',
    character: '#2c5b4b',
    event: '#8b5e34',
    item: '#9a6a22',
    location: '#326d86',
    other: '#6f6558',
    sect: '#6f4f91',
    skill: '#a94f64',
  }
  return colors[type] ?? colors.other
}

function normalizeGraphSearch(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

function getKgEntityNodeWidth(entity: KgEntity): number {
  const mentionCount = Math.max(0, Number(entity.mentionCount) || 0)
  return Math.max(132, Math.min(190, 132 + Math.log2(mentionCount + 1) * 9))
}

function getKgRelationStrokeWidth(relation: KgRelation): number {
  const mentionCount = Math.max(0, Number(relation.mentionCount) || 0)
  return Math.max(1.25, Math.min(5, 1.25 + Math.log2(mentionCount + 1) * 0.75))
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
  const databaseImportInputRef = useRef<HTMLInputElement | null>(null)
  const shouldStopScanningRef = useRef(false)
  const [kgOverview, setKgOverview] = useState<KgOverview | null>(null)
  const [kgEntities, setKgEntities] = useState<KgEntity[]>([])
  const [kgRelations, setKgRelations] = useState<KgRelation[]>([])
  const [kgEntityDetail, setKgEntityDetail] = useState<KgEntityDetail | null>(null)
  const [kgScannedChapters, setKgScannedChapters] = useState<KgScannedChapter[]>([])
  const [showKgScannedChapters, setShowKgScannedChapters] = useState(false)
  const [showKgEntities, setShowKgEntities] = useState(false)
  const [showKgRelations, setShowKgRelations] = useState(false)
  const [kgExtractionText, setKgExtractionText] = useState('')
  const [kgExtractionPreview, setKgExtractionPreview] = useState<KgExtractionPreview | null>(null)
  const [isKgApplyingPreview, setIsKgApplyingPreview] = useState(false)
  const [kgError, setKgError] = useState('')
  const [showKgManualExtraction, setShowKgManualExtraction] = useState(false)
  const [kgScanMode, setKgScanMode] = useState<KgScanMode>('current')
  const [kgScanStart, setKgScanStart] = useState(1)
  const [kgScanEnd, setKgScanEnd] = useState(1)
  const [kgScanConcurrency, setKgScanConcurrency] = useState(10)
  const [kgScanOverwriteCompleted, setKgScanOverwriteCompleted] = useState(false)
  const [isKgScanning, setIsKgScanning] = useState(false)
  const [isStoppingKgScan, setIsStoppingKgScan] = useState(false)
  const [kgScanProgress, setKgScanProgress] = useState('')
  const [kgScanJob, setKgScanJob] = useState<KgScanJob | null>(null)
  const [kgRelationDetail, setKgRelationDetail] = useState<KgRelationDetail | null>(null)
  const [kgNeighborhood, setKgNeighborhood] = useState<KgNeighborhood | null>(null)
  const [showKgGraph, setShowKgGraph] = useState(false)
  const [kgGraphEntityTypeFilter, setKgGraphEntityTypeFilter] = useState('')
  const [kgGraphRelationTypeFilter, setKgGraphRelationTypeFilter] = useState('')
  const [kgBookGraph, setKgBookGraph] = useState<KgBookGraph | null>(null)
  const [showKgBookGraph, setShowKgBookGraph] = useState(false)
  const [kgBookGraphEntityTypeFilter, setKgBookGraphEntityTypeFilter] = useState('character')
  const [kgBookGraphRelationTypeFilter, setKgBookGraphRelationTypeFilter] = useState('')
  const [kgBookGraphSearch, setKgBookGraphSearch] = useState('')
  const [kgBookGraphMaxNodes, setKgBookGraphMaxNodes] = useState('80')
  const [showKgEvidenceSearch, setShowKgEvidenceSearch] = useState(false)
  const [kgEvidenceSearchQuery, setKgEvidenceSearchQuery] = useState('')
  const [kgEvidenceSearchKind, setKgEvidenceSearchKind] = useState<'all' | 'entities' | 'relations'>('all')
  const [kgEvidenceEntityHits, setKgEvidenceEntityHits] = useState<KgEvidenceEntityHit[]>([])
  const [kgEvidenceRelationHits, setKgEvidenceRelationHits] = useState<KgEvidenceRelationHit[]>([])
  const [isKgEvidenceSearching, setIsKgEvidenceSearching] = useState(false)
  const [isKgExporting, setIsKgExporting] = useState(false)
  const [isDatabaseBackupBusy, setIsDatabaseBackupBusy] = useState(false)
  const [databaseBackupStatus, setDatabaseBackupStatus] = useState('')
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
  const [kgRelationEditSourceId, setKgRelationEditSourceId] = useState('')
  const [kgRelationEditTargetId, setKgRelationEditTargetId] = useState('')
  const [kgRelationEditSourceQuery, setKgRelationEditSourceQuery] = useState('')
  const [kgRelationEditTargetQuery, setKgRelationEditTargetQuery] = useState('')
  const [kgRelationEditSourceCandidates, setKgRelationEditSourceCandidates] = useState<KgEntity[]>([])
  const [kgRelationEditTargetCandidates, setKgRelationEditTargetCandidates] = useState<KgEntity[]>([])
  const [kgMergeSource, setKgMergeSource] = useState<KgEntity | null>(null)
  const [kgMergeTargetId, setKgMergeTargetId] = useState('')
  const [kgMergeCandidates, setKgMergeCandidates] = useState<KgEntity[]>([])
  const [kgMergeQuery, setKgMergeQuery] = useState('')
  const [kgBatchMergeMode, setKgBatchMergeMode] = useState(false)
  const [kgBatchMergeSelectedIds, setKgBatchMergeSelectedIds] = useState<string[]>([])
  const [kgBatchMergeTargetId, setKgBatchMergeTargetId] = useState('')
  const [kgBatchMergeCandidates, setKgBatchMergeCandidates] = useState<KgEntity[]>([])
  const [kgBatchMergeQuery, setKgBatchMergeQuery] = useState('')
  const [kgSplitSource, setKgSplitSource] = useState<KgEntityDetail | null>(null)
  const [kgSplitMode, setKgSplitMode] = useState<'new' | 'existing'>('new')
  const [kgSplitName, setKgSplitName] = useState('')
  const [kgSplitType, setKgSplitType] = useState('')
  const [kgSplitAliases, setKgSplitAliases] = useState('')
  const [kgSplitDescription, setKgSplitDescription] = useState('')
  const [kgSplitMovedAliases, setKgSplitMovedAliases] = useState<string[]>([])
  const [kgSplitMentionIds, setKgSplitMentionIds] = useState<string[]>([])
  const [kgSplitRelationIds, setKgSplitRelationIds] = useState<string[]>([])
  const [kgSplitTargetId, setKgSplitTargetId] = useState('')
  const [kgSplitTargetQuery, setKgSplitTargetQuery] = useState('')
  const [kgSplitTargetCandidates, setKgSplitTargetCandidates] = useState<KgEntity[]>([])
  const [showKgReviewQueue, setShowKgReviewQueue] = useState(false)
  const [kgReviewEntities, setKgReviewEntities] = useState<KgReviewEntity[]>([])
  const [kgReviewRelations, setKgReviewRelations] = useState<KgReviewRelation[]>([])
  const [kgReviewKind, setKgReviewKind] = useState<'all' | 'entity' | 'relation'>('all')
  const [kgReviewSelectedIds, setKgReviewSelectedIds] = useState<string[]>([])

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

  useEffect(() => {
    if (view !== 'reader' || !activeChapter) return

    window.requestAnimationFrame(() => {
      activeChapterButtonRef.current?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    })
  }, [view, activeChapter, activeChapter?.id, chapterPage])

  useEffect(() => {
    if (view !== 'reader' || !activeChapter) return

    window.requestAnimationFrame(() => {
      if (readerRef.current) {
        readerRef.current.scrollTop = 0
      }
    })
  }, [view, activeChapter, activeChapter?.id])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book) return

    const interval = setInterval(() => {
      void checkKgScanStatus()
    }, 5000)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!showKgGraph || !kgEntityDetail) return
    void fetchKgNeighborhood(kgEntityDetail.entity.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showKgGraph, kgEntityDetail?.entity.id, kgGraphEntityTypeFilter, kgGraphRelationTypeFilter])

  useEffect(() => {
    if (view !== 'knowledge' || !state.book || !showKgBookGraph) return
    void fetchKgBookGraph()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id, showKgBookGraph, kgBookGraphEntityTypeFilter, kgBookGraphRelationTypeFilter])

  useEffect(() => {
    if (!state.book) return

    const frame = window.requestAnimationFrame(() => {
      setKgScanStart(activeChapter?.index ?? 1)
      setKgScanEnd(activeChapter?.index ?? 1)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [state.book, activeChapter?.id, activeChapter?.index])

  useEffect(() => {
    if (view !== 'search' || !state.book) return

    void fetchEmbeddingStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, state.book?.id])

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
    if (!state.book) return []

    try {
      const response = await fetch(
        `/api/kg/chapters?bookId=${encodeURIComponent(state.book.id)}`,
      )
      if (!response.ok) throw new Error('读取已扫描章节失败。')
      const payload = (await response.json()) as { chapters: KgScannedChapter[] }
      setKgScannedChapters(payload.chapters)
      return payload.chapters
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取已扫描章节失败。')
      return []
    }
  }

  async function saveCurrentChapterExtraction() {
    if (!state.book || !activeChapter) return

    setKgError('')

    try {
      const extraction = JSON.parse(kgExtractionText) as unknown
      const diff = await fetchChapterExtractionDiff(activeChapter, extraction)
      setKgExtractionPreview({
        title: '保存当前章节前预览',
        items: [{ chapter: activeChapter, diff, extraction, model: 'manual-json' }],
      })
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '保存章节抽取结果失败。')
    }
  }

  async function fetchChapterExtractionDiff(chapter: Chapter, extraction: unknown): Promise<KgExtractionDiff> {
    if (!state.book) throw new Error('未选择书籍。')

    const response = await fetch(`/api/kg/chapters/${encodeURIComponent(chapter.id)}/extraction/diff`, {
      body: JSON.stringify({
        bookId: state.book.id,
        extraction,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      throw new Error(payload.error ?? `预览第 ${chapter.index} 章图谱变化失败。`)
    }

    return (await response.json()) as KgExtractionDiff
  }

  async function applyKgExtractionPreview() {
    if (!kgExtractionPreview) return

    setKgError('')
    setIsKgApplyingPreview(true)

    try {
      for (const item of kgExtractionPreview.items) {
        await saveChapterExtraction(item.chapter, item.extraction, item.model)
      }

      setKgExtractionText('')
      setKgExtractionPreview(null)
      setKgScanProgress(`已应用 ${kgExtractionPreview.items.length} 章图谱变化。`)
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '应用图谱变化失败。')
    } finally {
      setIsKgApplyingPreview(false)
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
      setKgNeighborhood(null)
      setShowKgGraph(false)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取实体详情失败。')
    }
  }

  async function fetchKgNeighborhood(entityId: string) {
    setKgError('')

    try {
      const response = await fetch(
        `/api/kg/entities/${encodeURIComponent(entityId)}/neighborhood?entityType=${encodeURIComponent(kgGraphEntityTypeFilter)}&relationType=${encodeURIComponent(kgGraphRelationTypeFilter)}&limit=120`,
      )

      if (!response.ok) {
        throw new Error('读取关系图失败。')
      }

      setKgNeighborhood((await response.json()) as KgNeighborhood)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取关系图失败。')
    }
  }

  async function fetchKgBookGraph() {
    if (!state.book) return

    setKgError('')

    try {
      const response = await fetch(
        `/api/kg/graph?bookId=${encodeURIComponent(state.book.id)}&entityType=${encodeURIComponent(kgBookGraphEntityTypeFilter)}&relationType=${encodeURIComponent(kgBookGraphRelationTypeFilter)}&limit=180`,
      )

      if (!response.ok) {
        throw new Error('读取全局图谱失败。')
      }

      setKgBookGraph((await response.json()) as KgBookGraph)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取全局图谱失败。')
    }
  }

  async function searchKgEvidence() {
    if (!state.book) return

    const query = kgEvidenceSearchQuery.trim()
    if (!query) {
      setKgEvidenceEntityHits([])
      setKgEvidenceRelationHits([])
      return
    }

    setKgError('')
    setIsKgEvidenceSearching(true)

    try {
      const response = await fetch(
        `/api/kg/search?bookId=${encodeURIComponent(state.book.id)}&q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kgEvidenceSearchKind)}&limit=120`,
      )

      if (!response.ok) {
        throw new Error('搜索图谱证据失败。')
      }

      const payload = (await response.json()) as KgEvidenceSearchResponse
      setKgEvidenceEntityHits(payload.entities)
      setKgEvidenceRelationHits(payload.relations)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '搜索图谱证据失败。')
    } finally {
      setIsKgEvidenceSearching(false)
    }
  }

  async function exportKnowledgeGraph(format: 'json' | 'graphml') {
    if (!state.book) return

    setKgError('')
    setIsKgExporting(true)

    try {
      const response = await fetch(
        `/api/kg/export?bookId=${encodeURIComponent(state.book.id)}&format=${encodeURIComponent(format)}`,
      )

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '导出图谱失败。')
      }

      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="([^"]+)"/)
      const fallbackName = `${state.book.title.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')}-knowledge-graph.${format}`
      const filename = filenameMatch?.[1] ?? fallbackName
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '导出图谱失败。')
    } finally {
      setIsKgExporting(false)
    }
  }

  async function downloadDatabaseBackup() {
    setKgError('')
    setDatabaseBackupStatus('')
    setIsDatabaseBackupBusy(true)

    try {
      const response = await fetch('/api/database/export')

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '导出数据库失败。')
      }

      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="([^"]+)"/)
      const filename = filenameMatch?.[1] ?? `novel_reader-backup-${new Date().toISOString()}.sqlite`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setDatabaseBackupStatus(`已开始下载：${filename}。保存位置由浏览器下载设置决定。`)
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出数据库失败。'
      setDatabaseBackupStatus(message)
      setKgError(message)
    } finally {
      setIsDatabaseBackupBusy(false)
    }
  }

  async function importDatabaseBackup(file: File) {
    const confirmed = window.confirm(
      '导入数据库备份会在下次启动本地服务时覆盖当前书架、概要和知识图谱。当前数据库会先自动备份。确定继续吗？',
    )
    if (!confirmed) return

    setKgError('')
    setDatabaseBackupStatus('')
    setIsDatabaseBackupBusy(true)

    try {
      const response = await fetch('/api/database/import', {
        body: await file.arrayBuffer(),
        headers: { 'Content-Type': 'application/octet-stream' },
        method: 'POST',
      })

      const payload = (await response.json()) as {
        backupPath?: string
        error?: string
        requiresRestart?: boolean
      }

      if (!response.ok) {
        throw new Error(payload.error ?? '导入数据库失败。')
      }

      setDatabaseBackupStatus(
        `已排队恢复。当前数据库已备份到：${payload.backupPath ?? '已创建'}。请重启本地数据库服务后刷新页面。`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : '导入数据库失败。'
      setDatabaseBackupStatus(message)
      setKgError(message)
    } finally {
      setIsDatabaseBackupBusy(false)
      if (databaseImportInputRef.current) {
        databaseImportInputRef.current.value = ''
      }
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

  function openKgEntityEdit(entity: KgEntity | null) {
    setKgEntityEdit(entity)
    setKgEntityEditName(entity?.name ?? '')
    setKgEntityEditType(entity?.type ?? '')
    setKgEntityEditAliases(entity?.aliases.join('、') ?? '')
    setKgEntityEditDescription(entity?.description ?? '')
  }

  function openKgRelationEdit(relation: KgRelation | null) {
    setKgRelationEdit(relation)
    setKgRelationEditType(relation?.type ?? '')
    setKgRelationEditDescription(relation?.description ?? '')
    setKgRelationEditSourceId(relation?.sourceId ?? '')
    setKgRelationEditTargetId(relation?.targetId ?? '')
    setKgRelationEditSourceQuery('')
    setKgRelationEditTargetQuery('')

    if (relation) {
      void searchKgRelationEndpointCandidates('', 'source')
      void searchKgRelationEndpointCandidates('', 'target')
    } else {
      setKgRelationEditSourceCandidates([])
      setKgRelationEditTargetCandidates([])
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

      openKgEntityEdit(null)
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
      openKgEntityEdit(null)
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

  async function updateKgRelation(
    relationId: string,
    payload: { type: string; description: string; sourceId: string; targetId: string },
  ) {
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

      const result = (await response.json()) as { relation: KgRelation }
      openKgRelationEdit(null)
      await Promise.all([fetchKgRelations(), openKgRelationDetail(result.relation.id), fetchKgReviewQueue()])
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '更新关系失败。')
    }
  }

  async function searchKgRelationEndpointCandidates(query: string, endpoint: 'source' | 'target') {
    if (!state.book) return

    try {
      const response = await fetch(
        `/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&type=&q=${encodeURIComponent(query)}&limit=50`,
      )
      if (!response.ok) throw new Error('读取候选实体失败。')
      const payload = (await response.json()) as { entities: KgEntity[] }
      if (endpoint === 'source') {
        setKgRelationEditSourceCandidates(payload.entities)
      } else {
        setKgRelationEditTargetCandidates(payload.entities)
      }
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取候选实体失败。')
    }
  }

  function getKgEndpointLabel(
    entityId: string,
    fallbackName: string,
    fallbackType: string,
    candidates: KgEntity[],
  ) {
    const entity = candidates.find((candidate) => candidate.id === entityId)
    return entity ? `${entity.name} · ${entity.type}` : `${fallbackName} · ${fallbackType}`
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

  function openKgSplitModal(entityDetail: KgEntityDetail) {
    setKgSplitSource(entityDetail)
    setKgSplitMode('new')
    setKgSplitName('')
    setKgSplitType(entityDetail.entity.type)
    setKgSplitAliases('')
    setKgSplitDescription('')
    setKgSplitMovedAliases([])
    setKgSplitMentionIds([])
    setKgSplitRelationIds([])
    setKgSplitTargetId('')
    setKgSplitTargetQuery('')
    setKgSplitTargetCandidates([])
  }

  function closeKgSplitModal() {
    setKgSplitSource(null)
    setKgSplitMode('new')
    setKgSplitName('')
    setKgSplitType('')
    setKgSplitAliases('')
    setKgSplitDescription('')
    setKgSplitMovedAliases([])
    setKgSplitMentionIds([])
    setKgSplitRelationIds([])
    setKgSplitTargetId('')
    setKgSplitTargetQuery('')
    setKgSplitTargetCandidates([])
  }

  function toggleKgSplitMention(mentionId: string) {
    setKgSplitMentionIds((current) =>
      current.includes(mentionId) ? current.filter((id) => id !== mentionId) : [...current, mentionId],
    )
  }

  function toggleKgSplitRelation(relationId: string) {
    setKgSplitRelationIds((current) =>
      current.includes(relationId) ? current.filter((id) => id !== relationId) : [...current, relationId],
    )
  }

  function toggleKgSplitAlias(alias: string) {
    setKgSplitMovedAliases((current) =>
      current.includes(alias) ? current.filter((value) => value !== alias) : [...current, alias],
    )
  }

  async function searchKgSplitTargetCandidates(query: string) {
    if (!state.book || !kgSplitSource) return

    try {
      const response = await fetch(
        `/api/kg/entities?bookId=${encodeURIComponent(state.book.id)}&type=&q=${encodeURIComponent(query)}&limit=50`,
      )
      if (!response.ok) throw new Error('读取候选实体失败。')
      const payload = (await response.json()) as { entities: KgEntity[] }
      setKgSplitTargetCandidates(payload.entities.filter((entity) => entity.id !== kgSplitSource.entity.id))
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '读取候选实体失败。')
    }
  }

  async function splitKgEntity() {
    if (!kgSplitSource) return

    setKgError('')

    try {
      const response = await fetch(`/api/kg/entities/${encodeURIComponent(kgSplitSource.entity.id)}/split`, {
        body: JSON.stringify({
          targetEntityId: kgSplitMode === 'existing' ? kgSplitTargetId : undefined,
          name: kgSplitName.trim(),
          type: kgSplitType,
          aliases: kgSplitAliases
            .split('、')
            .map((alias) => alias.trim())
            .filter(Boolean),
          movedAliases: kgSplitMovedAliases,
          description: kgSplitDescription.trim(),
          mentionIds: kgSplitMentionIds,
          relationIds: kgSplitRelationIds,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? '拆分实体失败。')
      }

      const result = (await response.json()) as { source: KgEntity; target: KgEntity }
      closeKgSplitModal()
      setKgRelationDetail(null)
      await refreshKnowledgeGraph()
      await openKgEntityDetail(result.target.id)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '拆分实体失败。')
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

  function getKgScanScopeDescription(selectedCount: number, pendingCount: number, overwriteCompleted = false): string {
    if (kgScanMode === 'current') return overwriteCompleted ? '覆盖重扫当前章节' : `当前章节（${pendingCount}/${selectedCount}）`
    if (kgScanMode === 'page') return overwriteCompleted ? `覆盖重扫当前页 ${selectedCount} 章` : `当前页 ${selectedCount} 章（${pendingCount} 待扫）`
    if (kgScanMode === 'all') return overwriteCompleted ? `覆盖重扫全书 ${selectedCount} 章` : `全书 ${selectedCount} 章（${pendingCount} 待扫）`
    const start = Math.min(kgScanStart, kgScanEnd)
    const end = Math.max(kgScanStart, kgScanEnd)
    return overwriteCompleted ? `覆盖重扫范围 ${start}-${end}` : `范围 ${start}-${end}（${pendingCount} 待扫）`
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

  async function replayChapterExtraction(chapter: Chapter) {
    if (!state.book) return

    const response = await fetch(`/api/kg/chapters/${encodeURIComponent(chapter.id)}/replay`, {
      body: JSON.stringify({ bookId: state.book.id }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      throw new Error(payload.error ?? `重放第 ${chapter.index} 章抽取结果失败。`)
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
    setEmbeddingProgress('准备生成 embedding...')

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

      const payload = (await response.json()) as { completed: number; failed: number; total: number; error?: string }
      if (!response.ok) {
        throw new Error(payload.error ?? '生成 embedding 失败。')
      }

      setEmbeddingProgress(`已生成 ${payload.completed}/${payload.total}，失败 ${payload.failed} 个。`)
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
        if (!activeOpenAIConfig) throw new Error('请先配置外部模型。')
        answer = await generateRagAnswerWithOpenAI(prompt, activeOpenAIConfig)
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

  async function scanSelectedKnowledgeGraphChapters(options?: { forcePending?: boolean; pendingChapters?: Chapter[]; overwriteCompleted?: boolean }) {
    const overwriteCompleted = Boolean(options?.overwriteCompleted)
    const selectedChapters = options?.forcePending
      ? state.book?.chapters ?? []
      : getSelectedKgScanChapters()
    const chapters = options?.pendingChapters
      ?? (overwriteCompleted
        ? selectedChapters
        : options?.forcePending
          ? getAllPendingKgScanChapters()
          : getPendingKgScanChapters())

    if (!state.book || !selectedChapters.length) {
      setKgError('没有可扫描的章节。')
      return
    }

    if (!chapters.length) {
      setKgScanProgress(options?.forcePending ? '没有需要恢复的章节。' : `选中的 ${selectedChapters.length} 章都已经扫描完成。`)
      return
    }

    if (!options?.forcePending && overwriteCompleted && chapters.length <= 10) {
      await previewOverwriteKnowledgeGraphScan(chapters)
      return
    }

    if (
      !options?.forcePending &&
      chapters.length > 50 &&
      !window.confirm(
        overwriteCompleted
          ? `将覆盖重扫 ${chapters.length} 章，会重新调用模型并替换对应章节的图谱证据。确定开始吗？`
          : `已跳过 ${selectedChapters.length - chapters.length} 个已完成章节，将扫描剩余 ${chapters.length} 章，可能耗时较长并产生模型调用成本。确定开始吗？`,
      )
    ) {
      return
    }

    if (
      overwriteCompleted &&
      chapters.length <= 50 &&
      !window.confirm(`将覆盖重扫 ${chapters.length} 章，会重新调用模型并替换对应章节的图谱证据。确定开始吗？`)
    ) {
      return
    }

    setKgError('')
    setIsKgScanning(true)
    setIsStoppingKgScan(false)
    shouldStopScanningRef.current = false

    let jobId: string | null = null
    let completedCount = 0
    let failedCount = 0
    let wasCancelled = false

    async function updateJobProgress(status: KgScanJob['status'], error?: string | null) {
      if (!jobId) return
      try {
        await fetch(`/api/kg/scan/jobs/${encodeURIComponent(jobId)}`, {
          body: JSON.stringify({
            status,
            completedChapters: completedCount,
            failedChapters: failedCount,
            error,
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
        : getKgScanScopeDescription(selectedChapters.length, chapters.length, overwriteCompleted)

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
          if (shouldStopScanningRef.current) {
            wasCancelled = true
            break
          }

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

          if (!shouldStopScanningRef.current) {
            await updateJobProgress('running')
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()),
      )

      let finalStatus: KgScanJob['status']
      let finalError: string | null = null

      if (wasCancelled) {
        finalStatus = 'cancelled'
        finalError = '已停止'
      } else if (failedCount > 0 && failedCount === chapters.length) {
        finalStatus = 'failed'
        finalError = `${failedCount} 章扫描失败`
      } else {
        finalStatus = 'completed'
        if (failedCount > 0) {
          finalError = `${failedCount} 章扫描失败`
        }
      }

      setKgScanProgress(
        finalStatus === 'cancelled'
          ? `扫描已停止，已完成 ${completedCount}/${chapters.length} 章。`
          : finalStatus === 'completed'
            ? `已完成 ${chapters.length} 章扫描。`
            : `扫描结束，成功 ${completedCount} 章，失败 ${failedCount} 章。`,
      )

      await updateJobProgress(finalStatus, finalError)
      setKgScanJob((prev) =>
        prev
          ? { ...prev, status: finalStatus, completedChapters: completedCount, failedChapters: failedCount, error: finalError }
          : null,
      )

      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '章节扫描失败。')
      await updateJobProgress('failed', '章节扫描失败')
      setKgScanJob((prev) => (prev ? { ...prev, status: 'failed' } : null))
    } finally {
      setIsKgScanning(false)
      setIsStoppingKgScan(false)
      shouldStopScanningRef.current = false
    }
  }

  async function previewOverwriteKnowledgeGraphScan(chapters: Chapter[]) {
    if (!state.book) return

    setKgError('')
    setIsKgScanning(true)
    setKgScanProgress(`正在生成 ${chapters.length} 章重扫预览...`)

    try {
      const items: KgExtractionPreviewItem[] = []

      for (const chapter of chapters) {
        setKgScanProgress(`正在预览第 ${chapter.index} 章 ${chapter.title}`)
        const { extraction, model } = await generateKnowledgeGraphExtraction(chapter)
        const diff = await fetchChapterExtractionDiff(chapter, extraction)
        items.push({ chapter, diff, extraction, model })
      }

      setKgExtractionPreview({
        title: `覆盖重扫前预览（${chapters.length} 章）`,
        items,
      })
      setKgScanProgress(`已生成 ${chapters.length} 章重扫预览，确认后才会写入图谱。`)
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '生成重扫预览失败。')
      setKgScanProgress('')
    } finally {
      setIsKgScanning(false)
    }
  }

  async function replaySelectedKnowledgeGraphChapters() {
    const selectedChapters = getSelectedKgScanChapters()
    const completedChapterIds = new Set(
      kgScannedChapters
        .filter((chapter) => chapter.status === 'completed')
        .map((chapter) => chapter.chapterId),
    )
    const chapters = selectedChapters.filter((chapter) => completedChapterIds.has(chapter.id))

    if (!state.book || !selectedChapters.length) {
      setKgError('没有可重放的章节。')
      return
    }

    if (!chapters.length) {
      setKgScanProgress('选中范围内没有已保存的章节抽取 JSON。')
      return
    }

    if (
      chapters.length > 50 &&
      !window.confirm(`将从已保存 JSON 重放 ${chapters.length} 章，不会调用模型，但会重建这些章节的图谱证据。确定开始吗？`)
    ) {
      return
    }

    setKgError('')
    setIsKgScanning(true)
    setIsStoppingKgScan(false)
    shouldStopScanningRef.current = false

    let completedCount = 0
    let failedCount = 0
    let nextIndex = 0
    const concurrency = Math.max(1, Math.min(10, Math.floor(kgScanConcurrency)))

    try {
      async function worker() {
        while (nextIndex < chapters.length) {
          if (shouldStopScanningRef.current) break

          const chapter = chapters[nextIndex]
          nextIndex += 1
          setKgScanProgress(
            `并发 ${concurrency}，正在重放 ${completedCount + failedCount + 1}/${chapters.length}：第 ${chapter.index} 章 ${chapter.title}`,
          )

          try {
            await replayChapterExtraction(chapter)
            completedCount += 1
          } catch {
            failedCount += 1
          }

          setKgScanProgress(`并发 ${concurrency}，已重放 ${completedCount}/${chapters.length}，失败 ${failedCount} 章`)
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()),
      )

      setKgScanProgress(
        shouldStopScanningRef.current
          ? `重放已停止，已完成 ${completedCount}/${chapters.length} 章。`
          : failedCount > 0
            ? `重放结束，成功 ${completedCount} 章，失败 ${failedCount} 章。`
            : `已完成 ${chapters.length} 章重放。`,
      )
      await refreshKnowledgeGraph()
    } catch (err) {
      setKgError(err instanceof Error ? err.message : '重放章节抽取失败。')
    } finally {
      setIsKgScanning(false)
      setIsStoppingKgScan(false)
      shouldStopScanningRef.current = false
    }
  }

  function stopKnowledgeGraphScan() {
    if (!isKgScanning) return
    shouldStopScanningRef.current = true
    setIsStoppingKgScan(true)
    setKgScanProgress('正在停止扫描...')
  }

  async function resumeKnowledgeGraphScan() {
    if (!state.book) return

    // Fetch the latest scanned chapter list and compute pending chapters locally.
    // Using the fetched result directly avoids React state batching issues where
    // getAllPendingKgScanChapters() would still see the stale kgScannedChapters array.
    const scannedChapters = await fetchKgScannedChapters()
    const completedChapterIds = new Set(
      scannedChapters.filter((chapter) => chapter.status === 'completed').map((chapter) => chapter.chapterId),
    )
    const pendingChapters = state.book.chapters.filter((chapter) => !completedChapterIds.has(chapter.id))

    await scanSelectedKnowledgeGraphChapters({ forcePending: true, pendingChapters })
  }

  const kgGraphNodes = useMemo<Node<KgGraphNodeData>[]>(() => {
    if (!kgNeighborhood) return []

    const center = kgNeighborhood.entities.find((entity) => entity.id === kgNeighborhood.centerId)
    const neighbors = kgNeighborhood.entities.filter((entity) => entity.id !== kgNeighborhood.centerId)
    const radius = neighbors.length <= 6 ? 230 : 285
    const nodes: Node<KgGraphNodeData>[] = []

    if (center) {
      nodes.push({
        id: center.id,
        position: { x: 0, y: 0 },
        data: { entity: center, label: center.name },
        style: {
          background: getKgEntityColor(center.type),
          border: '2px solid #1e332c',
          borderRadius: 8,
          color: '#fffaf2',
          fontWeight: 800,
          padding: 12,
          width: Math.max(150, getKgEntityNodeWidth(center)),
        },
      })
    }

    neighbors.forEach((entity, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, neighbors.length) - Math.PI / 2
      nodes.push({
        id: entity.id,
        position: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        },
        data: { entity, label: entity.name },
        style: {
          background: '#fffdf8',
          border: `2px solid ${getKgEntityColor(entity.type)}`,
          borderRadius: 8,
          color: '#24211c',
          fontWeight: 750,
          padding: 10,
          width: getKgEntityNodeWidth(entity),
        },
      })
    })

    return nodes
  }, [kgNeighborhood])

  const kgGraphEdges = useMemo<Edge<KgGraphEdgeData>[]>(() => {
    if (!kgNeighborhood) return []

    return kgNeighborhood.relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      label: relation.type,
      data: { relation },
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: '#8a6f45',
        strokeWidth: getKgRelationStrokeWidth(relation),
      },
      labelStyle: {
        fill: '#4d463d',
        fontSize: 12,
        fontWeight: 700,
      },
      labelBgStyle: {
        fill: '#fffaf2',
      },
    }))
  }, [kgNeighborhood])

  const kgVisibleBookGraph = useMemo(() => {
    if (!kgBookGraph) {
      return {
        entities: [] as KgEntity[],
        relations: [] as KgRelation[],
        matchingEntityIds: new Set<string>(),
      }
    }

    const degreeById = new Map<string, number>()
    for (const relation of kgBookGraph.relations) {
      degreeById.set(relation.sourceId, (degreeById.get(relation.sourceId) ?? 0) + 1)
      degreeById.set(relation.targetId, (degreeById.get(relation.targetId) ?? 0) + 1)
    }

    const query = normalizeGraphSearch(kgBookGraphSearch)
    const matchingEntityIds = new Set<string>()

    if (query) {
      for (const entity of kgBookGraph.entities) {
        const names = [entity.name, ...entity.aliases].map(normalizeGraphSearch)
        if (names.some((name) => name.includes(query))) {
          matchingEntityIds.add(entity.id)
        }
      }
    }

    let visibleEntityIds = new Set<string>()
    if (query && matchingEntityIds.size) {
      for (const relation of kgBookGraph.relations) {
        if (matchingEntityIds.has(relation.sourceId) || matchingEntityIds.has(relation.targetId)) {
          visibleEntityIds.add(relation.sourceId)
          visibleEntityIds.add(relation.targetId)
        }
      }
      for (const id of matchingEntityIds) visibleEntityIds.add(id)
    } else if (!query) {
      const maxNodes = kgBookGraphMaxNodes === 'all'
        ? Number.POSITIVE_INFINITY
        : Math.max(10, Number(kgBookGraphMaxNodes) || 80)
      visibleEntityIds = new Set(
        [...kgBookGraph.entities]
          .sort((a, b) =>
            ((b.mentionCount || 0) + (degreeById.get(b.id) ?? 0) * 2)
            - ((a.mentionCount || 0) + (degreeById.get(a.id) ?? 0) * 2),
          )
          .slice(0, maxNodes)
          .map((entity) => entity.id),
      )
    }

    const visibleEntities = kgBookGraph.entities.filter((entity) => visibleEntityIds.has(entity.id))
    const visibleRelations = kgBookGraph.relations.filter(
      (relation) => visibleEntityIds.has(relation.sourceId) && visibleEntityIds.has(relation.targetId),
    )

    return {
      entities: visibleEntities,
      relations: visibleRelations,
      matchingEntityIds,
    }
  }, [kgBookGraph, kgBookGraphMaxNodes, kgBookGraphSearch])

  const kgBookGraphNodes = useMemo<Node<KgGraphNodeData>[]>(() => {
    if (!kgBookGraph) return []

    return kgVisibleBookGraph.entities.map((entity, index) => {
      const ring = Math.floor(index / 12)
      const ringIndex = index % 12
      const ringSize = Math.min(12, kgVisibleBookGraph.entities.length - ring * 12)
      const radius = ring === 0 ? 260 : 260 + ring * 170
      const angle = (Math.PI * 2 * ringIndex) / Math.max(1, ringSize) - Math.PI / 2
      const isMatch = kgVisibleBookGraph.matchingEntityIds.has(entity.id)

      return {
        id: entity.id,
        position: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        },
        data: { entity, label: entity.name },
        style: {
          background: isMatch ? '#f8efe0' : '#fffdf8',
          border: `${isMatch ? 3 : 2}px solid ${getKgEntityColor(entity.type)}`,
          borderRadius: 8,
          color: '#24211c',
          fontWeight: 750,
          padding: Math.max(9, Math.min(14, 8 + Math.log2((entity.mentionCount || 0) + 1))),
          width: getKgEntityNodeWidth(entity),
        },
      }
    })
  }, [kgBookGraph, kgVisibleBookGraph])

  const kgBookGraphEdges = useMemo<Edge<KgGraphEdgeData>[]>(() => {
    if (!kgBookGraph) return []

    return kgVisibleBookGraph.relations.map((relation) => ({
      id: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      label: relation.type,
      data: { relation },
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: '#8a6f45',
        strokeWidth: getKgRelationStrokeWidth(relation),
      },
      labelStyle: {
        fill: '#4d463d',
        fontSize: 11,
        fontWeight: 700,
      },
      labelBgStyle: {
        fill: '#fffaf2',
      },
    }))
  }, [kgBookGraph, kgVisibleBookGraph])

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
    if (kgScanJob.status === 'cancelled') return { label: '已停止', isInterrupted: false }
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
              <button type="button" className="ghost-button home-button" onClick={() => setView('search')}>
                智能搜索
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

                  <label htmlFor="draft-embedding-provider">Embedding 提供商</label>
                  <select
                    id="draft-embedding-provider"
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
                  <small>生成章节摘要 embedding 使用的提供商，可与上方 LLM 提供商不同。</small>

                  <label htmlFor="draft-embedding-base-url">Embedding Base URL</label>
                  <input
                    id="draft-embedding-base-url"
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

                  <label htmlFor="draft-embedding-model">Embedding 模型名</label>
                  <input
                    id="draft-embedding-model"
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

                  {modelConfigDraft.embeddingConfig.provider === 'openai' && (
                    <>
                      <label htmlFor="draft-embedding-api-key">Embedding API Key</label>
                      <input
                        id="draft-embedding-api-key"
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
                    </>
                  )}

                  {typeof modelConfigDraft.embeddingConfig.dimension === 'number' && (
                    <small>当前已生成 embedding 的维度：{modelConfigDraft.embeddingConfig.dimension}</small>
                  )}
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

                  <label htmlFor="draft-embedding-provider">Embedding 提供商</label>
                  <select
                    id="draft-embedding-provider"
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
                  <small>生成章节摘要 embedding 使用的提供商，可与上方 LLM 提供商不同。</small>

                  <label htmlFor="draft-embedding-base-url">Embedding Base URL</label>
                  <input
                    id="draft-embedding-base-url"
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

                  <label htmlFor="draft-embedding-model">Embedding 模型名</label>
                  <input
                    id="draft-embedding-model"
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

                  {modelConfigDraft.embeddingConfig.provider === 'openai' && (
                    <>
                      <label htmlFor="draft-embedding-api-key">Embedding API Key</label>
                      <input
                        id="draft-embedding-api-key"
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
                    </>
                  )}

                  {typeof modelConfigDraft.embeddingConfig.dimension === 'number' && (
                    <small>当前已生成 embedding 的维度：{modelConfigDraft.embeddingConfig.dimension}</small>
                  )}

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

          <div className="database-backup-card">
            <div>
              <h3>数据库备份</h3>
              <p>导出或恢复完整 SQLite 数据库，包含书架、章节、概要和知识图谱。</p>
              {databaseBackupStatus && <p className="database-backup-status">{databaseBackupStatus}</p>}
            </div>
            <div className="book-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={isDatabaseBackupBusy}
                onClick={() => void downloadDatabaseBackup()}
              >
                备份数据库
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={isDatabaseBackupBusy}
                onClick={() => databaseImportInputRef.current?.click()}
              >
                恢复数据库
              </button>
            </div>
            <input
              ref={databaseImportInputRef}
              type="file"
              accept=".sqlite,.db,application/vnd.sqlite3,application/x-sqlite3"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importDatabaseBackup(file)
              }}
            />
          </div>
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
            <div className="kg-heading-actions">
              <button type="button" onClick={() => void refreshKnowledgeGraph()}>
                刷新图谱
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={isKgExporting}
                onClick={() => void exportKnowledgeGraph('json')}
              >
                导出 JSON
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={isKgExporting}
                onClick={() => void exportKnowledgeGraph('graphml')}
              >
                导出 GraphML
              </button>
            </div>
          </div>

          {kgEntityEdit && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-edit-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">实体编辑</p>
                    <h2 id="kg-edit-title">编辑实体</h2>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => openKgEntityEdit(null)}>
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
                  <button type="button" className="ghost-button" onClick={() => openKgEntityEdit(null)}>
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
                  <button type="button" className="ghost-button" onClick={() => openKgRelationEdit(null)}>
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <p>
                    当前：{kgRelationEdit.sourceName} <strong>--</strong> {kgRelationEdit.targetName}
                  </p>

                  <label htmlFor="kg-relation-edit-source">源实体</label>
                  <div className="kg-endpoint-picker">
                    <input
                      id="kg-relation-edit-source"
                      type="text"
                      placeholder="搜索源实体"
                      value={kgRelationEditSourceQuery}
                      onChange={(event) => {
                        setKgRelationEditSourceQuery(event.target.value)
                        void searchKgRelationEndpointCandidates(event.target.value, 'source')
                      }}
                    />
                    <span>
                      已选：{getKgEndpointLabel(
                        kgRelationEditSourceId,
                        kgRelationEdit.sourceName,
                        kgRelationEdit.sourceType,
                        kgRelationEditSourceCandidates,
                      )}
                    </span>
                    <div className="kg-merge-candidate-list">
                      {kgRelationEditSourceCandidates
                        .filter((candidate) => candidate.id !== kgRelationEditTargetId)
                        .map((candidate) => (
                          <button
                            type="button"
                            className={`kg-entity-row ${kgRelationEditSourceId === candidate.id ? 'active' : ''}`}
                            key={candidate.id}
                            onClick={() => setKgRelationEditSourceId(candidate.id)}
                          >
                            <div className="kg-entity-row-main">
                              <strong>{candidate.name}</strong>
                              <span>{candidate.type}</span>
                            </div>
                            <p>{candidate.description || '暂无描述'}</p>
                          </button>
                        ))}
                    </div>
                  </div>

                  <label htmlFor="kg-relation-edit-target">目标实体</label>
                  <div className="kg-endpoint-picker">
                    <input
                      id="kg-relation-edit-target"
                      type="text"
                      placeholder="搜索目标实体"
                      value={kgRelationEditTargetQuery}
                      onChange={(event) => {
                        setKgRelationEditTargetQuery(event.target.value)
                        void searchKgRelationEndpointCandidates(event.target.value, 'target')
                      }}
                    />
                    <span>
                      已选：{getKgEndpointLabel(
                        kgRelationEditTargetId,
                        kgRelationEdit.targetName,
                        kgRelationEdit.targetType,
                        kgRelationEditTargetCandidates,
                      )}
                    </span>
                    <div className="kg-merge-candidate-list">
                      {kgRelationEditTargetCandidates
                        .filter((candidate) => candidate.id !== kgRelationEditSourceId)
                        .map((candidate) => (
                          <button
                            type="button"
                            className={`kg-entity-row ${kgRelationEditTargetId === candidate.id ? 'active' : ''}`}
                            key={candidate.id}
                            onClick={() => setKgRelationEditTargetId(candidate.id)}
                          >
                            <div className="kg-entity-row-main">
                              <strong>{candidate.name}</strong>
                              <span>{candidate.type}</span>
                            </div>
                            <p>{candidate.description || '暂无描述'}</p>
                          </button>
                        ))}
                    </div>
                  </div>

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
                  <button type="button" className="ghost-button" onClick={() => openKgRelationEdit(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={
                      !kgRelationEditSourceId ||
                      !kgRelationEditTargetId ||
                      kgRelationEditSourceId === kgRelationEditTargetId
                    }
                    onClick={() =>
                      void updateKgRelation(kgRelationEdit.id, {
                        type: kgRelationEditType,
                        description: kgRelationEditDescription.trim(),
                        sourceId: kgRelationEditSourceId,
                        targetId: kgRelationEditTargetId,
                      })
                    }
                  >
                    保存
                  </button>
                </div>
              </section>
            </div>
          )}

          {kgSplitSource && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="kg-split-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">实体拆分</p>
                    <h2 id="kg-split-title">从 {kgSplitSource.entity.name} 拆出新实体</h2>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => closeKgSplitModal()}>
                    取消
                  </button>
                </div>

                <div className="config-form">
                  <label htmlFor="kg-split-mode">拆分目标</label>
                  <select
                    id="kg-split-mode"
                    value={kgSplitMode}
                    onChange={(event) => {
                      const mode = event.target.value as 'new' | 'existing'
                      setKgSplitMode(mode)
                      if (mode === 'existing') {
                        void searchKgSplitTargetCandidates(kgSplitTargetQuery)
                      }
                    }}
                  >
                    <option value="new">新实体</option>
                    <option value="existing">已有实体</option>
                  </select>

                  {kgSplitMode === 'new' ? (
                    <>
                      <label htmlFor="kg-split-name">新实体名称</label>
                      <input
                        id="kg-split-name"
                        type="text"
                        value={kgSplitName}
                        onChange={(event) => setKgSplitName(event.target.value)}
                      />

                      <label htmlFor="kg-split-type">类型</label>
                      <select
                        id="kg-split-type"
                        value={kgSplitType}
                        onChange={(event) => setKgSplitType(event.target.value)}
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

                      <label htmlFor="kg-split-aliases">新别名（用中文顿号“、”分隔）</label>
                      <input
                        id="kg-split-aliases"
                        type="text"
                        value={kgSplitAliases}
                        onChange={(event) => setKgSplitAliases(event.target.value)}
                      />

                      <label htmlFor="kg-split-description">描述</label>
                      <input
                        id="kg-split-description"
                        type="text"
                        value={kgSplitDescription}
                        onChange={(event) => setKgSplitDescription(event.target.value)}
                      />
                    </>
                  ) : (
                    <>
                      <label htmlFor="kg-split-target">目标实体</label>
                      <div className="kg-endpoint-picker">
                        <input
                          id="kg-split-target"
                          type="text"
                          placeholder="搜索已有实体"
                          value={kgSplitTargetQuery}
                          onChange={(event) => {
                            setKgSplitTargetQuery(event.target.value)
                            void searchKgSplitTargetCandidates(event.target.value)
                          }}
                        />
                        <span>
                          已选：{
                            kgSplitTargetCandidates.find((candidate) => candidate.id === kgSplitTargetId)
                              ? getKgEndpointLabel(kgSplitTargetId, '', '', kgSplitTargetCandidates)
                              : '未选择'
                          }
                        </span>
                        <div className="kg-merge-candidate-list">
                          {kgSplitTargetCandidates.map((candidate) => (
                            <button
                              type="button"
                              className={`kg-entity-row ${kgSplitTargetId === candidate.id ? 'active' : ''}`}
                              key={candidate.id}
                              onClick={() => setKgSplitTargetId(candidate.id)}
                            >
                              <div className="kg-entity-row-main">
                                <strong>{candidate.name}</strong>
                                <span>{candidate.type}</span>
                              </div>
                              <p>{candidate.description || '暂无描述'}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {kgSplitSource.entity.aliases.length > 0 && (
                    <div className="kg-split-section">
                      <h3>迁出别名</h3>
                      <div className="kg-split-list compact">
                        {kgSplitSource.entity.aliases.map((alias) => (
                          <label className="kg-split-option" key={alias}>
                            <input
                              type="checkbox"
                              checked={kgSplitMovedAliases.includes(alias)}
                              onChange={() => toggleKgSplitAlias(alias)}
                            />
                            <span>
                              <strong>{alias}</strong>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="kg-split-section">
                    <h3>迁出出现章节</h3>
                    <div className="kg-split-list">
                      {kgSplitSource.mentions.map((mention) => (
                        <label className="kg-split-option" key={mention.id}>
                          <input
                            type="checkbox"
                            checked={kgSplitMentionIds.includes(mention.id)}
                            onChange={() => toggleKgSplitMention(mention.id)}
                          />
                          <span>
                            <strong>第 {mention.chapterIndex} 章 · {mention.chapterTitle}</strong>
                            {mention.evidence && <small>{mention.evidence}</small>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="kg-split-section">
                    <h3>迁出相关关系</h3>
                    <div className="kg-split-list">
                      {kgSplitSource.relations.map((relation) => (
                        <label className="kg-split-option" key={relation.id}>
                          <input
                            type="checkbox"
                            checked={kgSplitRelationIds.includes(relation.id)}
                            onChange={() => toggleKgSplitRelation(relation.id)}
                          />
                          <span>
                            <strong>{relation.sourceName} -- {relation.type} -- {relation.targetName}</strong>
                            {relation.description && <small>{relation.description}</small>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" className="ghost-button" onClick={() => closeKgSplitModal()}>
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={
                      (kgSplitMode === 'new' && !kgSplitName.trim()) ||
                      (kgSplitMode === 'existing' && !kgSplitTargetId) ||
                      (kgSplitMentionIds.length === 0 && kgSplitRelationIds.length === 0)
                    }
                    onClick={() => void splitKgEntity()}
                  >
                    拆分
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

          {kgExtractionPreview && (
            <div className="modal-backdrop" role="presentation">
              <section className="config-modal kg-diff-modal" role="dialog" aria-modal="true" aria-labelledby="kg-diff-title">
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">图谱变化预览</p>
                    <h2 id="kg-diff-title">{kgExtractionPreview.title}</h2>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={isKgApplyingPreview}
                    onClick={() => setKgExtractionPreview(null)}
                  >
                    取消
                  </button>
                </div>

                <div className="kg-diff-summary">
                  <span>
                    实体 +{kgExtractionPreview.items.reduce((sum, item) => sum + item.diff.summary.entitiesAdded, 0)}
                  </span>
                  <span>
                    实体 -{kgExtractionPreview.items.reduce((sum, item) => sum + item.diff.summary.entitiesRemoved, 0)}
                  </span>
                  <span>
                    关系 +{kgExtractionPreview.items.reduce((sum, item) => sum + item.diff.summary.relationsAdded, 0)}
                  </span>
                  <span>
                    关系 -{kgExtractionPreview.items.reduce((sum, item) => sum + item.diff.summary.relationsRemoved, 0)}
                  </span>
                </div>

                <div className="kg-diff-list">
                  {kgExtractionPreview.items.map((item) => (
                    <article className="kg-diff-chapter" key={item.chapter.id}>
                      <h3>
                        第 {item.chapter.index} 章 · {item.chapter.title}
                      </h3>
                      <p>
                        实体 +{item.diff.summary.entitiesAdded} / -{item.diff.summary.entitiesRemoved} / 不变 {item.diff.summary.entitiesUnchanged}
                        {' · '}
                        关系 +{item.diff.summary.relationsAdded} / -{item.diff.summary.relationsRemoved} / 不变 {item.diff.summary.relationsUnchanged}
                      </p>

                      <div className="kg-diff-columns">
                        <div>
                          <h4>新增实体</h4>
                          {item.diff.entities.added.slice(0, 8).map((entity) => (
                            <span className="tag" key={entity.key}>{entity.name} · {getKgEntityTypeLabel(entity.type)}</span>
                          ))}
                          {!item.diff.entities.added.length && <small>无</small>}
                        </div>
                        <div>
                          <h4>移除实体证据</h4>
                          {item.diff.entities.removed.slice(0, 8).map((entity) => (
                            <span className="tag" key={entity.key}>{entity.name} · {getKgEntityTypeLabel(entity.type)}</span>
                          ))}
                          {!item.diff.entities.removed.length && <small>无</small>}
                        </div>
                        <div>
                          <h4>新增关系</h4>
                          {item.diff.relations.added.slice(0, 8).map((relation) => (
                            <span className="tag" key={relation.key}>
                              {relation.sourceName} -- {relation.type} -- {relation.targetName}
                            </span>
                          ))}
                          {!item.diff.relations.added.length && <small>无</small>}
                        </div>
                        <div>
                          <h4>移除关系证据</h4>
                          {item.diff.relations.removed.slice(0, 8).map((relation) => (
                            <span className="tag" key={relation.key}>
                              {relation.sourceName} -- {relation.type} -- {relation.targetName}
                            </span>
                          ))}
                          {!item.diff.relations.removed.length && <small>无</small>}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={isKgApplyingPreview}
                    onClick={() => setKgExtractionPreview(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={isKgApplyingPreview}
                    onClick={() => void applyKgExtractionPreview()}
                  >
                    {isKgApplyingPreview ? '应用中...' : '确认应用到图谱'}
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
                setShowKgBookGraph(false)
                setShowKgEvidenceSearch(false)
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
                setShowKgBookGraph(false)
                setShowKgEvidenceSearch(false)
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
                setShowKgBookGraph(false)
                setShowKgEvidenceSearch(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
              }}
            >
              <span>关系</span>
              <strong>{kgOverview?.relation_count ?? 0}</strong>
            </button>
            <button
              type="button"
              className={showKgBookGraph ? 'active' : ''}
              onClick={() => {
                setShowKgBookGraph((current) => !current)
                setShowKgEntities(false)
                setShowKgRelations(false)
                setShowKgReviewQueue(false)
                setShowKgScannedChapters(false)
                setShowKgEvidenceSearch(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
                if (!showKgBookGraph) void fetchKgBookGraph()
              }}
            >
              <span>图谱视图</span>
              <strong>{kgBookGraph?.relations.length ?? kgOverview?.relation_count ?? 0}</strong>
            </button>
            <button
              type="button"
              className={showKgEvidenceSearch ? 'active' : ''}
              onClick={() => {
                setShowKgEvidenceSearch((current) => !current)
                setShowKgEntities(false)
                setShowKgRelations(false)
                setShowKgReviewQueue(false)
                setShowKgScannedChapters(false)
                setShowKgBookGraph(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
              }}
            >
              <span>证据搜索</span>
              <strong>{kgEvidenceEntityHits.length + kgEvidenceRelationHits.length}</strong>
            </button>
            <button
              type="button"
              className={showKgReviewQueue ? 'active' : ''}
              onClick={() => {
                setShowKgReviewQueue((current) => !current)
                setShowKgEntities(false)
                setShowKgRelations(false)
                setShowKgScannedChapters(false)
                setShowKgBookGraph(false)
                setShowKgEvidenceSearch(false)
                setKgEntityDetail(null)
                setKgRelationDetail(null)
              }}
            >
              <span>待复审</span>
              <strong>{kgReviewEntities.length + kgReviewRelations.length}</strong>
            </button>
          </div>

          {showKgEvidenceSearch && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>证据搜索</h3>
                  <p>搜索实体、关系、证据文本、描述和章节标题，结果可跳转到对应详情或正文。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgEvidenceSearch(false)}>
                  收起
                </button>
              </div>

              <div className="kg-filter-bar">
                <input
                  type="search"
                  placeholder="搜索实体、关系或证据"
                  value={kgEvidenceSearchQuery}
                  onChange={(event) => setKgEvidenceSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchKgEvidence()
                  }}
                />
                <select
                  value={kgEvidenceSearchKind}
                  onChange={(event) => setKgEvidenceSearchKind(event.target.value as 'all' | 'entities' | 'relations')}
                >
                  <option value="all">全部证据</option>
                  <option value="entities">只看实体</option>
                  <option value="relations">只看关系</option>
                </select>
                <button type="button" disabled={isKgEvidenceSearching} onClick={() => void searchKgEvidence()}>
                  {isKgEvidenceSearching ? '搜索中...' : '搜索'}
                </button>
                {(kgEvidenceSearchQuery || kgEvidenceEntityHits.length || kgEvidenceRelationHits.length) && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgEvidenceSearchQuery('')
                      setKgEvidenceEntityHits([])
                      setKgEvidenceRelationHits([])
                    }}
                  >
                    清除
                  </button>
                )}
              </div>

              {kgEvidenceEntityHits.length || kgEvidenceRelationHits.length ? (
                <div className="kg-search-results">
                  {kgEvidenceEntityHits.length > 0 && (
                    <div>
                      <h4>实体证据 · {kgEvidenceEntityHits.length}</h4>
                      <div className="kg-search-hit-list">
                        {kgEvidenceEntityHits.map((hit) => (
                          <article className="kg-search-hit" key={hit.mentionId}>
                            <div>
                              <button type="button" onClick={() => void openKgEntityDetail(hit.entityId)}>
                                {hit.entityName}
                              </button>
                              <span>{getKgEntityTypeLabel(hit.entityType)}</span>
                              <button type="button" className="ghost-button" onClick={() => openChapterFromKnowledgeGraph(hit.chapterId)}>
                                第 {hit.chapterIndex} 章
                              </button>
                            </div>
                            <strong>{hit.chapterTitle}</strong>
                            <p>{hit.evidence || hit.entityDescription || '暂无证据文本。'}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}

                  {kgEvidenceRelationHits.length > 0 && (
                    <div>
                      <h4>关系证据 · {kgEvidenceRelationHits.length}</h4>
                      <div className="kg-search-hit-list">
                        {kgEvidenceRelationHits.map((hit) => (
                          <article className="kg-search-hit" key={hit.mentionId}>
                            <div>
                              <button type="button" onClick={() => void openKgRelationDetail(hit.relationId)}>
                                {hit.sourceName} -- {hit.relationType} -- {hit.targetName}
                              </button>
                              <button type="button" className="ghost-button" onClick={() => openChapterFromKnowledgeGraph(hit.chapterId)}>
                                第 {hit.chapterIndex} 章
                              </button>
                            </div>
                            <strong>{hit.chapterTitle}</strong>
                            <p>{hit.evidence || hit.relationDescription || '暂无证据文本。'}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="empty-summary">
                  {kgEvidenceSearchQuery.trim() ? '没有匹配的图谱证据。' : '输入关键词后搜索图谱证据。'}
                </p>
              )}
            </section>
          )}

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
                                ? openKgEntityEdit(item)
                                : openKgRelationEdit(item)
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

          {showKgBookGraph && (
            <section className="kg-card kg-scanned-card">
              <div className="kg-card-heading">
                <div>
                  <h3>图谱视图</h3>
                  <p>按实体类型和关系类型查看当前书的限量关系图，默认展示人物之间的高频关系。</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setShowKgBookGraph(false)}>
                  收起
                </button>
              </div>

              <div className="kg-filter-bar kg-graph-filters">
                <select
                  value={kgBookGraphEntityTypeFilter}
                  onChange={(event) => setKgBookGraphEntityTypeFilter(event.target.value)}
                >
                  <option value="">全部实体类型</option>
                  <option value="character">人物图</option>
                  <option value="sect">门派/组织图</option>
                  <option value="item">道具/法宝图</option>
                  <option value="skill">功法/法术图</option>
                  <option value="location">地点图</option>
                  <option value="beast">灵兽/妖兽图</option>
                  <option value="event">事件图</option>
                </select>
                <select
                  value={kgBookGraphRelationTypeFilter}
                  onChange={(event) => setKgBookGraphRelationTypeFilter(event.target.value)}
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
                <input
                  type="search"
                  placeholder="定位实体名称或别名"
                  value={kgBookGraphSearch}
                  onChange={(event) => setKgBookGraphSearch(event.target.value)}
                />
                <select
                  value={kgBookGraphMaxNodes}
                  onChange={(event) => setKgBookGraphMaxNodes(event.target.value)}
                  disabled={Boolean(kgBookGraphSearch.trim())}
                >
                  <option value="40">核心 40</option>
                  <option value="80">核心 80</option>
                  <option value="140">核心 140</option>
                  <option value="all">全部</option>
                </select>
                {(kgBookGraphEntityTypeFilter !== 'character' || kgBookGraphRelationTypeFilter || kgBookGraphSearch || kgBookGraphMaxNodes !== '80') && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setKgBookGraphEntityTypeFilter('character')
                      setKgBookGraphRelationTypeFilter('')
                      setKgBookGraphSearch('')
                      setKgBookGraphMaxNodes('80')
                    }}
                  >
                    重置
                  </button>
                )}
              </div>

              <div className="kg-graph-canvas kg-book-graph-canvas">
                {kgBookGraph && kgBookGraphNodes.length > 0 ? (
                  <ReactFlow
                    key={`${kgBookGraphEntityTypeFilter}-${kgBookGraphRelationTypeFilter}-${kgBookGraphSearch}-${kgBookGraphMaxNodes}`}
                    nodes={kgBookGraphNodes}
                    edges={kgBookGraphEdges}
                    fitView
                    fitViewOptions={{ padding: 0.18 }}
                    minZoom={0.12}
                    maxZoom={1.4}
                    nodesDraggable
                    onNodeClick={(_, node) => void openKgEntityDetail(node.id)}
                    onEdgeClick={(_, edge) => void openKgRelationDetail(edge.id)}
                  >
                    <Background color="#e2d8ca" gap={24} />
                    <Controls showInteractive={false} />
                    <MiniMap
                      nodeColor={(node) => getKgEntityColor((node.data as KgGraphNodeData).entity.type)}
                      pannable
                      zoomable
                    />
                  </ReactFlow>
                ) : (
                  <p className="empty-summary">当前筛选下没有可展示的关系。</p>
                )}
              </div>

              {kgBookGraph && (
                <div className="kg-graph-legend">
                  <span>
                    节点 {kgVisibleBookGraph.entities.length}/{kgBookGraph.entities.length}
                  </span>
                  <span>
                    关系 {kgVisibleBookGraph.relations.length}/{kgBookGraph.relations.length}
                  </span>
                  {kgBookGraphSearch.trim() && (
                    <span>
                      匹配 {kgVisibleBookGraph.matchingEntityIds.size}
                    </span>
                  )}
                  {Array.from(new Set(kgBookGraph.entities.map((entity) => entity.type))).map((type) => (
                    <span key={type}>
                      <i style={{ background: getKgEntityColor(type) }} />
                      {getKgEntityTypeLabel(type)}
                    </span>
                  ))}
                </div>
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
                    onClick={() => openKgEntityEdit(kgEntityDetail.entity)}
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
                    className="ghost-button"
                    onClick={() => {
                      setShowKgGraph((current) => !current)
                      if (!showKgGraph) void fetchKgNeighborhood(kgEntityDetail.entity.id)
                    }}
                  >
                    关系图
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => openKgSplitModal(kgEntityDetail)}
                  >
                    拆分
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
              {showKgGraph && (
                <div className="kg-graph-panel">
                  <div className="kg-filter-bar kg-graph-filters">
                    <select
                      value={kgGraphEntityTypeFilter}
                      onChange={(event) => setKgGraphEntityTypeFilter(event.target.value)}
                    >
                      <option value="">全部实体类型</option>
                      <option value="character">人物</option>
                      <option value="sect">门派/组织</option>
                      <option value="item">道具/法宝</option>
                      <option value="skill">功法/法术</option>
                      <option value="location">地点</option>
                      <option value="beast">灵兽/妖兽</option>
                      <option value="event">事件</option>
                      <option value="other">其他</option>
                    </select>
                    <select
                      value={kgGraphRelationTypeFilter}
                      onChange={(event) => setKgGraphRelationTypeFilter(event.target.value)}
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
                    {(kgGraphEntityTypeFilter || kgGraphRelationTypeFilter) && (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setKgGraphEntityTypeFilter('')
                          setKgGraphRelationTypeFilter('')
                        }}
                      >
                        清除
                      </button>
                    )}
                  </div>
                  <div className="kg-graph-canvas">
                    {kgNeighborhood && kgGraphNodes.length > 0 ? (
                      <ReactFlow
                        nodes={kgGraphNodes}
                        edges={kgGraphEdges}
                        fitView
                        fitViewOptions={{ padding: 0.25 }}
                        minZoom={0.25}
                        maxZoom={1.6}
                        nodesDraggable
                        onNodeClick={(_, node) => void openKgEntityDetail(node.id)}
                        onEdgeClick={(_, edge) => void openKgRelationDetail(edge.id)}
                      >
                        <Background color="#e2d8ca" gap={20} />
                        <Controls showInteractive={false} />
                        <MiniMap
                          nodeColor={(node) => getKgEntityColor((node.data as KgGraphNodeData).entity.type)}
                          pannable
                          zoomable
                        />
                      </ReactFlow>
                    ) : (
                      <p className="empty-summary">没有可展示的关系。</p>
                    )}
                  </div>
                  {kgNeighborhood && (
                    <div className="kg-graph-legend">
                      {kgNeighborhood.entities.map((entity) => (
                        <span key={entity.id}>
                          <i style={{ background: getKgEntityColor(entity.type) }} />
                          {getKgEntityTypeLabel(entity.type)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
                    onClick={() => openKgRelationEdit(kgRelationDetail.relation)}
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

            <label className="kg-inline-toggle" htmlFor="kg-scan-overwrite">
              <input
                id="kg-scan-overwrite"
                type="checkbox"
                checked={kgScanOverwriteCompleted}
                onChange={(event) => setKgScanOverwriteCompleted(event.target.checked)}
              />
              覆盖已完成章节
            </label>

            <div className="kg-scan-actions">
              {isKgScanning ? (
                <>
                  <button type="button" disabled>
                    任务进行中...
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    disabled={isStoppingKgScan}
                    onClick={() => void stopKnowledgeGraphScan()}
                  >
                    {isStoppingKgScan ? '停止中...' : '停止任务'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={getSelectedKgScanChapters().length === 0}
                    onClick={() => void scanSelectedKnowledgeGraphChapters({ overwriteCompleted: kgScanOverwriteCompleted })}
                  >
                    {kgScanOverwriteCompleted
                      ? `预览覆盖重扫 ${getSelectedKgScanChapters().length} 章`
                      : `开始扫描 ${getPendingKgScanChapters().length} 章`}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={getSelectedKgScanChapters().length === 0}
                    onClick={() => void replaySelectedKnowledgeGraphChapters()}
                  >
                    重放已保存 JSON
                  </button>
                </>
              )}
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
                    {(kgScanJob.status === 'failed' || kgScanJob.status === 'cancelled') && (
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
                已选 {getSelectedKgScanChapters().length} 章，
                {kgScanOverwriteCompleted
                  ? '将覆盖已完成章节并重新调用模型。'
                  : `已完成将自动跳过 ${getSelectedKgScanChapters().length - getPendingKgScanChapters().length} 章。`}
              </p>
              <p>“重放已保存 JSON”不会调用模型，只会用现有章节抽取结果重建图谱写入。</p>
              {kgScanProgress && <p>{kgScanProgress}</p>}
            </div>

            <div className="kg-advanced-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowKgManualExtraction((current) => !current)}
              >
                {showKgManualExtraction ? '收起手动 JSON' : '手动 JSON'}
              </button>
            </div>

            {showKgManualExtraction && (
              <div className="kg-manual-extraction">
                <h4>当前章节 JSON</h4>
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
                  预览并保存到图谱
                </button>
                {kgError && <p className="error">{kgError}</p>}
              </div>
            )}
          </section>
        </section>
      ) : view === 'search' && state.book ? (
        <section className="search-panel">
          <div className="search-heading">
            <div>
              <p className="eyebrow">智能搜索</p>
              <h2>{state.book.title}</h2>
              <p>基于章节摘要和知识图谱，回答跨章节问题。</p>
            </div>
          </div>

          {embeddingStatus && (
            <div className="embedding-status">
              <span>
                Embedding 覆盖：{embeddingStatus.embeddedChapters}/{embeddingStatus.totalChapters} 章
                {embeddingStatus.missingChapters > 0 && `（还差 ${embeddingStatus.missingChapters} 章）`}
                {typeof embeddingStatus.dimension === 'number' && ` · 维度 ${embeddingStatus.dimension}`}
              </span>
              {embeddingStatus.missingChapters > 0 && (
                <button
                  type="button"
                  onClick={() => void handleGenerateEmbeddings()}
                  disabled={isGeneratingEmbeddings}
                >
                  {isGeneratingEmbeddings ? '生成中...' : '生成 embedding'}
                </button>
              )}
              {embeddingProgress && <small>{embeddingProgress}</small>}
            </div>
          )}

          <div className="search-input-area">
            <input
              type="text"
              placeholder="例如：某某功法第一次出现在哪里"
              value={ragQuery}
              onChange={(event) => setRagQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleRagSearch()
              }}
            />
            <button type="button" onClick={() => void handleRagSearch()} disabled={ragIsSearching}>
              {ragIsSearching ? '搜索中...' : '搜索'}
            </button>
          </div>

          <div className="search-options">
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
              包含原文片段
            </label>
          </div>

          {ragEntityMatches.length > 0 && (
            <div className="entity-tags">
              <span style={{ color: '#5e5549', fontSize: '14px' }}>识别到实体：</span>
              {ragEntityMatches.map((entity) => (
                <span className="entity-tag" key={entity.entityId}>
                  {entity.entityName}
                </span>
              ))}
            </div>
          )}

          {ragError && <p className="error">{ragError}</p>}

          {ragAnswer && (
            <div className="search-answer">
              <p className="eyebrow">AI 回答</p>
              <div className="search-answer-content">{ragAnswer}</div>
            </div>
          )}

          {ragResults.length > 0 && (
            <div className="search-results">
              <div className="search-results-header">
                <h3>相关章节（{ragResults.length}）</h3>
                <button
                  type="button"
                  onClick={() => void handleGenerateRagAnswer()}
                  disabled={ragIsGeneratingAnswer}
                >
                  {ragIsGeneratingAnswer ? '生成中...' : '生成答案'}
                </button>
              </div>
              {ragResults.map((result) => (
                <div className="search-result-card" key={result.chapterId}>
                  <div className="search-result-header">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        updateActiveChapter(result.chapterId)
                        setView('reader')
                      }}
                    >
                      第 {result.chapterIndex} 章：{result.chapterTitle}
                    </button>
                    <span className={`match-type ${result.matchType}`}>
                      {result.matchType === 'vector' ? '语义' : result.matchType === 'entity' ? '实体' : '混合'}
                    </span>
                  </div>
                  {result.matchedEntities.length > 0 && (
                    <div className="entity-tags">
                      {result.matchedEntities.map((name) => (
                        <span className="entity-tag" key={name}>
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="search-result-summary">{result.summary.detail}</p>
                  {result.contentSnippet && <p className="search-result-snippet">{result.contentSnippet}...</p>}
                </div>
              ))}
            </div>
          )}
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
                <nav className="chapter-bottom-nav" aria-label="章节底部导航">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!previousChapter}
                    onClick={navigateToPreviousChapter}
                  >
                    <span>上一章</span>
                    <strong>{previousChapter?.title ?? '已经是第一章'}</strong>
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!nextChapter}
                    onClick={navigateToNextChapter}
                  >
                    <span>下一章</span>
                    <strong>{nextChapter?.title ?? '已经是最后一章'}</strong>
                  </button>
                </nav>
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
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleBatchGenerateAllMissingSummaries()}
                disabled={isGenerating}
              >
                批量生成全书缺失概要
              </button>
            </div>
            <p className="batch-status">
              全书已生成 {processedCount}/{state.book.chapters.length} 章 · 本页 {pageSummaryCount}/{pagedChapters.length} 章
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
